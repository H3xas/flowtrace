/**
 * Web and mobile `branch_point` facts, read from the `kiln-yard` corpus: what extraction
 * writes, that the walk and its readers do not see them, and how `cover --runtime` joins them.
 *
 * Every comparison runs one fact set twice: as extracted, and with each web and mobile
 * `branch_point` removed. The walk's status identity hashes the facts it read, so it differs
 * between the two by design; every other byte has to stay the same.
 */
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import { copyFixture, runCli } from './helpers.js';
import { BRANCH_ROW_CAP, buildRuntimeIndex, runtimeSummary } from '../lib/runtime-cover.js';

const CONFIG = 'kiln.config.json';
const PLAIN = 'plain.config.json';
const ROUTE = 'GET kiln/v1/kilns/{kilnId}/firings';
const FORMS = 'src/forms/DecisionForms.ts';
const MOBILE_FORMS = 'src/app/features/forms/decision-forms.service.ts';

function corpus(t) {
  const dir = copyFixture(t, 'kiln-yard');
  const config = JSON.parse(readFileSync(join(dir, CONFIG), 'utf8'));
  writeFileSync(join(dir, PLAIN), JSON.stringify({ ...config, out: 'out-plain' }));
  const run = (args, configFile = CONFIG) => runCli([...args, '--config', configFile], { cwd: dir });
  const extracted = run(['extract']);
  assert.equal(extracted.status, 0, extracted.stderr);
  mkdirSync(join(dir, 'out-plain', 'facts'), { recursive: true });
  for (const name of readdirSync(join(dir, 'out', 'facts'))) {
    const set = JSON.parse(readFileSync(join(dir, 'out', 'facts', name), 'utf8'));
    if (set.kind === 'web' || set.kind === 'mobile') set.facts = set.facts.filter((item) => item.type !== 'branch_point');
    writeFileSync(join(dir, 'out-plain', 'facts', name), JSON.stringify(set, null, 2));
  }
  writeFileSync(join(dir, 'area.txt'), `${ROUTE}\n`);
  const facts = (repo) => JSON.parse(readFileSync(join(dir, 'out', 'facts', `${repo}.json`), 'utf8')).facts;
  return { dir, run, facts };
}

const decisionsOf = (facts, file) =>
  facts
    .filter((item) => item.type === 'branch_point' && item.file === file)
    .map((item) => [item.line, item.endLine, `${item.class}.${item.method}`, item.kind, item.text]);

const FORM_FACTS = [
  [9, 11, 'DecisionForms.branches', 'if', 'if (entry.open)'],
  [11, 13, 'DecisionForms.branches', 'else', "else if (mode === 'all')"],
  [11, 13, 'DecisionForms.branches', 'if', "if (mode === 'all')"],
  [13, 15, 'DecisionForms.branches', 'else', 'else'],
  [19, 19, 'DecisionForms.single', 'if', 'if (entry.pinned)'],
  [20, 20, 'DecisionForms.single', 'else', 'else'],
  [24, 32, 'DecisionForms.clauses', 'switch', 'switch (kind)'],
  [25, 26, 'DecisionForms.clauses', 'case', "case 'a':"],
  [27, 27, 'DecisionForms.clauses', 'case', "case 'b':"],
  [28, 29, 'DecisionForms.clauses', 'case', "case 'c':"],
  [30, 31, 'DecisionForms.clauses', 'case', 'default:'],
  [36, 36, 'DecisionForms.expressions', 'ternary', "entry.ready ? 'ready' : 'waiting'"],
  [37, 37, 'DecisionForms.expressions', 'coalesce', "entry.owner ?? 'nobody'"],
  [38, 38, 'DecisionForms.expressions', 'logical', 'entry.open && entry.total > 0'],
  [39, 39, 'DecisionForms.expressions', 'logical', '(entry.open && entry.pinned) || entry.ready'],
  [40, 40, 'DecisionForms.expressions', 'logical', 'item.open || item.pinned'],
  [41, 41, 'DecisionForms.expressions', 'ternary', 'entry.total ?.5 : 1'],
  [42, 44, 'DecisionForms.expressions', 'ternary', "entry.total > 9 ? 'high' : 'low'"],
  [49, 51, 'DecisionForms.conditions', 'if', 'if (entry.open && list.some((item) => item.ready && item.total > 0))'],
  [49, 49, 'DecisionForms.conditions', 'logical', 'item.ready && item.total > 0'],
  [58, 58, 'DecisionForms.conditions', 'ternary', 'entry.open && entry.pinned ? 2 : 3'],
];

