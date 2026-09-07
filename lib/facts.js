/**
 * Fact constructors and validation.
 *
 * A fact is the smallest thing an extractor can state about a repository. Every fact
 * carries `type`, `file` (repository-relative, forward slashes) and `line` (1-based);
 * each type adds its own required fields. Optional fields may be supplied freely.
 *
 * A fact set can also take facts from an external provider — a file, or a command whose
 * stdout is a fact document — configured per repository as `factsProvider`. Every such
 * fact is validated here exactly as an extractor's would be, stamped with a `provenance`
 * naming the producer, and merged with the extraction per the configured mode. An
 * extracted fact never carries `provenance`; that absence is what tells a reader the
 * bundled extractor read it. The header of the written fact set records both producers
 * and a per-type comparison between the two, computed before the merge discards anything.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const REQUIRED_ON_ALL = ['file', 'line'];

/** How an external provider's facts combine with the extractor's; `docs/configuration.md` defines each. */
export const PROVIDER_MERGE_MODES = Object.freeze(['prefer-external', 'external-only', 'regex-only-with-diff']);
/** A provider command that has not finished after this long is a refusal, not a wait. */
export const PROVIDER_TIMEOUT_MS = 300_000;
/** The most stdout a provider command may produce before the run is refused. */
export const PROVIDER_MAX_OUTPUT = 256 * 1024 * 1024;
/** Environment a provider command receives on top of the current process environment. */
export const PROVIDER_ENV = Object.freeze({
  id: 'FLOWTRACE_REPO_ID',
  root: 'FLOWTRACE_REPO_ROOT',
  kind: 'FLOWTRACE_REPO_KIND',
});

const TYPE_FIELDS = {
  route: ['controller', 'action', 'verb', 'template'],
  http_out: ['configKey', 'template'],
  // `message` may be null only when `unresolved` names why the argument's type could not be
  // read (`lambda-parameter`, `local-variable`, `parameter-type`, `unknown-identifier`): the
  // site is still stated, so a publish never disappears for want of a type. `verb` is the
  // matched call name lower-cased (`publish`, `send`, `defer`, `submitjob`, `reply`, …),
  // required and non-empty so `PublishAsync` and `Publish` never read as two kinds of fact.
  publish: ['message', 'verb'],
  consume: ['message', 'consumer'],
  // A class implementing a saga interface (`workerPatterns.sagaInterfaces`, default
  // `IAmInitiatedBy`): `initiatedBy` and `handles` are message-type-name arrays read off the
  // class's own base list, and `correlation` is the property a `ConfigureHowToFindSaga` or
  // `CorrelateBy` lambda names, or `null` when the class states none -- a fact about the
  // code, not a parse failure, so `null` is a value this field is allowed to carry.
  saga: ['saga', 'initiatedBy', 'handles', 'correlation'],
  worker_processor: ['workType', 'processor'],
  signalr_push: ['method'],
  exchange_name: ['name', 'constant'],
  // Three producers, one shape: the two-argument registration (`AddScoped<TIface, TImpl>()`),
  // the single-generic-arg factory lambda, and the mediator request-to-handler
  // binding, where `iface` is the request type a handler class declares it handles rather than
  // an interface name. Every consumer reads `iface`/`impl` with no assumption about which.
  di_binding: ['iface', 'impl'],
  // A class's own declared base list (`class X : IFoo`) naming it an implementation of an
  // interface -- source-level evidence, independent of whether anything registers it in DI.
  // The interface-collection fan-out reads this alongside `di_binding` so a receiver
  // registered by resolving concrete singletons directly (never through an interface-typed
  // DI call) still has a known set of implementations to fan out over.
  iface_impl: ['class', 'iface'],
  gateway_call: ['service', 'method', 'verb', 'template', 'resolved'],
  injects: ['from', 'to'],
  // `role` is one of: page | container | component | hook | service — the mobile
  // extractor states page/component/service, the web extractor page/container/component/hook.
  component: ['name', 'selector', 'role'],
  renders: ['from', 'to'],
  template_handler: ['component', 'event', 'handler', 'kind'],
  cypress_intercept: ['spec', 'test', 'verb', 'pattern'],
  cypress_test: ['spec', 'test', 'skipped'],
  pw_test: ['spec', 'test', 'skipped'],
  pw_request: ['spec', 'test', 'verb', 'template', 'resolved'],
  pw_assert: ['spec', 'test', 'kind'],
  pw_stub: ['spec', 'test', 'kind'],
  ctor_field: ['class', 'field', 'paramType'],
  method_call: ['class', 'method', 'field', 'calledMethod'],
  branch_point: ['class', 'method', 'kind', 'text', 'endLine'],
  redis_publish: ['channel'],
  message_class: ['name', 'fqn'],
  queue_name: ['message', 'name'],
  method_span: ['class', 'method', 'endLine'],
  param_source: ['class', 'method', 'param', 'source', 'via'],
  action_dispatch: ['class', 'method', 'action'],
  effect_handler: ['class', 'field', 'actions', 'endLine'],
  action_def: ['action'],
  props_bind: ['component', 'prop', 'target'],
  // Optional enrichment: the titles a collector resolved at one `pw_test` declaration
  // line, one per parameter instance. No bundled extractor emits it; a reader that has
  // none keeps the title expression as written rather than evaluating it.
  pw_title: ['spec', 'titles'],
  // `source` is one of: annotation | literal | table — a `case-id` annotation push, a
  // literal argument of a configured case-id call, or one row of a same-file data table
  // the test iterates. Nothing else resolves.
  case_id: ['spec', 'ids', 'source'],
  // `scope` is one of: global | action — a registered exception filter applies to every
  // action, a per-action catch only to its own.
  exception_map: ['scope', 'class', 'exception', 'status'],
  // `status` is one of: resolved | gap — a resolved row adds `state` and `observe`, a gap row `reason`.
  assertion_surface: ['route', 'status', 'chain'],
  // The judgment half of an assertion surface, cached rather than derived: `field` is the
  // response field of `observe` an agent or a human read the projection path for, `reflects`
  // is true or false, and `file`/`line` are the evidence that reading rests on. A refusal is
  // recorded as `reflects: false`; a correlation nobody has read is absent, never assumed.
  surface_verdict: ['route', 'state', 'observe', 'field', 'reflects'],
};

