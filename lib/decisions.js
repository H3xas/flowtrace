/**
 * The changed decisions of a set of revisions.
 *
 * A changed line is a line that `git blame` at a fact set's `headSha` gives to one of the
 * revisions, so blamed lines and fact spans read the same content. A `method_span` that
 * holds a changed line is a unit, and a `branch_point` of that unit whose own span holds a
 * changed line is a changed decision. Everything here reads fact files and git; no source
 * is parsed.
 *
 * A line a revision added that blame no longer gives back did not vanish silently: it is
 * listed as `unmapped`, with the last commit that still held it, and so is a hunk that only
 * deleted lines and a file that no longer exists at `headSha`.
 */

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { relative } from 'node:path';

import { attributeChanges } from './affected.js';

export const DECISIONS_SCHEMA_VERSION = 1;

/** Repository kinds whose fact sets carry units and decisions. */
const SOURCE_KINDS = new Set(['backend', 'web', 'mobile']);

const REV_PATTERN = /^[0-9a-f]{7,40}$/;

export class DecisionsRefusal extends Error {}

function compare(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The revision ids of one `--revs` value, lowercase, first spelling first, or `null`. */
export function parseRevs(value) {
  if (typeof value !== 'string' || value === '') return null;
  const ids = [];
  for (const entry of value.split(',')) {
    const id = entry.toLowerCase();
    if (!REV_PATTERN.test(id)) return null;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout || '' };
}

function gitOut(cwd, args) {
  const result = git(cwd, args);
  return result.status === 0 ? result.stdout : null;
}

const lines = (text) => String(text || '').split('\n').filter((line) => line.length > 0);

function realRoot(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** Each configured root's git working tree, keyed by the tree's top level. */
function workingTrees(repos) {
  const trees = new Map();
  for (const repo of repos) {
    const root = realRoot(repo.root);
    if (!root) continue;
    const top = gitOut(root, ['rev-parse', '--show-toplevel']);
    if (top === null) continue;
    const tree = realRoot(top.trim());
    if (!tree) continue;
    if (!trees.has(tree)) trees.set(tree, []);
    trees.get(tree).push({ ...repo, root, tree, prefix: relative(tree, root).split('\\').join('/') });
  }
  return trees;
}

function treePath(repo, file) {
  return repo.prefix ? `${repo.prefix}/${file}` : file;
}

/**
 * Resolve each id to one commit in one working tree and expand a merge to the commits of
 * `<rev>^1..<rev>`. An id that no tree, or more than one, holds is a refusal.
 */
function resolveRevisions(ids, trees) {
  const revisions = [];
  for (const id of ids) {
    const holders = [];
    for (const [tree, repos] of trees) {
      const out = gitOut(tree, ['rev-parse', '--verify', '--quiet', `${id}^{commit}`]);
      if (out !== null) holders.push({ tree, repos, commit: out.trim() });
    }
    if (holders.length !== 1) {
      throw new DecisionsRefusal(
        `revision ${id} resolves in ${holders.length} working trees; it must resolve in exactly one ` +
          '(--repo <id> limits the search to the working tree of one repository)',
      );
    }
    const [{ tree, repos, commit }] = holders;
    if (revisions.some((revision) => revision.commit === commit)) continue;
    const parents = lines(gitOut(tree, ['rev-list', '--parents', '-n', '1', commit]))[0].split(' ').slice(1);
    const merge = parents.length > 1;
    const commits = merge ? lines(gitOut(tree, ['rev-list', '--reverse', `${commit}^1..${commit}`])) : [commit];
    revisions.push({ id, commit, merge, commits, tree, repos });
  }
  return revisions;
}

function changedPaths(tree, commit) {
  return lines(
    gitOut(tree, ['diff-tree', '--root', '-r', '-m', '--first-parent', '--name-only', '--no-commit-id', commit]),
  );
}

/** Each path of one tree given to the configured root that holds it, with its reason. */
function attribute(paths, repos, tree) {
  const byId = new Map(repos.map((repo) => [repo.id, repo]));
  const attributed = attributeChanges(paths, repos, { root: tree, prefix: '' });
  return attributed.map((entry) => {
    if (!entry.repo) return { repo: null, file: entry.path, reason: 'no-root' };
    const repo = byId.get(entry.repo);
    if (entry.kind === 'excluded') return { repo, file: entry.path, reason: 'excluded' };
    if (!SOURCE_KINDS.has(repo.kind)) return { repo, file: entry.path, reason: 'not-source' };
    return { repo, file: entry.path, reason: null };
  });
}

/** `git blame --porcelain` into one `{ commit, origLine, origFile }` per final line. */
function parseBlame(text) {
  const byLine = new Map();
  const files = new Map();
  let current = null;
  for (const line of String(text).split('\n')) {
    const header = /^([0-9a-f]{40}) (\d+) (\d+)(?: \d+)?$/.exec(line);
    if (header) {
      current = { commit: header[1], origLine: Number(header[2]), finalLine: Number(header[3]) };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('filename ')) files.set(current.commit, line.slice('filename '.length));
    else if (line.startsWith('\t')) {
      byLine.set(current.finalLine, { commit: current.commit, origLine: current.origLine });
      current = null;
    }
  }
  for (const entry of byLine.values()) entry.origFile = files.get(entry.commit);
  return byLine;
}

/** The added lines and deletion-only hunks of one commit's diff against its first parent. */
function parseHunks(text) {
  const byFile = new Map();
  let file = null;
  for (const line of String(text).split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line === '+++ /dev/null' ? null : line.slice(6);
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk || file === null) continue;
    const start = Number(hunk[3]);
    const count = hunk[4] === undefined ? 1 : Number(hunk[4]);
    if (!byFile.has(file)) byFile.set(file, { added: [], deletions: [] });
    const entry = byFile.get(file);
    if (count === 0) entry.deletions.push(start);
    for (let n = start; n < start + count; n += 1) entry.added.push(n);
  }
  return byFile;
}

function ranges(numbers) {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const out = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out.map(([from, to]) => (from === to ? `${from}` : `${from}-${to}`)).join(', ');
}

/**
 * The decisions document for `ids`. `readFactSet(id)` returns the loaded fact set of one
 * repository, or `null` when none was written. Refusals throw `DecisionsRefusal`.
 */
export function decisions(config, ids, { repo: only, readFactSet } = {}) {
  let trees = workingTrees(config.repos || []);
  if (only) {
    const holder = [...trees].find(([, repos]) => repos.some((repo) => repo.id === only));
    if (!holder) throw new DecisionsRefusal(`--repo ${only}: no configured repository with that id is in a git working tree`);
    trees = new Map([holder]);
  }
  const revisions = resolveRevisions(ids, trees);

  // Every path each commit changed, given to its root. A source root a revision changes is
  // touched, and needs a fact set to read.
  const commitPaths = new Map();
  const touched = new Map();
  for (const revision of revisions) {
    for (const commit of revision.commits) {
      if (commitPaths.has(commit)) continue;
      const entries = attribute(changedPaths(revision.tree, commit), revision.repos, revision.tree);
      commitPaths.set(commit, entries);
      for (const entry of entries) if (entry.repo && !entry.reason) touched.set(entry.repo.id, entry.repo);
    }
  }

  const sets = new Map();
  for (const repo of [...touched.values()].sort((a, b) => compare(a.id, b.id))) {
    const set = readFactSet(repo.id);
    const problem = !set
      ? 'is missing'
      : !set.headSha
        ? 'has no headSha'
        : set.dirty === true
          ? 'was extracted from a dirty working tree'
          : null;
    if (problem) throw new DecisionsRefusal(`${repo.id}: the fact set ${problem}; run "flowtrace extract" on a clean checkout`);
    if (gitOut(repo.root, ['cat-file', '-e', `${set.headSha}^{commit}`]) === null) {
      throw new DecisionsRefusal(
        `${repo.id}: the fact set's headSha ${set.headSha} is not in its working tree; run "flowtrace extract" on a clean checkout`,
      );
    }
    sets.set(repo.id, set);
  }

  // Which revisions each repository reads: only those inside the history of its headSha.
  const revisionRepos = new Map();
  const commitRevisions = new Map();
  for (const revision of revisions) {
    const states = [];
    const repoIds = new Set();
    for (const commit of revision.commits) for (const entry of commitPaths.get(commit)) if (entry.repo && sets.has(entry.repo.id)) repoIds.add(entry.repo.id);
    for (const id of [...repoIds].sort(compare)) {
      const set = sets.get(id);
      const ancestor = git(touched.get(id).root, ['merge-base', '--is-ancestor', revision.commit, set.headSha]).status === 0;
      states.push({ repo: id, status: ancestor ? 'ancestor' : 'not-ancestor' });
      if (!ancestor) continue;
      for (const commit of revision.commits) {
        const key = `${id}\0${commit}`;
        if (!commitRevisions.has(key)) commitRevisions.set(key, new Set());
        commitRevisions.get(key).add(revision.commit);
      }
    }
    revisionRepos.set(revision.commit, states);
  }
  const revisionsOf = (repoId, commit) => commitRevisions.get(`${repoId}\0${commit}`);

  const notExtracted = new Map();
  const unmapped = [];
  const blamed = new Map();
  const noteNotExtracted = (entry, revisionCommit) => {
    const key = `${entry.repo ? entry.repo.id : ''}\0${entry.file}\0${entry.reason}`;
    if (!notExtracted.has(key)) {
      notExtracted.set(key, { repo: entry.repo ? entry.repo.id : null, file: entry.file, reason: entry.reason, revisions: new Set() });
    }
    notExtracted.get(key).revisions.add(revisionCommit);
  };
  const factFiles = new Map();
  const filesOf = (id) => {
    if (!factFiles.has(id)) factFiles.set(id, new Set(sets.get(id).facts.map((item) => item.file).filter(Boolean)));
    return factFiles.get(id);
  };
  const existsAtHead = new Map();
  const exists = (repo, file) => {
    const key = `${repo.id}\0${file}`;
    if (!existsAtHead.has(key)) {
      existsAtHead.set(key, gitOut(repo.root, ['cat-file', '-e', `${sets.get(repo.id).headSha}:${treePath(repo, file)}`]) !== null);
    }
    return existsAtHead.get(key);
  };
  const blameOf = (repo, file) => {
    const key = `${repo.id}\0${file}`;
    if (!blamed.has(key)) {
      const out = gitOut(repo.tree, ['blame', '--porcelain', sets.get(repo.id).headSha, '--', treePath(repo, file)]);
      blamed.set(key, out === null ? new Map() : parseBlame(out));
    }
    return blamed.get(key);
  };

  // The files blame reads: each changed file of a read revision that the fact set covers.
  const readFiles = new Map();
  for (const revision of revisions) {
    for (const commit of revision.commits) {
      for (const entry of commitPaths.get(commit)) {
        if (entry.reason) {
          noteNotExtracted(entry, revision.commit);
          continue;
        }
        if (!revisionsOf(entry.repo.id, commit)) continue;
        if (!exists(entry.repo, entry.file)) continue;
        if (!filesOf(entry.repo.id).has(entry.file)) {
          noteNotExtracted({ ...entry, reason: 'no-facts' }, revision.commit);
          continue;
        }
        readFiles.set(`${entry.repo.id}\0${entry.file}`, entry);
      }
    }
  }

  // Changed lines: blame at headSha gives the line to a commit of a read revision.
  const changed = new Map();
  for (const [key, entry] of readFiles) {
    const lineRevisions = new Map();
    for (const [line, blame] of blameOf(entry.repo, entry.file)) {
      const owners = revisionsOf(entry.repo.id, blame.commit);
      if (owners) lineRevisions.set(line, owners);
    }
    if (lineRevisions.size > 0) changed.set(key, { entry, lineRevisions });
  }

  // Unmapped: what each read commit's own diff added or deleted that blame does not give back.
  for (const revision of revisions) {
    for (const commit of revision.commits) {
      const isMerge = revision.merge && commit === revision.commit;
      const entries = commitPaths.get(commit).filter((entry) => !entry.reason && revisionsOf(entry.repo.id, commit));
      if (isMerge || entries.length === 0) continue;
      const hunks = parseHunks(gitOut(revision.tree, ['diff-tree', '-p', '-U0', '--root', '--no-commit-id', '-r', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', commit]) || '');
      for (const entry of entries) {
        const path = treePath(entry.repo, entry.file);
        const base = { repo: entry.repo.id, file: entry.file, revision: revision.commit, commit };
        if (!exists(entry.repo, entry.file)) {
          unmapped.push({ reason: 'file-gone', ...base });
          continue;
        }
        if (!readFiles.has(`${entry.repo.id}\0${entry.file}`)) continue;
        const hunk = hunks.get(path);
        if (!hunk) continue;
        for (const line of hunk.deletions) unmapped.push({ reason: 'deletion-only', ...base, line });
        const kept = new Set();
        for (const blame of blameOf(entry.repo, entry.file).values()) {
          if (blame.commit === commit && blame.origFile === path) kept.add(blame.origLine);
        }
        const lost = hunk.added.filter((line) => !kept.has(line));
        if (lost.length === 0) continue;
        const reverse = gitOut(entry.repo.tree, [
          'blame', '--porcelain', '--reverse', `${commit}..${sets.get(entry.repo.id).headSha}`,
          ...lost.flatMap((line) => ['-L', `${line},${line}`]), '--', path,
        ]);
        const last = reverse === null ? new Map() : parseBlame(reverse);
        for (const line of lost) {
          unmapped.push({ reason: 'changed-later', ...base, line, lastCommit: last.has(line) ? last.get(line).commit : null });
        }
      }
    }
  }

  const units = [];
  const outsideUnits = [];
  for (const { entry, lineRevisions } of changed.values()) {
    const set = sets.get(entry.repo.id);
    const spans = set.facts.filter((item) => item.type === 'method_span' && item.file === entry.file);
    const held = new Set();
    for (const span of spans) {
      const end = span.endLine ?? span.line;
      const inside = [...lineRevisions.keys()].filter((line) => line >= span.line && line <= end).sort((a, b) => a - b);
      if (inside.length === 0) continue;
      for (const line of inside) held.add(line);
      const unitRevisions = new Set(inside.flatMap((line) => [...lineRevisions.get(line)]));
      units.push({
        repo: entry.repo.id,
        file: entry.file,
        line: span.line,
        endLine: end,
        class: span.class ?? null,
        method: span.method ?? null,
        changedLines: inside,
        revisions: [...unitRevisions].sort(compare),
        decisions: unitDecisions(set, span, inside),
      });
    }
    for (const [line, owners] of lineRevisions) {
      if (held.has(line)) continue;
      outsideUnits.push({ repo: entry.repo.id, file: entry.file, line, revisions: [...owners].sort(compare) });
    }
  }

  units.sort(
    (a, b) =>
      compare(a.repo, b.repo) || compare(a.file, b.file) || a.line - b.line || a.endLine - b.endLine ||
      compare(a.class, b.class) || compare(a.method, b.method),
  );
  outsideUnits.sort((a, b) => compare(a.repo, b.repo) || compare(a.file, b.file) || a.line - b.line);
  const notExtractedRows = [...notExtracted.values()]
    .map((row) => ({ ...row, revisions: [...row.revisions].sort(compare) }))
    .sort((a, b) => compare(a.repo, b.repo) || compare(a.file, b.file) || compare(a.reason, b.reason));
  const unmappedRows = dedupeUnmapped(unmapped).sort(
    (a, b) =>
      compare(a.repo, b.repo) || compare(a.file, b.file) || compare(a.reason, b.reason) ||
      (a.line ?? 0) - (b.line ?? 0) || compare(a.commit, b.commit),
  );

  return {
    schemaVersion: DECISIONS_SCHEMA_VERSION,
    revisions: revisions.map((revision) => ({
      rev: revision.id,
      commit: revision.commit,
      merge: revision.merge,
      commits: revision.commits,
      repos: revisionRepos.get(revision.commit),
    })),
    repos: [...sets.entries()].map(([id, set]) => ({
      id,
      kind: set.kind,
      headSha: set.headSha,
      generatedFrom: set.generatedFrom ?? null,
      decisionFacts: set.facts.filter((item) => item.type === 'branch_point').length,
    })),
    units,
    outsideUnits,
    notExtracted: notExtractedRows,
    unmapped: unmappedRows,
  };
}

function dedupeUnmapped(rows) {
  const seen = new Map();
  for (const row of rows) {
    const key = [row.reason, row.repo, row.file, row.line ?? '', row.commit].join('\0');
    if (!seen.has(key)) seen.set(key, row);
  }
  return [...seen.values()];
}

/**
 * The decisions of one unit whose own span holds a changed line. An id counts repeats of one
 * kind on one line over the whole fact set, in fact order, so it never depends on which
 * revisions a run names.
 */
function unitDecisions(set, span, changedLines) {
  const end = span.endLine ?? span.line;
  const ordinal = new Map();
  const out = [];
  for (const item of set.facts) {
    if (item.type !== 'branch_point') continue;
    const base = `${set.repo}:${item.file}:${item.line}:${item.kind}`;
    const n = (ordinal.get(base) || 0) + 1;
    ordinal.set(base, n);
    if (item.file !== span.file || item.class !== span.class || item.method !== span.method) continue;
    if (item.line < span.line || item.line > end) continue;
    const itemEnd = item.endLine ?? item.line;
    if (!changedLines.some((line) => line >= item.line && line <= itemEnd)) continue;
    out.push({
      id: n === 1 ? base : `${base}#${n}`,
      kind: item.kind,
      text: item.text ?? '',
      file: item.file,
      line: item.line,
      endLine: itemEnd,
    });
  }
  return out.sort((a, b) => a.line - b.line || compare(a.kind, b.kind) || compare(a.id, b.id));
}

/** The text listing: one block per unit, then the lines that did not map to one. */
export function renderDecisions(document) {
  const short = (sha) => String(sha).slice(0, 12);
  const out = [];
  out.push(`revisions: ${document.revisions.length}`);
  for (const revision of document.revisions) {
    const states = revision.repos.map((state) => `${state.repo} ${state.status}`).join(', ');
    const expansion = revision.merge ? ` merge of ${revision.commits.map(short).join(' ')}` : '';
    out.push(`  ${short(revision.commit)}${expansion}${states ? ` (${states})` : ''}`);
  }
  out.push('');
  const total = document.units.reduce((sum, unit) => sum + unit.decisions.length, 0);
  out.push(`units: ${document.units.length}, decisions: ${total}`);
  for (const unit of document.units) {
    const name = [unit.class, unit.method].filter(Boolean).join('.');
    out.push(`${unit.repo} ${unit.file}:${unit.line}-${unit.endLine} ${name}`);
    out.push(`  changed lines: ${ranges(unit.changedLines)}; revisions: ${unit.revisions.map(short).join(', ')}`);
    for (const decision of unit.decisions) out.push(`    ${decision.id} ${decision.kind} ${decision.text}`);
  }
  const section = (title, rows, line) => {
    if (rows.length === 0) return;
    out.push('');
    out.push(`${title}: ${rows.length}`);
    for (const row of rows) out.push(`  ${line(row)}`);
  };
  section('outside units', document.outsideUnits, (row) => `${row.repo} ${row.file}:${row.line}`);
  section('not extracted', document.notExtracted, (row) => `${row.repo ?? '-'} ${row.file} ${row.reason}`);
  section('unmapped', document.unmapped, (row) => {
    const where = row.line === undefined ? row.file : `${row.file}:${row.line}`;
    const last = row.lastCommit ? ` last held in ${short(row.lastCommit)}` : '';
    return `${row.repo} ${where} ${row.reason} in ${short(row.commit)}${last}`;
  });
  return `${out.join('\n')}\n`;
}
