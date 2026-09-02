/**
 * Runtime coverage join — per-`(spec, test)` line hits against branch spans.
 *
 * Static attribution (`cover`'s `playwright-status` promotion) joins a branch's stated
 * outcome status against a test's asserted HTTP status. That join has one hard ceiling:
 * an outcome-*symmetric* branch — a guard whose both arms answer the same status —
 * carries nothing to join on, so a test asserting that status cannot say which arm it
 * drove. This module closes exactly that gap with a different fact: not what status a
 * test observed, but whether the lines *inside* a branch executed while it ran.
 *
 * The input is a coverage artifact produced by a collector wrapped around the process
 * under test — a per-spec `cobertura` snapshot, or any `lcov` writer. Nothing here starts
 * a collector or runs a suite: this is the ingest and the join, and it reads whatever the
 * collector already wrote.
 *
 * The join is a line-range intersection, and the arm it names comes from *interior*
 * lines, never from the condition line. A condition line is hit on every pass through
 * the method regardless of which way the request went, so a hit there proves reach and
 * nothing else; a hit strictly inside `(line, endLine]` proves the controlled block ran.
 * That distinction is the whole mechanism — without it the join would attribute both
 * arms of every branch it saw.
 *
 * What a runtime attribution claims, exactly: the lines of that arm executed during that
 * snapshot's window. It does **not** claim the test asserted anything about the arm — a
 * hit line is not an assertion, the same caveat the `playwright-status` tier one level up
 * already carries.
 */

import { readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

import { BRANCH_DISPOSITIONS, blockDisposition } from './trace.js';

/** What `seed.verdictSource` reads when this join, and not a reader, set the level. */
export const RUNTIME_VERDICT_SOURCE = 'runtime-coverage';

/**
 * What one snapshot says about one branch.
 *
 * `block` — a line strictly inside the controlled block ran, so the request took it.
 * `other` — the condition ran and the block did not, so the request took the other way.
 * `both` — both the block and its `else` ran inside one snapshot window: two tests of
 *   one spec went different ways and a per-spec boundary cannot separate them.
 * `unreached` — the condition line itself never ran in that window.
 * `undecidable` — the branch occupies a single line, so it has no interior to observe.
 */
export const ARMS = Object.freeze(['block', 'other', 'both', 'unreached', 'undecidable']);

/** At most this many branch rows ride along in the report's runtime block. */
export const BRANCH_ROW_CAP = 200;

const XML_ENTITIES = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" });

function decodeXml(value) {
  return String(value).replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, body) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    }
    if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return Object.hasOwn(XML_ENTITIES, body) ? XML_ENTITIES[body] : whole;
  });
}

function attribute(text, name) {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(text);
  return match ? decodeXml(match[1]) : null;
}

/** Repository-relative form: forward slashes, no `./` prefix, no doubled separators. */
export function normalizePath(value) {
  return String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\.\//, '');
}

function addHit(files, file, line, hits) {
  if (!Number.isInteger(line) || line < 1) return;
  const key = normalizePath(file);
  if (!key) return;
  const lines = files.get(key) || new Map();
  lines.set(line, Math.max(lines.get(line) || 0, hits));
  files.set(key, lines);
}

/**
 * Cobertura XML into `{ files: Map<path, Map<line, hits>>, sources }`.
 *
 * Read as a token stream rather than as a document: `<class filename=...>` opens a file
 * scope and every `<line number= hits=>` until `</class>` belongs to it. One file split
 * across several `<class>` elements — partial types, or one element per type — folds
 * together, a line keeping the highest hit count any element stated for it.
 */
