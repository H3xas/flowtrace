/**
 * Mobile sites and starts: each template site of a handler is its own trace node and its own
 * `--from-handler` choice, a gateway call keeps its request when it is written over several
 * lines, undecorated and base classes are mobile declarations with static calls and inherited
 * lifecycle hooks, plain helpers are qualified starts, chains keep the declaration a template
 * owner proves, and the component span JSON is one contract for web and mobile.
 *
 * Every new source shape lives in a disposable copy of a committed corpus, so the committed
 * corpus outputs stay as they are.
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { REPO_ROOT, runCli } from './helpers.js';

const CORPUS = join(REPO_ROOT, 'selftest', 'corpus');
const made = [];

after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/**
 * A disposable copy of one corpus with files written, rewritten or removed, then extracted and
 * joined. `files` maps a path under the corpus to its new text, or to a function of the old.
 */
function pack(corpus, configName, files = {}, { remove = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'flowtrace-sites-starts-'));
  made.push(dir);
  cpSync(join(CORPUS, corpus), dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    const target = join(dir, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, typeof text === 'function' ? text(readFileSync(target, 'utf8')) : text);
  }
  for (const file of remove) unlinkSync(join(dir, file));
  const config = join(dir, configName);
  for (const verb of ['extract', 'join']) {
    const result = runCli([verb, '--config', config], { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
  }
  const cli = (args) => runCli([...args, '--config', config], { cwd: dir });
  const facts = (repo) => JSON.parse(readFileSync(join(dir, 'out', 'facts', `${repo}.json`), 'utf8')).facts;
  const json = (args) => {
    const result = cli([...args, '--json']);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  return { dir, config, cli, facts, json };
}

function nursery(files, options) {
  return pack('nursery-mobile', 'nursery.config.json', files, options);
}

const PLOT_SERVICE = 'mobile/src/app/features/plots/plot.service.ts';

function entryOf(model, handlerOrTrigger) {
  const found = model.entries.filter(
    (view) => view.identity.handler === handlerOrTrigger || view.identity.trigger === handlerOrTrigger,
  );
  assert.equal(found.length, 1, `exactly one entry is ${handlerOrTrigger}`);
  return found[0];
}

test('Mobile sites and starts AC-3: a gateway call split by spaces, line breaks, comments and type arguments states one fact at the line of this', () => {
  const split = [
    '  splitNote(plotId: string) {',
    '    return this /* shared */ .',
    '      gateway // the one gateway',
    '      .post<{ id: string }>(`nursery/v1/plots/${plotId}/notes`, {});',
    '  }',
    '',
    '  oneLineNote(plotId: string) {',
    '    return this.gateway.post<{ id: string }>(`nursery/v1/plots/${plotId}/notes`, {});',
    '  }',
    '',
    '  notGateway(plotId: string) {',
    '    return this.helper',
    '      .post(`nursery/v1/plots/${plotId}/notes`, {});',
    '  }',
    '',
  ].join('\n');
  const variant = nursery({
    [PLOT_SERVICE]: (text) =>
      text
        .replace('constructor(private gateway: GatewayService) {}', 'constructor(private gateway: GatewayService, private helper: NoteHelper) {}')
        .replace('  exportPlot(plotId: string) {', `${split}  exportPlot(plotId: string) {`),
  });
  const calls = variant.facts('mobile').filter((fact) => fact.type === 'gateway_call');
  const source = readFileSync(join(variant.dir, PLOT_SERVICE), 'utf8').split('\n');
  const lineOf = (text) => source.findIndex((line) => line.includes(text)) + 1;
  const of = (method) => calls.filter((fact) => fact.method === method);
  assert.equal(of('splitNote').length, 1);
  assert.equal(of('splitNote')[0].line, lineOf('return this /* shared */ .'));
  assert.equal(of('oneLineNote').length, 1);
  const shape = (fact) => [fact.verb, fact.template, fact.resolved];
  assert.deepEqual(shape(of('splitNote')[0]), shape(of('oneLineNote')[0]));
  assert.deepEqual(shape(of('splitNote')[0]), ['POST', 'nursery/v1/plots/${plotId}/notes', true]);
  assert.deepEqual(of('notGateway'), [], 'a call through a field that is not a GatewayService field states nothing');
  assert.deepEqual(
    of('addNote').map((fact) => [fact.line, ...shape(fact)]),
    [[source.findIndex((line) => line.trimEnd().endsWith('return this.gateway')) + 1, 'POST', 'nursery/v1/plots/${plotId}/notes', true]],
  );
});

test('Mobile sites and starts AC-3: the committed two-line addNote call reaches its route under the onNote entry', () => {
  const committed = nursery();
  const model = committed.json(['span', '--from-component', 'PlotDetailPage']);
  const note = entryOf(model, 'onNote');
  assert.deepEqual([note.routes, note.arms, note.unresolved], [['POST nursery/v1/plots/*/notes'], 1, 0]);
  const route = model.routes.find((entry) => entry.key === 'POST nursery/v1/plots/*/notes');
  assert.deepEqual(route.arms.map((arm) => arm.entry), [note.identity.id]);
  const help = runCli(['--help']).stdout;
  assert.doesNotMatch(help, /written over more than one line states no fact/);
  assert.doesNotMatch(readFileSync(join(REPO_ROOT, 'docs', 'cli.md'), 'utf8'), /written over more than one line states no fact/);
});
