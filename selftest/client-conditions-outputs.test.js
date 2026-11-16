import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareFacts } from '../lib/facts.js';
import { receiverScopedIndex } from '../lib/affected.js';
import { CLI, REPO_ROOT, runCli } from './helpers.js';

const CLIENT_TYPES = new Set(['display_condition', 'client_transfer', 'client_assignment', 'client_read', 'client_scan']);
const COMPONENT_ROLES = new Set(['page', 'container', 'component']);
const SAMPLE = 3;
const CONCURRENCY = 6;

/** Every corpus with a configuration, and the worked example. */
function targets() {
  const out = [];
  const corpus = join(REPO_ROOT, 'selftest', 'corpus');
  for (const name of readdirSync(corpus).sort()) {
    const dir = join(corpus, name);
    if (!statSync(dir).isDirectory()) continue;
    for (const config of readdirSync(dir).filter((file) => file.endsWith('.config.json')).sort()) {
      out.push({ name, dir, config });
    }
  }
  out.push({ name: 'demo-shop', dir: join(REPO_ROOT, 'examples', 'demo-shop'), config: 'flowtrace.config.json' });
  return out;
}

function runAsync(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd });
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

async function pool(items, worker) {
  const results = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, lane));
  return results;
}

function factSets(dir, out) {
  const factsDir = join(dir, out, 'facts');
  if (!existsSync(factsDir)) return [];
  return readdirSync(factsDir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => ({ file: join(factsDir, file), set: JSON.parse(readFileSync(join(factsDir, file), 'utf8')) }));
}

/** The same fact files without the five client types, and without their provider rows. */
function withoutClientFacts(dir, out) {
  let gained = 0;
  for (const { file, set } of factSets(dir, out)) {
    const kept = (set.facts || []).filter((entry) => !CLIENT_TYPES.has(entry.type));
    gained += (set.facts || []).length - kept.length;
    set.facts = kept;
    const comparison = set.provider && set.provider.comparison;
    if (comparison && typeof comparison === 'object') {
      for (const key of Object.keys(comparison)) {
        if (CLIENT_TYPES.has(key)) delete comparison[key];
        else if (comparison[key] && typeof comparison[key] === 'object') {
          for (const inner of Object.keys(comparison[key])) if (CLIENT_TYPES.has(inner)) delete comparison[key][inner];
        }
      }
    }
    writeFileSync(file, `${JSON.stringify(set, null, 2)}\n`);
  }
  return gained;
}

/**
 * An output with the fields the new facts move set aside: the fact set `digest`, each
 * identity that hashes it, the snapshot `facts`, the fact counts of the render report,
 * and each run time.
 */
const STAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;

function normalize(raw) {
  const text = raw.replace(STAMP, '-');
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return text
      .split('\n')
      .filter((line) => !/^generated:/.test(line.trim()) && !/^_?generated/i.test(line.trim()))
      .map((line) => line.replace(/\bsha256:[0-9a-f]{64}\b/g, 'sha256:-').replace(/\b[0-9a-f]{16}\b/g, '-'))
      .map((line) => line.replace(PRODUCER_ROW, '$1 n |'))
      .filter((line) => !CLIENT_TYPE_ROW.test(line))
      .join('\n');
  }
  return JSON.stringify(strip(value));
}

const CLIENT_TYPE_ROW = new RegExp(`^\\| (${[...CLIENT_TYPES].join('|')}) \\|`);
const PRODUCER_ROW = /^(\| [^|]+ \| [^|]+ \((?:extracted|external[^)]*)\) \|) \d+ \|$/;

function strip(value, parent = '') {
  if (Array.isArray(value)) return value.map((item) => strip(item, parent));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'digest') continue;
    if (key === 'identity' && parent === 'status') continue;
    if (key === 'id' && parent === 'provenance') continue;
    if (key === 'provenance' && typeof item === 'string') continue;
    if (key === 'facts' && Array.isArray(item)) continue;
    out[key] = strip(item, key);
  }
  return out;
}

function startsOf(dir, out) {
  const routes = [];
  const components = new Set();
  for (const { set } of factSets(dir, out)) {
    for (const entry of set.facts || []) {
      if (entry.type === 'route') routes.push(entry);
      if (entry.type === 'component' && COMPONENT_ROLES.has(entry.role)) components.add(entry.name);
    }
  }
  const keys = [...new Set(routes.map((route) => `${route.verb} ${route.template}`))].sort();
  return { keys, points: routes.slice(0, SAMPLE).map((route) => `${route.file}:${route.line}`), components: [...components].sort().slice(0, SAMPLE) };
}

