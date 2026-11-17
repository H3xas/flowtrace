/**
 * The result status on the two HTML pages. The `trace --html` tree page keeps the terminal
 * tree byte for byte, status lines, frontier lines and dependency label included. The span
 * page keeps its status visible and puts every `file:line` behind an expander, the start
 * location of the status included.
 *
 * The cases run the CLI as a subprocess over the invented `quarry-dispatch` corpus. The
 * start without a location builds a status by hand, because every corpus start has one.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { copyFixture, runCli } from './helpers.js';
import { statusBlock } from '../lib/render-span-html.js';
import { startLocationOf, statusLines } from '../lib/result-status.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = 'quarry.config.json';
const PLAN = 'POST dispatch/v1/plans';
const ROUTE = 'POST dispatch/v1/route';
const PLAN_START_AT = 'src/Controllers/DispatchController.cs:24';
const COMPONENT_START_AT = 'src/dispatch/DispatchBoard.tsx:11';
const SOURCE_LOCATION = /[\w./-]+\.(?:cs|tsx?):\d+/;

function corpus(t) {
  const dir = copyFixture(t, 'quarry-dispatch');
  const result = runCli(['extract', '--config', CONFIG], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  return dir;
}

function unescapeHtml(text) {
  return text.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}

/**
 * The tree text of a page, collected by class: every run the terminal renderer produced
 * carries `tt`, and nothing the page adds does. One `ln` row is one line, and the trailer
 * follows one empty line, as `renderTree` joins them.
 */
function treeText(page) {
  const block = /<pre class="tree">([\s\S]*?)<\/pre>/.exec(page);
  assert.ok(block, 'no tree block on the page');
  const lines = block[1]
    .split('<div class="ln')
    .slice(1)
    .map((row) => [...row.matchAll(/<span class="tt[^"]*">([^<]*)<\/span>/g)].map((run) => unescapeHtml(run[1])).join(''));
  const trailer = /<div class="trailer">([\s\S]*?)<\/div>/.exec(page);
  assert.ok(trailer, 'no trailer block on the page');
  return `${lines.join('\n')}\n\n${unescapeHtml(trailer[1])}`;
}

function terminalTree(dir, start, ...flags) {
  const run = runCli(['trace', start, '--config', CONFIG, ...flags], { cwd: dir });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.stdout.endsWith('\n'), 'the terminal tree ends with one newline');
  return run.stdout.slice(0, -1);
}

function treePage(dir, name, start, ...flags) {
  const file = join(dir, name);
  const run = runCli(['trace', start, '--config', CONFIG, ...flags, '--html', file], { cwd: dir });
  assert.equal(run.status, 0, run.stderr);
  return readFileSync(file, 'utf8');
}

function statusOf(dir, start, ...flags) {
  const run = runCli(['trace', start, '--config', CONFIG, '--json', ...flags], { cwd: dir });
  assert.ok(run.stdout, run.stderr);
  return JSON.parse(run.stdout).status;
}

test('Tree page fidelity AC-6: a stopped walk strips back to the terminal tree, with and without a cover overlay', (t) => {
  const dir = corpus(t);
  const terminal = terminalTree(dir, PLAN, '--max-nodes', '20');
  const header = terminal.split('\n');
  assert.match(header[0], /^start: /, 'the terminal tree opens with the status lines');
  assert.ok(header.some((line) => /^frontier: 3 stopped places$/.test(line)), 'the frontier is in the terminal header');

  for (const [name, overlay] of [['plain.html', []], ['overlay.html', ['--cover-overlay']]]) {
    const page = treePage(dir, name, PLAN, '--max-nodes', '20', ...overlay);
    assert.equal(treeText(page), terminal, `${name}: the page differs from the terminal tree`);
    assert.match(page, /<b>Result status\.<\/b>/, `${name}: the status note stays on the page`);
    assert.match(page, /<summary>3 stopped places<\/summary>/, `${name}: the frontier expander stays on the page`);
  }
});

test('Tree page fidelity AC-6: a complete walk strips back to the terminal tree, with and without a cover overlay', (t) => {
  const dir = corpus(t);
  const terminal = terminalTree(dir, ROUTE);
  for (const [name, overlay] of [['plain.html', []], ['overlay.html', ['--cover-overlay']]]) {
    const page = treePage(dir, name, ROUTE, ...overlay);
    assert.equal(treeText(page), terminal, `${name}: the page differs from the terminal tree`);
    assert.match(page, /<b>Result status\.<\/b>/, `${name}: the status note stays on the page`);
  }
});

test('Tree page fidelity AC-6: the status lines, the frontier lines and the label are tree text on the page', (t) => {
  const dir = corpus(t);
  const status = statusOf(dir, PLAN, '--max-nodes', '20');
  const page = treePage(dir, 'plain.html', PLAN, '--max-nodes', '20');
  const text = treeText(page).split('\n');
  assert.deepEqual(text.slice(0, statusLines(status).length), statusLines(status), 'the status lines lead the tree text');
  const label = text.findIndex((line) => line.startsWith('dependency view: '));
  assert.ok(label > 0, 'the label is tree text');
  assert.equal(text[label - 1], '', 'the label follows the empty line that ends the header');
  assert.match(page, /<span class="tt c-dim">dependency view: /, 'the label keeps the dim colour of the terminal');
});

test('Span page expanders AC-7: the status stays visible and its start location sits in an expander', (t) => {
  const dir = corpus(t);
  const status = statusOf(dir, PLAN, '--max-nodes', '20');
  const file = join(dir, 'span.html');
  const run = runCli(['span', PLAN, '--config', CONFIG, '--max-nodes', '20', '--out', file], { cwd: dir });
  assert.equal(run.status, 0, run.stderr);
  const page = readFileSync(file, 'utf8');

  const outside = page.replace(/<details[\s\S]*?<\/details>/g, '');
  assert.doesNotMatch(outside, SOURCE_LOCATION, 'a source location leaked out of its expander');
  const shown = /<pre class="status">([\s\S]*?)<\/pre>/.exec(outside);
  assert.ok(shown, 'the status stays visible');
  assert.equal(unescapeHtml(shown[1]), statusLines(status, { withStartLocation: false }).join('\n'));
  assert.equal(startLocationOf(status), PLAN_START_AT);
  const where = /<details class="where"><summary>where the walk starts<\/summary>([\s\S]*?)<\/details>/.exec(page);
  assert.ok(where, 'the start location has its own expander');
  assert.ok(where[1].includes(PLAN_START_AT), 'the expander holds the start location');
  assert.doesNotMatch(where[1], /<details/, 'the start expander holds no other expander');
  assert.match(page, /<summary>3 stopped places<\/summary>/, 'the frontier expander stays');

  const again = join(dir, 'again.html');
  const second = runCli(['span', PLAN, '--config', CONFIG, '--max-nodes', '20', '--out', again], { cwd: dir });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(again, 'utf8'), page, 'two renders of one input differ');
});

