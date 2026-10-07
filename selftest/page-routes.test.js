/**
 * `trace <browser path>` against the orchard routes matrix: a nested URL resolves to one page
 * entry through a mount chain whose every segment names where it came from, or fails with a
 * reason that says which boundary stopped it. The expectations live in the fixture's
 * `matrix.json`; the tests below also check the detail each row rests on.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { buildPageRouteIndex, createPageLookup } from '../lib/page-routes.js';
import { copyFixture, runCli } from './helpers.js';

const FIXTURE = 'orchard-routes';

function prepare(t) {
  const dir = copyFixture(t, FIXTURE);
  for (const config of ['orchard.config.json', 'orchard-mounted.config.json']) {
    const extracted = runCli(['extract', '--config', config], { cwd: dir });
    assert.equal(extracted.status, 0, extracted.stderr);
  }
  return dir;
}

function traceJson(dir, start, config = 'orchard.config.json') {
  const result = runCli(['trace', start, '--config', config, '--json'], { cwd: dir });
  return { ...result, document: result.stdout.trim() === '' ? null : JSON.parse(result.stdout) };
}

function entryOf(document) {
  return `${document.root.file}#${document.root.ref}`;
}

function chainSites(document) {
  return document.root.mount.chain.map((segment) => `${segment.kind} ${segment.file ?? '-'}:${segment.line ?? '-'} ${segment.source}`);
}

test('every matrix row resolves to its expected entry or fails with its expected reason', (t) => {
  const dir = prepare(t);
  const matrix = JSON.parse(readFileSync(join(dir, 'matrix.json'), 'utf8'));
  for (const row of matrix.rows) {
    const { status, document, stderr } = traceJson(dir, row.start, row.config);
    if (row.expect.entry) {
      assert.equal(status, 0, `${row.id}: ${stderr}`);
      assert.equal(entryOf(document), row.expect.entry, row.id);
    } else {
      assert.equal(status, 2, `${row.id} must not resolve`);
      assert.equal(document.reason, row.expect.reason, row.id);
      assert.equal(document.root, undefined, `${row.id}: a failed lookup carries no page`);
      assert.equal(document.nodes, undefined, `${row.id}: a failed lookup carries no walk`);
    }
  }
});

test('a nested URL composes the app-root mount, layout, absolute child and lazy import into one page', (t) => {
  const dir = prepare(t);
  const { document } = traceJson(dir, '/orchard/harvest/crates');
  assert.equal(document.root.kind, 'page');
  assert.equal(document.root.pagePath, '/orchard/harvest/crates');
  assert.equal(document.root.inferred, false, 'every segment is declared in source');
  assert.deepEqual(document.root.mount.host, { source: 'declared', path: '/orchard', root: 'OrchardApp', file: 'src/index.tsx', line: 7 });
  assert.deepEqual(chainSites(document), [
    'route src/OrchardApp.tsx:35 declared',
    'route src/OrchardApp.tsx:41 declared',
    'route src/harvest/HarvestRoutes.tsx:11 declared',
    'lazy src/harvest/HarvestRoutes.tsx:5 declared',
  ]);
  const mounts = document.nodes.filter((node) => node.kind === 'mount');
  assert.deepEqual(
    mounts.map((node) => `${node.file}:${node.line}`),
    ['src/index.tsx:7', 'src/OrchardApp.tsx:35', 'src/OrchardApp.tsx:41', 'src/harvest/HarvestRoutes.tsx:11', 'src/harvest/HarvestRoutes.tsx:5'],
    'the chain is part of the walk, so every segment is a node a reader can open',
  );
  assert.ok(mounts.every((node) => node.via === 'mount' && node.hops === 0), 'a mount hop spends no depth');
});

test('relative children, index routes and parameters compose under their parents', (t) => {
  const dir = prepare(t);
  const home = traceJson(dir, '/orchard').document;
  assert.equal(entryOf(home), 'src/landing/OrchardHome.tsx#OrchardHome', 'an index route answers for its parent path, not the layout');
  assert.deepEqual(home.root.mount.chain.map((segment) => segment.kind), ['route', 'index']);

  const concrete = traceJson(dir, '/orchard/rows/r-17').document;
  assert.equal(concrete.root.pagePath, '/orchard/rows/:rowId');
  assert.equal(concrete.root.url, '/orchard/rows/r-17');
  assert.equal(entryOf(concrete), 'src/rows/RowDetail.tsx#RowDetail', 'the imported file decides between two components of one name');
});

test('a redirect is followed once and stays visible in the chain', (t) => {
  const dir = prepare(t);
  const { document } = traceJson(dir, '/orchard/old-rows');
  assert.equal(entryOf(document), 'src/rows/RowList.tsx#RowList');
  const redirect = document.root.mount.chain.find((segment) => segment.kind === 'redirect');
  assert.deepEqual(
    { file: redirect.file, line: redirect.line, from: redirect.from, to: redirect.to },
    { file: 'src/OrchardApp.tsx', line: 42, from: '/orchard/old-rows', to: '/orchard/rows' },
  );
});

test('a wildcard leaf keeps the unmatched remainder visible', (t) => {
  const dir = prepare(t);
  const { document } = traceJson(dir, '/orchard/reports/2026/summary');
  assert.equal(document.root.pagePath, '/orchard/reports/*');
  assert.equal(document.root.mount.remainder, '2026/summary');
});

test('an unknown host stays a labelled boundary: read from the root or behind an inferred prefix, never declared', (t) => {
  const dir = prepare(t);
  const fromRoot = traceJson(dir, '/partners').document;
  assert.equal(fromRoot.root.inferred, true);
  assert.equal(fromRoot.root.mount.host.source, 'assumed');
  assert.equal(fromRoot.root.mount.host.root, 'PartnerRoutes');
  assert.match(fromRoot.root.mount.host.boundary, /not declared/);

  const prefixed = traceJson(dir, '/orchard/partners').document;
  assert.equal(prefixed.root.inferred, true);
  assert.equal(prefixed.root.mountPrefix, '/orchard');
  assert.equal(prefixed.root.mount.host.source, 'inferred');
  assert.equal(prefixed.root.mount.host.evidence, 2, 'the prefix names how many navigate() literals agree');
  assert.ok(prefixed.root.mount.host.file, 'an inferred prefix names a literal it was read from');

  const text = runCli(['trace', '/orchard/partners', '--config', 'orchard.config.json'], { cwd: dir });
  assert.match(text.stdout, /^PartnerDirectory .*inferred mount \/orchard/m);
});

test('a URL below an unmounted root with an unknown prefix reports the missing mount, and a configured mount resolves it', (t) => {
  const dir = prepare(t);
  const missing = traceJson(dir, '/portal/partners').document;
  assert.equal(missing.reason, 'missing-mount');
  assert.equal(missing.status, 'unresolved');
  assert.ok(missing.frontier.some((entry) => entry.root === 'PartnerRoutes' && entry.unmatched === '/portal'));

  const configured = traceJson(dir, '/portal/partners', 'orchard-mounted.config.json').document;
  assert.equal(entryOf(configured), 'src/partners/PartnerDirectory.tsx#PartnerDirectory');
  assert.equal(configured.root.inferred, false);
  assert.deepEqual(configured.root.mount.host, { source: 'configuration', path: '/portal', root: 'PartnerRoutes', key: 'repos[web].mounts.PartnerRoutes' });
  assert.equal(traceJson(dir, '/partners', 'orchard-mounted.config.json').document.reason, 'no-declaration', 'a configured mount replaces the guessed readings');
});

test('mutually exclusive guarded routes stay alternatives until a configured assumption picks one', (t) => {
  const dir = prepare(t);
  const open = traceJson(dir, '/orchard/pruning').document;
  assert.equal(open.reason, 'ambiguous');
  assert.equal(open.candidates.length, 2);
  assert.ok(open.candidates.some((label) => /PruningPlannerPage .*\[when features\.pruningPlanner\]/.test(label)));
  assert.ok(open.candidates.some((label) => /PruningLegacyPage .*\[unless features\.pruningPlanner\]/.test(label)));

  const assumed = traceJson(dir, '/orchard/pruning', 'orchard-mounted.config.json').document;
  assert.equal(entryOf(assumed), 'src/pruning/PruningPlannerPage.tsx#PruningPlannerPage');
  assert.deepEqual(assumed.root.mount.assumptions, [
    { condition: 'features.pruningPlanner', value: true, source: 'configuration', file: 'src/OrchardApp.tsx', line: 43 },
  ]);
  const text = runCli(['trace', '/orchard/pruning', '--config', 'orchard-mounted.config.json'], { cwd: dir });
  assert.match(text.stdout, /assumes features\.pruningPlanner=true/);
});

test('an access wrapper is a guard on the page it wraps, not the page', (t) => {
  const dir = prepare(t);
  const { document } = traceJson(dir, '/orchard/irrigation');
  assert.equal(entryOf(document), 'src/irrigation/IrrigationPage.tsx#IrrigationPage');
  assert.deepEqual(document.root.mount.guards, [
    { kind: 'wrapper', text: '<RequireCrew role="irrigator">', file: 'src/OrchardApp.tsx', line: 51 },
  ]);
});

test('an unsupported route declaration is named as the frontier instead of being guessed through', (t) => {
  const dir = prepare(t);
  const expression = traceJson(dir, '/orchard/mystery/shelf').document;
  assert.equal(expression.reason, 'unsupported-expression');
  assert.ok(expression.frontier.some((entry) => entry.file === 'src/OrchardApp.tsx' && entry.line === 57 && entry.unsupported === 'path-expression'));

  const objects = traceJson(dir, '/orchard/shed/tools').document;
  assert.equal(objects.reason, 'unsupported-expression');
  assert.ok(objects.frontier.some((entry) => entry.file === 'src/shed/ShedRoutes.tsx' && entry.unsupported === 'route-object'));
});

test('duplicate mounts and conflicting lazy aliases are candidates with file qualifiers, in a stable order', (t) => {
  const dir = prepare(t);
  const first = traceJson(dir, '/ledger').document;
  const second = traceJson(dir, '/ledger').document;
  assert.equal(first.reason, 'ambiguous');
  assert.deepEqual(first.candidates, second.candidates);
  assert.ok(first.candidates[0].includes('src/audit/AuditLedger.tsx'));
  assert.ok(first.candidates[1].includes('src/partners/PartnerLedger.tsx'));

  const aliases = traceJson(dir, 'LedgerPage').document;
  assert.equal(aliases.reason, 'ambiguous');
  assert.ok(aliases.candidates.some((label) => label.includes('src/audit/AuditLedger.tsx')));
  assert.ok(aliases.candidates.some((label) => label.includes('src/partners/PartnerLedger.tsx')));
});

test('the URL and the component name lead to the same qualified entry', (t) => {
  const dir = prepare(t);
  const byUrl = traceJson(dir, '/orchard/harvest/crates').document.root;
  const byName = traceJson(dir, 'CrateLedgerPage').document.root;
  assert.deepEqual(
    { repo: byName.repo, kind: byName.kind, ref: byName.ref, file: byName.file, line: byName.line },
    { repo: byUrl.repo, kind: byUrl.kind, ref: byUrl.ref, file: byUrl.file, line: byUrl.line },
  );
});

test('text, JSON and HTML carry the same failure reason, and a failed lookup is never drawn as an empty page', (t) => {
  const dir = prepare(t);
  for (const [start, reason] of [
    ['/portal/partners', 'missing-mount'],
    ['/orchard/mystery/shelf', 'unsupported-expression'],
    ['/nowhere/at/all', 'no-declaration'],
    ['/ledger', 'ambiguous'],
  ]) {
    const json = traceJson(dir, start).document;
    assert.equal(json.reason, reason, start);
    assert.equal(json.schemaVersion, 1);
    assert.equal(json.start, start);

    const text = runCli(['trace', start, '--config', 'orchard.config.json'], { cwd: dir });
    assert.equal(text.status, 2);
    assert.equal(text.stdout, '', `${start}: no tree is printed for a failed lookup`);
    assert.match(text.stderr, new RegExp(`^reason: ${reason}$`, 'm'), start);

    const html = runCli(['trace', start, '--config', 'orchard.config.json', '--html', 'out/failed.html'], { cwd: dir });
    assert.equal(html.status, 2);
    const page = readFileSync(join(dir, 'out', 'failed.html'), 'utf8');
    assert.match(page, new RegExp(`data-reason="${reason}"`), start);
    assert.doesNotMatch(page, /class="tree"/, `${start}: the page draws no tree`);
  }
});

test('a component-name start keeps its meaning when a lazy binding shares the name', (t) => {
  const dir = prepare(t);
  const byName = traceJson(dir, 'PartnerDirectory').document;
  assert.equal(entryOf(byName), 'src/partners/PartnerDirectory.tsx#PartnerDirectory');
  assert.equal(byName.root.mount, undefined, 'a name start is not a URL start and carries no mount chain');
});

/** A throwaway web repository written from `files`, extracted under `config`, for shapes the matrix does not hold. */
function inlineRepo(t, files, repoExtra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'flowtrace-routes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, 'web', path)), { recursive: true });
    writeFileSync(join(dir, 'web', path), text);
  }
  writeFileSync(join(dir, 'inline.config.json'), JSON.stringify({ out: 'out', repos: [{ id: 'web', kind: 'web', root: 'web', ...repoExtra }] }));
  const extracted = runCli(['extract', '--config', 'inline.config.json'], { cwd: dir });
  assert.equal(extracted.status, 0, extracted.stderr);
  return (start) => traceJson(dir, start, 'inline.config.json');
}

