/**
 * The `branch_point` facts of every tracked corpus and of the worked example, written once
 * and compared on every run. A change that adds decision kinds must leave the facts of the
 * kinds it does not own exactly as they were: the same count, lines, kinds, text and end
 * lines.
 *
 *   node selftest/branch-point-baseline.js --write
 *
 * The corpus list is stored in the baseline itself, so a corpus added later never joins a
 * baseline it was not part of.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const CLI = join(REPO_ROOT, 'bin', 'flowtrace.js');
export const BASELINE_FILE = join(HERE, 'corpus', 'branch-point-baseline', 'branch-points.json');

/** The C# decision kinds a backend repository gains; the TypeScript scanner already wrote
 * `ternary` and `coalesce` for web and mobile repositories, so the filter is backend only. */
export const ADDED_BACKEND_KINDS = Object.freeze(['ternary', 'coalesce', 'predicate']);

const FIELDS = ['file', 'line', 'kind', 'class', 'method', 'text', 'endLine'];

function corpusEntries() {
  const entries = [];
  const corpusRoot = join(HERE, 'corpus');
  for (const name of readdirSync(corpusRoot).sort()) {
    let files;
    try {
      files = readdirSync(join(corpusRoot, name));
    } catch {
      continue;
    }
    for (const config of files.filter((file) => file.endsWith('.config.json')).sort()) {
      entries.push({ corpus: `selftest/corpus/${name}`, config });
    }
  }
  entries.push({ corpus: 'examples/demo-shop', config: 'flowtrace.config.json' });
  return entries;
}

function compare(a, b) {
  for (const field of FIELDS) {
    const left = a[field] ?? '';
    const right = b[field] ?? '';
    if (left < right) return -1;
    if (left > right) return 1;
  }
  return 0;
}

/** `{ repo: { kind, facts: [...] } }` for one corpus and configuration, at the code as it is now. */
export function captureBranchPoints(entry) {
  const dir = mkdtempSync(join(tmpdir(), 'flowtrace-branch-points-'));
  try {
    cpSync(join(REPO_ROOT, entry.corpus), dir, { recursive: true });
    rmSync(join(dir, 'out'), { recursive: true, force: true });
    const result = spawnSync(process.execPath, [CLI, 'extract', '--config', entry.config], {
      cwd: dir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0) throw new Error(`extract ${entry.corpus} ${entry.config} exited ${result.status}: ${result.stderr}`);
    const config = JSON.parse(readFileSync(join(dir, entry.config), 'utf8'));
    const outDir = join(dir, config.out ?? 'out', 'facts');
    const repos = {};
    for (const name of readdirSync(outDir).sort()) {
      const set = JSON.parse(readFileSync(join(outDir, name), 'utf8'));
      const facts = (set.facts || [])
        .filter((item) => item.type === 'branch_point')
        .map((item) => Object.fromEntries(FIELDS.filter((field) => field in item).map((field) => [field, item[field]])))
        .sort(compare);
      repos[set.repo] = { kind: set.kind, facts };
    }
    return repos;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function readBaseline() {
  return JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
}

/** The facts of one repository that the baseline pins: a backend repository's facts without
 * the kinds it gained, and a web or mobile repository's facts unfiltered. */
export function pinnedFacts(repo) {
  if (repo.kind !== 'backend') return repo.facts;
  return repo.facts.filter((item) => !ADDED_BACKEND_KINDS.includes(item.kind));
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes('--write')) {
  const corpora = corpusEntries().map((entry) => ({ ...entry, repos: captureBranchPoints(entry) }));
  writeFileSync(BASELINE_FILE, `${JSON.stringify({ corpora }, null, 2)}\n`);
  for (const entry of corpora) {
    const count = Object.values(entry.repos).reduce((sum, repo) => sum + repo.facts.length, 0);
    process.stdout.write(`${entry.corpus} ${entry.config}: ${count} branch points\n`);
  }
}
