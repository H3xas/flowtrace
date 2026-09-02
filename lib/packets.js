/**
 * Reader hand-off — packets out, verdicts in.
 *
 * `cover` computes everything a regex can settle and reports `path` and
 * `disposition` as `needs-reader`: whether an assertion is diagnostic of a sink or of
 * one branch outcome is judgement, not extraction. This module is the hand-off itself.
 *
 * `buildPackets`/`writePackets` write one packet per route that has at least one
 * candidate test, carrying the seed's raw dispositions and outcomes, every candidate
 * test with its intercepts and a source excerpt, and the promotion rule for each
 * reader level — everything a reader needs and nothing it has to re-derive.
 *
 * `readVerdicts`/`mergeVerdicts` read the reader's answers back and apply them to a
 * `cover` report, one seed at a time. A verdict can only upgrade a seed's level
 * (`route` -> `path` -> `disposition`), never downgrade it, and never promote a seed
 * whose mechanical level is `none` or `skipped` — a reader cannot invent an execution
 * that never happened. Every accepted upgrade needs at least one evidence entry: a
 * claim with nothing pointing at it is not an upgrade.
 *
 * A verdict is matched to its seed by the seed's stable `key`. `U<n>` is a position in
 * a printed list: when a branch is added upstream, or a phantom split collapses, the
 * numbering moves and the same `U7` now names a different use case. An entry carrying
 * only an id is therefore honoured only while the packet it came from is still the
 * packet this run would write — `packetHash` on both sides — and rejected as
 * `stale-verdict` otherwise, because a verdict applied to the wrong seed is worse than
 * no verdict at all.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { buildEvidenceIndex, LEVEL_RULES, recomputeLevels, sinkSummary, readCount, STATE_ORDER } from './cover.js';
import { trace } from './trace.js';

const EXCERPT_CAP = 160;
const HELPER_CAP = 40;
const SUPPORT_WINDOW = 20;

function compare(a, b) {
  const left = a || '';
  const right = b || '';
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** `<route key>.packet.json` — lower-cased, `*` spelled out, everything else a dash. */
export function sanitiseRouteKey(key) {
  return (
    String(key)
      .toLowerCase()
      .replace(/\*/g, 'star')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120) || 'route'
  );
}

/**
 * One candidate per (repo, spec, test): every request the evidence index found for that
 * trio, plus the source excerpt built from the earliest of them. `test` is `null` for a
 * request registered outside any test block — a support command names no test and gets
 * the window excerpt instead of a block excerpt. `repo` is the fact set the evidence
 * came from, and the only thing that says which checkout the spec path is relative to:
 * a Cypress spec and a Playwright spec are both repository-relative paths, in different
 * repositories, and resolving one against the other's root reads nothing.
 */