export function parseCobertura(xml) {
  const text = String(xml ?? '');
  const files = new Map();
  const sources = [];
  for (const match of text.matchAll(/<source>([^<]*)<\/source>/g)) {
    const source = normalizePath(decodeXml(match[1]).trim());
    if (source && !sources.includes(source)) sources.push(source);
  }
  let current = null;
  for (const match of text.matchAll(/<class\b([^>]*?)\/?>|<\/class>|<line\b([^>]*?)\/?>/g)) {
    if (match[0].startsWith('</class')) {
      current = null;
      continue;
    }
    if (match[0].startsWith('<class')) {
      current = match[0].endsWith('/>') ? null : attribute(match[1], 'filename');
      continue;
    }
    if (!current) continue;
    const number = Number.parseInt(attribute(match[2], 'number') ?? '', 10);
    const hits = Number.parseInt(attribute(match[2], 'hits') ?? '0', 10);
    addHit(files, current, number, Number.isFinite(hits) ? hits : 0);
  }
  return { files, sources };
}

/** lcov tracefile into the same shape. `SF:` opens a file, `DA:<line>,<hits>` fills it. */
export function parseLcov(text) {
  const files = new Map();
  let current = null;
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      current = line.slice(3).trim();
      continue;
    }
    if (line === 'end_of_record') {
      current = null;
      continue;
    }
    if (!current || !line.startsWith('DA:')) continue;
    const [number, hits] = line.slice(3).split(',');
    addHit(files, current, Number.parseInt(number, 10), Number.parseInt(hits ?? '0', 10) || 0);
  }
  return { files, sources: [] };
}

/** `cobertura` when the text opens an XML document, `lcov` when it names a source file. */
export function detectCoverageFormat(text) {
  const head = String(text ?? '').trimStart();
  if (head.startsWith('<')) return 'cobertura';
  if (/^SF:/m.test(head) || head.startsWith('TN:')) return 'lcov';
  return null;
}

export function parseCoverageReport(text, options = {}) {
  const format = options.format || detectCoverageFormat(text);
  if (format === 'cobertura') return { format, ...parseCobertura(text) };
  if (format === 'lcov') return { format, ...parseLcov(text) };
  throw new Error('unrecognised coverage artifact: expected cobertura XML or an lcov tracefile');
}

/** The coverage extensions a per-spec snapshot file carries, longest first. */
const REPORT_SUFFIXES = ['.cobertura.xml', '.coverage.xml', '.lcov.info', '.info', '.lcov', '.xml'];

function specNameOf(path) {
  const name = basename(normalizePath(path));
  for (const suffix of REPORT_SUFFIXES) {
    if (name.length > suffix.length && name.endsWith(suffix)) return name.slice(0, -suffix.length);
  }
  return name;
}

function looksLikeManifest(text) {
  return /^\s*\{/.test(String(text ?? ''));
}

function compare(a, b) {
  const left = a ?? '';
  const right = b ?? '';
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Read what `--runtime` names: either a manifest indexing one coverage report per spec,
 * or a single report standing for one spec on its own.
 *
 * The manifest is the artifact a per-spec collection loop writes — one entry per snapshot
 * taken at a spec boundary:
 *
 *     { "snapshots": [ { "spec": "e2e/glance.pw.ts", "test": "...", "report": "glance.cobertura.xml" } ] }
 *
 * `test` is optional: a per-spec boundary states the spec only, and a collector that can
 * snapshot between individual tests fills it in without any change here — the join is the
 * same either way, only the window narrows. `report` paths resolve against the manifest's
 * own directory, so a snapshot directory moves as one piece. A bare report file is read as
 * a one-entry manifest whose spec name is the file name with its coverage extension
 * removed, which is what a per-spec `--output <spec>.cobertura.xml` loop produces.
 */
export function readRuntimeSnapshots(path, options = {}) {
  const readFile = options.readFile || ((target) => readFileSync(target, 'utf8'));
  const target = isAbsolute(path) ? path : resolve(path);
  const text = readFile(target);
  const warnings = [];
  const entries = [];

  if (looksLikeManifest(text)) {
    let manifest;
    try {
      manifest = JSON.parse(text);
    } catch (error) {
      throw new Error(`${basename(path)}: not a readable coverage manifest (${error.message})`);
    }
    const list = Array.isArray(manifest) ? manifest : manifest.snapshots;
    if (!Array.isArray(list)) {
      throw new Error(`${basename(path)}: coverage manifest has no "snapshots" array`);
    }
    const base = dirname(target);
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') {
        warnings.push('snapshot entry is not an object, skipped');
        continue;
      }
      if (typeof entry.report !== 'string' || entry.report === '') {
        warnings.push(`snapshot "${entry.spec ?? '?'}" names no report, skipped`);
        continue;
      }
      const reportPath = isAbsolute(entry.report) ? entry.report : resolve(base, entry.report);
      let parsed;
      try {
        parsed = parseCoverageReport(readFile(reportPath), { format: entry.format || manifest.format });
      } catch (error) {
        warnings.push(`${entry.report}: ${error.message}, skipped`);
        continue;
      }
      entries.push({
        spec: String(entry.spec || specNameOf(entry.report)),
        test: entry.test === undefined || entry.test === null ? null : String(entry.test),
        report: normalizePath(entry.report),
        ...parsed,
      });
    }
  } else {
    entries.push({
      spec: specNameOf(target),
      test: null,
      report: basename(normalizePath(target)),
      ...parseCoverageReport(text),
    });
  }

  entries.sort((a, b) => compare(a.spec, b.spec) || compare(a.test, b.test) || compare(a.report, b.report));
  return { snapshots: entries, warnings };
}

