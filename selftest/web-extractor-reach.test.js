/**
 * How far the web extractor reaches into a front end: plain JavaScript sources, gateway calls
 * made through `axios` or a declared client wrapper, URLs built from constants and helpers,
 * curried wrappers, default exports, imported route and render targets, object literal
 * methods and module-level functions as trace starts. Each test writes its own small
 * repository into a temporary directory and runs the CLI on it as a user would.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { runCli } from './helpers.js';

const TEMP = realpathSync(tmpdir());

/** Writes `files` (path -> text) into a fresh directory removed after the test. */
function buildRepo(t, files) {
  const dir = mkdtempSync(join(TEMP, 'flowtrace-reach-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    const target = join(dir, ...path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, typeof text === 'string' ? text : `${JSON.stringify(text, null, 2)}\n`);
  }
  return dir;
}

function config(repos, extra = {}) {
  return { out: 'out', repos, ...extra };
}

const WEB = { id: 'web', kind: 'web', root: 'web' };
const BACKEND = { id: 'backend', kind: 'backend', root: 'backend', role: ['api'] };

function cli(dir, args) {
  return runCli([...args, '--config', 'flowtrace.config.json'], { cwd: dir });
}

function extractAndJoin(dir) {
  const extracted = cli(dir, ['extract']);
  assert.equal(extracted.status, 0, extracted.stderr);
  const joined = cli(dir, ['join']);
  assert.equal(joined.status, 0, joined.stderr);
}

function factsOf(dir, repo = 'web') {
  return JSON.parse(readFileSync(join(dir, 'out', 'facts', `${repo}.json`), 'utf8')).facts;
}

function flowOf(dir) {
  return JSON.parse(readFileSync(join(dir, 'out', 'flow.json'), 'utf8'));
}

function ofType(facts, type) {
  return facts.filter((entry) => entry.type === type);
}

function sortedLines(values) {
  return values.map((value) => JSON.stringify(value)).sort();
}

function controller(name, prefix, actions) {
  const body = actions
    .map(([verb, path, action]) => `        [Http${verb}("${path}")]\n        public IActionResult ${action}(string id)\n        {\n            return Ok();\n        }\n`)
    .join('\n');
  return [
    'using Microsoft.AspNetCore.Mvc;',
    '',
    'namespace Sample.Api.Controllers',
    '{',
    '    [ApiController]',
    `    [Route("${prefix}")]`,
    `    public class ${name} : ControllerBase`,
    '    {',
    body,
    '    }',
    '}',
    '',
  ].join('\n');
}

const EXISTING_SHAPES = {
  'flowtrace.config.json': config([BACKEND, WEB]),
  'backend/src/ItemsController.cs': controller('ItemsController', 'api/v1/items', [
    ['Get', '{id}', 'GetItem'],
    ['Post', '{id}', 'SaveItem'],
  ]),
  'web/src/http/httpClient.ts': [
    'export class HttpClient {',
    '  getGatewayClient() {',
    '    return (window as any).gateway;',
    '  }',
    '}',
    '',
    'export const httpClient = new HttpClient();',
    '',
  ].join('\n'),
  'web/src/actions/items.ts': [
    "import { httpClient } from '../http/httpClient';",
    '',
    'export function loadItem(id: string) {',
    '  return httpClient.getGatewayClient().get(`/api/v1/items/${id}`);',
    '}',
    '',
    'export const saveItem = (id: string, body: unknown) =>',
    '  httpClient.getGatewayClient().post(`/api/v1/items/${id}`, body);',
    '',
  ].join('\n'),
  'web/src/components/ItemRow.tsx': [
    "import React from 'react';",
    '',
    'export function ItemRow(props: { label: string }) {',
    '  return <li>{props.label}</li>;',
    '}',
    '',
  ].join('\n'),
  'web/src/pages/ItemsPage.tsx': [
    "import React from 'react';",
    "import { loadItem } from '../actions/items';",
    '',
    'function ItemBadge() {',
    '  return <span>badge</span>;',
    '}',
    '',
    'export class ItemsPage extends React.Component {',
    '  componentDidMount() {',
    "    loadItem('first');",
    '  }',
    '',
    '  handleClick = () => {',
    "    if (this.props) loadItem('again');",
    '  };',
    '',
    '  render() {',
    '    return (',
    '      <div onClick={this.handleClick}>',
    '        <ItemBadge />',
    '      </div>',
    '    );',
    '  }',
    '}',
    '',
  ].join('\n'),
  'web/src/app/AppRoutes.tsx': [
    "import React from 'react';",
    "import { Route, Routes } from 'react-router-dom';",
    '',
    'function HomePage() {',
    '  return <main>home</main>;',
    '}',
    '',
    'export function AppRoutes() {',
    '  return (',
    '    <Routes>',
    '      <Route path="/home" element={<HomePage />} />',
    '    </Routes>',
    '  );',
    '}',
    '',
  ].join('\n'),
};

/** The facts and `join` edges the existing shapes gave before the web reader was widened. */
const EXISTING_SHAPES_GOLDEN = {
  facts: [
    "{\"type\":\"action_def\",\"file\":\"src/actions/items.ts\",\"line\":3,\"action\":\"loadItem\"}",
    "{\"type\":\"action_def\",\"file\":\"src/actions/items.ts\",\"line\":7,\"action\":\"saveItem\"}",
    "{\"type\":\"branch_point\",\"file\":\"src/pages/ItemsPage.tsx\",\"line\":14,\"class\":\"ItemsPage\",\"method\":\"handleClick\",\"kind\":\"if\",\"text\":\"if (this.props)\",\"endLine\":14}",
    "{\"type\":\"component\",\"file\":\"src/app/AppRoutes.tsx\",\"line\":4,\"name\":\"HomePage\",\"selector\":\"HomePage\",\"role\":\"page\",\"exports\":[],\"path\":\"/home\"}",
    "{\"type\":\"component\",\"file\":\"src/app/AppRoutes.tsx\",\"line\":8,\"name\":\"AppRoutes\",\"selector\":\"AppRoutes\",\"role\":\"component\",\"exports\":[\"AppRoutes\"]}",
    "{\"type\":\"component\",\"file\":\"src/components/ItemRow.tsx\",\"line\":3,\"name\":\"ItemRow\",\"selector\":\"ItemRow\",\"role\":\"component\",\"exports\":[\"ItemRow\"]}",
    "{\"type\":\"component\",\"file\":\"src/pages/ItemsPage.tsx\",\"line\":4,\"name\":\"ItemBadge\",\"selector\":\"ItemBadge\",\"role\":\"component\",\"exports\":[]}",
    "{\"type\":\"component\",\"file\":\"src/pages/ItemsPage.tsx\",\"line\":8,\"name\":\"ItemsPage\",\"selector\":\"ItemsPage\",\"role\":\"component\",\"exports\":[\"ItemsPage\"]}",
    "{\"type\":\"component_entry\",\"file\":\"src/pages/ItemsPage.tsx\",\"line\":9,\"column\":3,\"endLine\":11,\"component\":\"ItemsPage\",\"kind\":\"mount\",\"trigger\":\"componentDidMount\",\"handler\":null,\"guards\":[],\"method\":\"componentDidMount\"}",
    "{\"type\":\"effect_handler\",\"file\":\"src/actions/items.ts\",\"line\":3,\"endLine\":5,\"class\":\"Items\",\"field\":\"loadItem\",\"actions\":[\"loadItem\"]}",
    "{\"type\":\"effect_handler\",\"file\":\"src/actions/items.ts\",\"line\":7,\"endLine\":8,\"class\":\"Items\",\"field\":\"saveItem\",\"actions\":[\"saveItem\"]}",
    "{\"type\":\"gateway_call\",\"file\":\"src/actions/items.ts\",\"line\":4,\"service\":\"httpClient\",\"method\":\"loadItem\",\"verb\":\"GET\",\"template\":\"/api/v1/items/${id}\",\"resolved\":true}",
    "{\"type\":\"gateway_call\",\"file\":\"src/actions/items.ts\",\"line\":8,\"service\":\"httpClient\",\"method\":\"saveItem\",\"verb\":\"POST\",\"template\":\"/api/v1/items/${id}\",\"resolved\":true}",
    "{\"type\":\"method_call\",\"file\":\"src/pages/ItemsPage.tsx\",\"line\":10,\"class\":\"ItemsPage\",\"method\":\"componentDidMount\",\"field\":\"import\",\"calledMethod\":\"loadItem\"}",
    "{\"type\":\"method_call\",\"file\":\"src/pages/ItemsPage.tsx\",\"line\":14,\"class\":\"ItemsPage\",\"method\":\"handleClick\",\"field\":\"import\",\"calledMethod\":\"loadItem\"}",
    "{\"type\":\"method_span\",\"file\":\"src/actions/items.ts\",\"line\":3,\"endLine\":5,\"class\":\"Items\",\"method\":\"loadItem\"}",
    "{\"type\":\"method_span\",\"file\":\"src/actions/items.ts\",\"line\":7,\"endLine\":8,\"class\":\"Items\",\"method\":\"saveItem\"}",
    "{\"type\":\"method_span\",\"file\":\"src/app/AppRoutes.tsx\",\"line\":4,\"endLine\":6,\"class\":\"HomePage\",\"method\":\"HomePage\"}",
    "{\"type\":\"method_span\",\"file\":\"src/app/AppRoutes.tsx\",\"line\":8,\"endLine\":14,\"class\":\"AppRoutes\",\"method\":\"AppRoutes\"}",
    "{\"type\":\"method_span\",\"file\":\"src/components/ItemRow.tsx\",\"line\":3,\"endLine\":5,\"class\":\"ItemRow\",\"method\":\"ItemRow\"}",
    "{\"type\":\"method_span\",\"file\":\"src/http/httpClient.ts\",\"line\":2,\"endLine\":4,\"class\":\"HttpClient\",\"method\":\"getGatewayClient\"}",
    "{\"type\":\"method_span\",\"file\":\"src/pages/ItemsPage.tsx\",\"line\":13,\"endLine\":15,\"class\":\"ItemsPage\",\"method\":\"handleClick\"}",
    "{\"type\":\"method_span\",\"file\":\"src/pages/ItemsPage.tsx\",\"line\":17,\"endLine\":23,\"class\":\"ItemsPage\",\"method\":\"render\"}",
    "{\"type\":\"method_span\",\"file\":\"src/pages/ItemsPage.tsx\",\"line\":4,\"endLine\":6,\"class\":\"ItemBadge\",\"method\":\"ItemBadge\"}",
    "{\"type\":\"method_span\",\"file\":\"src/pages/ItemsPage.tsx\",\"line\":9,\"endLine\":11,\"class\":\"ItemsPage\",\"method\":\"componentDidMount\"}",
    "{\"type\":\"page_route\",\"file\":\"src/app/AppRoutes.tsx\",\"line\":11,\"column\":7,\"endLine\":11,\"owner\":\"AppRoutes\",\"path\":\"/home\",\"element\":\"HomePage\",\"elementLine\":11,\"elementFile\":\"src/app/AppRoutes.tsx\",\"elementName\":\"HomePage\"}",
    "{\"type\":\"renders\",\"file\":\"src/app/AppRoutes.tsx\",\"line\":11,\"from\":\"AppRoutes\",\"to\":\"HomePage\",\"resolved\":true}",
    "{\"type\":\"renders\",\"file\":\"src/pages/ItemsPage.tsx\",\"line\":20,\"from\":\"ItemsPage\",\"to\":\"ItemBadge\",\"resolved\":true}",
    "{\"type\":\"template_handler\",\"file\":\"src/pages/ItemsPage.tsx\",\"line\":19,\"column\":12,\"component\":\"ItemsPage\",\"event\":\"onClick\",\"handler\":\"handleClick\",\"kind\":\"ref\"}",
  ],
  edges: [
    "{\"kind\":\"calls\",\"from\":{\"repo\":\"web\",\"ref\":\"httpClient.loadItem\",\"file\":\"src/actions/items.ts\",\"line\":4,\"class\":\"httpClient\"},\"to\":{\"repo\":\"backend\",\"ref\":\"ItemsController.GetItem\",\"file\":\"src/ItemsController.cs\",\"line\":9},\"key\":\"GET api/v1/items/*\",\"callerKey\":\"GET api/v1/items/*\",\"match\":\"exact\"}",
    "{\"kind\":\"calls\",\"from\":{\"repo\":\"web\",\"ref\":\"httpClient.saveItem\",\"file\":\"src/actions/items.ts\",\"line\":8,\"class\":\"httpClient\"},\"to\":{\"repo\":\"backend\",\"ref\":\"ItemsController.SaveItem\",\"file\":\"src/ItemsController.cs\",\"line\":15},\"key\":\"POST api/v1/items/*\",\"callerKey\":\"POST api/v1/items/*\",\"match\":\"exact\"}",
    "{\"kind\":\"renders\",\"from\":{\"repo\":\"web\",\"ref\":\"AppRoutes\",\"file\":\"src/app/AppRoutes.tsx\",\"line\":11,\"role\":\"component\"},\"to\":{\"repo\":\"web\",\"ref\":\"HomePage\",\"file\":\"src/app/AppRoutes.tsx\",\"line\":4,\"role\":\"page\"},\"key\":\"AppRoutes->HomePage\"}",
    "{\"kind\":\"renders\",\"from\":{\"repo\":\"web\",\"ref\":\"ItemsPage\",\"file\":\"src/pages/ItemsPage.tsx\",\"line\":20,\"role\":\"component\"},\"to\":{\"repo\":\"web\",\"ref\":\"ItemBadge\",\"file\":\"src/pages/ItemsPage.tsx\",\"line\":4,\"role\":\"component\"},\"key\":\"ItemsPage->ItemBadge\"}",
  ],
  unjoined: {
    mobile_calls_without_route: [],
    routes_without_caller: [],
    publish_without_consumer: [],
    consume_without_publisher: [],
    intercepts_without_route: [],
    messages_without_contract: [],
    publish_unresolved: [],
  },
};

test('Web extractor reach AC-18: the existing shapes keep their facts and join edges', (t) => {
  const dir = buildRepo(t, EXISTING_SHAPES);
  extractAndJoin(dir);
  const flow = flowOf(dir);
  const observed = {
    facts: sortedLines(factsOf(dir)),
    edges: sortedLines(flow.edges),
    unjoined: Object.fromEntries(Object.entries(flow.unjoined).map(([bucket, items]) => [bucket, sortedLines(items)])),
  };
  assert.deepEqual(observed, EXISTING_SHAPES_GOLDEN);
  const spans = ofType(factsOf(dir), 'method_span').filter((span) => span.class === 'ItemsPage');
  assert.deepEqual(spans.map((span) => span.method).sort(), ['componentDidMount', 'handleClick', 'render']);
});

const JS_CLIENT = [
  'export class HttpClient {',
  '  getGatewayClient() {',
  '    return window.gateway;',
  '  }',
  '}',
  '',
  'export const httpClient = new HttpClient();',
  '',
].join('\n');

test('Web extractor reach AC-1: .js and .jsx sources give facts, JSX in a .js file included', (t) => {
  const dir = buildRepo(t, {
    'flowtrace.config.json': config([BACKEND, WEB]),
    'backend/src/ItemsController.cs': controller('ItemsController', 'api/v1/items', [['Get', '{id}', 'GetItem']]),
    'web/src/http/httpClient.js': JS_CLIENT,
    'web/src/actions/items.js': [
      "import { httpClient } from '../http/httpClient';",
      '',
      'export function loadItem(id) {',
      '  return httpClient.getGatewayClient().get(`/api/v1/items/${id}`);',
      '}',
      '',
    ].join('\n'),
    'web/src/components/ItemRow.jsx': [
      "import React from 'react';",
      '',
      'export function ItemRow({ label }) {',
      '  return <li>{label}</li>;',
      '}',
      '',
    ].join('\n'),
    'web/src/pages/ItemsPage.js': [
      "import React from 'react';",
      "import { ItemRow } from '../components/ItemRow';",
      "import { loadItem } from '../actions/items';",
      '',
      'export function ItemsPage({ ready, count }) {',
      '  if (count < 3) {',
      "    loadItem('few');",
      '  }',
      '  return (',
      '    <div>',
      '      <p>Ready? Yes && no</p>',
      '      {ready && <ItemRow label="one" />}',
      '    </div>',
      '  );',
      '}',
      '',
    ].join('\n'),
    'web/src/pages/ItemsPage.test.js': "export function TestPage() { return <div />; }\n",
    'web/src/components/ItemRow.spec.jsx': "export function SpecRow() { return <div />; }\n",
    'web/src/components/ItemRow.stories.js': "export function StoryRow() { return <div />; }\n",
    'web/src/pages/ItemsPage.cy.js': "export function CypressPage() { return <div />; }\n",
  });
  extractAndJoin(dir);
  const facts = factsOf(dir);
  const files = new Set(facts.map((entry) => entry.file));
  for (const excluded of ['ItemsPage.test.js', 'ItemRow.spec.jsx', 'ItemRow.stories.js', 'ItemsPage.cy.js']) {
    assert.ok(![...files].some((file) => file.endsWith(excluded)), `${excluded} gives no facts`);
  }
  assert.deepEqual(
    ofType(facts, 'component').map((entry) => `${entry.file} ${entry.name}`).sort(),
    ['src/components/ItemRow.jsx ItemRow', 'src/pages/ItemsPage.js ItemsPage'],
  );
  assert.deepEqual(
    ofType(facts, 'renders').map((entry) => `${entry.from}->${entry.to} ${entry.source}`),
    ['ItemsPage->ItemRow ../components/ItemRow'],
  );
  assert.ok(ofType(facts, 'method_span').some((span) => span.file === 'src/actions/items.js' && span.method === 'loadItem'));
  assert.deepEqual(
    ofType(facts, 'gateway_call').map((entry) => `${entry.file} ${entry.verb} ${entry.template} ${entry.resolved}`),
    ['src/actions/items.js GET /api/v1/items/${id} true'],
  );
  const decisions = ofType(facts, 'branch_point').filter((entry) => entry.file === 'src/pages/ItemsPage.js');
  assert.deepEqual(decisions.map((entry) => `${entry.line} ${entry.kind}`), ['6 if', '12 logical']);
  assert.ok(flowOf(dir).edges.some((edge) => edge.kind === 'calls' && edge.to.ref === 'ItemsController.GetItem'));
});

test('Web extractor reach AC-1: a TypeScript repository reads its .js and .jsx files too', (t) => {
  const dir = buildRepo(t, {
    'flowtrace.config.json': config([WEB]),
    'web/src/App.tsx': [
      "import React from 'react';",
      "import { LegacyBanner } from './legacy/LegacyBanner';",
      '',
      'export function App(): JSX.Element {',
      '  return <LegacyBanner />;',
      '}',
      '',
    ].join('\n'),
    'web/src/legacy/LegacyBanner.jsx': [
      "import React from 'react';",
      '',
      'export function LegacyBanner() {',
      '  return <header>legacy</header>;',
      '}',
      '',
    ].join('\n'),
    'web/src/legacy/format.js': [
      'export function formatLabel(value) {',
      "  return value ? String(value) : '';",
      '}',
      '',
    ].join('\n'),
  });
  extractAndJoin(dir);
  const facts = factsOf(dir);
  assert.ok(ofType(facts, 'component').some((entry) => entry.file === 'src/legacy/LegacyBanner.jsx' && entry.name === 'LegacyBanner'));
  assert.ok(ofType(facts, 'method_span').some((span) => span.file === 'src/legacy/format.js' && span.method === 'formatLabel'));
  assert.ok(ofType(facts, 'branch_point').some((entry) => entry.file === 'src/legacy/format.js' && entry.kind === 'ternary'));
});

const CURRIED_SHAPES = [
  ['connect', "connect(mapState, { loadItem })(itemCard)"],
  ['withRouter-connect', "withRouter(connect(mapState, { loadItem })(itemCard))"],
  ['compose', 'compose(withTheme, withStyles)(itemCard)'],
  ['curried', 'withData(source)(options)(itemCard)'],
];

test('Web extractor reach AC-9: curried wrappers give the wrapped component in wrappers and default exports', (t) => {
  const files = { 'flowtrace.config.json': config([WEB]) };
  for (const [name, expression] of CURRIED_SHAPES) {
    files[`web/src/${name}.tsx`] = [
      "import React from 'react';",
      "import { connect } from 'react-redux';",
      "import { withRouter } from 'react-router-dom';",
      "import { loadItem } from './items';",
      '',
      'const mapState = (state: any) => state;',
      'const withTheme = (c: any) => c;',
      'const withStyles = (c: any) => c;',
      'const withData = (s: any) => (o: any) => (c: any) => c;',
      'const compose = (...f: any[]) => (c: any) => c;',
      'const source = 1;',
      'const options = 2;',
      '',
      'function itemCard() {',
      '  return <div>card</div>;',
      '}',
      '',
      `export const Wrapped = ${expression};`,
      '',
    ].join('\n');
    files[`web/src/default-${name}.tsx`] = files[`web/src/${name}.tsx`].replace(/export const Wrapped = /, 'export default ');
  }
  files['web/src/items.ts'] = 'export function loadItem() {\n  return 1;\n}\n';
  files['web/src/single.tsx'] = [
    "import React from 'react';",
    'function plainCard() {',
    '  return <div>card</div>;',
    '}',
    'export const Styled = styled(plainCard, theme);',
    '',
  ].join('\n');
  const dir = buildRepo(t, files);
  extractAndJoin(dir);
  const facts = factsOf(dir);
  const components = ofType(facts, 'component');
  for (const [name] of CURRIED_SHAPES) {
    assert.ok(components.some((entry) => entry.file === `src/${name}.tsx` && entry.name === 'itemCard'), `${name}: the wrapper names itemCard`);
    const target = components.find((entry) => entry.file === `src/default-${name}.tsx` && entry.exports.includes('default'));
    assert.equal(target && target.name, 'itemCard', `${name}: the default export is itemCard`);
  }
  for (const file of ['src/connect.tsx', 'src/withRouter-connect.tsx']) {
    const binds = ofType(facts, 'props_bind').filter((entry) => entry.file === file);
    assert.deepEqual(binds.map((entry) => entry.component), ['itemCard'], `${file}: the connect binding names the wrapped component`);
  }
  assert.ok(!components.some((entry) => entry.file === 'src/single.tsx' && entry.name === 'plainCard'), 'a one-group call keeps its reading');
});

const DEFAULT_EXPORT_SHAPES = [
  ['bare', 'function X() {\n  return <div />;\n}\nexport default X;\n', 'X'],
  ['connected', "import { connect } from 'react-redux';\nfunction X() {\n  return <div />;\n}\nexport default connect(mapState)(X);\nfunction mapState() {\n  return {};\n}\n", 'X'],
  ['memo', "import { memo } from 'react';\nfunction X() {\n  return <div />;\n}\nexport default memo(X);\n", 'X'],
  ['listed', 'function X() {\n  return <div />;\n}\nexport { X as default };\n', 'X'],
  ['forwarded', "export { X as default } from './source';\n", null],
  ['function', 'export default function X() {\n  return <div />;\n}\n', 'X'],
  ['class', "import React from 'react';\nexport default class X extends React.Component {\n  render() {\n    return <div />;\n  }\n}\n", 'X'],
  ['anonymous-class', "import React from 'react';\nexport default class extends React.Component {\n  render() {\n    return <div />;\n  }\n}\n", null],
  ['anonymous-function', 'export default function (props: any) {\n  return <div>{props.a}</div>;\n}\n', null],
];

test('Web extractor reach AC-10: one default-export reader answers routes, lazy imports and exports alike', (t) => {
  const files = { 'flowtrace.config.json': config([WEB]) };
  const lazies = [];
  const routes = [];
  DEFAULT_EXPORT_SHAPES.forEach(([name, source], position) => {
    files[`web/src/shapes/${name}.tsx`] = `import React from 'react';\n${source}`;
    lazies.push(`const Lazy${position} = lazy(() => import('./shapes/${name}'));`);
    routes.push(`import Routed${position} from './shapes/${name}';`);
  });
  files['web/src/shapes/source.tsx'] = "import React from 'react';\nexport function X() {\n  return <div />;\n}\n";
  files['web/src/App.tsx'] = [
    "import React, { lazy } from 'react';",
    "import { Route, Routes } from 'react-router-dom';",
    ...routes,
    ...lazies,
    '',
    'export function App() {',
    '  return (',
    '    <Routes>',
    ...DEFAULT_EXPORT_SHAPES.map((_, position) => `      <Route path="/routed-${position}" element={<Routed${position} />} />`),
    '    </Routes>',
    '  );',
    '}',
    '',
  ].join('\n');
  const dir = buildRepo(t, files);
  extractAndJoin(dir);
  const facts = factsOf(dir);
  const components = ofType(facts, 'component');
  const pageRoutes = ofType(facts, 'page_route');
  DEFAULT_EXPORT_SHAPES.forEach(([name, , expected], position) => {
    const file = `src/shapes/${name}.tsx`;
    const lazy = components.find((entry) => entry.name === `Lazy${position}`);
    const route = pageRoutes.find((entry) => entry.path === `/routed-${position}`);
    const exported = components.find((entry) => entry.file === file && entry.exports.includes('default'));
    assert.equal(lazy.lazyName ?? null, expected, `${name}: lazyName`);
    assert.equal(route.elementName ?? null, expected, `${name}: page_route.elementName`);
    assert.equal(exported ? exported.name : null, expected, `${name}: component exports`);
  });
});

test('Web extractor reach AC-10: a listed default export gives its lazy page and keeps each page trace apart', (t) => {
  const dir = buildRepo(t, {
    'flowtrace.config.json': config([WEB]),
    'web/src/App.tsx': [
      "import React, { lazy } from 'react';",
      "import { Route } from 'react-router-dom';",
      "const List = lazy(() => import('./List'));",
      "const Form = lazy(() => import('./Form'));",
      'export default function App() {',
      '  return (',
      '    <>',
      '      <Route path="/list" element={<List />} />',
      '      <Route path="/form" element={<Form />} />',
      '    </>',
      '  );',
      '}',
      '',
    ].join('\n'),
    'web/src/List.tsx': [
      "import React, { useEffect } from 'react';",
      'function ListPage() {',
      "  useEffect(() => { fetch('/list-load'); }, []);",
      "  return <button onClick={() => fetch('/list-save')}>Save</button>;",
      '}',
      'export { ListPage as default };',
      '',
    ].join('\n'),
    'web/src/Form.tsx': [
      "import React, { useEffect } from 'react';",
      'export default function FormPage() {',
      "  useEffect(() => { fetch('/form-load'); }, []);",
      '  return <div />;',
      '}',
      '',
    ].join('\n'),
  });
  extractAndJoin(dir);
  const components = ofType(factsOf(dir), 'component');
  assert.equal(components.find((entry) => entry.name === 'List').lazyName, 'ListPage');
  assert.equal(components.find((entry) => entry.name === 'Form').lazyName, 'FormPage');
  for (const [start, own, other] of [['/list', 'ListPage', 'FormPage'], ['/form', 'FormPage', 'ListPage']]) {
    const run = cli(dir, ['trace', start, '--json', '--expand']);
    assert.equal(run.status, 0, run.stderr);
    assert.ok(run.stdout.includes(own), `${start} reaches ${own}`);
    assert.ok(run.stdout.includes(`${own}.useEffect@`), `${start} reaches the effect of ${own}`);
    assert.ok(!run.stdout.includes(other), `${start} does not reach ${other}`);
  }
});

test('Web extractor reach AC-11: an imported route target marks only the component its module exports', (t) => {
  const page = (name) => `import React from 'react';\nexport function ${name}() {\n  return <div>${name}</div>;\n}\n`;
  const dir = buildRepo(t, {
    'flowtrace.config.json': config([WEB]),
    'web/src/foo.tsx': page('Foo'),
    'web/src/baz.tsx': page('Baz'),
    'web/src/other/Bar.tsx': page('Bar'),
    'web/src/other/Foo.tsx': page('Foo'),
    'web/src/other/Qux.tsx': page('Qux'),
    'web/src/App.tsx': [
      "import React from 'react';",
      "import { Route, Routes } from 'react-router-dom';",
      "import { Foo as Bar } from './foo';",
      "import { Baz as Qux } from './baz';",
      '',
      'function Local() {',
      '  return <div>local</div>;',
      '}',
      '',
      'export function App() {',
      '  return (',
      '    <Routes>',
      '      <Route path="/aliased" element={<Bar />} />',
      '      <Route path="/legacy" component={Qux} />',
      '      <Route path="/local" element={<Local />} />',
      '    </Routes>',
      '  );',
      '}',
      '',
    ].join('\n'),
  });
  extractAndJoin(dir);
  const roles = ofType(factsOf(dir), 'component')
    .map((entry) => `${entry.file} ${entry.name} ${entry.role}${entry.path ? ` ${entry.path}` : ''}`)
    .sort();
  assert.deepEqual(roles, [
    'src/App.tsx App component',
    'src/App.tsx Local page /local',
    'src/baz.tsx Baz page /legacy',
    'src/foo.tsx Foo page /aliased',
    'src/other/Bar.tsx Bar component',
    'src/other/Foo.tsx Foo component',
    'src/other/Qux.tsx Qux component',
  ]);
});