function groupCandidates(evidence, readSpec) {
  const groups = new Map();
  const order = [];
  for (const entry of evidence) {
    const test = entry.test || null;
    const key = `${entry.repo ?? ''}\0${entry.spec}\0${test ?? ''}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        repo: entry.repo ?? null,
        spec: entry.spec,
        test,
        skipped: entry.skipped,
        match: entry.match,
        intercepts: [],
      };
      groups.set(key, group);
      order.push(key);
    }
    group.intercepts.push({
      verb: entry.verb,
      pattern: entry.pattern,
      line: entry.line,
      ...(entry.via ? { via: entry.via } : {}),
    });
  }
  const list = order.map((key) => groups.get(key));
  for (const group of list) group.intercepts.sort((a, b) => a.line - b.line);
  list.sort((a, b) => compare(a.spec, b.spec) || compare(a.test || '', b.test || ''));
  for (const group of list) {
    group.excerpt = buildExcerpt(readSpec, group.repo, group.spec, group.intercepts[0].line);
    const viaHelper = group.intercepts.find((intercept) => intercept.via === 'helper');
    if (!viaHelper) continue;
    const helper = buildHelperExcerpt(readSpec, group.repo, group.spec, viaHelper.line);
    if (helper) group.helperExcerpt = helper;
  }
  return list;
}

const BLOCK_LINE = /(^|[^A-Za-z0-9_$.])(it|xit|test)(\.only|\.skip|\.fixme)?\s*\(/;

function charIndexOfLine(lines, lineNumber) {
  let index = 0;
  for (let i = 0; i < lineNumber - 1; i += 1) index += lines[i].length + 1;
  return index;
}

function lineNumberAtIndex(lines, index) {
  let cursor = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const next = cursor + lines[i].length + 1;
    if (index < next) return i + 1;
    cursor = next;
  }
  return lines.length;
}

/**
 * Scan upward from a request's line for the nearest preceding block declaration on its
 * own line — `it(`/`xit(` in a Cypress spec, `test(` in a Playwright one. Both tokens
 * are tried on every spec, so which harness wrote the file is not something the evidence
 * entry has to carry for the excerpt to be the right block.
 */
function findEnclosingBlockLine(lines, fromLine) {
  const start = Math.min(fromLine, lines.length);
  for (let ln = start; ln >= 1; ln -= 1) {
    if (BLOCK_LINE.test(lines[ln - 1])) return ln;
  }
  return null;
}

/**
 * Brace-count from a block's opening line to its closing brace, char by char, with
 * enough state to skip braces inside comments, strings and template literals — and to
 * treat a `${…}` interpolation's own braces as real code, returning to the
 * surrounding template string once that expression's closing brace is found.
 */
function walkBraces(text, startIndex) {
  let state = 'code';
  let depth = 0;
  let started = false;
  const templateReturnDepths = [];
  let i = startIndex;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (state === 'line-comment') {
      if (c === '\n') state = 'code';
      i += 1;
      continue;
    }
    if (state === 'block-comment') {
      if (c === '*' && next === '/') {
        state = 'code';
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (state === 'single' || state === 'double') {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if ((state === 'single' && c === "'") || (state === 'double' && c === '"')) state = 'code';
      i += 1;
      continue;
    }
    if (state === 'template') {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '`') {
        state = 'code';
        i += 1;
        continue;
      }
      if (c === '$' && next === '{') {
        templateReturnDepths.push(depth);
        state = 'code';
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    // state === 'code'
    if (c === '/' && next === '/') {
      state = 'line-comment';
      i += 2;
      continue;
    }
    if (c === '/' && next === '*') {
      state = 'block-comment';
      i += 2;
      continue;
    }
    if (c === "'") {
      state = 'single';
      i += 1;
      continue;
    }
    if (c === '"') {
      state = 'double';
      i += 1;
      continue;
    }
    if (c === '`') {
      state = 'template';
      i += 1;
      continue;
    }
    if (c === '{') {
      depth += 1;
      started = true;
      i += 1;
      continue;
    }
    if (c === '}') {
      depth -= 1;
      if (templateReturnDepths.length > 0 && depth === templateReturnDepths[templateReturnDepths.length - 1]) {
        templateReturnDepths.pop();
        state = 'template';
      }
      if (started && depth === 0 && templateReturnDepths.length === 0) return i;
      i += 1;
      continue;
    }
    i += 1;
  }
  return n > 0 ? n - 1 : 0;
}

/**
 * Where the block's body actually opens. `test("name", async ({ request }) => {` puts a
 * destructured parameter object before the body, and counting from the first brace on
 * the line closes the block on the parameter's own `}` — a one-line excerpt. The body
 * begins at the first brace after the callback's arrow.
 */
function bodyStartIndex(lines, blockStartLine) {
  const lineStart = charIndexOfLine(lines, blockStartLine);
  const line = lines[blockStartLine - 1] || '';
  const arrow = line.lastIndexOf('=>');
  if (arrow === -1) return lineStart;
  const brace = line.indexOf('{', arrow);
  return brace === -1 ? lineStart : lineStart + brace;
}

function findBlockEndLine(lines, blockStartLine) {
  const text = lines.join('\n');
  const endIndex = walkBraces(text, bodyStartIndex(lines, blockStartLine));
  return lineNumberAtIndex(lines, endIndex);
}

/** First `cap` lines of `startLine..endLine`, with a trailer when more were cut. */
function sliceExcerptCapped(spec, lines, startLine, endLine, cap) {
  const total = endLine - startLine + 1;
  const capped = Math.min(total, cap);
  const finalEndLine = startLine + capped - 1;
  const body = lines.slice(startLine - 1, finalEndLine).join('\n');
  const overflow = total - capped;
  const text = overflow > 0 ? `${body}\n… (${overflow} more lines)` : body;
  return { file: spec, startLine, endLine: finalEndLine, text };
}

function sliceExcerpt(spec, lines, startLine, endLine) {
  return sliceExcerptCapped(spec, lines, startLine, endLine, EXCERPT_CAP);
}

/**
 * The enclosing test block's source, located from the spec path and the line of the
 * candidate's earliest request. A support-file request — no block found scanning
 * upward — gets the 40 lines around it instead.
 */
function buildExcerpt(readSpec, repo, spec, line) {
  const source = readSpec(spec, repo);
  if (source == null) {
    return { file: spec, startLine: line, endLine: line, text: '(spec file not found)' };
  }
  const lines = source.split('\n');
  const blockStart = findEnclosingBlockLine(lines, line);
  if (blockStart !== null) {
    const endLine = findBlockEndLine(lines, blockStart);
    return sliceExcerpt(spec, lines, blockStart, Math.max(endLine, blockStart));
  }
  const windowStart = Math.max(1, line - SUPPORT_WINDOW);
  const windowEnd = Math.min(lines.length, line + SUPPORT_WINDOW - 1);
  return sliceExcerpt(spec, lines, windowStart, Math.max(windowEnd, windowStart));
}

const CALLEE = /(?:await\s+)?(?:[A-Za-z_$][\w$]*\s*=\s*)?(?:[A-Za-z_$][\w$]*\.)*([A-Za-z_$][\w$]*)\s*\(/;
const DEFINITION_CAP = 400;

/** The name of the function or method the request line calls into. */
export function calleeAt(text) {
  const match = CALLEE.exec(String(text || ''));
  if (!match) return null;
  const name = match[1];
  return /^(expect|await|return|if|for|while|switch|catch)$/.test(name) ? null : name;
}

function definitionLine(lines, name) {
  const declaration = new RegExp(
    `(^|[^A-Za-z0-9_$.])(?:async\\s+)?(?:function\\s+|const\\s+|(?:public|private|protected)\\s+(?:async\\s+)?)?${name}\\s*(?:[:=]\\s*(?:async\\s*)?\\(|\\()`,
  );
  for (let ln = 1; ln <= lines.length; ln += 1) {
    if (declaration.test(lines[ln - 1])) return ln;
  }
  return null;
}

/**
 * The body of the helper a request was resolved through. A `via: "helper"` request is a
 * call into a feature client or an assertion helper: the spec line shows the call, and
 * the promotion rule turns on what the helper itself sends and asserts, so the reader is
 * handed that body too rather than being asked to imagine it.
 */
function buildHelperExcerpt(readSpec, repo, spec, line) {
  const source = readSpec(spec, repo);
  if (source == null) return null;
  const lines = source.split('\n');
  if (line > lines.length) return null;
  const name = calleeAt(lines[line - 1]);
  if (!name) return null;
  const files = readSpec.siblings ? readSpec.siblings(spec, repo) : [];
  for (const file of files) {
    const text = readSpec(file, repo);
    if (text == null) continue;
    const body = text.split('\n');
    const start = definitionLine(body, name);
    if (start === null) continue;
    const endIndex = walkBraces(text, bodyStartIndex(body, start));
    const end = Math.min(lineNumberAtIndex(body, endIndex), start + DEFINITION_CAP);
    const excerpt = sliceExcerptCapped(file, body, start, Math.max(end, start), HELPER_CAP);
    return { name, ...excerpt };
  }
  return null;
}

/**
 * A reader over one or more checkouts: `readSpec(path, repo)` resolves the path against
 * that repository's configured root. `repos` is `{<id>: <root>}`; a bare string keeps the
 * single-root form the mobile tree used. `siblings` lists the other source files of a
 * repository, which is how a helper body is found from the spec that calls it.
 */
export function makeSpecReader(repos) {
  const roots = typeof repos === 'string' || repos == null ? { '': repos } : { ...repos };
  const fallback = typeof repos === 'string' ? repos : null;
  const rootFor = (repo) => roots[repo ?? ''] ?? fallback ?? roots[''] ?? null;
  const listings = new Map();

  const reader = (specPath, repo) => {
    const root = rootFor(repo);
    if (!root) return null;
    try {
      return readFileSync(resolve(root, specPath), 'utf8');
    } catch {
      return null;
    }
  };
  reader.siblings = (specPath, repo) => {
    const root = rootFor(repo);
    if (!root) return [];
    if (!listings.has(root)) {
      let found = [];
      try {
        found = walkSources(root, root);
      } catch {
        found = [];
      }
      listings.set(root, found);
    }
    return listings.get(root).filter((file) => file !== specPath);
  };
  return reader;
}

const SOURCE_EXTENSIONS = /\.(ts|tsx|js|mjs)$/;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'playwright-report']);

function walkSources(root, dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkSources(root, full, out);
      continue;
    }
    if (SOURCE_EXTENSIONS.test(entry.name)) out.push(relative(root, full));
  }
  return out;
}

