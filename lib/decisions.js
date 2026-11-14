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

// Paths reach git as literal paths, never as pathspec patterns.
function git(cwd, args) {
  const result = spawnSync('git', ['--literal-pathspecs', '-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

/** stdout of a git query that may fail, or `null`: a failed query here is an answer. */
function gitOut(cwd, args) {
  const result = git(cwd, args);
  return result.status === 0 ? result.stdout : null;
}

/** stdout of a git read the listing depends on. A failure stops the run, never reads as empty. */
function gitRead(cwd, args) {
  const result = git(cwd, args);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout;
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
    const parents = lines(gitRead(tree, ['rev-list', '--parents', '-n', '1', commit]))[0].split(' ').slice(1);
    const merge = parents.length > 1;
    const commits = merge ? lines(gitRead(tree, ['rev-list', '--reverse', `${commit}^1..${commit}`])) : [commit];
    revisions.push({ id, commit, merge, commits, tree, repos });
  }
  return revisions;
}

/** NUL-separated, so git never quotes a path with a space, a quote or a non-ASCII letter. */
function changedPaths(tree, commit) {
  const out = gitRead(tree, ['diff-tree', '--root', '-r', '-m', '--first-parent', '--name-only', '--no-commit-id', '-z', commit]);
  return [...new Set(out.split('\0').filter((path) => path.length > 0))];
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
    if (line.startsWith('filename ')) files.set(current.commit, unquotePath(line.slice('filename '.length)));
    else if (line.startsWith('\t')) {
      byLine.set(current.finalLine, { commit: current.commit, origLine: current.origLine });
      current = null;
    }
  }
  for (const entry of byLine.values()) entry.origFile = files.get(entry.commit);
  return byLine;
}

/** A path as git prints it: C-quoted, with octal byte escapes, when it holds special characters. */
function unquotePath(name) {
  if (!name.startsWith('"') || !name.endsWith('"')) return name;
  const bytes = [];
  const body = name.slice(1, -1);
  const escapes = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== '\\') {
      bytes.push(...Buffer.from(body[i], 'utf8'));
      continue;
    }
    const octal = /^[0-7]{3}/.exec(body.slice(i + 1));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      i += 3;
    } else {
      bytes.push(escapes[body[i + 1]] ?? body.charCodeAt(i + 1));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * The added lines and deletion-only hunks of one file in one commit's diff against its first
 * parent. The diff names one path, so no header has to be read back as a path.
 */
function fileHunks(tree, commit, path) {
  const out = gitRead(tree, ['diff-tree', '-p', '-U0', '--root', '--no-commit-id', '-r', '--no-ext-diff', commit, '--', path]);
  const entry = { added: [], deletions: [] };
  for (const line of out.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk) continue;
    const start = Number(hunk[3]);
    const count = hunk[4] === undefined ? 1 : Number(hunk[4]);
    if (count === 0) entry.deletions.push(start);
    for (let n = start; n < start + count; n += 1) entry.added.push(n);
  }
  return entry;
}

/** Whether a `-U0` diff holds a hunk that removes lines and whose old range holds `line`. */
function removesLine(diff, line) {
  for (const row of diff.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(row);
    if (!hunk) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count > 0 && line >= start && line < start + count) return true;
  }
  return false;
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
      const check = git(touched.get(id).root, ['merge-base', '--is-ancestor', revision.commit, set.headSha]);
      if (check.status !== 0 && check.status !== 1) {
        throw new Error(`git merge-base --is-ancestor ${revision.commit} ${set.headSha} failed: ${check.stderr.trim()}`);
      }
      const ancestor = check.status === 0;
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
      blamed.set(key, parseBlame(gitRead(repo.tree, ['blame', '--porcelain', sets.get(repo.id).headSha, '--', treePath(repo, file)])));
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

  // The commit of a listed revision that replaced a line, found among the children of the
  // last commit that held it on the way to headSha, in topological order.
  const childrenOf = new Map();
  const children = (repo, last, headSha) => {
    const key = `${repo.id}\0${last}\0${headSha}`;
    if (!childrenOf.has(key)) {
      const listed = gitRead(repo.tree, ['rev-list', '--ancestry-path', '--topo-order', '--reverse', '--parents', `${last}..${headSha}`]);
      const out = [];
      for (const row of listed.split('\n')) {
        const [child, ...parents] = row.trim().split(' ');
        if (child && parents.includes(last)) out.push(child);
      }
      childrenOf.set(key, out);
    }
    return childrenOf.get(key);
  };
  const replacing = (repo, path, last, origLine, headSha) => {
    for (const child of children(repo, last, headSha)) {
      const owners = revisionsOf(repo.id, child);
      if (!owners) continue;
      if (!removesLine(gitRead(repo.tree, ['diff', '--no-ext-diff', '--no-color', '-U0', last, child, '--', path]), origLine)) continue;
      const revision = revisions.find((item) => owners.has(item.commit));
      return { commit: child, revision: revision.commit };
    }
    return null;
  };

  // Unmapped: what each read commit's own diff added or deleted that blame does not give back.
  for (const revision of revisions) {
    for (const commit of revision.commits) {
      const isMerge = revision.merge && commit === revision.commit;
      const entries = commitPaths.get(commit).filter((entry) => !entry.reason && revisionsOf(entry.repo.id, commit));
      if (isMerge || entries.length === 0) continue;
      for (const entry of entries) {
        const path = treePath(entry.repo, entry.file);
        const base = { repo: entry.repo.id, file: entry.file, revision: revision.commit, commit };
        if (!exists(entry.repo, entry.file)) {
          unmapped.push({ reason: 'file-gone', ...base });
          continue;
        }
        if (!readFiles.has(`${entry.repo.id}\0${entry.file}`)) continue;
        const hunk = fileHunks(revision.tree, commit, path);
        for (const line of hunk.deletions) unmapped.push({ reason: 'deletion-only', ...base, line });
        const kept = new Set();
        for (const blame of blameOf(entry.repo, entry.file).values()) {
          if (blame.commit === commit && blame.origFile === path) kept.add(blame.origLine);
        }
        const lost = hunk.added.filter((line) => !kept.has(line));
        if (lost.length === 0) continue;
        const headSha = sets.get(entry.repo.id).headSha;
        const last = parseBlame(gitRead(entry.repo.tree, [
          'blame', '--porcelain', '--reverse', `${commit}..${headSha}`,
          ...lost.flatMap((line) => ['-L', `${line},${line}`]), '--', path,
        ]));
        for (const line of lost) {
          const held = last.get(line) || null;
          unmapped.push({
            reason: 'changed-later',
            ...base,
            line,
            lastCommit: held ? held.commit : null,
            replacedBy: held ? replacing(entry.repo, path, held.commit, held.origLine, headSha) : null,
          });
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
    const replaced = row.replacedBy ? ` replaced by ${short(row.replacedBy.commit)} in ${short(row.replacedBy.revision)}` : '';
    return `${row.repo} ${where} ${row.reason} in ${short(row.commit)}${last}${replaced}`;
  });
  return `${out.join('\n')}\n`;
}
