/**
 * Split step — a branch diff into ordered, checked commit slices.
 *
 * The grouping is a pass over paths, never a new fact type: every changed file carries a
 * **concern** (the feature package, production source, config/infra, a spec, docs) and an
 * **endpoint area** read off the path the same way `cover` and `affected` read an area
 * name — the first path segment that is neither a checkout-root segment (`src`, `tests`,
 * `docs`) nor a package segment (`clients`, `builders`). Ordering then applies one fixed
 * rule: a feature package lands before the specs that consume it, config/infra lands
 * before the tests that depend on it, and a slice never mixes a config change with a
 * test-only one.
 *
 * Caps are hard and split *inside* one area: a group over `--max-specs` spec files or
 * `--max-lines` added lines breaks into further slices of the same area rather than
 * spilling into an unrelated one, so a reviewer never gets two endpoints in one PR
 * because of arithmetic. A single file whose own added lines exceed the cap cannot be
 * split further and is emitted alone, flagged.
 *
 * Checks are per slice and reuse what already exists: the project-scoped `tsc` the
 * touched area's own `tsconfig.json` names, and the spec list `affected` selects for that
 * slice's own changed files — passed in, never re-derived here. A check that cannot run
 * degrades to `skipped` with its reason; a check that fails flags the slice in the
 * emitted script's comments rather than dropping it silently.
 *
 * `split` itself runs no mutating git command. The emitted script is inert text until a
 * person runs it, the same "outside every checkout" boundary `scaffold` and `cases` hold.
 *
 * One deliberate divergence from `affected`'s `classifyPath`: markdown is `docs` here,
 * not `config`. `affected` asks "can this select a spec" (it cannot, so it is inert
 * config); `split` asks "what commit type does this diff support", and a documentation
 * change supports exactly one.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

/** Spec files per slice before a reviewer stops reading. */
export const DEFAULT_MAX_SPECS = 10;
/** Added lines per slice before a reviewer stops reading. */
export const DEFAULT_MAX_LINES = 400;

/**
 * Exit codes: a script was produced, nothing was in the diff, a slice failed its own
 * check (the script still exists, with the failure written into it).
 */
export const EXIT = Object.freeze({ ok: 0, failed: 1, nothing: 3 });

/** Concern order is the ordering rule: package, then source, then config, then tests, then docs. */
export const CONCERN_ORDER = Object.freeze(['package', 'source', 'config', 'spec', 'docs']);

/** Path segments a feature package lives under. Overridable per call. */
export const DEFAULT_PACKAGE_DIRS = Object.freeze(['clients', 'client', 'builders', 'builder']);

const SPEC_PATTERN = /\.(spec|cy|test)\.[cm]?[jt]sx?$/i;
const CONFIG_FILE_PATTERN = /\.(config|conf)\.[cm]?[jt]sx?$/i;
const ROOT_SEGMENTS = new Set([
  'src', 'lib', 'app', 'apps', 'packages', 'tests', 'test', 'specs', 'spec',
  'docs', 'doc', 'e2e', 'automation', 'source', 'projects',
]);
const CONFIG_EXTENSIONS = new Set([
  'json', 'yml', 'yaml', 'xml', 'config', 'props', 'targets', 'csproj', 'sln',
  'toml', 'ini', 'env', 'lock', 'runsettings', 'editorconfig', 'npmrc', 'nvmrc',
]);
const CONFIG_NAMES = new Set([
  'dockerfile', 'makefile', '.editorconfig', '.gitignore', '.dockerignore', '.npmrc', '.nvmrc',
]);
const DOC_EXTENSIONS = new Set(['md', 'mdx', 'rst', 'adoc', 'txt']);

/** Commit type per concern; `package` and `source` decide between feat and fix from the diff. */
const TYPE_BY_CONCERN = Object.freeze({ config: 'chore', spec: 'test', docs: 'docs' });