/**
 * Which coverage path stands for a fact's repository-relative path.
 *
 * A collector states whatever root it ran under; facts state repository-relative paths.
 * Rather than guessing a rebase, match on suffix in both directions and prefer the most
 * specific: an exact match first, then a coverage path ending in the fact path, then a
 * fact path ending in the coverage path. Ties break lexicographically so two runs over
 * the same inputs resolve the same way, and a fact matching more than one coverage path
 * is counted as ambiguous rather than silently folded.
 */
export function resolveCoveragePath(factPath, coveragePaths) {
  const want = normalizePath(factPath);
  const tiers = [[], [], []];
  for (const candidate of coveragePaths) {
    if (candidate === want) tiers[0].push(candidate);
    else if (candidate.endsWith(`/${want}`)) tiers[1].push(candidate);
    else if (want.endsWith(`/${candidate}`)) tiers[2].push(candidate);
  }
  for (const tier of tiers) {
    if (tier.length === 0) continue;
    const sorted = [...tier].sort(compare);
    return { path: sorted[0], ambiguous: sorted.length > 1 };
  }
  return { path: null, ambiguous: false };
}

/**
 * The two dispositions a branch of this kind chooses between, reconstructed from the one
 * a seed fixed. The four multiplying kinds carry a declared pair; a discriminator branch
 * (`kind: "if"`) carries `label` against `not-label`, which is the shape the trace step's
 * own discriminator derivation emits.
 */
export function dispositionPair(kind, disposition) {
  if (Object.hasOwn(BRANCH_DISPOSITIONS, kind)) return [...BRANCH_DISPOSITIONS[kind]];
  const value = String(disposition ?? '');
  if (!value) return [];
  return value.startsWith('not-') ? [value.slice(4), value] : [value, `not-${value}`];
}