const page = (name) => `import React from 'react';\n\nexport default function ${name}() {\n  return <div />;\n}\n`;

test('a root rendered through a held createRoot handle is a declared mount', (t) => {
  const trace = inlineRepo(t, {
    'src/main.tsx': [
      "import React from 'react';",
      "import { createRoot } from 'react-dom/client';",
      "import { HashRouter } from 'react-router-dom';",
      "import Shell from './Shell';",
      '',
      "const root = createRoot(document.getElementById('app') as HTMLElement);",
      'root.render(',
      '  <HashRouter basename="/greens">',
      '    <Shell />',
      '  </HashRouter>,',
      ');',
      '',
    ].join('\n'),
    'src/Shell.tsx': [
      "import React from 'react';",
      "import { Route, Routes } from 'react-router-dom';",
      "import Beds from './Beds';",
      '',
      'export default function Shell() {',
      '  return (',
      '    <Routes>',
      '      <Route path="beds" element={<Beds />} />',
      '    </Routes>',
      '  );',
      '}',
      '',
    ].join('\n'),
    'src/Beds.tsx': page('Beds'),
  });
  const { document } = trace('/greens/beds?sort=name#top');
  assert.equal(document.root.ref, 'Beds', 'a query string and a fragment are not path segments');
  assert.equal(document.root.inferred, false);
  assert.deepEqual(document.root.mount.host, { source: 'declared', path: '/greens', root: 'Shell', file: 'src/main.tsx', line: 8 });
});