test('Caller decisions AC-1: web extraction writes one branch_point per decision inside a method body', (t) => {
  const env = corpus(t);
  const web = env.facts('web');
  assert.deepEqual(decisionsOf(web, FORMS), FORM_FACTS);

  assert.deepEqual(decisionsOf(web, 'src/forms/FormsPanel.tsx'), [
    [5, 5, 'FormsPanel.close', 'if', 'if (open)'],
    [10, 10, 'FormsPanel.FormsPanel', 'logical', 'open && <span>open</span>'],
    [11, 11, 'FormsPanel.FormsPanel', 'ternary', 'rows.length > 0 ? <b>many</b> : <i>none?</i>'],
    [12, 12, 'FormsPanel.FormsPanel', 'ternary', "open ? 'Close' : 'Open'"],
  ]);

  const source = readFileSync(join(env.dir, 'web', FORMS), 'utf8').split('\n');
  const lineOf = (needle) => source.findIndex((line) => line.includes(needle)) + 1;
  const quiet = web.find((item) => item.type === 'method_span' && item.file === FORMS && item.method === 'quiet');
  const inQuiet = web.filter((item) => item.type === 'branch_point' && item.line >= quiet.line && item.line <= quiet.endLine);
  assert.deepEqual(inQuiet, [], 'strings, templates, comments, regex literals, optional chaining, logical assignments and type syntax give no decision');
  const outside = [lineOf("private mode = OPEN"), lineOf('export const LIMIT'), lineOf('return x ? 1 : 2;')];
  for (const line of outside) {
    assert.equal(web.some((item) => item.type === 'branch_point' && item.file === FORMS && item.line === line), false, `line ${line} is outside every method_span`);
  }

  const spans = web.filter((item) => item.type === 'method_span' && item.file === FORMS);
  for (const item of web.filter((entry) => entry.type === 'branch_point')) {
    const holders = web.filter((span) => span.type === 'method_span' && span.file === item.file && span.line <= item.line && item.line <= span.endLine);
    const innermost = holders.sort((a, b) => (a.endLine - a.line) - (b.endLine - b.line))[0];
    assert.deepEqual([item.class, item.method], [innermost.class, innermost.method], `${item.file}:${item.line}`);
  }
  assert.ok(spans.length > 0);
});

test('Caller decisions AC-2: the same forms in a mobile class give the same facts', (t) => {
  const env = corpus(t);
  const mobile = env.facts('mobile');
  assert.deepEqual(decisionsOf(mobile, MOBILE_FORMS), FORM_FACTS);
  assert.deepEqual(decisionsOf(mobile, 'src/app/features/tally/tally.service.ts'), [
    [13, 15, 'TallyService.pick', 'if', 'if (entry.open)'],
  ]);
});

/** Parsed JSON with every walk status identity set aside, and the identities it held. */
function withoutIdentity(text) {
  const identities = [];
  const strip = (value) => {
    if (Array.isArray(value)) return value.map(strip);
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === 'identity' && 'schemaVersion' in value && 'traversal' in value) {
        identities.push(item);
        continue;
      }
      out[key] = strip(item);
    }
    return out;
  };
  return { value: strip(JSON.parse(text)), identities };
}

function same(env, args, { json = false } = {}) {
  const withFacts = env.run(args);
  const plain = env.run(args, PLAIN);
  assert.equal(withFacts.status, 0, withFacts.stderr);
  assert.equal(plain.status, 0, plain.stderr);
  if (!json) {
    assert.equal(withFacts.stdout, plain.stdout, args.join(' '));
    return withFacts;
  }
  const left = withoutIdentity(withFacts.stdout);
  const right = withoutIdentity(plain.stdout);
  assert.deepEqual(left.value, right.value, args.join(' '));
  assert.ok(left.identities.length > 0, `${args.join(' ')} states an identity`);
  assert.notDeepEqual(left.identities, right.identities, `${args.join(' ')}: the two runs read different facts`);
  return withFacts;
}

function lcov(records) {
  return records.map(([file, lines]) => `SF:${file}\n${lines.map((line) => `DA:${line},1`).join('\n')}\nend_of_record\n`).join('');
}

