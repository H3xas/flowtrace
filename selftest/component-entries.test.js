/**
 * Component entries: how execution reaches a web component, and how that reaching is kept
 * apart on the way out. The extractor states one `component_entry` per lifecycle callback,
 * hook effect, effect cleanup and unread trigger; the walk carries the entry below it; the
 * component span attributes every arm to the entry that reached it and can be narrowed to
 * one entry at a time.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
    effects.map((entry) => [entry.line, entry.deps, entry.handler, entry.depsUnknown]),
    [
      [25, [], null, undefined],
      [29, ['draft'], null, undefined],
      [36, ['readings'], 'refresh', undefined],
      [42, undefined, null, true],
    ],
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
    ],
  );
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
  assert.deepEqual(unread.map((arm) => arm.cause).sort(), ['custom-hook', 'dynamic-callback']);
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

test('the pack states one entry per trigger and none for the foreign hooks it also calls', () => {
  const triggers = webFacts()
    .filter((fact) => fact.type === 'component_entry')
    .map((fact) => `${fact.component}|${fact.trigger}@${fact.line}`);
  assert.deepEqual(triggers, [
    'ZoneOverviewPanel|componentDidMount@15',
    'ZonesLandingPanel|componentDidMount@13',
    'WatcherPreferencesPage|useEffect@15',
    'WatcherNotesPanel|useEffect@25',
    'WatcherNotesPanel|useEffect@29',
    'WatcherNotesPanel|useEffect@31',
    'WatcherNotesPanel|useEffect@36',
    'WatcherNotesPanel|useEffect@38',
    'WatcherNotesPanel|useEffect@42',
    'WatcherNotesPanel|useNoteDraft@19',
  ]);
});