test('an unreadable root basename leaves a source-qualified frontier until configuration supplies the host', (t) => {
  const files = {
    'src/main.tsx': [
      "import React from 'react';",
      "import { createRoot } from 'react-dom/client';",
      "import { BrowserRouter } from 'react-router-dom';",
      "import Shell from './Shell';",
      'const hostBase = window.location.pathname;',
      "createRoot(document.getElementById('app')).render(",
      '  <BrowserRouter basename={hostBase}><Shell /></BrowserRouter>,',
      ');',
    ].join('\n'),
    'src/Shell.tsx': [
      "import React from 'react';",
      "import { Route, Routes } from 'react-router-dom';",
      "import Beds from './Beds';",
      'export default function Shell() {',
      '  return <Routes><Route index element={<Beds />} /><Route path="beds" element={<Beds />} /></Routes>;',
      '}',
    ].join('\n'),
    'src/Beds.tsx': page('Beds'),
  };
  const trace = inlineRepo(t, files);
  for (const start of ['/', '/beds', '/host/beds']) {
    const result = trace(start);
    assert.equal(result.status, 2, start);
    assert.equal(result.document.reason, 'unsupported-expression', start);
    assert.equal(result.document.root, undefined, start);
    assert.ok(result.document.frontier.some((entry) => entry.file === 'src/main.tsx' && entry.line === 7 && entry.unsupported === 'basename-expression'), start);
  }

  const configured = inlineRepo(t, files, { mounts: { Shell: '/host' } });
  const resolved = configured('/host/beds').document;
  assert.equal(resolved.root.ref, 'Beds');
  assert.equal(resolved.root.inferred, false);
  assert.equal(resolved.root.mount.host.source, 'configuration');
  assert.equal(configured('/beds').document.reason, 'unsupported-expression');
});