export const PACKET_HASH_LENGTH = 12;

/**
 * The identity of this run of the packet: the route and every seed in it, by stable key
 * and by the position it was printed at. A verdict that names a seed only by `U<n>`
 * carries this hash back, and the id is trusted only while the hash still matches —
 * once a branch is added or a phantom split collapses, the numbering has moved and the
 * verdict is stale rather than silently applied to a different use case.
 */
export function packetHashOf(route, seeds) {
  const material = [route, ...seeds.map((seed) => `${seed.id}=${seed.key || ''}`)].join('\n');
  return createHash('sha1').update(material).digest('hex').slice(0, PACKET_HASH_LENGTH);
}

function buildPacket(key, walked, evidence, readSpec) {
  const seeds = (walked.seeds || []).map((seed) => ({
    id: seed.id,
    key: seed.key || null,
    dispositions: (seed.dispositions || []).map((branch) => ({
      kind: branch.kind,
      line: branch.line,
      disposition: branch.disposition,
      text: branch.text,
      ...(branch.toggle ? { toggle: branch.toggle } : {}),
      ...(branch.count > 1 ? { count: branch.count, lines: branch.lines } : {}),
    })),
    ...(seed.kind ? { kind: seed.kind } : {}),
    ...(seed.response ? { response: seed.response } : {}),
    outcomes: sinkSummary(seed),
    reads: readCount(seed),
  }));
  return {
    route: key,
    routeRef: walked.root ? walked.root.ref : key,
    file: walked.root ? walked.root.file ?? null : null,
    line: walked.root ? walked.root.line ?? null : null,
    packetHash: packetHashOf(key, seeds),
    seeds,
    candidates: groupCandidates(evidence, readSpec),
    rules: { path: LEVEL_RULES.path, disposition: LEVEL_RULES.disposition },
  };
}

