/**
 * The dependency view of every committed corpus, as the release branch renders it, compared
 * on every run. A change that moves the dependency view on purpose writes the golden again
 * with `--write`. A change that should leave the dependency view
 * alone has to leave these bytes alone: the source-flow work adds a label line and a `view`
 * key, and nothing else in the dependency output may move.
 *
 *   node selftest/dependency-goldens.js --write --cli <release checkout>/bin/flowtrace.js
 *   node selftest/dependency-goldens.js --check
 *   node selftest/dependency-goldens.js --check --cli <checkout>/bin/flowtrace.js
 *
 * This checkout always extracts, so every capture reads facts that carry the control
 * evidence fields; `--cli` names only the binary that renders. A golden written with the
 * release's binary therefore states what the release prints for those same facts, which is
 * the comparison a check of this checkout needs. Each corpus is copied to a temporary
 * directory and extracted there, so a capture never writes into the tracked fixture.
 *
 * One record per start holds the exit status and the sha256 of stdout and stderr for six
 * outputs: the tree, the tree with seeds, the tree with infrastructure expanded and folding
 * off, `--graph`, `--mermaid` and `--json`. A route key also records its `span` page. A
 * corpus record holds the sha1 of each fact set's facts array, so a fact change shows even
 * when a rendering happens to look the same.
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DEPENDENCY_LABEL } from '../lib/render-tree.js';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
export const GOLDEN_FILE = join(HERE, 'corpus', 'dependency-goldens.json');
const EXTRACTOR = join(REPO_ROOT, 'bin', 'flowtrace.js');

/** The corpora this golden set covers, with the configuration each is extracted under. */
export const GOLDEN_CORPORA = Object.freeze([
  { name: 'gizmo-shop', source: join(HERE, 'corpus', 'gizmo-shop'), configs: ['gizmo.config.json'] },
  { name: 'greenhouse-alerts', source: join(HERE, 'corpus', 'greenhouse-alerts'), configs: ['greenhouse.config.json'] },
  { name: 'demo-shop', source: join(REPO_ROOT, 'examples', 'demo-shop'), configs: ['flowtrace.config.json'] },
  { name: 'nursery-mobile', source: join(HERE, 'corpus', 'nursery-mobile'), configs: ['nursery.config.json'] },
  { name: 'kettle-market', source: join(HERE, 'corpus', 'kettle-market'), configs: ['kettle.config.json'] },
  { name: 'bakery-orders', source: join(HERE, 'corpus', 'bakery-orders'), configs: ['bakery.config.json'] },
  { name: 'bakery-gates', source: join(HERE, 'corpus', 'bakery-gates'), configs: ['bakery.config.json'] },
  { name: 'lantern-depot', source: join(HERE, 'corpus', 'lantern-depot'), configs: ['lantern.config.json'] },
  { name: 'orchard-routes', source: join(HERE, 'corpus', 'orchard-routes'), configs: ['orchard.config.json', 'orchard-mounted.config.json'] },
]);

/** The six outputs every start records. */
export const OUTPUTS = Object.freeze([
  { key: 'tree', args: [] },
  { key: 'treeSeeds', args: ['--seeds'] },
  { key: 'treeExpanded', args: ['--expand-infra', '--no-fold'] },
  { key: 'graph', args: ['--graph'] },
  { key: 'mermaid', args: ['--mermaid'] },
  { key: 'json', args: ['--json'] },
]);

const COMPONENT_ROLES = new Set(['page', 'container', 'component']);

/** How many CLI processes run at once: enough to hide the startup cost, few enough to stay polite. */
const CAPTURE_CONCURRENCY = 6;

function sha256(text) {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

function sha1(text) {
  return `sha1:${createHash('sha1').update(text).digest('hex')}`;
}

function run(cli, args, cwd) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  return result;
}

/**
 * One CLI run whose answer is read when it finishes. The capture runs a few of these at a
 * time: the golden set is about seven hundred processes, and serially that is over a minute
 * of waiting on nothing.
 */