test('an unreadable basename on a router inside a component cannot declare the root mount', (t) => {
  const trace = inlineRepo(t, {
    'src/Shell.tsx': [
      "import React from 'react';",
      "import { BrowserRouter, Route, Routes } from 'react-router-dom';",
      "import Beds from './Beds';",
      'export default function Shell({ hostBase }) {',
      '  return <BrowserRouter basename={hostBase}><Routes><Route path="beds" element={<Beds />} /></Routes></BrowserRouter>;',
      '}',
    ].join('\n'),
    'src/Beds.tsx': page('Beds'),
  });
  const result = trace('/beds');
  assert.equal(result.status, 2);
  assert.equal(result.document.reason, 'unsupported-expression');
  assert.ok(result.document.frontier.some((entry) => entry.file === 'src/Shell.tsx' && entry.line === 5 && entry.unsupported === 'basename-expression'));
});

test('a stored unsupported mount with an older root placeholder remains non-authoritative', () => {
  const index = buildPageRouteIndex([{ repo: 'web', kind: 'web', facts: [
    { type: 'component', file: 'src/Shell.tsx', line: 1, name: 'Shell' },
    { type: 'component', file: 'src/Beds.tsx', line: 1, name: 'Beds' },
    { type: 'page_route', file: 'src/Shell.tsx', line: 2, owner: 'Shell', path: 'beds', element: 'Beds', elementFile: 'src/Beds.tsx' },
    { type: 'page_mount', file: 'src/main.tsx', line: 3, component: 'Shell', path: '/', source: 'app-root', unsupported: 'basename-expression' },
  ] }]);
  const result = createPageLookup(index).lookup('/beds');
  assert.equal(result.reason, 'unsupported-expression');
  assert.ok(result.frontier.some((entry) => entry.file === 'src/main.tsx' && entry.unsupported === 'basename-expression'));
});

test('a component holding its own routes answers only at its own path, and a mount cycle ends', (t) => {
  const trace = inlineRepo(t, {
    'src/Loop.tsx': [
      "import React from 'react';",
      "import { Route, Routes } from 'react-router-dom';",
      "import Other from './Other';",
      '',
      'export default function Loop() {',
      '  return (',
      '    <Routes>',
      '      <Route path="other/*" element={<Other />} />',
      '    </Routes>',
      '  );',
      '}',
      '',
    ].join('\n'),
    'src/Other.tsx': [
      "import React from 'react';",
      "import { Route, Routes } from 'react-router-dom';",
      "import Loop from './Loop';",
      "import Leaf from './Leaf';",
      '',
      'export default function Other() {',
      '  return (',
      '    <Routes>',
      '      <Route path="loop/*" element={<Loop />} />',
      '      <Route path="leaf" element={<Leaf />} />',
      '    </Routes>',
      '  );',
      '}',
      '',
    ].join('\n'),
    'src/Leaf.tsx': page('Leaf'),
  });
  const leaf = trace('/other/leaf');
  assert.equal(leaf.status, 0, leaf.stderr);
  assert.equal(leaf.document.root.ref, 'Leaf');
  assert.equal(trace('/other').document.root.ref, 'Other', 'the routes owner itself renders at its own path');
  assert.equal(trace('/other/elsewhere').document.reason, 'no-declaration', 'below its path only its routes answer');
});

