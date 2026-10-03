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
    'route src/OrchardApp.tsx:21 declared',
    'route src/OrchardApp.tsx:27 declared',
    'route src/harvest/HarvestRoutes.tsx:11 declared',
    'lazy src/harvest/HarvestRoutes.tsx:5 declared',
  ]);
  const mounts = document.nodes.filter((node) => node.kind === 'mount');
  assert.deepEqual(
    mounts.map((node) => `${node.file}:${node.line}`),
    ['src/index.tsx:7', 'src/OrchardApp.tsx:21', 'src/OrchardApp.tsx:27', 'src/harvest/HarvestRoutes.tsx:11', 'src/harvest/HarvestRoutes.tsx:5'],
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
    { file: 'src/OrchardApp.tsx', line: 28, from: '/orchard/old-rows', to: '/orchard/rows' },
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
    { condition: 'features.pruningPlanner', value: true, source: 'configuration', file: 'src/OrchardApp.tsx', line: 29 },
  ]);
  const text = runCli(['trace', '/orchard/pruning', '--config', 'orchard-mounted.config.json'], { cwd: dir });
  assert.match(text.stdout, /assumes features\.pruningPlanner=true/);
});

test('an access wrapper is a guard on the page it wraps, not the page', (t) => {
  const dir = prepare(t);
  const { document } = traceJson(dir, '/orchard/irrigation');
  assert.equal(entryOf(document), 'src/irrigation/IrrigationPage.tsx#IrrigationPage');
  assert.deepEqual(document.root.mount.guards, [
    { kind: 'wrapper', text: '<RequireCrew role="irrigator">', file: 'src/OrchardApp.tsx', line: 37 },
  ]);
});

test('an unsupported route declaration is named as the frontier instead of being guessed through', (t) => {
  const dir = prepare(t);
  const expression = traceJson(dir, '/orchard/mystery/shelf').document;
  assert.equal(expression.reason, 'unsupported-expression');
  assert.ok(expression.frontier.some((entry) => entry.file === 'src/OrchardApp.tsx' && entry.line === 43 && entry.unsupported === 'path-expression'));

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