/** Branch spans from `branch_point` facts, `else` blocks paired onto the branch they close. */
export function branchSpans(factSets) {
  const byMethod = new Map();
  for (const set of factSets || []) {
    for (const item of set.facts || []) {
      if (item.type !== 'branch_point') continue;
      const key = `${set.repo || ''}|${normalizePath(item.file)}|${item.class}|${item.method}`;
      const list = byMethod.get(key) || [];
      list.push(item);
      byMethod.set(key, list);
    }
  }
  const spans = new Map();
  for (const list of byMethod.values()) {
    const ordered = [...list].sort((a, b) => a.line - b.line);
    const branches = ordered.filter((item) => item.kind !== 'else');
    const elses = new Map();
    for (const item of ordered) {
      if (item.kind !== 'else') continue;
      let owner = null;
      for (const candidate of branches) {
        const end = candidate.endLine ?? candidate.line;
        if (end < item.line && (!owner || end > (owner.endLine ?? owner.line))) owner = candidate;
      }
      if (owner) elses.set(owner, { elseLine: item.line, elseEndLine: item.endLine ?? item.line });
    }
    for (const item of branches) {
      const file = normalizePath(item.file);
      const key = `${file}:${item.line}`;
      if (spans.has(key)) continue;
      spans.set(key, {
        file,
        line: item.line,
        endLine: item.endLine ?? item.line,
        kind: item.kind,
        class: item.class,
        method: item.method,
        text: item.text,
        ...(elses.get(item) || {}),
      });
    }
  }
  return spans;
}

/**
 * Which way one snapshot took one branch. The condition line proves reach only — it runs
 * whichever way the request went — so the arm is read from interior lines alone.
 */
export function armOf(span, lines) {
  const hit = (number) => (lines ? (lines.get(number) || 0) > 0 : false);
  const anyHit = (from, to) => {
    for (let number = from; number <= to; number += 1) if (hit(number)) return true;
    return false;
  };
  const hasBlock = span.endLine > span.line;
  const hasElse = span.elseEndLine !== undefined && span.elseEndLine > span.elseLine;
  const blockHit = hasBlock && anyHit(span.line + 1, span.endLine);
  const elseHit = hasElse && anyHit(span.elseLine + 1, span.elseEndLine);
  if (blockHit && elseHit) return 'both';
  if (blockHit) return 'block';
  if (elseHit) return 'other';
  if (!hit(span.line)) return 'unreached';
  return hasBlock ? 'other' : 'undecidable';
}

function snapshotLabel(snapshot) {
  return `${snapshot.spec}\0${snapshot.test ?? ''}`;
}

/**
 * The whole join, once: every branch span against every snapshot, with the coverage-path
 * resolution done one file at a time rather than once per branch.
 */
export function buildRuntimeIndex(factSets, runtime) {
  const spans = branchSpans(factSets);
  const snapshots = runtime.snapshots || [];
  const resolved = new Map();
  let ambiguousFiles = 0;

  for (const snapshot of snapshots) {
    const coveragePaths = [...snapshot.files.keys()].sort(compare);
    const perFile = new Map();
    for (const span of spans.values()) {
      if (perFile.has(span.file)) continue;
      const match = resolveCoveragePath(span.file, coveragePaths);
      if (match.ambiguous) ambiguousFiles += 1;
      perFile.set(span.file, match.path ? snapshot.files.get(match.path) : null);
    }
    resolved.set(snapshotLabel(snapshot), perFile);
  }

  const byBranch = new Map();
  const matchedFiles = new Set();
  const seenFiles = new Set();
  for (const [key, span] of spans) {
    seenFiles.add(span.file);
    const arms = [];
    for (const snapshot of snapshots) {
      const lines = resolved.get(snapshotLabel(snapshot)).get(span.file);
      if (lines) matchedFiles.add(span.file);
      arms.push({ spec: snapshot.spec, test: snapshot.test, arm: armOf(span, lines) });
    }
    byBranch.set(key, { ...span, arms });
  }
  const unmatchedFiles = [...seenFiles].filter((file) => !matchedFiles.has(file));

  return {
    byBranch,
    snapshots: snapshots.map((snapshot) => ({
      spec: snapshot.spec,
      test: snapshot.test,
      report: snapshot.report,
      format: snapshot.format,
      files: snapshot.files.size,
    })),
    matchedFiles: [...matchedFiles].sort(compare),
    unmatchedFiles: unmatchedFiles.sort(compare),
    ambiguousFiles,
    warnings: runtime.warnings || [],
  };
}