test('a single guarded route resolves with its guard shown, and a negated assumption can exclude it', (t) => {
  const files = {
    'src/App.tsx': [
      "import React from 'react';",
      "import { Route, Routes } from 'react-router-dom';",
      "import Compost from './Compost';",
      "import Beta from './Beta';",
      "import Stable from './Stable';",
      '',
      'export function App({ flags }: { flags: { compost: boolean; beta: boolean } }) {',
      '  return (',
      '    <Routes>',
      '      {flags.compost && <Route path="compost" element={<Compost />} />}',
      '      <Route path="beds" element={flags.beta ? <Beta /> : <Stable />} />',
      '      <Route path="seeds/:variety?" element={<Stable />} />',
      '    </Routes>',
      '  );',
      '}',
      '',
    ].join('\n'),
    'src/Compost.tsx': page('Compost'),
    'src/Beta.tsx': page('Beta'),
    'src/Stable.tsx': page('Stable'),
  };
  const open = inlineRepo(t, files);
  const compost = open('/compost').document;
  assert.equal(compost.root.ref, 'Compost');
  assert.deepEqual(compost.root.mount.guards.map((guard) => [guard.kind, guard.text, guard.branch]), [['condition', 'flags.compost', 'then']]);
  assert.equal(open('/beds').document.reason, 'ambiguous', 'the two arms of an element condition are alternatives');
  const optional = open('/seeds/tomato').document;
  assert.equal(optional.reason, 'unsupported-expression', 'an optional segment is named, not guessed');
  assert.ok(optional.frontier.some((entry) => entry.unsupported === 'optional-segment'));

  const assumed = inlineRepo(t, files, { routeAssumptions: { '!flags.compost': true, 'flags.beta': false } });
  const excluded = assumed('/compost').document;
  assert.equal(excluded.reason, 'no-declaration');
  assert.match(excluded.message, /excluded by configured assumptions/);
  const stable = assumed('/beds').document;
  assert.equal(stable.root.ref, 'Stable');
  assert.deepEqual(stable.root.mount.assumptions.map((entry) => [entry.condition, entry.value]), [['flags.beta', false]]);
});