function runAsync(cli, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

/** Run `worker` over `items`, at most `limit` at a time, keeping result order. */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

/**
 * The starts of one extracted corpus: every route key, every routed component, and every
 * URL a route matrix names. A route key also brings its `span` page.
 */
function startsOf(dir) {
  const routes = new Set();
  const components = new Set();
  const configs = new Map();
  const factsDir = join(dir, 'out', 'facts');
  for (const name of readdirSync(factsDir).sort()) {
    const set = JSON.parse(readFileSync(join(factsDir, name), 'utf8'));
    for (const fact of set.facts || []) {
      if (fact.type === 'route') {
        routes.add(`${fact.verb} ${fact.template}`);
        configs.set(`${fact.verb} ${fact.template}`, set.config || null);
      }
      if (fact.type === 'component' && COMPONENT_ROLES.has(fact.role)) components.add(fact.name);
    }
  }
  const starts = [];
  for (const key of [...routes].sort()) starts.push({ start: key, kind: 'route' });
  for (const name of [...components].sort()) starts.push({ start: name, kind: 'component' });
  return starts;
}

function matrixStarts(source) {
  const file = join(source, 'matrix.json');
  let document;
  try {
    document = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  return (document.rows || []).map((row) => ({ start: row.start, kind: 'matrix', config: row.config }));
}

/**
 * What a golden compares: the dependency answer without the one line that names the view
 * and the one key that declares it. Those are the only additions this work makes to the
 * dependency output, so everything else has to keep the bytes the release wrote. A JSON
 * answer is always written back in one form, so an answer with the key and one without it
 * compare on their content.
 */
function normalized(key, stdout) {
  if (key === 'json') {
    try {
      const parsed = JSON.parse(stdout);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) delete parsed.view;
      return JSON.stringify(parsed);
    } catch {
      return stdout;
    }
  }
  // The label is the first line of the tree, which the result header stands above.
  const lines = stdout.split('\n');
  const at = lines.indexOf(DEPENDENCY_LABEL);
  return at === -1 ? stdout : `${lines.slice(0, at).concat(lines.slice(at + 1)).join('\n')}`;
}

function outputRecord(key, runResult) {
  return {
    status: runResult.status,
    stdout: sha256(normalized(key, runResult.stdout || '')),
    stderr: sha256(runResult.stderr || ''),
  };
}

/** Capture one corpus rendered by one CLI: facts digests and the six outputs of every start. */
export async function captureCorpus(corpus, cli) {
  const dir = mkdtempSync(join(tmpdir(), 'flowtrace-dependency-'));
  try {
    cpSync(corpus.source, dir, { recursive: true });
    rmSync(join(dir, 'out'), { recursive: true, force: true });
    const config = corpus.configs[0];
    const extracted = run(EXTRACTOR, ['extract', '--config', config], dir);
    if (extracted.status !== 0) {
      throw new Error(`extract ${corpus.name} exited ${extracted.status}: ${extracted.stderr}`);
    }
    const factDigests = {};
    for (const name of readdirSync(join(dir, 'out', 'facts')).sort()) {
      const set = JSON.parse(readFileSync(join(dir, 'out', 'facts', name), 'utf8'));
      factDigests[name] = sha1(JSON.stringify(set.facts));
    }
    const starts = [...startsOf(dir), ...matrixStarts(corpus.source)].sort((a, b) =>
      a.start.localeCompare(b.start) || (a.config || '').localeCompare(b.config || ''),
    );
    const jobs = [];
    for (const entry of starts) {
      const args = ['trace', entry.start, '--config', entry.config || config];
      for (const output of OUTPUTS) jobs.push({ entry, output, args: [...args, ...output.args] });
      if (entry.kind === 'route') jobs.push({ entry, output: { key: 'span' }, args: ['span', entry.start, '--config', entry.config || config] });
    }
    const answers = await pool(jobs, CAPTURE_CONCURRENCY, (job) => runAsync(cli, job.args, dir));
    const byStart = new Map(starts.map((entry) => [entry, { start: entry.start, kind: entry.kind, ...(entry.config ? { config: entry.config } : {}), outputs: {} }]));
    jobs.forEach((job, index) => {
      byStart.get(job.entry).outputs[job.output.key] = outputRecord(job.output.key, answers[index]);
    });
    return { config, facts: factDigests, starts: starts.map((entry) => byStart.get(entry)) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function captureAll(cli) {
  const corpora = {};
  for (const corpus of GOLDEN_CORPORA) corpora[corpus.name] = await captureCorpus(corpus, cli);
  return { format: 'flowtrace-dependency-goldens', schemaVersion: 1, corpora };
}

/** Compare a fresh capture with the stored golden, naming every start that moved. */
export async function checkGoldens(cli = join(REPO_ROOT, 'bin', 'flowtrace.js')) {
  const golden = JSON.parse(readFileSync(GOLDEN_FILE, 'utf8'));
  const fresh = await captureAll(cli);
  const problems = [];
  for (const [name, expected] of Object.entries(golden.corpora)) {
    const actual = fresh.corpora[name];
    if (!actual) {
      problems.push(`${name}: missing from the fresh capture`);
      continue;
    }
    for (const [file, digest] of Object.entries(expected.facts)) {
      if (actual.facts[file] !== digest) problems.push(`${name}: facts ${file} moved`);
    }
    if (expected.starts.length !== actual.starts.length) {
      problems.push(`${name}: ${actual.starts.length} starts, golden has ${expected.starts.length}`);
    }
    for (const start of expected.starts) {
      const other = actual.starts.find(
        (candidate) => candidate.start === start.start && (candidate.config || '') === (start.config || ''),
      );
      if (!other) {
        problems.push(`${name}: start "${start.start}" is missing`);
        continue;
      }
      for (const [output, value] of Object.entries(start.outputs)) {
        const freshValue = other.outputs[output];
        if (!freshValue || freshValue.status !== value.status || freshValue.stdout !== value.stdout || freshValue.stderr !== value.stderr) {
          problems.push(`${name}: "${start.start}" ${output} moved`);
        }
      }
    }
  }
  return { ok: problems.length === 0, problems, fresh };
}

function cliArgument(argv) {
  const index = argv.indexOf('--cli');
  if (index === -1) return join(REPO_ROOT, 'bin', 'flowtrace.js');
  const value = argv[index + 1];
  if (!value) throw new Error('--cli requires a path to a flowtrace binary');
  return value;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const cli = cliArgument(argv);
  if (argv.includes('--write')) {
    writeFileSync(GOLDEN_FILE, `${JSON.stringify(await captureAll(cli), null, 2)}\n`);
    process.stdout.write(`wrote ${GOLDEN_FILE}\n`);
  } else if (argv.includes('--check')) {
    const result = await checkGoldens(cli);
    if (!result.ok) {
      process.stderr.write(`${result.problems.join('\n')}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write('dependency goldens match\n');
    }
  } else {
    process.stderr.write('usage: node selftest/dependency-goldens.js --write|--check [--cli <bin>]\n');
    process.exitCode = 2;
  }
}
