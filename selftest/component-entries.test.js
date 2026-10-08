/**
 * Component entries: how execution reaches a web component, and how that reaching is kept
 * apart on the way out. The extractor states one `component_entry` per lifecycle callback,
 * hook effect, effect cleanup and unread trigger; the walk carries the entry below it; the
 * component span attributes every arm to the entry that reached it and can be narrowed to
 * one entry at a time.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { componentSpan } from '../lib/component-span.js';
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

test('two entries of a component declared under a deep path write two pages', () => {
  const deep = `deep-${'d'.repeat(96)}`;
  const { dir, config: variantConfig } = variant('deep-path', (root) => {
    const target = join(root, 'web', 'src', 'zones', deep);
    mkdirSync(target, { recursive: true });
    cpSync(join(root, 'web', 'src', 'zones', 'notes', 'WatcherNotesPanel.tsx'), join(target, 'WatcherNotesPanel.tsx'));
  });
  try {
    const scope = ['--from-component', 'WatcherNotesPanel', '--file', `zones/${deep}/`];
    const narrowed = runCli(['span', ...scope, '--json', '--config', variantConfig]);
    assert.equal(narrowed.status, 0, narrowed.stderr);
    const effects = JSON.parse(narrowed.stdout).entries
      .map((entry) => entry.identity)
      .filter((identity) => identity.kind === 'effect');
    assert.ok(effects.length >= 2, 'the deep declaration states both of its effects');
    const written = effects.slice(0, 2).map((identity) => {
      const run = runCli(['span', ...scope, '--entry', identity.id, '--config', variantConfig], { cwd: dir });
      assert.equal(run.status, 0, run.stderr);
      return { identity, target: run.stdout.slice(run.stdout.lastIndexOf(' -> ') + 4).trim() };
    });
    assert.notEqual(
      written[0].target,
      written[1].target,
      'a path deep enough to spend the name cap may not fold two entries onto one page',
    );
    for (const { identity, target } of written) {
      assert.ok(readFileSync(target, 'utf8').includes(identity.id), `the page of ${identity.id} should state it`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a file-qualified start states only the entries and requests its own declaration carries', () => {
  const single = spanJson('WatcherNotesPanel').model;
  const routesAt = (model, line) =>
    model.entries.find((entry) => entry.identity.kind === 'effect' && entry.identity.line === line).routes;
  const mountRoutes = routesAt(single, 25);
  const refreshRoutes = routesAt(single, 36);
  assert.notDeepEqual(mountRoutes, refreshRoutes, 'the two effects must request different routes to tell the files apart');
  const { dir, config: variantConfig } = variant('file-scope', (root) => {
    const source = readFileSync(join(root, 'web', 'src', 'zones', 'notes', 'WatcherNotesPanel.tsx'), 'utf8');
    const mount = "dispatch(loadWatchers('latest'));\n  }, []);";
    assert.ok(source.includes(mount));
    mkdirSync(join(root, 'web', 'src', 'zones', 'other'), { recursive: true });
    writeFileSync(
      join(root, 'web', 'src', 'zones', 'other', 'WatcherNotesPanel.tsx'),
      source.replace(mount, "dispatch(loadZoneReadings('latest'));\n  }, []);"),
    );
  });
  try {
    const scoped = [
      ['zones/notes/', mountRoutes],
      ['zones/other/', refreshRoutes],
    ].map(([file, expected]) => {
      const result = runCli(['span', '--from-component', 'WatcherNotesPanel', '--file', file, '--json', '--config', variantConfig]);
      assert.equal(result.status, 0, result.stderr);
      const model = JSON.parse(result.stdout);
      const foreign = model.entries.filter((entry) => !entry.identity.file.includes(file));
      assert.deepEqual(foreign.map((entry) => entry.identity.id), [], `--file ${file} may state no other file's entry`);
      assert.equal(model.entries.length, single.entries.length, `--file ${file} states every entry its own file declares`);
      assert.deepEqual(routesAt(model, 25), expected, `the mount effect under ${file} requests what that file's effect dispatches`);
      const strayArms = model.unresolved.filter(
        (arm) => String(arm.file).endsWith('WatcherNotesPanel.tsx') && !arm.file.includes(file),
      );
      assert.deepEqual(strayArms, [], `--file ${file} may carry no arm written in the other declaration`);
      return model;
    });
    const notesMount = scoped[0].entries.find((entry) => entry.identity.kind === 'effect' && entry.identity.line === 25);
    const crossed = runCli([
      'span', '--from-component', 'WatcherNotesPanel', '--file', 'zones/other/', '--entry', notesMount.identity.id,
      '--json', '--config', variantConfig,
    ]);
    assert.equal(crossed.status, 2, 'an entry declared in another file is not selectable under this --file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The pack with a second `WatcherNotesPanel` under `zones/other/` whose mount effect loads
 * readings instead of watchers, plus one parent per given import specifier, each rendering
 * `<WatcherNotesPanel />` through that import.
 */