/**
 * The checkout each fact set's spec paths are relative to, keyed by repository id.
 * `options.repos` is the configured repository list; `options.mobileRoot` stays as the
 * single-root form for a caller that only has the mobile tree.
 */
function specRoots(options) {
  const roots = {};
  for (const repo of options.repos || []) {
    if (repo && repo.id && repo.root) roots[repo.id] = repo.root;
  }
  if (Object.keys(roots).length > 0) {
    if (options.mobileRoot) roots[''] = options.mobileRoot;
    return roots;
  }
  return options.mobileRoot;
}

/**
 * Build one packet per area route with at least one candidate test. `options.trace`
 * replaces the walker in tests; `options.readSpec` replaces the file reader — default
 * is a real read rooted, per candidate, at the repository that fact came from.
 */
export function buildPackets(factSets, options = {}) {
  const keys = options.keys || [];
  const walker = options.trace || trace;
  const readSpec = options.readSpec || makeSpecReader(specRoots(options));
  const index = buildEvidenceIndex(factSets, { aliases: options.aliases });
  const packets = [];
  let skipped = 0;

  for (const key of keys) {
    const evidence = index.byRoute.get(key) || [];
    if (evidence.length === 0) {
      skipped += 1;
      continue;
    }
    const walked = walker(factSets, key, { ...options.traceOptions, seeds: true });
    packets.push(buildPacket(key, walked || {}, evidence, readSpec));
  }
  return { packets, written: packets.length, skipped };
}