test('Caller decisions AC-3: caller facts leave trace, span and cover as they were', (t) => {
  const env = corpus(t);
  for (const start of ['LedgerService', 'TallyService', 'KilnPanel', ROUTE]) {
    same(env, ['trace', start]);
    same(env, ['trace', start, '--mermaid']);
    same(env, ['trace', start, '--json'], { json: true });
    same(env, ['trace', start, '--graph'], { json: true });
  }
  const tree = same(env, ['trace', 'LedgerService']).stdout;
  assert.doesNotMatch(tree, /LedgerService\.pick/, 'a method that holds only a decision is no child of its class start');
  assert.ok(env.facts('web').some((item) => item.type === 'branch_point' && item.method === 'pick'));
  assert.doesNotMatch(same(env, ['trace', 'TallyService']).stdout, /TallyService\.pick/);

  same(env, ['span', '--from-component', 'KilnPanel', '--json'], { json: true });
  const pageOf = (configFile) => {
    const out = join(env.dir, `${configFile}.html`);
    assert.equal(env.run(['span', ROUTE, '--out', out], configFile).status, 0);
    return readFileSync(out, 'utf8');
  };
  assert.equal(pageOf(CONFIG), pageOf(PLAIN));

  same(env, ['cover', '--area', 'area.txt']);
  same(env, ['cover', '--area', 'area.txt', '--json']);

  writeFileSync(join(env.dir, 'backend.lcov'), lcov([
    ['backend/src/Controllers/KilnController.cs', [19, 20, 24]],
    ['backend/src/Services/FiringService.cs', [14, 15, 17, 23]],
  ]));
  const runtime = ['cover', '--area', 'area.txt', '--json', '--runtime', 'backend.lcov'];
  const withFacts = env.run(runtime);
  const plain = env.run(runtime, PLAIN);
  assert.equal(withFacts.status, 0, withFacts.stderr);
  const left = withoutIdentity(withFacts.stdout).value;
  const right = withoutIdentity(plain.stdout).value;
  const skipped = left.runtime.warnings.filter((warning) => !right.runtime.warnings.includes(warning));
  assert.deepEqual(skipped.map((warning) => warning.split(':')[0]), ['mobile', 'web']);
  left.runtime.warnings = right.runtime.warnings;
  assert.deepEqual(left, right);
  const extraLines = withFacts.stderr.split('\n').filter((line) => !plain.stderr.split('\n').includes(line));
  assert.equal(extraLines.length, 2);
  for (const warning of skipped) assert.ok(extraLines.some((line) => line.endsWith(`runtime: ${warning}`)), warning);
});

function runtimeReport(env, records, configFile = CONFIG) {
  const manifest = { snapshots: records.map(([spec, rows], index) => ({ spec, report: `snap-${index}.lcov` })) };
  records.forEach(([, rows], index) => writeFileSync(join(env.dir, `snap-${index}.lcov`), lcov(rows)));
  writeFileSync(join(env.dir, 'runtime.json'), JSON.stringify(manifest));
  const result = env.run(['cover', '--area', 'area.txt', '--json', '--runtime', 'runtime.json'], configFile);
  assert.equal(result.status, 0, result.stderr);
  return { report: JSON.parse(result.stdout), stderr: result.stderr };
}

const webForms = `web/${FORMS}`;

test('Caller decisions AC-11: web decisions join line coverage like backend decisions', (t) => {
  const env = corpus(t);
  const records = [
    ['if-only.spec.ts', [[webForms, [9, 10, 36]]]],
    ['else-only.spec.ts', [[webForms, [9, 11, 12]]]],
    ['both.spec.ts', [[webForms, [9, 10, 11, 12]]]],
  ];
  const { report } = runtimeReport(env, records);
  const rows = report.runtime.branches.filter((row) => row.file === FORMS);
  const row = (line) => rows.find((entry) => entry.line === line);
  for (const entry of rows) {
    assert.deepEqual(Object.keys(entry), ['file', 'line', 'endLine', 'kind', 'class', 'method', 'arms']);
  }
  const arms = (entry) => Object.fromEntries(entry.arms.map((arm) => [arm.spec, arm.arm]));
  assert.deepEqual([row(9).kind, row(9).endLine, arms(row(9))], ['if', 10, { 'if-only.spec.ts': 'block', 'else-only.spec.ts': 'other', 'both.spec.ts': 'both' }]);
  assert.deepEqual([row(11).kind, row(11).endLine, arms(row(11))], ['if', 12, { 'if-only.spec.ts': 'unreached', 'else-only.spec.ts': 'block', 'both.spec.ts': 'block' }]);
  assert.deepEqual([row(36).kind, arms(row(36))], ['ternary', { 'if-only.spec.ts': 'undecidable', 'else-only.spec.ts': 'unreached', 'both.spec.ts': 'unreached' }]);
  assert.equal(row(37), undefined, 'a decision whose line never ran is not listed');

  const web = env.facts('web').filter((item) => item.type === 'branch_point' && item.kind !== 'else');
  const backend = env.facts('backend').filter((item) => item.type === 'branch_point' && item.kind !== 'else');
  const keys = (list) => new Set(list.map((item) => `${item.file}:${item.line}`)).size;
  assert.equal(report.runtime.totalBranches, keys(web) + keys(backend));
  assert.equal(report.runtime.reachedBranches, rows.length);
  assert.deepEqual(rows.map((entry) => entry.line), [9, 11, 36]);

  const plain = runtimeReport(env, records, PLAIN).report;
  assert.deepEqual(report.runtime.seeds, plain.runtime.seeds);
  const seedLevels = (doc) => doc.routes.map((route) => route.seeds.map((seed) => [seed.key, seed.level, seed.verdictSource ?? null]));
  assert.deepEqual(seedLevels(report), seedLevels(plain));
});