/** The verb runs of one extracted tree; each writes into its own tree, so A and B run alike. */
function plan(config, starts) {
  const c = ['--config', config];
  const runs = [];
  for (const key of starts.keys.slice(0, SAMPLE)) {
    runs.push({ args: ['trace', key, '--json', ...c] }, { args: ['trace', key, '--seeds', ...c] });
    runs.push({ args: ['chains', key, '--json', ...c] });
    runs.push({ args: ['span', key, '--out', `ac9-span-${runs.length}.html`, ...c], file: `ac9-span-${runs.length}.html` });
  }
  for (const name of starts.components) runs.push({ args: ['trace', name, ...c] });
  for (const point of starts.points) runs.push({ args: ['routes-of', point, '--json', ...c] });
  if (starts.keys.length > 0) {
    runs.push({ args: ['cover', '--area', 'ac9-area.txt', '--json', ...c] });
    runs.push({ args: ['scope', '--area', 'ac9-area.txt', '--json', ...c] });
    runs.push({ args: ['check', '--area', 'ac9-area.txt', '--baseline', 'ac9-baseline.json', '--write-baseline', ...c], file: 'ac9-baseline.json' });
  }
  runs.push({ args: ['readiness', '--areas', 'ac9-areas.txt', '--json', ...c] });
  return runs;
}

async function outputs(dir, config, out, starts) {
  writeFileSync(join(dir, 'ac9-area.txt'), `${starts.keys.join('\n')}\n`);
  writeFileSync(join(dir, 'ac9-areas.txt'), 'all,**\n');
  const results = await pool(plan(config, starts), async (run) => {
    const result = await runAsync(run.args, dir);
    const file = run.file && existsSync(join(dir, run.file)) ? readFileSync(join(dir, run.file), 'utf8') : '';
    return { args: run.args.join(' '), status: result.status, stdout: result.stdout, stderr: result.stderr, file };
  });
  const c = ['--config', config];
  const sequential = [
    { args: ['join', ...c], file: join(out, 'flow.json') },
    { args: ['join', '--snapshot', 'ac9-snapshot.json', ...c], file: 'ac9-snapshot.json' },
    { args: ['join', '--export-edges', 'ac9-edges.json', ...c], file: 'ac9-edges.json' },
    { args: ['join', '--against', 'ac9-snapshot.json', '--json', ...c] },
    { args: ['render', ...c], file: join(out, 'report.md') },
  ];
  for (const run of sequential) {
    const result = await runAsync(run.args, dir);
    const file = run.file && existsSync(join(dir, run.file)) ? readFileSync(join(dir, run.file), 'utf8') : '';
    results.push({ args: run.args.join(' '), status: result.status, stdout: result.stdout, stderr: result.stderr, file });
  }
  const flows = join(dir, out, 'flows');
  if (existsSync(flows)) {
    for (const name of readdirSync(flows).sort()) {
      results.push({ args: `render flows/${name}`, status: 0, stdout: '', stderr: '', file: readFileSync(join(flows, name), 'utf8') });
    }
  }
  return results;
}

test('Client conditions AC-9: existing outputs keep every field but the five named kinds', { timeout: 600000 }, async (t) => {
  let compared = 0;
  let movedDigests = 0;
  for (const target of targets()) {
    const config = JSON.parse(readFileSync(join(target.dir, target.config), 'utf8'));
    const out = config.out || 'out';
    const a = mkdtempSync(join(tmpdir(), 'flowtrace-ac9-a-'));
    const b = mkdtempSync(join(tmpdir(), 'flowtrace-ac9-b-'));
    t.after(() => {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    });
    cpSync(target.dir, a, { recursive: true });
    rmSync(join(a, out), { recursive: true, force: true });
    const extracted = spawnSync(process.execPath, [CLI, 'extract', '--config', target.config], { cwd: a, encoding: 'utf8' });
    assert.equal(extracted.status, 0, `${target.name} ${target.config}: ${extracted.stderr}`);
    cpSync(a, b, { recursive: true });
    const gained = withoutClientFacts(b, out);
    const starts = startsOf(a, out);
    const [left, right] = await Promise.all([outputs(a, target.config, out, starts), outputs(b, target.config, out, starts)]);
    assert.equal(left.length, right.length);
    for (let k = 0; k < left.length; k += 1) {
      const label = `${target.name} ${target.config}: ${left[k].args}`;
      assert.equal(left[k].status, right[k].status, label);
      assert.equal(normalize(left[k].stdout), normalize(right[k].stdout), `${label} stdout`);
      assert.equal(normalize(left[k].stderr), normalize(right[k].stderr), `${label} stderr`);
      assert.equal(normalize(left[k].file), normalize(right[k].file), `${label} file`);
      compared += 1;
    }
    if (gained > 0) {
      const snapshotA = left.find((entry) => entry.args.startsWith('join --snapshot')).file;
      const snapshotB = right.find((entry) => entry.args.startsWith('join --snapshot')).file;
      assert.notEqual(snapshotA, snapshotB, `${target.name}: a set that gained facts has a new digest`);
      const edgesA = JSON.parse(left.find((entry) => entry.args.startsWith('join --export-edges')).file);
      const edgesB = JSON.parse(right.find((entry) => entry.args.startsWith('join --export-edges')).file);
      assert.notEqual(edgesA.provenance.id, edgesB.provenance.id, `${target.name}: the edge export identity moves`);
      const traced = left.find((entry) => entry.args.startsWith('trace') && entry.args.includes('--json'));
      if (traced && traced.status === 0) {
        const identityA = JSON.parse(traced.stdout).status?.identity;
        const identityB = JSON.parse(right.find((entry) => entry.args === traced.args).stdout).status?.identity;
        if (identityA !== undefined) assert.notEqual(identityA, identityB, `${target.name}: the trace identity moves`);
      }
      movedDigests += 1;
    }
  }
  assert.ok(compared > 300, `compared ${compared} outputs`);
  assert.ok(movedDigests > 5, `${movedDigests} targets gained client facts`);
});