/**
 * A Conventional Commit subject. Exported so a caller can assert on the same rule the
 * drafter writes to. A configured ticket prefix (`split.ticketPrefix`) goes in front of
 * this shape, separated by one space; without one the subject is exactly this shape.
 */
export const CONVENTIONAL_TITLE = /^(feat|fix|docs|test|chore|refactor|perf|build|ci)(\([a-z0-9][a-z0-9._/-]*\))?!?: \S.*$/;

/**
 * True when `title` is a Conventional Commit subject, carrying exactly the configured
 * prefix when one is configured and none when none is.
 */
export function isConventionalTitle(title, { ticketPrefix } = {}) {
  const text = String(title ?? '');
  if (ticketPrefix) {
    const lead = `${ticketPrefix} `;
    return text.startsWith(lead) && CONVENTIONAL_TITLE.test(text.slice(lead.length));
  }
  return CONVENTIONAL_TITLE.test(text);
}

function compare(a, b) {
  const left = a || '';
  const right = b || '';
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function segmentsOf(path) {
  return String(path || '').replace(/^\.\//, '').split('/').filter((segment) => segment !== '');
}

function fileName(path) {
  const segments = segmentsOf(path);
  return segments.length === 0 ? '' : segments[segments.length - 1];
}

function extensionOf(path) {
  const name = fileName(path).toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1);
}

function packageSet(packageDirs) {
  return new Set((packageDirs || DEFAULT_PACKAGE_DIRS).map((value) => String(value).toLowerCase()));
}

/**
 * The concern one path belongs to. Specs first — a spec under a package directory is
 * still a consumer, never the package — then docs, then the package, then config, and
 * production source as the remainder.
 */
export function classifyConcern(path, { packageDirs } = {}) {
  const value = String(path || '');
  if (SPEC_PATTERN.test(value)) return 'spec';
  const extension = extensionOf(value);
  if (DOC_EXTENSIONS.has(extension)) return 'docs';
  const dirs = packageSet(packageDirs);
  const segments = segmentsOf(value);
  if (segments.slice(0, -1).some((segment) => dirs.has(segment.toLowerCase()))) return 'package';
  const name = fileName(value).toLowerCase();
  if (CONFIG_NAMES.has(name)) return 'config';
  if (CONFIG_FILE_PATTERN.test(name)) return 'config';
  if (CONFIG_EXTENSIONS.has(extension)) return 'config';
  if (segments.includes('.github')) return 'config';
  return 'source';
}

function slug(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'root';
}

/**
 * The endpoint area one path belongs to: the first directory segment that is neither a
 * checkout-root segment nor a package segment. A file at the checkout root belongs to
 * area `root`, which is where repository-wide config lands.
 */
export function areaForPath(path, { packageDirs } = {}) {
  const dirs = packageSet(packageDirs);
  const segments = segmentsOf(path).slice(0, -1);
  for (const segment of segments) {
    const lower = segment.toLowerCase();
    if (ROOT_SEGMENTS.has(lower) || dirs.has(lower)) continue;
    return slug(segment);
  }
  return 'root';
}

/** The package kind one path sits under (`client`, `builder`), singular, or null. */
export function packageKind(path, { packageDirs } = {}) {
  const dirs = packageSet(packageDirs);
  for (const segment of segmentsOf(path).slice(0, -1)) {
    const lower = segment.toLowerCase();
    if (dirs.has(lower)) return lower.replace(/s$/, '');
  }
  return null;
}

function normalizeFile(entry, options) {
  const path = String(entry && entry.path ? entry.path : entry || '').replace(/^\.\//, '');
  const added = Number.isFinite(Number(entry && entry.added)) ? Math.max(0, Number(entry.added)) : 0;
  const removed = Number.isFinite(Number(entry && entry.removed)) ? Math.max(0, Number(entry.removed)) : 0;
  const status = String((entry && entry.status) || 'M').slice(0, 1).toUpperCase();
  return {
    path,
    added,
    removed,
    status,
    binary: entry && entry.binary === true,
    concern: classifyConcern(path, options),
    area: areaForPath(path, options),
  };
}

/** Group one diff's files by concern and area, in the order the slices will be emitted. */
export function groupFiles(files, options = {}) {
  const groups = new Map();
  for (const file of files) {
    const key = `${file.concern}\u0000${file.area}`;
    if (!groups.has(key)) groups.set(key, { concern: file.concern, area: file.area, files: [] });
    groups.get(key).files.push(file);
  }
  const ordered = [...groups.values()];
  for (const group of ordered) group.files.sort((a, b) => compare(a.path, b.path));
  ordered.sort(
    (a, b) => CONCERN_ORDER.indexOf(a.concern) - CONCERN_ORDER.indexOf(b.concern) || compare(a.area, b.area),
  );
  return ordered;
}

/**
 * Break one area's files into chunks under both caps, in sorted path order so a
 * sub-directory's files stay contiguous. The chunk boundary never leaves the area — an
 * over-cap area yields more slices of that area, never a slice mixing two areas. A single
 * file over the line cap cannot be split further and rides alone, flagged `overCap`.
 */
export function chunkGroup(group, { maxSpecs = DEFAULT_MAX_SPECS, maxLines = DEFAULT_MAX_LINES } = {}) {
  const chunks = [];
  let current = [];
  let specs = 0;
  let lines = 0;
  for (const file of group.files) {
    const isSpec = file.concern === 'spec';
    const wouldSpecs = specs + (isSpec ? 1 : 0);
    const wouldLines = lines + file.added;
    const overSpecs = wouldSpecs > maxSpecs;
    const overLines = wouldLines > maxLines;
    if (current.length > 0 && (overSpecs || overLines)) {
      chunks.push(current);
      current = [];
      specs = 0;
      lines = 0;
    }
    current.push(file);
    specs += isSpec ? 1 : 0;
    lines += file.added;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function verbFor(files) {
  if (files.every((file) => file.status === 'A')) return 'add';
  if (files.every((file) => file.status === 'D')) return 'remove';
  return 'update';
}

function joinPhrases(parts) {
  if (parts.length <= 1) return parts.join('');
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function packageSummary(area, files, options) {
  const counts = new Map();
  for (const file of files) {
    const kind = packageKind(file.path, options) || 'package';
    counts.set(kind, (counts.get(kind) || 0) + 1);
  }
  const parts = [...counts.entries()]
    .sort((a, b) => compare(a[0], b[0]))
    .map(([kind, count]) => (count === 1 ? kind : `${kind}s`));
  return `${verbFor(files)} ${area} ${joinPhrases(parts)}`;
}

/**
 * One imperative summary per slice, built from what the diff carries — a count, an area,
 * a file name, the package directory a file sits under — and nothing beyond it.
 */
export function summaryFor(slice, options = {}) {
  const { concern, area, files } = slice;
  const verb = verbFor(files);
  if (concern === 'package') return packageSummary(area, files, options);
  if (concern === 'spec') return `${verb} ${plural(files.length, `${area} spec`)}`;
  if (concern === 'source') return `${verb} ${plural(files.length, `${area} source file`)}`;
  if (concern === 'config') {
    return files.length === 1
      ? `${verb} ${fileName(files[0].path)}`
      : `${verb} ${plural(files.length, `${area} configuration file`)}`;
  }
  if (concern === 'docs') {
    return files.length === 1
      ? `${verb} ${fileName(files[0].path)}`
      : `${verb} ${plural(files.length, `${area} documentation file`)}`;
  }
  return `${verb} ${plural(files.length, `${area} file`)}`;
}

/** The Conventional Commit type the slice's own diff supports. */
export function typeFor(slice) {
  const fixed = TYPE_BY_CONCERN[slice.concern];
  if (fixed) return fixed;
  // A deletion adds no behaviour and fixes nothing — the only type the diff supports is chore.
  if (slice.files.every((file) => file.status === 'D')) return 'chore';
  return slice.files.some((file) => file.status === 'A') ? 'feat' : 'fix';
}

/**
 * One drafted commit subject per slice: the configured ticket prefix first when there is
 * one, then type, scope and the derived summary. A slice that is one part of a
 * cap-driven split carries its part marker, because that is the only thing
 * distinguishing two otherwise identical subjects.
 */
export function draftMessage(slice, options = {}) {
  const type = typeFor(slice);
  const scope = slice.area;
  const summary = summaryFor(slice, options);
  const part = slice.parts > 1 ? ` (${slice.part}/${slice.parts})` : '';
  const lead = options.ticketPrefix ? `${options.ticketPrefix} ` : '';
  return {
    type,
    scope,
    summary,
    title: `${lead}${type}(${scope}): ${summary}${part}`,
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function statusWord(entry) {
  if (!entry) return 'skipped';
  return entry.status || 'skipped';
}

function checkPhrase(label, entry) {
  const status = statusWord(entry);
  const reason = entry && entry.reason ? ` (${entry.reason})` : '';
  return `${label} ${status}${reason}`;
}

/**
 * The emitted script: comments carrying the slice's shape and its check verdict, then the
 * explicit `git add` paths and the drafted commit. Deterministic for a given diff — no
 * timestamp, no absolute path beyond the checkout root the caller passes.
 */
export function renderScript(result) {
  const lines = [
    '#!/usr/bin/env bash',
    `# flowtrace split — ${plural(result.counts.slices, 'slice')}, ${plural(result.counts.files, 'file')}, ` +
      `${plural(result.counts.added, 'added line')}.`,
    '# split ran nothing: this script is the only thing that commits, and only when you run it.',
    result.ticketPrefix
      ? `# Review every slice before running it, and replace ${result.ticketPrefix} with the real ticket id.`
      : '# Review every slice before running it.',
    'set -euo pipefail',
  ];
  if (result.repoRoot) {
    lines.push('', `cd ${shellQuote(result.repoRoot)}`);
  }
  for (const slice of result.slices) {
    lines.push('');
    lines.push(
      `# slice ${slice.index}/${result.counts.slices} · ${slice.concern} · ${slice.area} · ` +
        `${plural(slice.files.length, 'file')} · ${plural(slice.added, 'added line')}` +
        (slice.parts > 1 ? ` · part ${slice.part}/${slice.parts} of a cap-driven split` : ''),
    );
    lines.push(`# check: ${checkPhrase('tsc', slice.check.tsc)} · ${checkPhrase('specs', slice.check.specs)}`);
    if (slice.check.status === 'fail') {
      lines.push('# check FAILED for this slice — fix it before this boundary becomes a PR.');
    }
    if (slice.overCap) {
      lines.push('# over the line cap on one file alone — it cannot be split further.');
    }
    for (const file of slice.files) lines.push(`git add -- ${shellQuote(file.path)}`);
    lines.push(`git commit -m ${shellQuote(slice.message.title)}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** The human page: one row per slice in the emitted order, then the caps that shaped it. */
export function renderSplit(result) {
  const lines = [];
  const scope = result.repo ? `${result.repo}: ` : '';
  lines.push(
    `split ${scope}${plural(result.counts.files, 'file')} -> ${plural(result.counts.slices, 'slice')} ` +
      `(caps: ${result.caps.maxSpecs} specs, ${result.caps.maxLines} added lines)`,
  );
  if (result.slices.length === 0) {
    lines.push('  nothing to split: the diff named no file');
    return lines.join('\n');
  }
  for (const slice of result.slices) {
    lines.push(
      `  ${slice.index}. ${slice.concern}/${slice.area}  ${plural(slice.files.length, 'file')}, ` +
        `${slice.specs} spec, +${slice.added}  [${slice.check.status}]`,
    );
    lines.push(`     ${slice.message.title}`);
    for (const file of slice.files) lines.push(`       ${file.path}`);
  }
  const failed = result.slices.filter((slice) => slice.check.status === 'fail');
  if (failed.length > 0) {
    lines.push(`  ${plural(failed.length, 'slice')} failed its own check — flagged in the script, not dropped`);
  }
  return lines.join('\n');
}

/**
 * Split one diff into ordered, checked slices. `check` is a `(slice) => {tsc, specs}`
 * function; without one every slice records both checks as skipped, which is the honest
 * answer rather than an unrun pass.
 */
export function split(options = {}) {
  const {
    files = [],
    maxSpecs = DEFAULT_MAX_SPECS,
    maxLines = DEFAULT_MAX_LINES,
    packageDirs = DEFAULT_PACKAGE_DIRS,
    check = null,
    repo = null,
    repoRoot = null,
    ticketPrefix = null,
  } = options;
  const grouping = { packageDirs, ticketPrefix };
  const normalized = (files || [])
    .map((entry) => normalizeFile(entry, grouping))
    .filter((file) => file.path !== '');
  const seen = new Set();
  const unique = normalized.filter((file) => {
    if (seen.has(file.path)) return false;
    seen.add(file.path);
    return true;
  });

  const slices = [];
  for (const group of groupFiles(unique, grouping)) {
    const chunks = chunkGroup(group, { maxSpecs, maxLines });
    chunks.forEach((chunkFiles, position) => {
      const added = chunkFiles.reduce((total, file) => total + file.added, 0);
      slices.push({
        index: 0,
        concern: group.concern,
        area: group.area,
        part: position + 1,
        parts: chunks.length,
        files: chunkFiles,
        added,
        removed: chunkFiles.reduce((total, file) => total + file.removed, 0),
        specs: chunkFiles.filter((file) => file.concern === 'spec').length,
        overCap: chunkFiles.length === 1 && chunkFiles[0].added > maxLines,
        check: { status: 'skipped', tsc: null, specs: null },
        message: null,
      });
    });
  }
  slices.forEach((slice, position) => {
    slice.index = position + 1;
    slice.message = draftMessage(slice, grouping);
  });

  for (const slice of slices) {
    const outcome = check ? check(slice) : null;
    const tsc = (outcome && outcome.tsc) || { status: 'skipped', reason: 'no check runner' };
    const specs = (outcome && outcome.specs) || { status: 'skipped', reason: 'no check runner' };
    const status = tsc.status === 'fail' || specs.status === 'fail'
      ? 'fail'
      : (tsc.status === 'pass' || specs.status === 'pass' ? 'pass' : 'skipped');
    slice.check = { status, tsc, specs };
  }

  const placed = slices.reduce((total, slice) => total + slice.files.length, 0);
  if (placed !== unique.length) {
    throw new Error(`split: ${unique.length} changed files produced ${placed} placements — every path lands in exactly one slice`);
  }

  const result = {
    repo,
    repoRoot,
    ticketPrefix: ticketPrefix || null,
    caps: { maxSpecs, maxLines },
    slices,
    counts: {
      files: unique.length,
      slices: slices.length,
      added: unique.reduce((total, file) => total + file.added, 0),
      specs: unique.filter((file) => file.concern === 'spec').length,
      capSplits: slices.filter((slice) => slice.parts > 1).length,
      failed: slices.filter((slice) => slice.check.status === 'fail').length,
    },
    exit: EXIT.ok,
  };
  result.script = renderScript(result);
  if (result.counts.files === 0) result.exit = EXIT.nothing;
  else if (result.counts.failed > 0) result.exit = EXIT.failed;
  return result;
}

/**
 * The script is a proposal a person runs, never a file this tool drops into a checkout it
 * does not own — the same refusal `scaffold` and `cases` hold for their own output.
 */
export function assertOutsideRepos(target, repoRoots) {
  const out = resolve(target);
  const real = resolvedThrough(out);
  for (const root of repoRoots || []) {
    if (!root) continue;
    for (const base of new Set([resolve(root), resolvedThrough(root)])) {
      if (real === base || real.startsWith(`${base}${sep}`) || out === base || out.startsWith(`${base}${sep}`)) {
        throw new Error(`split: refusing to write inside a configured repository (${target})`);
      }
    }
  }
  return out;
}

/**
 * The path with every symlink in its existing prefix resolved. A checkout reached through
 * a link (`/var` on macOS) is the same checkout, and a guard comparing spellings rather
 * than locations would wave the write through.
 */
function resolvedThrough(target) {
  let candidate = resolve(target);
  const tail = [];
  for (;;) {
    try {
      return join(realpathSync(candidate), ...tail);
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) return resolve(target);
      tail.unshift(basename(candidate));
      candidate = parent;
    }
  }
}

/**
 * A rename's new path. `git` writes the common part once — `a/{old => new}/f.ts` — and
 * falls back to `old/f.ts => new/f.ts` when nothing is shared; both name the file the
 * slice must `git add`, which is always the right-hand side.
 */
function renamedPath(raw) {
  const braced = String(raw).match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (braced) return `${braced[1]}${braced[3]}${braced[4]}`.replace(/\/{2,}/g, '/');
  const parts = String(raw).split(' => ');
  return parts.length > 1 ? parts[parts.length - 1] : String(raw);
}

/** `git diff --numstat` rows: added, removed, path. `-` counts mark a binary file. */
export function parseNumstat(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    if (line.trim() === '') continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [added, removed, ...rest] = parts;
    rows.push({
      path: renamedPath(rest.join('\t')).trim(),
      added: added === '-' ? 0 : Number(added) || 0,
      removed: removed === '-' ? 0 : Number(removed) || 0,
      binary: added === '-' || removed === '-',
    });
  }
  return rows;
}

/** `git diff --name-status` rows: one status letter per path, renames keyed on the new path. */
export function parseNameStatus(text) {
  const status = new Map();
  for (const line of String(text || '').split('\n')) {
    if (line.trim() === '') continue;
    const parts = line.split('\t').filter((part) => part !== '');
    if (parts.length < 2) continue;
    status.set(parts[parts.length - 1].trim(), parts[0].slice(0, 1).toUpperCase());
  }
  return status;
}

function runGit(root, args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

function countLines(target) {
  try {
    const text = readFileSync(target, 'utf8');
    if (text === '') return 0;
    return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
  } catch {
    return 0;
  }
}

/**
 * The changed files of one diff with their added-line counts — what `affected`'s
 * `changedPaths` names, plus the size a cap is measured in. Untracked files are counted
 * from disk, because a whole new spec file is exactly the change a cap exists to bound.
 * `null` when the directory is not a git checkout, or git is not on PATH.
 */
export function changedStats(root, { diff, staged } = {}) {
  const args = diff ? [diff] : (staged ? ['--cached'] : ['HEAD']);
  const numstat = runGit(root, ['diff', '--numstat', ...args]);
  if (numstat === null) return null;
  const nameStatus = parseNameStatus(runGit(root, ['diff', '--name-status', ...args]) ?? '');
  const rows = parseNumstat(numstat).map((row) => ({ ...row, status: nameStatus.get(row.path) || 'M' }));
  if (!diff && !staged) {
    const untracked = String(runGit(root, ['ls-files', '--others', '--exclude-standard']) ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const known = new Set(rows.map((row) => row.path));
    for (const path of untracked) {
      if (known.has(path)) continue;
      rows.push({ path, added: countLines(join(root, path)), removed: 0, binary: false, status: 'A' });
    }
  }
  rows.sort((a, b) => compare(a.path, b.path));
  return rows;
}

/**
 * The `tsconfig.json` the slice's own files sit under: walk up from their deepest common
 * directory, stopping at the checkout root. Null when the area names none — a slice with
 * no project config has no project-scoped `tsc` to run, and says so.
 */
export function findTsconfig(root, paths) {
  const base = resolve(root || '.');
  const lists = (paths || []).map((path) => segmentsOf(path).slice(0, -1));
  if (lists.length === 0) return null;
  let common = lists[0];
  for (const list of lists.slice(1)) {
    let index = 0;
    while (index < common.length && index < list.length && common[index] === list[index]) index += 1;
    common = common.slice(0, index);
  }
  let directory = join(base, ...common);
  for (;;) {
    const candidate = join(directory, 'tsconfig.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory || !isAbsolute(directory) || directory === base || !directory.startsWith(base + sep)) {
      if (directory === base) {
        const atRoot = join(base, 'tsconfig.json');
        return existsSync(atRoot) ? atRoot : null;
      }
      return null;
    }
    directory = parent;
  }
}

/**
 * The per-slice check the ticket asks for, with both halves injected: `runTsc(project)`
 * throws on a type error, and `affectedFor(paths)` is `affected` itself, called with this
 * slice's own changed files. Either being absent is a skip with a reason, never a pass.
 */
export function createSliceCheck({ root = '.', runTsc = null, affectedFor = null, reasons = {} } = {}) {
  return (slice) => {
    const paths = slice.files.map((file) => file.path);
    let tsc = { status: 'skipped', reason: reasons.tsc || 'no tsc runner' };
    if (runTsc) {
      const project = findTsconfig(root, paths);
      if (!project) tsc = { status: 'skipped', reason: 'no tsconfig above the slice files' };
      else {
        const relative = project.startsWith(resolve(root) + sep) ? project.slice(resolve(root).length + 1) : project;
        try {
          runTsc(project);
          tsc = { status: 'pass', project: relative };
        } catch (error) {
          // A missing compiler is a check that could not run, never a slice that failed.
          tsc = error && error.code === 'ENOENT'
            ? { status: 'skipped', project: relative, reason: 'tsc unavailable' }
            : { status: 'fail', project: relative, reason: firstLine((error && error.stdout) || (error && error.message)) };
        }
      }
    }
    let specs = { status: 'skipped', reason: reasons.specs || 'no affected run' };
    if (affectedFor) {
      try {
        const report = affectedFor(paths);
        if (!report) specs = { status: 'skipped', reason: 'affected produced no report' };
        else {
          const list = (report.specs || []).map((row) => row.spec).filter(Boolean);
          specs = { status: 'pass', reason: `${plural(list.length, 'spec')} selected`, list };
        }
      } catch (error) {
        specs = { status: 'fail', reason: firstLine(error && error.message) };
      }
    }
    return { tsc, specs };
  };
}

/**
 * The project-scoped compiler, taken from the checkout's own `node_modules/.bin` walking
 * up from the project file. A checkout with no compiler installed raises ENOENT, which
 * the check records as a skip — an absent tool is never a failing slice.
 */
export function tscRunner(root) {
  const base = resolve(root);
  return (project) => {
    const binary = findExecutable(base, dirname(resolve(project)), 'tsc');
    if (!binary) {
      const error = new Error('tsc is not installed in this checkout');
      error.code = 'ENOENT';
      throw error;
    }
    execFileSync(binary, ['-p', project, '--noEmit'], {
      cwd: base,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  };
}

function findExecutable(base, from, name) {
  let directory = from;
  for (;;) {
    const candidate = join(directory, 'node_modules', '.bin', name);
    if (existsSync(candidate)) return candidate;
    if (directory === base) return null;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function firstLine(text) {
  const value = String(text || 'failed').split('\n').find((line) => line.trim() !== '') || 'failed';
  return value.trim().replace(/\s+/g, ' ').slice(0, 120);
}
