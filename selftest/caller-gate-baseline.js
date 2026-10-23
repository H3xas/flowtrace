/**
 * The facts of every committed corpus that has a web or mobile repository, as extracted before
 * the caller decision scanner learned its later forms and before extraction wrote gate records.
 *
 *   node selftest/caller-gate-baseline.js --write
 *   node selftest/caller-gate-baseline.js --check
 *
 * One record per fact set holds the sha1 of its facts without `branch_point` and `caller_gate`,
 * and, for a web or mobile set, the list of its `branch_point` facts. A check therefore shows a
 * changed decision fact as that fact, and any other changed fact as a changed digest. Each
 * corpus is copied to a temporary directory and extracted there, so the check never writes
 * into the tracked fixture.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asReleaseFacts } from './helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const CLI = join(REPO_ROOT, 'bin', 'flowtrace.js');
export const BASELINE_FILE = join(HERE, 'corpus', 'caller-gate-baseline.json');
const SET_ASIDE = new Set(['branch_point', 'caller_gate']);

/** Every corpus configuration that names a web or mobile repository, in a fixed order. */
export function baselineConfigs() {
  const out = [];
  const roots = [
    ...readdirSync(join(HERE, 'corpus'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, source: join(HERE, 'corpus', entry.name) })),
    { name: 'demo-shop', source: join(REPO_ROOT, 'examples', 'demo-shop') },
  ].sort((a, b) => a.name.localeCompare(b.name));
  for (const root of roots) {
    const configs = readdirSync(root.source)
      .filter((name) => name.endsWith('.config.json') || name === 'flowtrace.config.json')
      .sort();
    for (const config of configs) {
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(join(root.source, config), 'utf8'));
      } catch {
        continue;
      }
      const repos = Array.isArray(parsed.repos) ? parsed.repos : [];
      if (!repos.some((repo) => repo.kind === 'web' || repo.kind === 'mobile')) continue;
      out.push({ corpus: root.name, source: root.source, config, out: parsed.out || 'out' });
    }
  }
  return out;
}

const sha1 = (value) => createHash('sha1').update(JSON.stringify(value)).digest('hex');

export const decisionRow = (item) => [item.file, item.line, item.endLine, `${item.class}.${item.method}`, item.kind, item.text];

/** The record of one extracted fact set. */
export function setRecord(set) {
  const facts = Array.isArray(set.facts) ? set.facts : [];
  const record = { kind: set.kind, sha1: sha1(asReleaseFacts(facts).filter((item) => !SET_ASIDE.has(item.type))) };
  if (set.kind === 'web' || set.kind === 'mobile') {
    record.branchPoints = facts.filter((item) => item.type === 'branch_point').map(decisionRow);
  }
  return record;
}

/** Extracts one corpus configuration in a temporary copy and returns its fact sets by file name. */
export function extractConfig(entry) {
  const dir = mkdtempSync(join(tmpdir(), 'flowtrace-gate-baseline-'));
  try {
    cpSync(entry.source, dir, { recursive: true });
    const run = spawnSync(process.execPath, [CLI, 'extract', '--config', entry.config], { cwd: dir, encoding: 'utf8' });
    if (run.status !== 0) throw new Error(`extract ${entry.corpus}/${entry.config} exited ${run.status}: ${run.stderr}`);
    const factsDir = join(dir, entry.out, 'facts');
    const sets = {};
    if (existsSync(factsDir)) {
      for (const name of readdirSync(factsDir).filter((file) => file.endsWith('.json')).sort()) {
        sets[name] = JSON.parse(readFileSync(join(factsDir, name), 'utf8'));
      }
    }
    return sets;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The baseline of every configuration, keyed `<corpus>/<config>`, then by fact set file name. */
export function captureBaseline() {
  const out = {};
  for (const entry of baselineConfigs()) {
    const sets = extractConfig(entry);
    const records = {};
    for (const [name, set] of Object.entries(sets)) records[name] = setRecord(set);
    out[`${entry.corpus}/${entry.config}`] = records;
  }
  return out;
}

/**
 * Every difference between two baselines, one line each. A corpus added after the baseline
 * has no record to keep, so only the recorded corpora are compared.
 */
export function compareBaselines(expected, actual) {
  const problems = [];
  for (const key of Object.keys(expected).sort()) {
    const want = expected[key] || {};
    const got = actual[key] || {};
    const names = [...new Set([...Object.keys(want), ...Object.keys(got)])].sort();
    for (const name of names) {
      const a = want[name];
      const b = got[name];
      if (!a || !b) {
        problems.push(`${key} ${name}: ${a ? 'missing now' : 'new set'}`);
        continue;
      }
      if (a.sha1 !== b.sha1) problems.push(`${key} ${name}: facts other than branch_point changed`);
      const before = (a.branchPoints || []).map((row) => JSON.stringify(row));
      const after = (b.branchPoints || []).map((row) => JSON.stringify(row));
      const lost = before.filter((row) => !after.includes(row));
      const gained = after.filter((row) => !before.includes(row));
      for (const row of lost) problems.push(`${key} ${name}: lost ${row}`);
      for (const row of gained) problems.push(`${key} ${name}: gained ${row}`);
      if (lost.length === 0 && gained.length === 0 && before.join('\n') !== after.join('\n')) {
        problems.push(`${key} ${name}: branch_point order changed`);
      }
    }
  }
  return problems;
}

function main() {
  const mode = process.argv[2];
  if (mode === '--write') {
    writeFileSync(BASELINE_FILE, `${JSON.stringify(captureBaseline(), null, 2)}\n`);
    return 0;
  }
  if (mode === '--check') {
    const problems = compareBaselines(JSON.parse(readFileSync(BASELINE_FILE, 'utf8')), captureBaseline());
    for (const line of problems) process.stdout.write(`${line}\n`);
    return problems.length === 0 ? 0 : 1;
  }
  process.stderr.write('usage: node selftest/caller-gate-baseline.js --write | --check\n');
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main();