const TEMPLATE = 'src/app/features/harbor/shore-note.component.html';
const CLASS_FILE = 'src/app/features/harbor/shore-note.component.ts';

function tidepool(t) {
  const dir = mkdtempSync(join(tmpdir(), 'flowtrace-ac9-tidepool-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(REPO_ROOT, 'selftest', 'corpus', 'tidepool-mobile'), dir, { recursive: true });
  return { dir, config: 'tidepool-mobile.config.json', facts: join(dir, 'out', 'facts', 'mobile.json') };
}

const readSet = (file) => JSON.parse(readFileSync(file, 'utf8'));

test('Client conditions AC-9: the fact count and the producer rows count the new facts', (t) => {
  const pack = tidepool(t);
  const extracted = runCli(['extract', '--config', pack.config], { cwd: pack.dir });
  assert.equal(extracted.status, 0, extracted.stderr);
  const set = readSet(pack.facts);
  const added = set.facts.filter((entry) => CLIENT_TYPES.has(entry.type)).length;
  assert.ok(added > 0 && added < set.facts.length);
  assert.match(extracted.stdout, new RegExp(`: ${set.facts.length} facts -> `));
  assert.equal(runCli(['join', '--config', pack.config], { cwd: pack.dir }).status, 0);
  const rendered = runCli(['render', '--config', pack.config], { cwd: pack.dir });
  assert.equal(rendered.status, 0, rendered.stderr);
  const report = readFileSync(join(pack.dir, 'out', 'report.md'), 'utf8');
  assert.match(report, new RegExp(`^\\| mobile \\| [^|]+ \\(extracted\\) \\| ${set.facts.length} \\|$`, 'm'));
  const comparison = compareFacts(set.facts, []);
  for (const type of CLIENT_TYPES) {
    if (set.facts.some((entry) => entry.type === type)) assert.ok(comparison[type].extracted > 0, type);
  }
});

test('Client conditions AC-9: a file whose only facts are new facts is a file the extractor read', (t) => {
  const pack = tidepool(t);
  writeFileSync(join(pack.dir, '.gitignore'), 'out/\n');
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: pack.dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q');
  git('config', 'user.email', 'selftest@example.invalid');
  git('config', 'user.name', 'flowtrace selftest');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  const template = join(pack.dir, 'mobile', TEMPLATE);
  writeFileSync(template, readFileSync(template, 'utf8').replace('still water', 'still water today'));
  git('commit', '-q', '-am', 'change the template');
  const revision = git('rev-parse', 'HEAD');
  assert.equal(runCli(['extract', '--config', pack.config], { cwd: pack.dir }).status, 0);

  const withNew = readSet(pack.facts);
  const onTemplate = withNew.facts.filter((entry) => entry.file === TEMPLATE);
  assert.ok(onTemplate.length > 0 && onTemplate.every((entry) => CLIENT_TYPES.has(entry.type)));
  const decisions = () => {
    const result = runCli(['decisions', '--revs', revision, '--json', '--config', pack.config], { cwd: pack.dir });
    assert.equal(result.status, 0, result.stderr);
    return JSON.stringify(JSON.parse(result.stdout));
  };
  const read = decisions();
  const index = receiverScopedIndex([withNew]);

  const without = { ...withNew, facts: withNew.facts.filter((entry) => !CLIENT_TYPES.has(entry.type)) };
  writeFileSync(pack.facts, `${JSON.stringify(without, null, 2)}\n`);
  const unread = decisions();
  assert.ok(!read.includes('"no-facts"'), 'decisions reads the template with blame');
  assert.ok(unread.includes('"no-facts"') && unread.includes(TEMPLATE), 'without the new facts the template is not extracted');
  assert.notEqual(index.judge(CLASS_FILE, TEMPLATE).reason, 'no-facts-for-file');
  assert.equal(receiverScopedIndex([without]).judge(CLASS_FILE, TEMPLATE).reason, 'no-facts-for-file');
});