/**
 * Does one snapshot prove this seed? Every disposition the seed fixed has to be the arm
 * that snapshot observed — one branch going the other way disproves the whole path, and a
 * branch with no span, no reach or an undecidable shape leaves it unproven rather than
 * assumed. A `both` arm is the per-spec-boundary limit stated as itself: two tests of one
 * spec went different ways and this window cannot say which one this seed belongs to.
 */
export function seedRuntimeVerdict(dispositions, index) {
  const branches = dispositions || [];
  if (branches.length === 0) return { status: 'no-branches', proofs: [] };

  const wanted = branches.map((entry) => {
    const span = index.byBranch.get(`${normalizePath(entry.file)}:${entry.line}`);
    const pair = dispositionPair(entry.kind, entry.disposition);
    const owner = blockDisposition(entry.kind, entry.text, pair);
    return { span, want: owner === entry.disposition ? 'block' : 'other' };
  });
  if (wanted.some((item) => !item.span)) return { status: 'no-span', proofs: [] };

  const windows = new Map();
  for (const arm of wanted[0].span.arms) windows.set(`${arm.spec}\0${arm.test ?? ''}`, arm);

  const proofs = [];
  let ambiguous = false;
  let reached = false;
  for (const [key, window] of windows) {
    let proven = true;
    for (const item of wanted) {
      const arm = item.span.arms.find((row) => `${row.spec}\0${row.test ?? ''}` === key);
      if (!arm || arm.arm === 'unreached' || arm.arm === 'undecidable') {
        proven = false;
        continue;
      }
      reached = true;
      if (arm.arm === 'both') {
        proven = false;
        ambiguous = true;
        continue;
      }
      if (arm.arm !== item.want) proven = false;
    }
    if (proven) proofs.push({ spec: window.spec, test: window.test });
  }

  if (proofs.length > 0) {
    proofs.sort((a, b) => compare(a.spec, b.spec) || compare(a.test, b.test));
    return { status: 'proven', proofs };
  }
  if (ambiguous) return { status: 'ambiguous', proofs: [] };
  return { status: reached ? 'contradicted' : 'unreached', proofs: [] };
}

/** The branch spans a seed was proven through, in the order it meets them. */
export function runtimeProofSpans(dispositions, index) {
  const parts = [];
  for (const entry of dispositions || []) {
    const span = index.byBranch.get(`${normalizePath(entry.file)}:${entry.line}`);
    if (!span) continue;
    parts.push(`${span.file}:${span.line}-${span.endLine}`);
  }
  return parts.join(' + ');
}

/** The one evidence line a runtime-proven seed carries in place of its route evidence. */
export function runtimeEvidenceLabel(proof, spans) {
  const where = proof.test ? `${proof.spec} :: ${proof.test}` : proof.spec;
  return `${where} — runtime line hit in ${spans}`;
}

/** The report-level block: what was ingested, what it reached, what it could not decide. */
export function runtimeSummary(index, counts) {
  const rows = [];
  for (const span of index.byBranch.values()) {
    if (!span.arms.some((arm) => arm.arm !== 'unreached')) continue;
    rows.push({
      file: span.file,
      line: span.line,
      endLine: span.endLine,
      kind: span.kind,
      class: span.class,
      method: span.method,
      arms: span.arms.map((arm) => ({ spec: arm.spec, test: arm.test, arm: arm.arm })),
    });
  }
  rows.sort((a, b) => compare(a.file, b.file) || a.line - b.line);
  return {
    snapshots: index.snapshots,
    branches: rows.slice(0, BRANCH_ROW_CAP),
    branchesTruncated: Math.max(0, rows.length - BRANCH_ROW_CAP),
    reachedBranches: rows.length,
    totalBranches: index.byBranch.size,
    matchedFiles: index.matchedFiles,
    unmatchedFiles: index.unmatchedFiles,
    ambiguousFiles: index.ambiguousFiles,
    warnings: index.warnings,
    seeds: { ...counts },
    claims:
      'a hit line proves the arm executed inside that snapshot window, never that a test asserted anything about it',
  };
}