function twinChildVariant(name, parents) {
  return variant(name, (root) => {
    const zones = join(root, 'web', 'src', 'zones');
    const source = readFileSync(join(zones, 'notes', 'WatcherNotesPanel.tsx'), 'utf8');
    const mount = "dispatch(loadWatchers('latest'));\n  }, []);";
    assert.ok(source.includes(mount));
    mkdirSync(join(zones, 'other'), { recursive: true });
    writeFileSync(
      join(zones, 'other', 'WatcherNotesPanel.tsx'),
      source.replace(mount, "dispatch(loadZoneReadings('latest'));\n  }, []);"),
    );
    for (const [parent, specifier] of parents) {
      writeFileSync(
        join(zones, `${parent}.tsx`),
        `import React from 'react';\nimport WatcherNotesPanel from '${specifier}';\n\n` +
          `export function ${parent}() {\n  return <WatcherNotesPanel />;\n}\n`,
      );
    }
  });
}

test('a parent walks into the same-named child its own import names, whichever was declared last', () => {
  const single = spanJson('WatcherNotesPanel').model;
  const watchersRoutes = single.entries.find((entry) => entry.identity.kind === 'effect' && entry.identity.line === 25).routes;
  const { dir, config: variantConfig } = twinChildVariant('render-import', [
    ['NotesParent', './notes/WatcherNotesPanel'],
    ['OtherParent', './other/WatcherNotesPanel'],
  ]);
  try {
    for (const [parent, folder, mountRoutes] of [
      ['NotesParent', 'zones/notes/', watchersRoutes],
      ['OtherParent', 'zones/other/', null],
    ]) {
      const result = runCli(['span', '--from-component', parent, '--json', '--config', variantConfig]);
      assert.equal(result.status, 0, result.stderr);
      const model = JSON.parse(result.stdout);
      const files = [...new Set(model.entries.map((entry) => entry.identity.file))];
      assert.deepEqual(files, [`src/${folder}WatcherNotesPanel.tsx`], `${parent} reaches only the child it imports`);
      assert.equal(model.entries.length, single.entries.length, `${parent} states every entry of its child`);
      const mount = model.entries.find((entry) => entry.identity.kind === 'effect' && entry.identity.line === 25);
      if (mountRoutes) assert.deepEqual(mount.routes, mountRoutes, `${parent} keeps the request its child makes on mount`);
      else assert.ok(!mount.routes.some((route) => watchersRoutes.includes(route)), `${parent} borrows no request from the other child`);
      assert.ok(!model.unresolved.some((arm) => arm.reason === 'component-ambiguous'));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a rendered name its source does not settle is an unknown target at its own site', () => {
  const { dir, config: variantConfig } = twinChildVariant('render-unsettled', [
    ['AliasParent', '@zones/notes/WatcherNotesPanel'],
  ]);
  try {
    const result = runCli(['span', '--from-component', 'AliasParent', '--json', '--config', variantConfig]);
    assert.equal(result.status, 0, result.stderr);
    const model = JSON.parse(result.stdout);
    assert.deepEqual(model.entries, [], 'no declaration is entered on a guess');
    const arms = model.unresolved.filter((arm) => arm.reason === 'component-ambiguous');
    assert.equal(arms.length, 1, JSON.stringify(model.unresolved));
    assert.equal(arms[0].attempted, 'WatcherNotesPanel');
    assert.equal(arms[0].file, 'src/zones/AliasParent.tsx');
    assert.equal(arms[0].line, 5);
    assert.deepEqual(arms[0].candidates, [
      'src/zones/notes/WatcherNotesPanel.tsx',
      'src/zones/other/WatcherNotesPanel.tsx',
    ]);
    const out = join(dir, 'alias-parent.html');
    const page = runCli(['span', '--from-component', 'AliasParent', '--out', out, '--config', variantConfig]);
    assert.equal(page.status, 0, page.stderr);
    const html = readFileSync(out, 'utf8');
    assert.match(html, /component not settled/);
    assert.match(html, /declared in src\/zones\/notes\/WatcherNotesPanel\.tsx, src\/zones\/other\/WatcherNotesPanel\.tsx/);
    assert.match(html, /src\/zones\/AliasParent\.tsx:5/);
    const tree = runCli(['trace', 'AliasParent', '--expand', '--config', variantConfig]);
    assert.equal(tree.status, 0, tree.stderr);
    assert.match(tree.stdout, /WatcherNotesPanel.*declared in 2 files/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('which same-named child a parent reaches never depends on the order its facts were read', () => {
  const entry = (file) => ({
    type: 'component_entry', file, line: 3, column: 3, component: 'Child', kind: 'unknown',
    trigger: 'useLiveFeed', handler: null, guards: [], unresolved: 'custom-hook',
  });
  const child = (file) => [{ type: 'component', file, line: 1, name: 'Child', selector: 'Child', role: 'component' }, entry(file)];
  const parent = ({ source, lazy }) => [
    { type: 'component', file: 'src/Parent.tsx', line: 4, name: 'Parent', selector: 'Parent', role: 'component' },
    ...(lazy ? [{ type: 'component', file: 'src/Parent.tsx', line: 2, name: 'Child', selector: 'Child', role: 'component', lazy }] : []),
    { type: 'renders', file: 'src/Parent.tsx', line: 5, from: 'Parent', to: 'Child', ...(source ? { source } : {}) },
  ];
  const files = (model) => [...new Set(model.entries.map((view) => view.identity.file))];
  for (const [statement, expected] of [
    [{ source: './b/Child' }, ['src/b/Child.tsx']],
    [{ source: '../src/a/Child.tsx' }, ['src/a/Child.tsx']],
    [{ lazy: './b/Child' }, ['src/b/Child.tsx']],
    [{ source: '@app/b/Child' }, []],
    [{}, []],
  ]) {
    const answers = [
      [...child('src/a/Child.tsx'), ...child('src/b/Child.tsx')],
      [...child('src/b/Child.tsx'), ...child('src/a/Child.tsx')],
    ].map((children) => componentSpan([{ repo: 'web', kind: 'web', facts: [...parent(statement), ...children] }], 'Parent'));
    for (const model of answers) {
      const label = JSON.stringify(statement);
      assert.deepEqual(files(model), expected, label);
      const ambiguous = model.unresolved.filter((arm) => arm.reason === 'component-ambiguous');
      assert.equal(ambiguous.length, expected.length === 0 ? 1 : 0, label);
    }
  }
  const forwarded = [
    ...parent({ lazy: './a/Child' }),
    { type: 'component', file: 'src/a/Child.tsx', line: 1, name: 'Child', selector: 'Child', role: 'component', lazy: '../b/Child' },
    ...child('src/b/Child.tsx'),
  ];
  const chained = componentSpan([{ repo: 'web', kind: 'web', facts: forwarded }], 'Parent');
  assert.deepEqual(files(chained), ['src/b/Child.tsx'], 'a lazy binding that loads another lazy binding is followed to the body');
  const looped = forwarded.slice(0, -2).concat({ ...forwarded[forwarded.length - 3], file: 'src/b/Child.tsx', lazy: '../a/Child' });
  const cycle = componentSpan([{ repo: 'web', kind: 'web', facts: looped }], 'Parent');
  assert.deepEqual(files(cycle), []);
  assert.equal(cycle.unresolved.filter((arm) => arm.reason === 'component-ambiguous').length, 1, 'a lazy cycle is an unknown target');
});

test('a lazy binding renders the module its import names', () => {
  const model = spanJson('ZoneRoutes').model;
  const files = [...new Set(model.entries.map((entry) => entry.identity.file))];
  assert.ok(files.includes('src/zones/alerts/WatcherPreferencesPage.tsx'), JSON.stringify(files));
  assert.ok(!model.unresolved.some((arm) => arm.reason === 'component-ambiguous'));
});

/** What a span states, without the component it started from: the comparable part of an answer. */
function reached(model) {
  return {
    entries: model.entries.map((entry) => ({ ...entry.identity, routes: entry.routes })),
    unresolved: model.unresolved.map((arm) => arm.reason),
  };
}

function writeParents(root, parents) {
  for (const [parent, clause, specifier, tag] of parents) {
    writeFileSync(
      join(root, 'web', 'src', 'zones', `${parent}.tsx`),
      `import React from 'react';\nimport ${clause} from '${specifier}';\n\n` +
        `export function ${parent}() {\n  return <${tag} />;\n}\n`,
    );
  }
}

test('a child imported under another local name is the child its module exports', () => {
  const direct = (name) => reached(spanJson(name).model);
  const parents = [
    ['ChosenNotesParent', 'ChosenNotes', './notes/WatcherNotesPanel', 'ChosenNotes', 'WatcherNotesPanel'],
    ['OverviewParent', 'Overview', './ZoneOverviewPanel', 'Overview', 'ZoneOverviewPanel'],
    ['ZonesParent', '{ ZoneRoutes as Zones }', './ZoneRoutes', 'Zones', 'ZoneRoutes'],
    ['RoutesParent', '* as Zoning', './ZoneRoutes', 'Zoning.ZoneRoutes', 'ZoneRoutes'],
  ];
  const { dir, config: variantConfig } = variant('render-alias', (root) => writeParents(root, parents));
  try {
    for (const [parent, , , , child] of parents) {
      const result = runCli(['span', '--from-component', parent, '--json', '--config', variantConfig]);
      assert.equal(result.status, 0, result.stderr);
      const model = JSON.parse(result.stdout);
      assert.ok(model.entries.length > 0, `${parent} states the entries of ${child}`);
      assert.deepEqual(reached(model), direct(child), `${parent} reaches what ${child} reaches`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const twin = twinChildVariant('render-alias-twin', []);
  try {
    writeParents(join(twin.dir), [
      ['PickedParent', 'Picked', './other/WatcherNotesPanel', 'Picked'],
      ['ChosenParent', 'Chosen', './notes/WatcherNotesPanel', 'Chosen'],
    ]);
    for (const verb of ['extract', 'join']) {
      const ran = runCli([verb, '--config', twin.config], { cwd: twin.dir });
      assert.equal(ran.status, 0, ran.stderr);
    }
    for (const [parent, folder] of [['PickedParent', 'other'], ['ChosenParent', 'notes']]) {
      const result = runCli(['span', '--from-component', parent, '--json', '--config', twin.config]);
      assert.equal(result.status, 0, result.stderr);
      const files = [...new Set(JSON.parse(result.stdout).entries.map((entry) => entry.identity.file))];
      assert.deepEqual(files, [`src/zones/${folder}/WatcherNotesPanel.tsx`], parent);
    }
  } finally {
    rmSync(twin.dir, { recursive: true, force: true });
  }
});

test('the extractor states the binding a render imports and the component a module exports by default', () => {
  const facts = webFacts();
  const defaults = facts.filter((entry) => entry.type === 'component' && entry.default === true).map((entry) => entry.name).sort();
  assert.deepEqual(defaults, ['GreenhouseShell', 'WatcherNotesPanel', 'WatcherPreferencesPage', 'ZoneOverviewPanel', 'ZonesLandingPanel']);
  const imported = (to) => facts.find((entry) => entry.type === 'renders' && entry.to === to).imported;
  assert.equal(imported('GreenhouseShell'), 'default');
  assert.equal(imported('ZoneOverviewPanel'), 'default');
  assert.equal(imported('ZoneRoutes'), undefined, 'a named import under its own name says nothing more');
});

test('a module default export is flagged on the component it binds, through any wrapper', () => {
  const forms = {
    Anonymous: 'export function Named() {\n  return <div />;\n}\nexport default class extends React.Component {\n  render() {\n    return <div />;\n  }\n}\n',
    Memo: 'function MemoInner() {\n  return <div />;\n}\nexport default memo(MemoInner);\n',
    Renamed: 'const RenamedInner = () => <div />;\nexport { RenamedInner as default };\n',
    Wrapped: 'function WrappedInner() {\n  return <div />;\n}\nexport default withRouter(connect(mapState)(WrappedInner))\n',
    Declared: 'export default function DeclaredInner() {\n  return <div />;\n}\n',
  };
  const { dir } = variant('default-forms', (root) => {
    mkdirSync(join(root, 'web', 'src', 'forms'), { recursive: true });
    for (const [file, body] of Object.entries(forms)) {
      writeFileSync(join(root, 'web', 'src', 'forms', `${file}.tsx`), `import React, { memo } from 'react';\n${body}`);
    }
  });
  try {
    const facts = JSON.parse(readFileSync(join(dir, 'out', 'facts', 'web.json'), 'utf8')).facts;
    const flagged = facts
      .filter((entry) => entry.type === 'component' && entry.file.startsWith('src/forms/') && entry.default === true)
      .map((entry) => entry.name)
      .sort();
    assert.deepEqual(flagged, ['DeclaredInner', 'MemoInner', 'RenamedInner', 'WrappedInner']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a rendered child no declaration settles is stated at its render site', () => {
  const { dir, config: variantConfig } = variant('render-unfound', (root) => {
    writeFileSync(
      join(root, 'web', 'src', 'zones', 'GhostParent.tsx'),
      "import React from 'react';\nimport { Link } from 'react-router-dom';\n" +
        "import Missing from './notes/MissingPanel';\nimport Elsewhere from './notes/WatcherNotesPanel';\n" +
        "import WatcherNotesPanel from './NoDefault';\nimport { ZoneOverviewPanel } from './NoDefault';\n" +
        "import ZoneRoutes from './Gone';\n\n" +
        'export function GhostParent() {\n  return (\n    <div>\n      <Missing />\n      <Link to="/zones" />\n' +
        '      <Unknown />\n      <Elsewhere />\n      <WatcherNotesPanel />\n      <ZoneOverviewPanel />\n' +
        '      <ZoneRoutes />\n    </div>\n  );\n}\n',
    );
    writeFileSync(
      join(root, 'web', 'src', 'zones', 'NoDefault.tsx'),
      "import React from 'react';\n\nexport function OtherPanel() {\n  return <div />;\n}\n",
    );
    const notes = join(root, 'web', 'src', 'zones', 'notes', 'WatcherNotesPanel.tsx');
    writeFileSync(notes, readFileSync(notes, 'utf8').replace('export default function', 'export function'));
  });
  try {
    const result = runCli(['span', '--from-component', 'GhostParent', '--json', '--config', variantConfig]);
    assert.equal(result.status, 0, result.stderr);
    const model = JSON.parse(result.stdout);
    assert.deepEqual(model.entries, []);
    const arms = model.unresolved.map(({ reason, attempted, file, line, source }) => ({ reason, attempted, file, line, source }));
    const unresolvedAt = (attempted, line, source) => ({ reason: 'component-unresolved', attempted, file: 'src/zones/GhostParent.tsx', line, source });
    assert.deepEqual(arms, [
      unresolvedAt('Elsewhere', 15, './notes/WatcherNotesPanel'),
      unresolvedAt('Missing', 12, './notes/MissingPanel'),
      unresolvedAt('Unknown', 14, undefined),
      unresolvedAt('WatcherNotesPanel', 16, './NoDefault'),
      unresolvedAt('ZoneOverviewPanel', 17, './NoDefault'),
      unresolvedAt('ZoneRoutes', 18, './Gone'),
    ]);
    const out = join(dir, 'ghost-parent.html');
    const page = runCli(['span', '--from-component', 'GhostParent', '--out', out, '--config', variantConfig]);
    assert.equal(page.status, 0, page.stderr);
    const html = readFileSync(out, 'utf8');
    assert.match(html, /6 arms unresolved/);
    assert.match(html, /component not found/);
    assert.match(html, /imported from \.\/notes\/MissingPanel/);
    assert.match(html, /imported from \.\/NoDefault/);
    assert.match(html, /src\/zones\/GhostParent\.tsx:14/);
    assert.doesNotMatch(html, /zones\/notes\/WatcherNotesPanel\.tsx|ZoneOverviewPanel\.tsx|ZoneRoutes\.tsx/);
    const tree = runCli(['trace', 'GhostParent', '--expand', '--config', variantConfig]);
    assert.equal(tree.status, 0, tree.stderr);
    assert.match(tree.stdout, /Missing.*unresolved.*imported from \.\/notes\/MissingPanel/);
    assert.match(tree.stdout, /WatcherNotesPanel.*unresolved.*imported from \.\/NoDefault/);
    assert.match(tree.stdout, /ZoneRoutes.*unresolved.*imported from \.\/Gone/);
    assert.match(tree.stdout, /Link/, 'a foreign child stays in the tree, only out of the arms');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an aliased render settles by its module and export, never by fact order or a borrowed local name', () => {
  const component = (file, name, extra = {}) => ({ type: 'component', file, line: 1, name, selector: name, role: 'component', ...extra });
  const entry = (file, name) => ({
    type: 'component_entry', file, line: 3, column: 3, component: name, kind: 'unknown',
    trigger: 'useLiveFeed', handler: null, guards: [], unresolved: 'custom-hook',
  });
  const module = (file, name, extra) => [component(file, name, extra), entry(file, name)];
  const parent = (render) => [
    component('src/Parent.tsx', 'Parent'),
    { type: 'renders', file: 'src/Parent.tsx', line: 5, from: 'Parent', ...render },
  ];
  const files = (model) => [...new Set(model.entries.map((view) => view.identity.file))];
  const declared = [
    ...module('src/a/Child.tsx', 'Child', { default: true }),
    ...module('src/b/Child.tsx', 'Child'),
    ...module('src/b/Child.tsx', 'Helper', { default: true }),
    ...module('src/Picked.tsx', 'Picked'),
    ...module('src/NoDefault.tsx', 'Other'),
    ...module('src/c/Mod.tsx', 'ModFile', { default: true }),
    ...module('src/c/Mod/index.tsx', 'ModFolder', { default: true }),
  ];
  for (const [render, expected, reason] of [
    [{ to: 'Picked', source: './a/Child', imported: 'default' }, ['src/a/Child.tsx']],
    [{ to: 'Picked', source: './b/Child', imported: 'default' }, ['src/b/Child.tsx']],
    [{ to: 'Picked', source: './b/Child', imported: 'Child' }, ['src/b/Child.tsx']],
    [{ to: 'Gone', source: './b/Missing', imported: 'default' }, []],
    [{ to: 'Picked', source: './a/Child', imported: 'Absent' }, []],
    [{ to: 'Picked', source: './barrel', imported: 'Helper' }, ['src/b/Child.tsx']],
    [{ to: 'Picked', source: './NoDefault', imported: 'default' }, []],
    [{ to: 'Picked', source: './b/Missing', imported: 'default' }, []],
    [{ to: 'Picked', source: './NoDefault', imported: 'Helper' }, []],
    [{ to: 'Other', source: './NoDefault', imported: 'default' }, []],
    [{ to: 'Helper', source: './a/Child' }, []],
    [{ to: 'Picked', source: './c/Mod', imported: 'default' }, [], 'component-ambiguous'],
    [{ to: 'Helper', source: '@app/Helper', imported: 'default' }, ['src/b/Child.tsx']],
  ]) {
    const label = JSON.stringify(render);
    for (const order of [declared, declared.slice().reverse()]) {
      const model = componentSpan([{ repo: 'web', kind: 'web', facts: [...parent(render), ...order] }], 'Parent');
      const names = [...new Set(model.entries.map((view) => view.identity.component))];
      assert.deepEqual(files(model), expected, label);
      if (expected.length > 0) assert.equal(names.length, 1, `${label} enters one declaration`);
      const reasons = expected.length > 0 ? ['entry-unresolved'] : [reason || 'component-unresolved'];
      assert.deepEqual(model.unresolved.map((arm) => arm.reason), reasons, label);
    }
  }
  const lazyFrom = (module, facts) => componentSpan(
    [{ repo: 'web', kind: 'web', facts: [
      ...parent({ to: 'Lazy' }),
      component('src/Parent.tsx', 'Lazy', { line: 2, lazy: module }),
      ...facts,
    ] }],
    'Parent',
  );
  const noDefault = lazyFrom('./NoDefault', [...declared, ...module('src/Lazy.tsx', 'Lazy')]);
  assert.deepEqual(files(noDefault), [], 'a lazy binding of a module with no default enters no other declaration');
  assert.deepEqual(noDefault.unresolved.map((arm) => arm.reason), ['component-unresolved']);
  const unflagged = declared.map((fact) => {
    const { default: _flag, ...rest } = fact;
    return rest;
  });
  const legacy = lazyFrom('./NoDefault', [...unflagged, ...module('src/Lazy.tsx', 'Lazy')]);
  assert.deepEqual(files(legacy), [], 'facts without the default flag still enter nothing the named module does not declare');
  assert.deepEqual(legacy.unresolved.map((arm) => arm.reason), ['component-unresolved']);
  const named = componentSpan(
    [{ repo: 'web', kind: 'web', facts: [...parent({ to: 'Picked', source: './NoDefault' }), ...unflagged] }],
    'Parent',
  );
  assert.deepEqual(files(named), [], 'a named import its module does not declare enters no same-named declaration');
  const loaded = componentSpan(
    [{ repo: 'web', kind: 'web', facts: [
      ...parent({ to: 'Lazy' }),
      component('src/Parent.tsx', 'Lazy', { line: 2, lazy: './b/Child' }),
      ...declared,
    ] }],
    'Parent',
  );
  assert.deepEqual([...new Set(loaded.entries.map((view) => view.identity.component))], ['Helper'], 'a lazy binding loads the default export');
});

test('a selected page never overwrites a page another entry already holds under its name', () => {
  const { dir, config: variantConfig } = variant('page-claim', () => {});
  try {
    const select = (selector) => {
      const run = runCli(
        ['span', '--from-component', 'WatcherNotesPanel', '--entry', selector, '--config', variantConfig],
        { cwd: dir },
      );
      assert.equal(run.status, 0, run.stderr);
      return run.stdout.slice(run.stdout.lastIndexOf(' -> ') + 4).trim();
    };
    const other = select('useEffect@29');
    const own = select('useEffect@25');
    const otherPage = readFileSync(other, 'utf8');
    // Two keys whose names collide are simulated by handing this entry's name to the other's page.
    writeFileSync(own, otherPage);
    const moved = select('useEffect@25');
    assert.notEqual(moved, own, 'a name held by another entry is not this entry\'s to overwrite');
    assert.equal(readFileSync(own, 'utf8'), otherPage, 'the page already there is left as it was');
    assert.ok(readFileSync(moved, 'utf8').includes('useEffect@25'), 'the moved page states its own entry');
    assert.equal(select('useEffect@25'), moved, 'the same entry finds its own page again on the next run');
    assert.equal(select('useEffect@29'), other, 'a page keeps its name while it holds its own key');
    writeFileSync(own, '<!doctype html><title>written before pages carried a key</title>\n');
    assert.equal(select('useEffect@25'), own, 'a page that carries no key is replaced, as every page was before keys');
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