/** Fact type -> every field required on that type, `file` and `line` included. */
export const FACT_TYPES = Object.freeze(
  Object.fromEntries(
    Object.entries(TYPE_FIELDS).map(([type, fields]) => [
      type,
      Object.freeze([...REQUIRED_ON_ALL, ...fields]),
    ]),
  ),
);

function isMissing(value) {
  return value === undefined || value === null;
}

function describe(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return '?';
  const { type } = candidate;
  return typeof type === 'string' && type ? type : '?';
}

function checkFact(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return 'not an object';
  }
  const { type } = candidate;
  if (isMissing(type) || type === '') return 'missing required field "type"';
  if (typeof type !== 'string' || !Object.hasOwn(FACT_TYPES, type)) {
    return `unknown fact type "${String(type)}"`;
  }
  for (const field of FACT_TYPES[type]) {
    if (!isMissing(candidate[field])) continue;
    if (type === 'publish' && field === 'message' && candidate.message === null && typeof candidate.unresolved === 'string' && candidate.unresolved !== '') continue;
    // `correlation` is required but `null` is its own valid value -- a saga that states no
    // correlation expression, not a fact that failed to state one.
    if (type === 'saga' && field === 'correlation') continue;
    return `missing required field "${field}"`;
  }
  if (type === 'publish' && (typeof candidate.verb !== 'string' || candidate.verb.trim() === '')) {
    return 'field "verb" must be a non-empty string';
  }
  const { file, line } = candidate;
  if (typeof file !== 'string' || file.trim() === '') {
    return 'field "file" must be a non-empty string';
  }
  if (file.includes('\\')) {
    return 'field "file" must be repository-relative with forward slashes';
  }
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
    return 'field "line" must be a positive integer';
  }
  return null;
}

/**
 * Build one fact. Throws on an unknown type, a missing required field, or a `file`
 * or `line` that cannot be used by the join step.
 */
export function fact(type, fields = {}) {
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new TypeError(`fact(${JSON.stringify(type)}): fields must be an object`);
  }
  const record = { type };
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'type') continue;
    record[key] = value;
  }
  const reason = checkFact(record);
  if (reason) throw new Error(`fact(${JSON.stringify(type)}): ${reason}`);
  return record;
}