test('Caller decisions AC-12: a caller repository no snapshot covers is skipped with one warning', (t) => {
  const env = corpus(t);
  const { report, stderr } = runtimeReport(env, [['api.spec.ts', [['backend/src/Services/FiringService.cs', [14, 15]]]]]);
  const backend = env.facts('backend').filter((item) => item.type === 'branch_point' && item.kind !== 'else');
  assert.equal(report.runtime.totalBranches, new Set(backend.map((item) => `${item.file}:${item.line}`)).size);
  assert.ok(report.runtime.branches.every((row) => row.file.endsWith('.cs')));
  assert.ok(report.runtime.unmatchedFiles.every((file) => file.endsWith('.cs')));
  const webCount = env.facts('web').filter((item) => item.type === 'branch_point').length;
  const mobileCount = env.facts('mobile').filter((item) => item.type === 'branch_point').length;
  const expected = [
    `mobile: no coverage snapshot matches a file of this mobile repository, so its ${mobileCount} decisions are left out`,
    `web: no coverage snapshot matches a file of this web repository, so its ${webCount} decisions are left out`,
  ];
  assert.deepEqual(report.runtime.warnings, expected);
  for (const warning of expected) assert.equal(stderr.split('\n').filter((line) => line === `runtime: ${warning}`).length, 1);

  const covered = runtimeReport(env, [['ui.spec.ts', [['web/src/ledger/LedgerService.ts', [5]]]]]).report;
  assert.ok(!covered.runtime.warnings.some((warning) => warning.startsWith('web:')), 'a snapshot that holds one file of the repository lets it take part');
  assert.ok(covered.runtime.unmatchedFiles.includes(FORMS));
});

test('Caller decisions AC-12: backend rows sort first, so the row cap drops caller rows first', () => {
  const decision = (file, line) => ({ type: 'branch_point', file, line, endLine: line, class: 'C', method: 'm', kind: 'if', text: 'if (x)' });
  const backendFacts = [];
  const webFacts = [];
  for (let n = 1; n <= 150; n += 1) {
    backendFacts.push(decision(`z/Backend${n % 3}.cs`, n));
    webFacts.push(decision(`a/web${n % 2}.ts`, n));
  }
  const files = new Map();
  for (const item of [...backendFacts, ...webFacts]) {
    if (!files.has(item.file)) files.set(item.file, new Map());
    files.get(item.file).set(item.line, 1);
  }
  const factSets = [
    { repo: 'web', kind: 'web', facts: webFacts },
    { repo: 'api', kind: 'backend', facts: backendFacts },
    { repo: 'quiet', kind: 'mobile', facts: [{ type: 'method_span', file: 'q/none.ts', line: 1, endLine: 2, class: 'Q', method: 'q' }] },
  ];
  const index = buildRuntimeIndex(factSets, { snapshots: [{ spec: 'all.spec.ts', test: null, files }], warnings: [] });
  const summary = runtimeSummary(index, {});
  assert.equal(summary.branches.length, BRANCH_ROW_CAP);
  assert.equal(summary.branchesTruncated, 300 - BRANCH_ROW_CAP);
  const backendRows = summary.branches.slice(0, 150);
  assert.ok(backendRows.every((row) => row.file.endsWith('.cs')));
  const order = (rows) => rows.map((row) => `${row.file}:${row.line}`);
  const sorted = [...backendRows].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  assert.deepEqual(order(backendRows), order(sorted));
  assert.ok(summary.branches.slice(150).every((row) => row.file.endsWith('.ts')));
  assert.deepEqual(summary.warnings, [], 'a skipped repository with no decision gives no warning');
});
