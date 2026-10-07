/**
 * Component entries: how execution reaches a web component, and how that reaching is kept
 * apart on the way out. The extractor states one `component_entry` per lifecycle callback,
 * hook effect, effect cleanup and unread trigger; the walk carries the entry below it; the
 * component span attributes every arm to the entry that reached it and can be narrowed to
 * one entry at a time.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT, runCli } from './helpers.js';

const FIXTURE = join(REPO_ROOT, 'selftest', 'corpus', 'greenhouse-alerts');
let pack = '';
let config = '';

before(() => {
  pack = mkdtempSync(join(tmpdir(), 'flowtrace-entries-'));
  cpSync(FIXTURE, pack, { recursive: true });
  config = join(pack, 'greenhouse.config.json');
  const extracted = runCli(['extract', '--config', config]);
  assert.equal(extracted.status, 0, extracted.stderr);
  const joined = runCli(['join', '--config', config]);
  assert.equal(joined.status, 0, joined.stderr);
});

after(() => {
  rmSync(pack, { recursive: true, force: true });
});

function webFacts() {
  return JSON.parse(readFileSync(join(pack, 'out', 'facts', 'web.json'), 'utf8')).facts;
}

function entriesOf(component) {
  return webFacts().filter((entry) => entry.type === 'component_entry' && entry.component === component);
}

function spanJson(name, extra = []) {
  const result = runCli(['span', '--from-component', name, '--json', '--config', config, ...extra]);
  return { ...result, model: result.status === 0 ? JSON.parse(result.stdout) : null };
}

/**
 * A disposable copy of the corpus with one source file rewritten and freshly extracted, for a
 * source shape the committed pack does not carry. The copy never reaches the pack's own ledger.
 */