/**
 * Validate a whole fact array. Throws `Fact #<index> (<type>): <reason>` on the first
 * bad entry; returns the number of facts checked.
 */
export function validateFacts(facts) {
  if (!Array.isArray(facts)) {
    throw new TypeError('validateFacts: expected an array of facts');
  }
  for (let index = 0; index < facts.length; index += 1) {
    const reason = checkFact(facts[index]);
    if (reason) {
      throw new Error(`Fact #${index} (${describe(facts[index])}): ${reason}`);
    }
  }
  return facts.length;
}

/** Whether a fact was supplied by an external provider rather than read by an extractor. */
export function isExternalFact(candidate) {
  return Boolean(candidate && typeof candidate === 'object' && candidate.provenance);
}

/**
 * Where a fact sits: its type at one line of one file. This is the unit the merge
 * replaces on, because the value fields (`paramType`, `template`, `endLine`) are exactly
 * what a semantic tool corrects — matching on them would keep the extractor's wrong value
 * beside the corrected one. A provider that states a site states it completely.
 */
export function factSite(candidate) {
  return `${candidate.type}|${candidate.file}|${candidate.line}`;
}

/** A fact's full identity: its type and every required field, in schema order. */
export function factIdentity(candidate) {
  const fields = FACT_TYPES[candidate.type] || REQUIRED_ON_ALL;
  return JSON.stringify([candidate.type, ...fields.map((field) => candidate[field])]);
}

/**
 * Check a parsed provider document: `{ producer, version?, repo?, facts }`. Throws on the
 * first problem, naming a bad fact by index and type the way `validateFacts` does. A fact
 * that already carries `provenance` is refused rather than overwritten: the stamp is this
 * tool's statement about where a fact came from, never the provider's claim about itself.
 * A document whose `repo` names another repository is refused for the same reason.
 */
export function parseProviderDocument(document, { repo }) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('the document must be a JSON object with "producer" and "facts"');
  }
  const { producer, version, repo: claimed, facts } = document;
  if (typeof producer !== 'string' || producer.trim() === '') {
    throw new Error('"producer" must be a non-empty string');
  }
  if (version !== undefined && version !== null && (typeof version !== 'string' || version.trim() === '')) {
    throw new Error('"version" must be a non-empty string when present');
  }
  if (claimed !== undefined && claimed !== repo) {
    throw new Error(`"repo" names "${String(claimed)}" but this fact set is for "${repo}"`);
  }
  if (!Array.isArray(facts)) throw new Error('"facts" must be an array');
  for (let index = 0; index < facts.length; index += 1) {
    const reason = checkFact(facts[index]);
    if (reason) throw new Error(`Fact #${index} (${describe(facts[index])}): ${reason}`);
    if (facts[index].provenance !== undefined) {
      throw new Error(
        `Fact #${index} (${describe(facts[index])}): carries "provenance"; that field is stamped by flowtrace, never supplied`,
      );
    }
  }
  return {
    producer: producer.trim(),
    version: typeof version === 'string' ? version.trim() : null,
    facts: facts.map((entry) => ({ ...entry })),
  };
}

function lastLine(text) {
  const lines = String(text || '').split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  return lines.length > 0 ? lines.at(-1) : '';
}

/**
 * The header-ready description of a validated `factsProvider` configuration entry:
 * `{ file }` for a static document, `{ command }` for a process whose stdout is one.
 */
export function providerSource(provider) {
  return provider.source === 'file' ? { file: provider.file } : { command: provider.command.slice() };
}

/**
 * Read the provider configured for one repository and return its validated document
 * plus the `source` the header records. A file is read as UTF-8 JSON. A command runs
 * with the repository as its working directory and `PROVIDER_ENV` in its environment; its
 * stdout must be the document. Every failure — an unreadable file, a command that cannot
 * start, exits non-zero or times out, output that is not JSON, a document that fails
 * `parseProviderDocument` — throws with the producer's source named, so the caller refuses
 * the whole run rather than writing a fact set that silently lacks what was configured.
 */