/** `buildPackets`, then one `<dir>/<sanitised route key>.packet.json` per packet. */
export function writePackets(factSets, options = {}) {
  const result = buildPackets(factSets, options);
  if (options.outDir) {
    mkdirSync(options.outDir, { recursive: true });
    for (const packet of result.packets) {
      const target = join(options.outDir, `${sanitiseRouteKey(packet.route)}.packet.json`);
      writeFileSync(target, `${JSON.stringify(packet, null, 2)}\n`);
    }
  }
  return result;
}

/** Every `<dir>/*.verdict.json`, parsed, in filename order for a deterministic merge. */
export function readVerdicts(dir) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.verdict.json'))
    .sort();
  return files.map((name) => {
    const target = join(dir, name);
    let doc;
    try {
      doc = JSON.parse(readFileSync(target, 'utf8'));
    } catch (error) {
      throw new Error(`${target}: not valid JSON (${error.message})`);
    }
    return { file: name, doc };
  });
}

/**
 * Merge every verdict into a `cover` report, mutating seed levels in place. A verdict
 * can only move a seed's level forward (`route` -> `path` -> `disposition`); a seed
 * whose mechanical level is `none` or `skipped` never ran, so no verdict can promote
 * it; an accepted upgrade needs at least one evidence entry. A verdict naming the
 * seed's *current* level is a confirmation, not an upgrade — the reader looked and
 * chose not to promote further, and that is silent: no warning, counted as
 * `confirmed`, its evidence kept on the seed as `notes` rather than `evidence`. Only
 * an actual downgrade (a level *below* the current one) warns. Returns files read,
 * upgrades applied, confirmations, rejections by reason, and one warning line per
 * rejection.
 */
const NOMINAL_SUMMARY = 'happy path';
const TOGGLE_TOKEN = /^toggle=/;

/** The disposition vector as the report summarises it: what this seed does differently. */
function dispositionTokens(seed) {
  const text = seed && seed.dispositions ? String(seed.dispositions) : '';
  if (text === '' || text === NOMINAL_SUMMARY) return [];
  return text.split(' \u00b7 ');
}

function toggleSplit(seed) {
  const tokens = dispositionTokens(seed);
  return {
    toggles: tokens.filter((token) => TOGGLE_TOKEN.test(token)),
    rest: tokens.filter((token) => !TOGGLE_TOKEN.test(token)),
  };
}

/** The evidence a verdict entry cites, as a set of (spec, test, line) — order-free. */
function evidenceSignature(evidence) {
  return (Array.isArray(evidence) ? evidence : [])
    .map((entry) => `${entry.spec || ''}\u0000${entry.test || ''}\u0000${entry.line ?? ''}`)
    .sort()
    .join('\u0001');
}

/**
 * Seeds of one route that differ only in which feature toggles are on, promoted on the
 * same evidence.
 *
 * A test that never sets a toggle runs one of those seeds and cannot say which, so one
 * excerpt promoting all of them is one observation counted three times. The upgrade is
 * kept for the seed whose toggles are all nominal — the one the test actually ran — and
 * the variants keep the reader's reasoning as `notes`. Where the family has no
 * all-nominal member (its nominal seed was never executed) the fewest-toggle seed keeps
 * it, so the count still moves by one observation rather than by the size of the family.
 *
 * Only toggles collapse. A named-constant `if` selects between cases the request body
 * chooses — a comment or a post — so a test does distinguish those, whatever it asserts.
 */
