/**
 * Fact constructors and validation.
 *
 * A fact is the smallest thing an extractor can state about a repository. Every fact
 * carries `type`, `file` (repository-relative, forward slashes) and `line` (1-based);
 * each type adds its own required fields. Optional fields may be supplied freely.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const REQUIRED_ON_ALL = ['file', 'line'];

const TYPE_FIELDS = {
  route: ['controller', 'action', 'verb', 'template'],
  http_out: ['configKey', 'template'],
  // `message` may be null only when `unresolved` names why the argument's type could not be
  // read (`lambda-parameter`, `local-variable`, `parameter-type`, `unknown-identifier`): the
  // site is still stated, so a publish never disappears for want of a type.
  publish: ['message'],
  consume: ['message', 'consumer'],
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
    return `missing required field "${field}"`;
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
export function factsHeader({ repo, kind, root, generatedFrom, facts, titles }) {
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
  header.facts = facts;
  return header;
}

/**
 * One stderr-ready line per fact set whose stored `headSha`/`dirtyDigest` no longer match
 * the repository it was extracted from: HEAD has moved, or the working tree's changed
 * paths differ from what was there at extraction time. A fact set stamped with a
 * `dirtyDigest` is fresh whenever the sha and the digest both still match — a dirty tree
 * that has not changed since extraction is fresh, not stale. A fact set with a `headSha`
 * but no `dirtyDigest` (extracted by an older flowtrace) falls back to the original,
 * more conservative rule: fresh only when HEAD matches and the tree is clean right now. A
 * fact set with no `headSha` at all (a legacy header, or one `factsHeader` could not
 * stamp) is skipped entirely — there is no baseline to compare against, and a guess would
 * be worse than silence. A fact set naming a repo id absent from `repos`, or a `root` git
 * cannot read, is skipped the same way.
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
    const fresh =
      set.dirtyDigest !== undefined
        ? status.sha === set.headSha && status.dirtyDigest === set.dirtyDigest
        : status.sha === set.headSha && !status.dirty;
    if (fresh) continue;
    warnings.push(
      `flowtrace: facts for ${set.repo} are stale (extracted at ${set.headSha.slice(0, 7)}, ` +
        `HEAD ${status.sha.slice(0, 7)}; ${status.changed} changed file${status.changed === 1 ? '' : 's'}) — ` +
        `run flowtrace extract --repo ${set.repo}`,
    );
  }
  return warnings;
}