export function loadFactsProvider(repo, provider, { spawn = spawnSync, readFile = readFileSync, env = process.env } = {}) {
  const label = provider.source === 'file' ? `file ${provider.file}` : `command ${provider.command.join(' ')}`;
  const refuse = (reason) => new Error(`facts provider (${label}): ${reason}`);
  let text;
  if (provider.source === 'file') {
    try {
      text = readFile(provider.file, 'utf8');
    } catch (error) {
      throw refuse(`cannot read (${error.message})`);
    }
  } else {
    const [bin, ...args] = provider.command;
    const run = spawn(bin, args, {
      cwd: repo.root,
      encoding: 'utf8',
      timeout: PROVIDER_TIMEOUT_MS,
      maxBuffer: PROVIDER_MAX_OUTPUT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, [PROVIDER_ENV.id]: repo.id, [PROVIDER_ENV.root]: repo.root, [PROVIDER_ENV.kind]: repo.kind },
    });
    if (run.error) {
      if (run.error.code === 'ETIMEDOUT') throw refuse(`timed out after ${PROVIDER_TIMEOUT_MS / 1000} s`);
      if (run.error.code === 'ENOBUFS') throw refuse(`produced more than ${PROVIDER_MAX_OUTPUT / (1024 * 1024)} MiB of output`);
      throw refuse(`could not start (${run.error.message})`);
    }
    if (run.status !== 0) {
      const tail = lastLine(run.stderr);
      throw refuse(`exited ${run.status === null ? `on signal ${run.signal}` : run.status}${tail ? `: ${tail}` : ''}`);
    }
    text = run.stdout;
  }
  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw refuse(`output is not valid JSON (${error.message})`);
  }
  let parsed;
  try {
    parsed = parseProviderDocument(document, { repo: repo.id });
  } catch (error) {
    throw refuse(error.message);
  }
  return { ...parsed, source: providerSource(provider) };
}

function groupBySite(facts) {
  const sites = new Map();
  for (const entry of facts) {
    const site = factSite(entry);
    if (!sites.has(site)) sites.set(site, []);
    sites.get(site).push(factIdentity(entry));
  }
  for (const identities of sites.values()) identities.sort();
  return sites;
}

/**
 * Per fact type, how the two sources compare: `extracted` and `external` count facts;
 * `agreed`, `disagreed`, `externalOnly` and `extractedOnly` count sites (`factSite`) —
 * both stated it identically, both stated it differently, only the provider stated it,
 * only the extractor stated it. Computed before any merge, because afterwards the losing
 * facts are gone and nothing could recount them. Types neither side states are absent.
 */