function foldToggleVariants(route, plans) {
  const families = new Map();
  for (const plan of plans) {
    if (plan.action !== 'upgrade') continue;
    const split = toggleSplit(plan.seed);
    const key = `${split.rest.join(' \u00b7 ')}\u0001${evidenceSignature(plan.entry.evidence)}`;
    const family = families.get(key) || [];
    family.push({ plan, toggles: split.toggles.length, position: route.seeds.indexOf(plan.seed) });
    families.set(key, family);
  }
  for (const family of families.values()) {
    if (family.length < 2) continue;
    const [keeper] = family.slice().sort((a, b) => a.toggles - b.toggles || a.position - b.position);
    for (const member of family) {
      if (member === keeper) continue;
      member.plan.action = 'indistinguishable';
      member.plan.keeper = keeper.plan;
    }
  }
}

export function mergeVerdicts(report, verdictEntries) {
  const routesByKey = new Map(report.routes.map((route) => [route.key, route]));
  const summary = { files: verdictEntries.length, upgrades: 0, confirmed: 0, rejections: {}, warnings: [] };

  const reject = (reason, message) => {
    summary.rejections[reason] = (summary.rejections[reason] || 0) + 1;
    summary.warnings.push(message);
  };

  for (const { file, doc } of verdictEntries) {
    const routeKey = doc && doc.route;
    const route = routeKey ? routesByKey.get(routeKey) : undefined;
    if (!route) {
      reject('unknown-id', `${file}: unknown route "${routeKey}"`);
      continue;
    }
    const currentHash = packetHashOf(route.key, route.seeds);
    const plans = [];
    for (const entry of Array.isArray(doc.seeds) ? doc.seeds : []) {
      const named = entry.key ? `#${entry.key}` : `"${entry.id}"`;
      let seed;
      if (entry.key) {
        seed = route.seeds.find((candidate) => candidate.key === entry.key);
        if (!seed) {
          reject(
            'stale-verdict',
            `${file}: seed ${named} on "${routeKey}" is not a use case of this run — the flow changed since the packet was written`,
          );
          continue;
        }
      } else {
        if (doc.packetHash !== currentHash) {
          reject(
            'stale-verdict',
            `${file}: seed ${named} on "${routeKey}" carries no key and packet hash ${doc.packetHash || '(missing)'} is not this run's ${currentHash} — positional ids do not survive a re-extract`,
          );
          continue;
        }
        seed = route.seeds.find((candidate) => candidate.id === entry.id);
        if (!seed) {
          reject('unknown-id', `${file}: unknown seed ${named} on route "${routeKey}"`);
          continue;
        }
      }
      if (seed.state === 'none' || seed.state === 'skipped') {
        reject(
          'not-executed',
          `${file}: seed ${named} on "${routeKey}" is mechanically ${seed.state} — a reader cannot invent execution`,
        );
        continue;
      }
      const currentRank = STATE_ORDER[seed.level];
      const requestedRank = STATE_ORDER[entry.level];
      if (requestedRank !== undefined && requestedRank === currentRank) {
        plans.push({ entry, seed, named, action: 'confirm' });
        continue;
      }
      if (requestedRank === undefined || requestedRank < currentRank) {
        reject(
          'downgrade',
          `${file}: seed ${named} on "${routeKey}" requests level "${entry.level}", a downgrade from "${seed.level}"`,
        );
        continue;
      }
      if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) {
        reject(
          'missing-evidence',
          `${file}: seed ${named} on "${routeKey}" upgrade to "${entry.level}" needs at least one evidence entry`,
        );
        continue;
      }
      plans.push({ entry, seed, named, action: 'upgrade' });
    }

    foldToggleVariants(route, plans);

    for (const plan of plans) {
      if (plan.action === 'confirm') {
        plan.seed.notes = plan.entry.evidence;
        summary.confirmed += 1;
        continue;
      }
      if (plan.action === 'indistinguishable') {
        plan.seed.notes = plan.entry.evidence;
        reject(
          'toggle-indistinguishable',
          `${file}: seed ${plan.named} on "${routeKey}" differs from ${plan.keeper.named} only in feature toggles and cites the same evidence — a test that never sets a toggle cannot tell them apart`,
        );
        continue;
      }
      plan.seed.level = plan.entry.level;
      plan.seed.evidence = plan.entry.evidence;
      plan.seed.evidenceMore = 0;
      plan.seed.verdictSource = doc.reader || null;
      summary.upgrades += 1;
    }
  }

  recomputeLevels(report);
  return summary;
}