test('Span page expanders AC-7: the component span page states its status the same way', (t) => {
  const dir = corpus(t);
  const file = join(dir, 'component.html');
  const run = runCli(['span', '--from-component', 'DispatchBoard', '--config', CONFIG, '--out', file], { cwd: dir });
  assert.equal(run.status, 0, run.stderr);
  const page = readFileSync(file, 'utf8');
  // Only the status block is the subject: the component page lists other sites of its own.
  const block = /<div class="plain"><b>Result status\.<\/b>[\s\S]*?<\/pre>(<details[\s\S]*?<\/details>)?/.exec(page);
  assert.ok(block, 'the status block is on the page');
  const outside = block[0].replace(/<details[\s\S]*?<\/details>/g, '');
  assert.doesNotMatch(outside, SOURCE_LOCATION, 'the start location leaked out of its expander');
  assert.match(outside, /<pre class="status">start: DispatchBoard \(component, web\)\n/);
  assert.ok(block[1] && block[1].includes(COMPONENT_START_AT), 'the start expander holds the component location');
});

test('Span page expanders AC-7: a start with no location gets no start expander', () => {
  const status = {
    schemaVersion: 1,
    traversal: 'complete',
    freshness: 'matching',
    factSets: [],
    evidence: { 'source-supported': 1, inferred: 0, runtime: 'not supplied' },
    scope: { mode: 'full', start: { ref: 'GET widgets/v1/ping', kind: 'route', repo: 'api' } },
    limits: { depth: 6, maxNodes: 1500, seedCap: 64, interfaceFanOut: 16, graphFanOut: 8 },
    schedule: null,
    stops: {},
    frontier: [],
    identity: 'sha256:fixture',
  };
  assert.equal(startLocationOf(status), null);
  const block = statusBlock(status);
  assert.ok(!block.includes('<details'), 'no expander without a location');
  assert.ok(block.includes('start: GET widgets/v1/ping (route, api)\n'), 'the start line carries no placeholder');
  assert.equal(statusLines(status)[0], 'start: GET widgets/v1/ping (route, api -)', 'the default line is unchanged');
});

test('Span page expanders AC-7: the help text and docs/cli.md state both page rules', () => {
  const help = runCli(['--help']).stdout;
  const doc = readFileSync(join(HERE, '..', 'docs', 'cli.md'), 'utf8');
  for (const [name, source] of [['help', help], ['docs/cli.md', doc]]) {
    const text = source.replace(/\s+/g, ' ');
    assert.match(text, /That text opens with the status lines and the frontier, then the dependency label/, `${name}: tree page rule`);
    assert.match(text, /The result status stays visible, and its start file:line sits behind an expander/, `${name}: span page rule`);
  }
});