export function compareFacts(extracted, external) {
  const byType = new Map();
  const bucket = (type) => {
    if (!byType.has(type)) {
      byType.set(type, { extracted: 0, external: 0, agreed: 0, disagreed: 0, externalOnly: 0, extractedOnly: 0 });
    }
    return byType.get(type);
  };
  for (const entry of extracted) bucket(entry.type).extracted += 1;
  for (const entry of external) bucket(entry.type).external += 1;
  const extractedSites = groupBySite(extracted);
  const externalSites = groupBySite(external);
  for (const [site, identities] of extractedSites) {
    const type = site.slice(0, site.indexOf('|'));
    const theirs = externalSites.get(site);
    if (!theirs) bucket(type).extractedOnly += 1;
    else if (theirs.join('\n') === identities.join('\n')) bucket(type).agreed += 1;
    else bucket(type).disagreed += 1;
  }
  for (const site of externalSites.keys()) {
    if (!extractedSites.has(site)) bucket(site.slice(0, site.indexOf('|'))).externalOnly += 1;
  }
  return Object.fromEntries([...byType.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * Combine the extractor's facts with a provider's under one `PROVIDER_MERGE_MODES` entry.
 * Every external fact that enters the result is a copy stamped `provenance: { producer,
 * version }`; extracted facts are carried as they are, in their original order, followed
 * by the external ones in the provider's order.
 *
 * - `prefer-external`: at every site the provider states, its facts replace the
 *   extractor's; sites it is silent on keep the extractor's facts.
 * - `external-only`: for every fact type the provider states, the extractor's facts of
 *   that type are dropped wholesale; types it is silent on keep the extractor's facts.
 * - `regex-only-with-diff`: the extractor's facts only; the provider's are validated and
 *   compared, and none of them enters the fact array.
 *
 * Returns the merged facts plus the numbers the header records: `supplied` (facts the
 * provider gave), `kept` (of those, how many entered the result), `replaced` (extracted
 * facts dropped in their favour) and the `compareFacts` table.
 */
export function mergeFacts(extracted, external, { mode, producer, version = null }) {
  if (!PROVIDER_MERGE_MODES.includes(mode)) {
    throw new Error(`mergeFacts: unknown merge mode "${String(mode)}" (expected one of ${PROVIDER_MERGE_MODES.join(', ')})`);
  }
  const provenance = version ? { producer, version } : { producer };
  const tagged = external.map((entry) => ({ ...entry, provenance: { ...provenance } }));
  const comparison = compareFacts(extracted, external);
  if (mode === 'regex-only-with-diff') {
    return { facts: extracted.slice(), supplied: external.length, kept: 0, replaced: 0, comparison };
  }
  let survives;
  if (mode === 'external-only') {
    const types = new Set(external.map((entry) => entry.type));
    survives = (entry) => !types.has(entry.type);
  } else {
    const sites = new Set(external.map(factSite));
    survives = (entry) => !sites.has(factSite(entry));
  }
  const kept = extracted.filter(survives);
  return {
    facts: [...kept, ...tagged],
    supplied: external.length,
    kept: tagged.length,
    replaced: extracted.length - kept.length,
    comparison,
  };
}

/**
 * Every `repo|file|line` at which some fact set carries an externally supplied fact —
 * what a reader consults to mark a hop located there. Location-level on purpose: the
 * statement "an external fact is stated at this line" is one the reader can check in the
 * fact file, whatever the hop's own kind.
 */
export function externalLocations(factSets) {
  const locations = new Set();
  for (const set of factSets || []) {
    for (const entry of set.facts || []) {
      if (isExternalFact(entry)) locations.add(`${set.repo}|${entry.file}|${entry.line}`);
    }
  }
  return locations;
}

/**
 * Per fact set, who wrote how many of its facts — counted from the facts' own
 * `provenance` tags rather than from the header, because the file's contents are the
 * evidence and the header a summary of them — together with the header's `provider`
 * block when one exists, so a report can print the comparison beside the counts.
 */
export function producerSummary(factSets) {
  return (factSets || []).map((set) => {
    let extracted = 0;
    const external = new Map();
    for (const entry of set.facts || []) {
      if (!isExternalFact(entry)) {
        extracted += 1;
        continue;
      }
      const key = `${entry.provenance.producer}\u0000${entry.provenance.version || ''}`;
      if (!external.has(key)) {
        external.set(key, { producer: entry.provenance.producer, version: entry.provenance.version || null, facts: 0 });
      }
      external.get(key).facts += 1;
    }
    return {
      repo: set.repo,
      generatedFrom: set.generatedFrom || null,
      extracted,
      external: [...external.values()],
      provider: set.provider || null,
    };
  });
}

function runGit(root, args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/**
 * The repository's HEAD sha, whether its working tree carries changes, how many of its
 * files changed, and how many files git tracks at that HEAD — or `null` when `root` is
 * not a git repository, or git itself is not on PATH. Every caller treats `null` the
 * same as a legacy header: there is nothing trustworthy to compare, so it stays silent
 * rather than guessing.
 */
export function gitStatus(root) {
  const sha = runGit(root, ['rev-parse', 'HEAD']);
  if (!sha) return null;
  const porcelain = runGit(root, ['status', '--porcelain']);
  const changedFiles = porcelain ? porcelain.split('\n').filter((line) => line.length > 0) : [];
  const tracked = runGit(root, ['ls-files']);
  return {
    sha,
    dirty: changedFiles.length > 0,
    changed: changedFiles.length,
    fileCount: tracked ? tracked.split('\n').filter((line) => line.length > 0).length : null,
    dirtyDigest: createHash('sha1').update([...changedFiles].sort().join('\n')).digest('hex'),
  };
}

/**
 * Build the `out/facts/<repo>.json` header: `generatedFrom` plus, when `root` resolves
 * to a git repository, the HEAD sha, the dirty flag, a `dirtyDigest` fingerprint of the
 * working tree's changed paths, an ISO extraction timestamp and the tracked file count —
 * the evidence `staleFactsWarnings` later checks a fact set against the repository it
 * came from. `dirtyDigest` lets a fact set extracted from a dirty tree stay fresh until
 * that tree actually changes, rather than being permanently unable to satisfy its own
 * "run flowtrace extract" advice. Facts are attached last so the metadata reads first in
 * the file. Silent (no git fields) when `root` is not a repository or git is unavailable;
 * a fact set extracted from a non-git checkout is valid without repository metadata.
 */
export function factsHeader({ repo, kind, root, generatedFrom, facts, titles, provider }) {
  const header = { repo, kind, generatedFrom, generatedAt: new Date().toISOString() };
  const status = root ? gitStatus(root) : null;
  if (status) {
    header.headSha = status.sha;
    header.dirty = status.dirty;
    if (status.fileCount !== null) header.fileCount = status.fileCount;
    header.dirtyDigest = status.dirtyDigest;
  }
  // Only a playwright repository configured `"titles": true` carries this: what the title
  // collector did, so a reader can explain a `raw` title without re-running anything.
  if (titles) header.titles = titles;
  // Only a repository configured with a `factsProvider` carries this: the second
  // producer, where its document came from, the merge mode, and how the two sources
  // compared before the merge — `generatedFrom` above still names the extraction.
  if (provider) header.provider = provider;
  header.facts = facts;
  return header;
}

/**
 * One stderr-ready `{ message, kind }` per fact set whose stored `headSha`/`dirtyDigest`
 * no longer match the repository it was extracted from: HEAD has moved, or the working
 * tree's changed paths differ from what was there at extraction time. A fact set stamped
 * with a `dirtyDigest` is fresh whenever the sha and the digest both still match — a
 * dirty tree that has not changed since extraction is fresh, not stale. A fact set with a
 * `headSha` but no `dirtyDigest` (extracted by an older flowtrace) falls back to the
 * original, more conservative rule: fresh only when HEAD matches and the tree is clean
 * right now. A fact set with no `headSha` at all (a legacy header, or one `factsHeader`
 * could not stamp) is skipped entirely — there is no baseline to compare against, and a
 * guess would be worse than silence. A fact set naming a repo id absent from `repos`, or
 * a `root` git cannot read, is skipped the same way.
 *
 * `kind` tells apart the two things staleness used to conflate. `head`: the recorded
 * `headSha` no longer names the repository's HEAD, or a legacy set (no `dirtyDigest`)
 * was already dirty at extraction — with no digest to compare, whatever is dirty now
 * cannot be told apart from what was dirty then, so the conservative reading stands.
 * `worktree`: HEAD still matches and only the dirty state has moved on from what
 * extraction recorded — a legacy set extracted clean whose tree has since picked up
 * edits, or a modern set whose `dirtyDigest` no longer matches. A `head` fact set is
 * behind a commit a caller has not seen; a `worktree` one is only behind edits already
 * sitting in the tree a caller reading that tree would see anyway.
 */
export function staleFactsWarnings(factSets, repos) {
  const rootById = new Map((repos || []).map((repo) => [repo.id, repo.root]));
  const warnings = [];
  for (const set of factSets || []) {
    if (!set || !set.headSha) continue;
    const root = rootById.get(set.repo);
    if (!root) continue;
    const status = gitStatus(root);
    if (!status) continue;
    const legacy = set.dirtyDigest === undefined;
    const fresh = legacy
      ? status.sha === set.headSha && !status.dirty
      : status.sha === set.headSha && status.dirtyDigest === set.dirtyDigest;
    if (fresh) continue;
    const headMoved = status.sha !== set.headSha;
    const kind = headMoved || (legacy && set.dirty === true) ? 'head' : 'worktree';
    const message =
      kind === 'head'
        ? `flowtrace: facts for ${set.repo} are stale (extracted at ${set.headSha.slice(0, 7)}, ` +
          `HEAD ${status.sha.slice(0, 7)}; ${status.changed} changed file${status.changed === 1 ? '' : 's'}) — ` +
          `run flowtrace extract --repo ${set.repo}`
        : `flowtrace: facts for ${set.repo} predate ${status.changed} uncommitted ` +
          `change${status.changed === 1 ? '' : 's'} in the working tree (extracted at ` +
          `${set.headSha.slice(0, 7)}, still HEAD) — not stale, gates nothing`;
    warnings.push({ message, kind });
  }
  return warnings;
}