test('a URL start walks the same page as its name start, joining requests through the same existing rules', (t) => {
  const dir = copyFixture(t, 'greenhouse-alerts');
  const extracted = runCli(['extract', '--config', 'greenhouse.config.json'], { cwd: dir });
  assert.equal(extracted.status, 0, extracted.stderr);
  const walk = (start) => {
    const result = runCli(['trace', start, '--config', 'greenhouse.config.json', '--json'], { cwd: dir });
    assert.equal(result.status, 0, `${start}: ${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  const byUrl = walk('/greenhouse/zones/:zoneId/alerts/watchers');
  const byName = walk('WatcherPreferencesPage');
  const routes = (document) => document.nodes.filter((node) => node.kind === 'route').map((node) => `${node.ref} [${node.via}]`).sort();
  assert.deepEqual(routes(byUrl), routes(byName));
  assert.ok(routes(byUrl).includes('PUT glasshouse/v1/zones/*/watchers [alias]'), 'the gateway request joins its backend route through the configured alias');
  assert.deepEqual(
    byUrl.nodes.filter((node) => node.kind !== 'mount' && node.id !== byUrl.root.id).map((node) => `${node.kind} ${node.ref} ${node.file}:${node.line}`),
    byName.nodes.filter((node) => node.id !== byName.root.id).map((node) => `${node.kind} ${node.ref} ${node.file}:${node.line}`),
    'below the mount chain the two walks are the same walk',
  );
  assert.equal(walk('PUT glasshouse/v1/zones/{zoneId}/watchers').root.kind, 'route', 'a route key keeps resolving to its backend route');
});

/** The extracted `page_route` and `page_mount` facts one fixture repository wrote. */
function routeFacts(dir, repo = 'web') {
  const document = JSON.parse(readFileSync(join(dir, 'out', 'facts', `${repo}.json`), 'utf8'));
  return document.facts.filter((fact) => fact.type === 'page_route' || fact.type === 'page_mount');
}

test('Page routes C8: an array entry is one page route naming its entry site and its rendering .map site', (t) => {
  const dir = prepare(t);
  const ferment = routeFacts(dir).filter((fact) => fact.type === 'page_route' && fact.path === '/ferment');
  assert.equal(ferment.length, 1, 'one page_route per array entry, not one per .map');
  const [fact] = ferment;
  assert.equal(fact.owner, 'PressRoutes');
  assert.equal(fact.element, 'FermentList');
  assert.equal(fact.elementFile, 'src/pressing/FermentList.tsx');
  assert.equal(fact.line, 36, 'the fact sits on the rendering <Route> the .map writes');
  assert.equal(fact.entryFile, 'src/pressing/PressRoutes.tsx');
  assert.equal(fact.entryLine, 19, 'and names the array entry it came from');
  assert.deepEqual(fact.guards, [{ kind: 'condition', text: 'features.ferment', branch: 'then', file: 'src/pressing/PressRoutes.tsx', line: 19 }]);

  const { document } = traceJson(dir, '/orchard/pressing/ferment');
  assert.equal(entryOf(document), 'src/pressing/FermentList.tsx#FermentList');
  assert.equal(document.root.inferred, false);
  const segment = document.root.mount.chain.find((entry) => entry.path === '/ferment');
  assert.equal(segment.file, 'src/pressing/PressRoutes.tsx');
  assert.equal(segment.line, 36);
  assert.equal(segment.entryLine, 19, 'the chain names both sites');
  const node = document.nodes.find((entry) => entry.kind === 'mount' && entry.file === 'src/pressing/PressRoutes.tsx' && entry.line === 36);
  assert.equal(node.ref, 'route /ferment → FermentList');
  assert.equal(node.entryLine, 19, 'and the walk opens both sites');
});

test('Page routes C8: a route array passed through one JSX prop resolves, spread constant objects included', (t) => {
  const dir = prepare(t);
  const rack = traceJson(dir, '/orchard/cellar/rack').document;
  assert.equal(entryOf(rack), 'src/cellar/RackList.tsx#RackList');
  assert.equal(rack.root.inferred, false, 'the array entry is declared, not read from the root');
  const entry = rack.root.mount.chain.find((segment) => segment.entryFile === 'src/cellar/cellarEntries.tsx' && segment.entryLine === 7);
  assert.equal(entry.file, 'src/cellar/CellarLayout.tsx');
  assert.equal(entry.line, 8, 'the .map that renders it is the second site');
  assert.ok(rack.root.mount.chain.some((segment) => segment.kind === 'render' && segment.from === 'CellarSettings'), 'the prop hop stays visible');

  assert.equal(entryOf(traceJson(dir, '/orchard/cellar/casks').document), 'src/cellar/CaskShelf.tsx#CaskShelf');
  assert.equal(entryOf(traceJson(dir, '/orchard/storehouse/bins').document), 'src/storehouse/BinList.tsx#BinList', 'an array imported by the mapping component needs no prop hop');
  assert.equal(entryOf(traceJson(dir, '/orchard/pressing/press-archive').document), 'src/pressing/PressArchive.tsx#PressArchive', 'a spread of a same-module constant object is one entry');
  const spread = traceJson(dir, '/orchard/pressing/press-archive').document;
  assert.deepEqual(spread.root.mount.guards, [{ kind: 'condition', text: 'features.pressArchive', branch: 'then', file: 'src/pressing/PressRoutes.tsx', line: 15 }], 'the spread object states the guard');
});

test('Page routes C8: a wildcard-interpolated array path and a loop-bound element keep the remainder', (t) => {
  const dir = prepare(t);
  const pane = traceJson(dir, '/orchard/queues/42/history').document;
  assert.equal(entryOf(pane), 'src/queues/QueuePane.tsx#QueuePane');
  assert.equal(pane.root.pagePath, '/orchard/queues/:queueId/*');
  assert.equal(pane.root.mount.remainder, 'history');
  assert.equal(entryOf(traceJson(dir, '/orchard/queues/head').document), 'src/queues/QueueHead.tsx#QueueHead');
});

test('Page routes C8: a .filter predicate guards each entry, and a configured assumption picks one alternative', (t) => {
  const dir = prepare(t);
  const open = traceJson(dir, '/orchard/pressing/tank').document;
  assert.equal(open.reason, 'ambiguous');
  assert.equal(open.candidates.length, 2);
  assert.ok(open.candidates.some((label) => /TankGauge .*\[when features\.tankGauge\]/.test(label)));
  assert.ok(open.candidates.some((label) => /TankProbe .*\[when features\.tankProbe\]/.test(label)));

  const assumed = traceJson(dir, '/orchard/pressing/tank', 'orchard-mounted.config.json').document;
  assert.equal(entryOf(assumed), 'src/pressing/TankGauge.tsx#TankGauge');
  assert.deepEqual(assumed.root.mount.assumptions, [
    { condition: 'features.tankGauge', value: true, source: 'configuration', file: 'src/pressing/PressRoutes.tsx', line: 22 },
  ]);
  assert.deepEqual(traceJson(dir, '/orchard/pressing/press-bench').document.root.mount.guards, [], 'a literal `true` is not a guard');
});

test('Page routes C8: a computed array, a second prop hop and an unreadable path are frontiers, never routes', (t) => {
  const dir = prepare(t);
  const computed = traceJson(dir, '/orchard/spare/shelf').document;
  assert.equal(computed.reason, 'unsupported-expression');
  assert.ok(computed.frontier.some((entry) => entry.file === 'src/spare/SpareRoutes.tsx' && entry.line === 29 && entry.unsupported === 'route-array-expression'));

  const hop = traceJson(dir, '/orchard/double/gate').document;
  assert.equal(hop.reason, 'unsupported-expression');
  assert.ok(hop.frontier.some((entry) => entry.file === 'src/double/DoubleRoutes.tsx' && entry.line === 8 && entry.unsupported === 'route-array-unresolved'));

  const unreadable = traceJson(dir, '/orchard/annex/annex-ledger').document;
  assert.equal(unreadable.reason, 'unsupported-expression');
  assert.ok(unreadable.frontier.some((entry) => entry.file === 'src/annex/AnnexRoutes.tsx' && entry.line === 15 && entry.unsupported === 'path-expression' && entry.pathText === 'annexSection'), 'the unreadable path is named, not guessed');
});

test('Page routes C8: a literal that is only part of a larger expression declares no route', (t) => {
  const dir = prepare(t);
  const facts = routeFacts(dir).filter((fact) => fact.owner === 'SpareRoutes');
  for (const path of ['/ledge', '/joist', '/post', '/sill']) {
    assert.equal(
      facts.filter((fact) => fact.type === 'page_route' && fact.path === path).length,
      0,
      `${path} is not the whole of what its site states`,
    );
  }

  const concatenated = traceJson(dir, '/orchard/spare/ledge').document;
  assert.equal(concatenated.reason, 'unsupported-expression');
  assert.ok(
    concatenated.frontier.some((entry) => entry.file === 'src/spare/SpareRoutes.tsx' && entry.line === 32 && entry.unsupported === 'route-array-expression'),
    'the first operand of a concatenation is not the array the .map iterates',
  );

  const tailed = traceJson(dir, '/orchard/spare/post').document;
  assert.equal(tailed.reason, 'unsupported-expression');
  assert.ok(
    tailed.frontier.some((entry) => entry.file === 'src/spare/SpareRoutes.tsx' && entry.line === 35 && entry.unsupported === 'route-array-expression'),
    'an entry read off an object literal is not that object',
  );

  const spread = traceJson(dir, '/orchard/spare/sill').document;
  assert.equal(spread.reason, 'unsupported-expression');
  assert.ok(
    spread.frontier.some((entry) => entry.file === 'src/spare/SpareRoutes.tsx' && entry.line === 38 && entry.unsupported === 'route-array-expression'),
    'a spread of a value read off an object literal is not that object',
  );
});

test('Page routes C8: a .map that renders no <Route> declares no route, even when its objects carry a path', (t) => {
  const dir = prepare(t);
  const facts = routeFacts(dir);
  assert.equal(facts.filter((fact) => fact.path === '/journal').length, 0, 'the sidebar array declares nothing');
  assert.equal(facts.filter((fact) => fact.type === 'page_route' && fact.owner === 'PressRoutes' && fact.line > 36).length, 0, 'and no fact sits at the sidebar .map');
  // The URL still cannot resolve: no route declares it.
  const { status, document } = traceJson(dir, '/orchard/pressing/journal');
  assert.equal(status, 2);
  assert.equal(document.root, undefined);
});

test('a prop supplies a route array only from a site that renders that component', (t) => {
  const mapping = [
    "import React from 'react';",
    "import { Route, Routes } from 'react-router-dom';",
    '',
    'export function Panel({ entries }: { entries: any[] }) {',
    '  return (',
    '    <Routes>',
    '      {entries.map((entry) => (',
    '        <Route path={entry.path} element={entry.component} key={entry.path} />',
    '      ))}',
    '    </Routes>',
    '  );',
    '}',
    '',
  ].join('\n');
  const files = {
    'src/Panel.tsx': mapping,
    'src/Host.tsx': [
      "import React from 'react';",
      "import { Panel } from './Panel';",
      "import entries from './entries';",
      '',
      'export function Host() {',
      '  return <Panel entries={entries} />;',
      '}',
      '',
    ].join('\n'),
    'src/entries.tsx': [
      "import React from 'react';",
      "import Compost from './Compost';",
      '',
      "const entries = [{ path: '/compost', component: <Compost /> }];",
      '',
      'export default entries;',
      '',
    ].join('\n'),
    'src/Compost.tsx': page('Compost'),
  };
  const open = inlineRepo(t, files);
  const resolved = open('/compost').document;
  assert.equal(resolved.root.ref, 'Compost');
  assert.equal(resolved.root.mount.chain.find((segment) => segment.entryFile).entryFile, 'src/entries.tsx');

  // A second component of the same name, rendered elsewhere with the same prop, must not
  // supply the array the mapping component reads: that site renders the other component.
  const decoy = {
    'src/mapping/Panel.tsx': mapping,
    'src/mapping/entries.tsx': "import React from 'react';\nimport Loam from './Loam';\n\nconst entries = [{ path: '/loam', component: <Loam /> }];\n\nexport default entries;\n",
    'src/mapping/Loam.tsx': page('Loam'),
    'src/Panel.tsx': "import React from 'react';\n\nexport function Panel({ entries }: { entries: any[] }) {\n  return <div>{entries.length}</div>;\n}\n",
    'src/Elsewhere.tsx': [
      "import React from 'react';",
      "import { Panel } from './Panel';",
      "import entries from './mapping/entries';",
      '',
      'export function Elsewhere() {',
      '  return <Panel entries={entries} />;',
      '}',
      '',
    ].join('\n'),
    'src/App.tsx': [
      "import React from 'react';",
      "import { Route, Routes } from 'react-router-dom';",
      "import { Panel } from './mapping/Panel';",
      '',
      'export function App() {',
      '  return (',
      '    <Routes>',
      '      <Route path="/panel/*" element={<Panel />} />',
      '    </Routes>',
      '  );',
      '}',
      '',
    ].join('\n'),
  };
  const conflicted = inlineRepo(t, decoy)('/panel/loam').document;
  assert.equal(conflicted.root, undefined, 'a same-named component elsewhere does not supply the array');
  assert.ok(conflicted.frontier.some((entry) => entry.unsupported === 'route-array-unresolved'), 'the missing array is named');
});

test('a route held by an if block carries that condition as a guard, and a loop container stays unread', (t) => {
  const dir = prepare(t);
  const guarded = traceJson(dir, '/orchard/greenhouse/glasshouse').document;
  assert.equal(entryOf(guarded), 'src/greenhouse/GlassHousePage.tsx#GlassHousePage');
  assert.deepEqual(guarded.root.mount.guards, [
    { kind: 'condition', text: 'features.greenhouse', branch: 'then', file: 'src/greenhouse/GreenhouseRoutes.tsx', line: 9 },
  ]);

  const files = {
    'src/App.tsx': [
      "import React from 'react';",
      "import { Route, Routes } from 'react-router-dom';",
      "import Glasshouse from './Glasshouse';",
      '',
      'export function App({ flags }: { flags: { glasshouse: boolean } }) {',
      '  const glasshouseRoute = () => {',
      '    if (flags.glasshouse) {',
      '      return <Route path="/glasshouse" element={<Glasshouse />} />;',
      '    }',
      '    return null;',
      '  };',
      '',
      '  return (',
      '    <Routes>',
      '      {glasshouseRoute()}',
      '    </Routes>',
      '  );',
      '}',
      '',
    ].join('\n'),
    'src/Glasshouse.tsx': page('Glasshouse'),
  };
  const open = inlineRepo(t, files);
  assert.deepEqual(
    open('/glasshouse').document.root.mount.guards.map((guard) => [guard.kind, guard.text, guard.branch]),
    [['condition', 'flags.glasshouse', 'then']],
  );
  const excluded = inlineRepo(t, files, { routeAssumptions: { 'flags.glasshouse': false } })('/glasshouse').document;
  assert.equal(excluded.reason, 'no-declaration');
  assert.match(excluded.message, /excluded by configured assumptions/);

  const loop = traceJson(dir, '/orchard/lofty/upper').document;
  assert.equal(loop.reason, 'unsupported-expression');
  assert.ok(loop.frontier.some((entry) => entry.file === 'src/lofty/LoftyRoutes.tsx' && entry.unsupported === 'route-expression'), 'a loop decides when a route exists, so it is refused');
});

test('a path read both from an anchored mount and from an inferred prefix answers with the anchored reading', () => {
  const facts = [
    { type: 'component', file: 'src/HookList.tsx', line: 2, name: 'HookList', selector: 'HookList', role: 'page' },
    { type: 'component', file: 'src/Inner.tsx', line: 2, name: 'Inner', selector: 'Inner', role: 'container' },
    { type: 'component', file: 'src/RootA.tsx', line: 2, name: 'RootA', selector: 'RootA', role: 'container' },
    { type: 'component', file: 'src/RootB.tsx', line: 2, name: 'RootB', selector: 'RootB', role: 'container' },
    { type: 'page_route', file: 'src/Inner.tsx', line: 10, column: 5, owner: 'Inner', path: '/hooks', element: 'HookList', elementFile: 'src/HookList.tsx', elementName: 'HookList' },
    { type: 'renders', file: 'src/RootA.tsx', line: 5, from: 'RootA', to: 'Inner' },
    { type: 'renders', file: 'src/RootB.tsx', line: 5, from: 'RootB', to: 'Inner' },
    { type: 'page_mount', file: 'src/main.tsx', line: 3, path: '/shed', source: 'app-root', component: 'RootA' },
    { type: 'page_mount', file: 'src/nav.tsx', line: 4, path: '/shed', source: 'inferred', evidence: 3 },
  ];
  const index = buildPageRouteIndex([{ repo: 'web', kind: 'web', facts }]);
  const answered = createPageLookup(index).lookup('/shed/hooks');
  assert.equal(answered.node.ref, 'HookList');
  assert.equal(answered.node.mount.host.source, 'declared', 'the guessed reading does not compete with the declared one');
  assert.equal(answered.candidates, undefined);
});

test('a mount that is not a browser path, a non-boolean assumption and either key off a web repository are refused', (t) => {
  const dir = copyFixture(t, FIXTURE);
  const cases = [
    [{ id: 'web', kind: 'web', root: 'web', mounts: { PartnerRoutes: 'portal' } }, /mounts\.PartnerRoutes" must be a browser path starting with "\/"/],
    [{ id: 'web', kind: 'web', root: 'web', routeAssumptions: { 'features.pruningPlanner': 'yes' } }, /routeAssumptions" value for "features\.pruningPlanner" must be true or false/],
    [{ id: 'api', kind: 'backend', root: 'web', mounts: { PartnerRoutes: '/portal' } }, /mounts" applies to a web repository only/],
    [{ id: 'api', kind: 'backend', root: 'web', routeAssumptions: { flag: true } }, /routeAssumptions" applies to a web repository only/],
  ];
  for (const [repo, message] of cases) {
    writeFileSync(join(dir, 'refused.config.json'), JSON.stringify({ out: 'out', repos: [repo] }));
    const result = runCli(['trace', '/portal/partners', '--config', 'refused.config.json'], { cwd: dir });
    assert.equal(result.status, 2);
    assert.match(result.stderr, message);
  }
});