function variant(name, mutate) {
  const dir = mkdtempSync(join(tmpdir(), `flowtrace-entries-${name}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  mutate(dir);
  const variantConfig = join(dir, 'greenhouse.config.json');
  const extracted = runCli(['extract', '--config', variantConfig], { cwd: dir });
  assert.equal(extracted.status, 0, extracted.stderr);
  const joined = runCli(['join', '--config', variantConfig], { cwd: dir });
  assert.equal(joined.status, 0, joined.stderr);
  return { dir, config: variantConfig };
}

test('a class lifecycle callback is one entry carrying its guard and its site', () => {
  const [mount] = entriesOf('ZoneOverviewPanel');
  assert.equal(mount.kind, 'mount');
  assert.equal(mount.trigger, 'componentDidMount');
  assert.equal(mount.handler, null);
  assert.equal(mount.file, 'src/zones/ZoneOverviewPanel.tsx');
  assert.equal(mount.line, 15);
  assert.deepEqual(mount.guards, ['this.props.zoneId']);
});

test('each useEffect states its own declaration: an empty list, a watched list, or a callback by name', () => {
  const effects = entriesOf('WatcherNotesPanel').filter((entry) => entry.kind === 'effect');
  assert.deepEqual(
    effects.map((entry) => [entry.line, entry.column, entry.deps, entry.handler, entry.depsUnknown]),
    [
      [25, 3, [], null, undefined],
      [29, 3, ['draft'], null, undefined],
      [36, 3, ['readings'], 'refresh', undefined],
      [42, 3, undefined, null, true],
      [46, 3, [], null, undefined],
      [46, 63, [], null, undefined],
    ],
  );
});

test('two effect declarations on one line are two entries, each with its own site and request', () => {
  const [first, second] = entriesOf('WatcherNotesPanel').filter((entry) => entry.line === 46);
  assert.notEqual(first.column, second.column, 'the two declarations are two columns of one line');
  assert.notEqual(first.method, second.method, 'each declaration owns its own method key');
  const { model } = spanJson('WatcherNotesPanel');
  const byColumn = new Map(
    model.entries.filter((entry) => entry.identity.line === 46).map((entry) => [entry.identity.column, entry]),
  );
  assert.deepEqual(
    [byColumn.get(first.column).unresolved, byColumn.get(second.column).unresolved],
    [1, 1],
    'neither same-line effect may be answered with the other one’s arms',
  );
  assert.notDeepEqual(
    byColumn.get(first.column).routes,
    byColumn.get(second.column).routes,
    'the two declarations reach their own routes',
  );
});

test('a dependency list written as an expression is stated as unread, never as absent', () => {
  const [withExpression] = entriesOf('WatcherNotesPanel').filter((entry) => entry.depsUnknown === true);
  assert.equal(withExpression.line, 42);
  assert.equal(withExpression.deps, undefined);
  const { model } = spanJson('WatcherNotesPanel');
  const identity = model.entries.find((entry) => entry.identity.line === 42).identity;
  assert.equal(identity.depsUnknown, true);
  assert.equal(identity.deps, undefined);
});

test('an effect that returns a function states a cleanup entry of its own', () => {
  const [cleanup] = entriesOf('WatcherNotesPanel').filter((entry) => entry.kind === 'cleanup');
  assert.equal(cleanup.trigger, 'useEffect');
  assert.equal(cleanup.line, 31);
  assert.equal(cleanup.endLine, 33);
});

test('a trigger the extractor cannot follow is stated with its reason, never dropped', () => {
  const unread = entriesOf('WatcherNotesPanel').filter((entry) => entry.kind === 'unknown');
  assert.deepEqual(
    unread.map((entry) => [entry.trigger, entry.unresolved, entry.line]),
    [
      ['useEffect', 'dynamic-callback', 38],
      ['useNoteDraft', 'custom-hook', 19],
      ['useNoteDraft', 'custom-hook', 48],
    ],
  );
});

test('a repeated unread hook keeps one entry per call site', () => {
  const calls = entriesOf('WatcherNotesPanel').filter((entry) => entry.trigger === 'useNoteDraft');
  assert.deepEqual(calls.map((entry) => entry.line), [19, 48]);
  const { model } = spanJson('WatcherNotesPanel');
  const arms = model.unresolved.filter((arm) => arm.cause === 'custom-hook');
  assert.deepEqual(arms.map((arm) => arm.line), [19, 48], 'both sites are unanswered, neither replaces the other');
});

test('a foreign hook is not an entry: the component does not reach anything through it', () => {
  const triggers = entriesOf('WatcherNotesPanel').map((entry) => entry.trigger);
  for (const foreign of ['useDispatch', 'useSelector', 'useState']) {
    assert.ok(!triggers.includes(foreign), `${foreign} should not be an entry`);
  }
});

test('every entry keeps its own arms: the mount request and the click request never merge', () => {
  const { model } = spanJson('ZoneOverviewPanel');
  const byTrigger = new Map(model.entries.map((entry) => [entry.identity.trigger, entry]));
  assert.deepEqual(byTrigger.get('componentDidMount').routes, ['GET glasshouse/v1/zones/*/readings']);
  assert.deepEqual(byTrigger.get('onClick').routes, []);
  const acknowledge = model.entries.find((entry) => entry.identity.handler === 'acknowledgeAlarm');
  assert.deepEqual(acknowledge.routes, ['POST glasshouse/v1/zones/*/alarms/ack']);
});

test('selecting one entry leaves every other trigger out of the answer', () => {
  const { model } = spanJson('ZoneOverviewPanel', ['--entry', 'acknowledgeAlarm']);
  assert.deepEqual(model.routes.map((route) => route.key), ['POST glasshouse/v1/zones/*/alarms/ack']);
  assert.deepEqual(model.entries.map((entry) => entry.identity.handler), ['acknowledgeAlarm']);
  assert.ok(!model.unresolved.some((arm) => arm.attempted === 'READINGS_LOADED'));
});

test('an entry is selectable by its full id, its trigger, a trigger at its line, or its handler', () => {
  const id = spanJson('ZoneOverviewPanel').model.entries
    .map((entry) => entry.identity.id)
    .find((value) => value.includes('componentDidMount'));
  for (const selector of [id, 'componentDidMount', 'componentDidMount@15']) {
    const { model } = spanJson('ZoneOverviewPanel', ['--entry', selector]);
    assert.deepEqual(model.entries.map((entry) => entry.identity.id), [id], `selector ${selector}`);
  }
});

test('a selector that is not exactly one entry is refused and lists them all', () => {
  const { status, stderr } = spanJson('ZoneOverviewPanel', ['--entry', 'nope']);
  assert.equal(status, 2);
  assert.match(stderr, /no entry matches "nope"/);
  assert.match(stderr, /componentDidMount/);
  const ambiguous = spanJson('ZoneOverviewPanel', ['--entry', 'onClick']);
  assert.equal(ambiguous.status, 2);
  assert.match(ambiguous.stderr, /matches 2 entries, not exactly one/);
});

test('an unread trigger prints as its own unresolved reason instead of vanishing', () => {
  const { model } = spanJson('WatcherNotesPanel');
  const unread = model.unresolved.filter((arm) => arm.reason === 'entry-unresolved');
  assert.deepEqual(unread.map((arm) => arm.cause).sort(), ['custom-hook', 'custom-hook', 'dynamic-callback']);
  for (const arm of unread) assert.ok(arm.entry, 'an unresolved entry arm names its entry');
});

test('an effect naming a callback the module declares is walked through that callback', () => {
  const { model } = spanJson('WatcherNotesPanel');
  const named = model.entries.find((entry) => entry.identity.handler === 'refresh');
  assert.ok(named, 'the callback named by useEffect is an entry of its own');
  assert.deepEqual(named.routes, ['GET glasshouse/v1/zones/*/readings']);
  assert.ok(!model.unresolved.some((arm) => arm.reason === 'entry-unresolved' && arm.cause === 'no-target'));
});

test('the JSON view and the page name the same entries by the same ids', () => {
  const json = spanJson('ZoneOverviewPanel').model;
  const html = runCli([
    'span', '--from-component', 'ZoneOverviewPanel',
    '--out', join(pack, 'span.html'), '--config', config,
  ]);
  assert.equal(html.status, 0, html.stderr);
  const page = readFileSync(join(pack, 'span.html'), 'utf8');
  for (const view of json.entries) {
    assert.ok(page.includes(view.identity.id), `the page should print ${view.identity.id}`);
  }
});

test('the page states where a trigger fires, never how often React runs it', () => {
  const target = join(pack, 'span-notes.html');
  const written = runCli(['span', '--from-component', 'WatcherNotesPanel', '--out', target, '--config', config]);
  assert.equal(written.status, 0, written.stderr);
  const page = readFileSync(target, 'utf8');
  assert.match(page, /never how often React runs it/);
  assert.doesNotMatch(page, /one run after mount|runs once after mount|on every render|runs before the|then runs the/);
});

test('two selected entries of one component write two pages, never one', () => {
  const written = ['useEffect@25', 'useEffect@29'].map((selector) => {
    const run = runCli(
      ['span', '--from-component', 'WatcherNotesPanel', '--entry', selector, '--config', config],
      { cwd: pack },
    );
    assert.equal(run.status, 0, run.stderr);
    const target = run.stdout.slice(run.stdout.lastIndexOf(' -> ') + 4).trim();
    assert.ok(existsSync(target), `the page ${selector} selected should have been written at ${target}`);
    return target;
  });
  assert.notEqual(
    written[0],
    written[1],
    'two entries of one component are two journeys, so the second selection may not overwrite the first page',
  );
  assert.notEqual(readFileSync(written[0], 'utf8'), readFileSync(written[1], 'utf8'));
});

test('two runs over the same facts write the same page', () => {
  const first = join(pack, 'span-1.html');
  const second = join(pack, 'span-2.html');
  assert.equal(runCli(['span', '--from-component', 'WatcherNotesPanel', '--out', first, '--config', config]).status, 0);
  assert.equal(runCli(['span', '--from-component', 'WatcherNotesPanel', '--out', second, '--config', config]).status, 0);
  assert.equal(readFileSync(first, 'utf8'), readFileSync(second, 'utf8'));
});

test('--entry without --from-component is a usage error, not a silent no-op', () => {
  const result = runCli(['span', '--entry', 'componentDidMount', '--config', config]);
  assert.equal(result.status, 2);
});

test('every entry fact validates against the fact schema', () => {
  const emitted = webFacts().filter((entry) => entry.type === 'component_entry');
  assert.ok(emitted.length >= 8, 'the pack should state every entry it contains');
  for (const entry of emitted) {
    assert.ok(Number.isInteger(entry.line) && entry.line > 0);
    assert.ok(Array.isArray(entry.guards));
    assert.ok(['mount', 'update', 'unmount', 'effect', 'cleanup', 'event', 'unknown'].includes(entry.kind));
  }
});

const WATCHER_PAGE = 'web/src/zones/alerts/WatcherPreferencesPage.tsx';
const SAVE_BUTTON = '      <button type="button" onClick={handleSave}>\n        Save watchers\n      </button>\n';

/** Every `handleSave` entry the watcher page states once the save button is written again. */
function saveEntries(writtenAgain) {
  const { dir, config: variantConfig } = variant('binding', (root) => {
    const page = join(root, ...WATCHER_PAGE.split('/'));
    const source = readFileSync(page, 'utf8');
    assert.ok(source.includes(SAVE_BUTTON), 'the fixture should still bind handleSave once');
    writeFileSync(page, source.replace(SAVE_BUTTON, SAVE_BUTTON + writtenAgain));
  });
  try {
    const result = runCli([
      'span', '--from-component', 'WatcherPreferencesPage',
      '--file', 'alerts/WatcherPreferencesPage.tsx', '--json', '--config', variantConfig,
    ]);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).entries
      .filter((entry) => entry.identity.handler === 'handleSave')
      .map((entry) => entry.identity);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a handler bound at two sites is two entries, one per binding', () => {
  const saves = saveEntries(
    '      <button type="button" onClick={handleSave}>\n        Save from the toolbar\n      </button>\n',
  );
  assert.equal(saves.length, 2, 'each binding of one handler is its own entry');
  assert.notEqual(saves[0].id, saves[1].id, 'two bindings may not share one identity');
  assert.notEqual(saves[0].line, saves[1].line, 'each entry keeps the line it was written at');
});

test('two bindings written on one line are two entries, at two columns', () => {
  const saves = saveEntries(
    '      <button onClick={handleSave}>Save</button><button onClick={handleSave}>Again</button>\n',
  );
  assert.equal(saves.length, 3, 'the pack’s own binding and both new ones are stated');
  const oneLine = saves.filter((entry) => saves.filter((other) => other.line === entry.line).length === 2);
  assert.equal(oneLine.length, 2, 'one line is not one site');
  assert.notEqual(oneLine[0].column, oneLine[1].column, 'the two bindings are two columns of it');
  assert.notEqual(oneLine[0].id, oneLine[1].id, 'two bindings on one line may not share one identity');
});

test('two same-named components in different files write two pages', () => {
  const { dir, config: variantConfig } = variant('same-name', (root) => {
    cpSync(
      join(root, 'web', 'src', 'zones', 'notes', 'WatcherNotesPanel.tsx'),
      join(root, 'web', 'src', 'zones', 'other', 'WatcherNotesPanel.tsx'),
      { recursive: false },
    );
  });
  try {
    const entriesAt = (file) => {
      const result = runCli([
        'span', '--from-component', 'WatcherNotesPanel', '--file', file, '--json', '--config', variantConfig,
      ]);
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout).entries.map((entry) => entry.identity);
    };
    const selected = ['zones/notes/', 'zones/other/'].map((file) => {
      const at = entriesAt(file).filter((entry) => entry.file.includes(file) && entry.line === 25);
      assert.equal(at.length, 1, `the file ${file} should carry one effect at line 25`);
      return at[0];
    });
    assert.notEqual(selected[0].id, selected[1].id, 'the two declarations are two identities');
    const written = selected.map((identity) => {
      const file = identity.file.replace(/^src\//, '');
      const run = runCli(
        ['span', '--from-component', 'WatcherNotesPanel', '--file', file, '--entry', identity.id, '--config', variantConfig],
        { cwd: dir },
      );
      assert.equal(run.status, 0, run.stderr);
      return run.stdout.slice(run.stdout.lastIndexOf(' -> ') + 4).trim();
    });
    assert.notEqual(written[0], written[1], 'a page may not be overwritten by another file’s entry');
    assert.notEqual(readFileSync(written[0], 'utf8'), readFileSync(written[1], 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the pack states one entry per trigger and none for the foreign hooks it also calls', () => {
  const triggers = webFacts()
    .filter((fact) => fact.type === 'component_entry')
    .map((fact) => `${fact.component}|${fact.trigger}@${fact.line}:${fact.column}`);
  assert.deepEqual(triggers, [
    'ZoneOverviewPanel|componentDidMount@15:3',
    'ZonesLandingPanel|componentDidMount@13:3',
    'WatcherPreferencesPage|useEffect@15:3',
    'WatcherNotesPanel|useEffect@25:3',
    'WatcherNotesPanel|useEffect@29:3',
    'WatcherNotesPanel|useEffect@31:5',
    'WatcherNotesPanel|useEffect@36:3',
    'WatcherNotesPanel|useEffect@38:3',
    'WatcherNotesPanel|useEffect@42:3',
    'WatcherNotesPanel|useEffect@46:3',
    'WatcherNotesPanel|useEffect@46:63',
    'WatcherNotesPanel|useNoteDraft@19:31',
    'WatcherNotesPanel|useNoteDraft@48:3',
  ]);
});
