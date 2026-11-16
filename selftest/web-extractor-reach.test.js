/**
 * How far the web extractor reaches into a front end: plain JavaScript sources, gateway calls
 * made through `axios` or a declared client wrapper, URLs built from constants and helpers,
 * curried wrappers, default exports, imported route and render targets, object literal
 * methods and module-level functions as trace starts. Each test writes its own small
 * repository into a temporary directory and runs the CLI on it as a user would.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { affected } from '../lib/affected.js';
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
    "{\"type\":\"client_scan\",\"component\":\"AppRoutes\",\"region\":\"jsx\",\"status\":\"complete\",\"file\":\"src/app/AppRoutes.tsx\",\"line\":8,\"counts\":{\"conditions\":0,\"transfers\":1,\"assignments\":0,\"reads\":0}}",
    "{\"type\":\"client_scan\",\"component\":\"HomePage\",\"region\":\"jsx\",\"status\":\"complete\",\"file\":\"src/app/AppRoutes.tsx\",\"line\":4,\"counts\":{\"conditions\":0,\"transfers\":0,\"assignments\":0,\"reads\":0}}",
    "{\"type\":\"client_scan\",\"component\":\"ItemBadge\",\"region\":\"jsx\",\"status\":\"complete\",\"file\":\"src/pages/ItemsPage.tsx\",\"line\":4,\"counts\":{\"conditions\":0,\"transfers\":0,\"assignments\":0,\"reads\":0}}",
    "{\"type\":\"client_scan\",\"component\":\"ItemRow\",\"region\":\"jsx\",\"status\":\"complete\",\"file\":\"src/components/ItemRow.tsx\",\"line\":3,\"counts\":{\"conditions\":0,\"transfers\":0,\"assignments\":0,\"reads\":0}}",
    "{\"type\":\"client_scan\",\"component\":\"ItemsPage\",\"region\":\"jsx\",\"status\":\"complete\",\"file\":\"src/pages/ItemsPage.tsx\",\"line\":8,\"counts\":{\"conditions\":0,\"transfers\":0,\"assignments\":0,\"reads\":0}}",
    "{\"type\":\"client_transfer\",\"component\":\"AppRoutes\",\"target\":\"Route\",\"name\":\"element\",\"text\":\"<HomePage />\",\"file\":\"src/app/AppRoutes.tsx\",\"line\":11,\"column\":27,\"form\":\"jsx\"}",
    "{\"type\":\"component\",\"file\":\"src/app/AppRoutes.tsx\",\"line\":4,\"name\":\"HomePage\",\"selector\":\"HomePage\",\"role\":\"page\",\"exports\":[],\"path\":\"/home\"}",
    "{\"type\":\"component\",\"file\":\"src/app/AppRoutes.tsx\",\"line\":8,\"name\":\"AppRoutes\",\"selector\":\"AppRoutes\",\"role\":\"component\",\"exports\":[\"AppRoutes\"]}",
    "{\"type\":\"component\",\"file\":\"src/components/ItemRow.tsx\",\"line\":3,\"name\":\"ItemRow\",\"selector\":\"ItemRow\",\"role\":\"component\",\"exports\":[\"ItemRow\"]}",
    "{\"type\":\"component\",\"file\":\"src/pages/ItemsPage.tsx\",\"line\":4,\"name\":\"ItemBadge\",\"selector\":\"ItemBadge\",\"role\":\"component\",\"exports\":[]}",
    "{\"type\":\"component\",\"file\":\"src/pages/ItemsPage.tsx\",\"line\":8,\"name\":\"ItemsPage\",\"selector\":\"ItemsPage\",\"role\":\"component\",\"exports\":[\"ItemsPage\"]}",
    "{\"type\":\"component_entry\",\"file\":\"src/pages/ItemsPage.tsx\",\"line\":9,\"column\":3,\"endLine\":11,\"component\":\"ItemsPage\",\"kind\":\"mount\",\"trigger\":\"componentDidMount\",\"handler\":null,\"guards\":[],\"method\":\"componentDidMount\"}",
    "{\"type\":\"effect_handler\",\"file\":\"src/actions/items.ts\",\"line\":3,\"endLine\":5,\"class\":\"Items\",\"field\":\"loadItem\",\"actions\":[\"loadItem\"]}",
    "{\"type\":\"effect_handler\",\"file\":\"src/actions/items.ts\",\"line\":7,\"endLine\":8,\"class\":\"Items\",\"field\":\"saveItem\",\"actions\":[\"saveItem\"]}",
    "{\"type\":\"gateway_call\",\"file\":\"src/actions/items.ts\",\"line\":4,\"service\":\"httpClient\",\"method\":\"loadItem\",\"verb\":\"GET\",\"template\":\"/api/v1/items/${id}\",\"resolved\":true,\"column\":10,\"control\":{\"path\":[]}}",
    "{\"type\":\"gateway_call\",\"file\":\"src/actions/items.ts\",\"line\":8,\"service\":\"httpClient\",\"method\":\"saveItem\",\"verb\":\"POST\",\"template\":\"/api/v1/items/${id}\",\"resolved\":true,\"column\":3,\"control\":{\"path\":[]}}",
    "{\"type\":\"method_call\",\"file\":\"src/pages/ItemsPage.tsx\",\"line\":10,\"class\":\"ItemsPage\",\"method\":\"componentDidMount\",\"field\":\"import\",\"calledMethod\":\"loadItem\",\"column\":5,\"control\":{\"path\":[]}}",
    "{\"type\":\"method_call\",\"file\":\"src/pages/ItemsPage.tsx\",\"line\":14,\"class\":\"ItemsPage\",\"method\":\"handleClick\",\"field\":\"import\",\"calledMethod\":\"loadItem\",\"column\":21,\"control\":{\"path\":[{\"kind\":\"arm\",\"form\":\"if\",\"id\":\"if@14:5\",\"line\":14,\"column\":5,\"text\":\"if (this.props)\",\"arm\":\"then\"}]},\"arrow\":{\"line\":13,\"column\":17,\"name\":\"handleClick\"}}",
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

test('Web extractor reach AC-12: join lands a render on the component its import names', (t) => {
  const child = (name, exported = true) =>
    `import React from 'react';\n${exported ? 'export ' : ''}function ${name}() {\n  return <span>${name}</span>;\n}\n`;
  const dir = buildRepo(t, {
    'flowtrace.config.json': config([WEB]),
    'web/src/cards/Card.tsx': child('Card'),
    'web/src/legacy/Card.tsx': child('Card'),
    'web/src/rows/Row.tsx': child('Row'),
    'web/src/empty.ts': 'export const nothing = 1;\n',
    'web/src/elsewhere.tsx': child('Missing', false),
    'web/src/dup.tsx': child('Thing'),
    'web/src/dup/index.tsx': child('Thing'),
    'web/src/App.tsx': [
      "import React from 'react';",
      "import { Card } from './cards/Card';",
      "import { Row as Line } from './rows/Row';",
      "import { Missing } from './empty';",
      "import { Thing } from './dup';",
      '',
      'export function App() {',
      '  return (',
      '    <div>',
      '      <Card />',
      '      <Line />',
      '      <Missing />',
      '      <Thing />',
      '    </div>',
      '  );',
      '}',
      '',
    ].join('\n'),
  });
  extractAndJoin(dir);
  const renders = flowOf(dir).edges.filter((edge) => edge.kind === 'renders' && edge.from.ref === 'App');
  const target = (key) => {
    const edge = renders.find((entry) => entry.key === key);
    return `${edge.to.ref} ${edge.to.file}`;
  };
  assert.equal(target('App->Card'), 'Card src/cards/Card.tsx');
  assert.equal(target('App->Line'), 'Row src/rows/Row.tsx');
  assert.equal(target('App->Missing'), 'Missing src/elsewhere.tsx', 'an import that settles on no component keeps the selector target');
  const things = ofType(factsOf(dir), 'component').filter((entry) => entry.name === 'Thing');
  const fallback = things[things.length - 1];
  assert.equal(target('App->Thing'), `Thing ${fallback.file}`, 'an import that settles on two components keeps the selector target');
});

const OBJECT_SERVICE = [
  "import { httpClient } from './httpClient';",
  "import { base } from './base';",
  '',
  "const key = 'dynamic';",
  '',
  'const itemsApi = {',
  '  // the shorthand form',
  '  load(id: string) {',
  '    if (!id) {',
  '      return null;',
  '    }',
  '    return httpClient.getGatewayClient().get(`items/v1/items/${id}`);',
  '  },',
  "  save: async (item: unknown) => httpClient.getGatewayClient().post('items/v1/items', item),",
  '  remove: function (id: string) {',
  '    return httpClient.getGatewayClient().delete(`items/v1/items/${id}`);',
  '  },',
  '  ...base,',
  '  [key]() {',
  '    return 1;',
  '  },',
  '  nested: {',
  '    inner() {',
  '      return 2;',
  '    },',
  '  },',
  "  label: 'items',",
  '};',
  '',
  'export const pingApi: Record<string, () => number> = {',
  '  ping: () => 1,',
  '};',
  '',
  'export function wrap() {',
  '  const local = { hidden: () => 3 };',
  '  return local;',
  '}',
  '',
  'export default itemsApi;',
  '',
].join('\n');

test('Web extractor reach AC-13: the methods of a module-level object literal are spans of its const', (t) => {
  const dir = buildRepo(t, {
    'flowtrace.config.json': config([WEB, BACKEND]),
    'web/src/httpClient.ts': 'export class HttpClient {\n  getGatewayClient() {\n    return null;\n  }\n}\nexport const httpClient = new HttpClient();\n',
    'web/src/base.ts': 'export const base = {};\n',
    'web/src/itemsApi.ts': OBJECT_SERVICE,
    'backend/src/Controllers/ItemsController.cs': controller('ItemsController', 'items/v1/items', [
      ['Get', '{id}', 'Load'],
      ['Post', '', 'Save'],
      ['Delete', '{id}', 'Remove'],
    ]),
  });
  extractAndJoin(dir);
  const facts = factsOf(dir).filter((entry) => entry.file === 'src/itemsApi.ts');
  assert.deepEqual(
    ofType(facts, 'method_span').map((entry) => `${entry.class}.${entry.method} ${entry.line}-${entry.endLine}`),
    ['itemsApi.load 8-13', 'itemsApi.save 14-14', 'itemsApi.remove 15-17', 'pingApi.ping 31-31', 'ItemsApi.wrap 34-37'],
  );
  assert.deepEqual(
    ofType(facts, 'gateway_call').map((entry) => `${entry.method} ${entry.verb} ${entry.template}`),
    ['load GET items/v1/items/${id}', 'save POST items/v1/items', 'remove DELETE items/v1/items/${id}'],
  );
  assert.deepEqual(
    ofType(facts, 'branch_point').map((entry) => `${entry.class}.${entry.method} ${entry.line}`),
    ['itemsApi.load 9'],
  );
  const calls = flowOf(dir).edges.filter((edge) => edge.kind === 'calls').map((edge) => `${edge.from.ref} -> ${edge.to.ref}`).sort();
  assert.deepEqual(calls, [
    'httpClient.load -> ItemsController.Load',
    'httpClient.remove -> ItemsController.Remove',
    'httpClient.save -> ItemsController.Save',
  ]);
});

const GATEWAY_CLIENT = 'export class HttpClient {\n  getGatewayClient() {\n    return null;\n  }\n}\nexport const httpClient = new HttpClient();\n';

const MEMBER_CALLS = {
  'flowtrace.config.json': config([WEB, BACKEND]),
  'web/src/http/httpClient.ts': GATEWAY_CLIENT,
  'web/src/api/audit.ts': 'export function audit() {\n  return 1;\n}\n',
  'web/src/api/itemsApi.ts': [
    "import { httpClient } from '../http/httpClient';",
    "import { audit } from './audit';",
    '',
    'function loadItem(id: string) {',
    '  return httpClient.getGatewayClient().get(`/api/v1/items/${id}`);',
    '}',
    '',
    "const request = () => httpClient.getGatewayClient().get('/api/v1/ping');",
    '',
    'export const itemsApi = {',
    '  load: (id: string) => loadItem(id),',
    '  reload(id: string) {',
    '    audit();',
    '    missing(id);',
    '    this.load(id);',
    '    return loadItem(id);',
    '  },',
    '  loadAll: (ids: string[]) => ids.map((id) => loadItem(id)),',
    '  request: () => request(),',
    '  skipAll: (ids: string[]) => ids.map((id) => absent(id)),',
    '};',
    '',
  ].join('\n'),
  'web/src/api/otherApi.ts': [
    "import { httpClient } from '../http/httpClient';",
    '',
    'export function loadItem(id: string) {',
    '  return httpClient.getGatewayClient().get(`/api/v1/other/${id}`);',
    '}',
    '',
  ].join('\n'),
  'web/src/pages/ItemsPage.tsx': [
    "import React from 'react';",
    "import { itemsApi } from '../api/itemsApi';",
    '',
    'export function ItemsPage() {',
    '  const onOpen = () => {',
    "    itemsApi.load('1');",
    '  };',
    '  return <button onClick={onOpen}>open</button>;',
    '}',
    '',
  ].join('\n'),
  'web/src/App.tsx': [
    "import React from 'react';",
    "import { Route } from 'react-router-dom';",
    "import { ItemsPage } from './pages/ItemsPage';",
    '',
    'export function App() {',
    '  return <Route path="/items" element={<ItemsPage />} />;',
    '}',
    '',
  ].join('\n'),
  'backend/src/ItemsController.cs': controller('ItemsController', 'api/v1', [
    ['Get', 'items/{id}', 'GetItem'],
    ['Get', 'ping', 'Ping'],
    ['Get', 'other/{id}', 'GetOther'],
  ]),
};

test('Web extractor reach AC-13: a member body call to a module-level function of the file names that function span', (t) => {
  const dir = buildRepo(t, MEMBER_CALLS);
  extractAndJoin(dir);
  const calls = ofType(factsOf(dir), 'method_call').filter((entry) => entry.file === 'src/api/itemsApi.ts');
  assert.deepEqual(
    calls.map((entry) => `${entry.class}.${entry.method} ${entry.field} ${entry.calledMethod} ${entry.calledClass ?? '-'}`),
    [
      'itemsApi.load this loadItem ItemsApi',
      'itemsApi.reload import audit -',
      'itemsApi.reload this load -',
      'itemsApi.reload this loadItem ItemsApi',
      'itemsApi.loadAll this loadItem ItemsApi',
      'itemsApi.request this request ItemsApi',
    ],
    'an imported callee keeps the import form, an undeclared one gives no fact, and this.<sibling> keeps the sibling form',
  );
  const held = calls.find((entry) => entry.method === 'loadAll');
  assert.deepEqual([held.arrow?.line, held.arrow?.column], [held.line, 39], 'a call in a held arrow names that arrow');
  const withField = calls.find((entry) => entry.calledClass !== undefined);
  assert.deepEqual(Object.keys(withField).slice(0, 8), ['type', 'file', 'line', 'class', 'method', 'field', 'calledMethod', 'calledClass']);

  const reach = (json) => json.nodes.map((node) => `${node.repo} ${node.kind} ${node.ref} ${node.file ?? ''}`.trim());
  for (const start of ['itemsApi.load', 'itemsApi.reload', 'itemsApi.loadAll']) {
    const traced = traceJson(dir, start);
    assert.equal(traced.status, 0, traced.stderr);
    const nodes = reach(traced.json);
    assert.ok(nodes.includes('web method ItemsApi.loadItem src/api/itemsApi.ts'), `${start}: ${JSON.stringify(nodes)}`);
    assert.ok(nodes.some((node) => node.startsWith('backend action ItemsController.GetItem')), `${start}: ${JSON.stringify(nodes)}`);
    assert.ok(!nodes.some((node) => node.includes('src/api/otherApi.ts') || node.includes('GetOther')), `${start} never enters the same-named function of another file`);
  }
  const named = traceJson(dir, 'itemsApi.request');
  assert.equal(named.status, 0, named.stderr);
  assert.ok(reach(named.json).includes('web method ItemsApi.request src/api/itemsApi.ts'), 'a member named as the module function is no recursion');
  assert.ok(reach(named.json).some((node) => node.startsWith('backend action ItemsController.Ping')));

  const chained = cli(dir, ['chains', 'GET api/v1/items/{id}', '--json']);
  assert.equal(chained.status, 0, chained.stderr);
  const complete = JSON.parse(chained.stdout).chains.filter((chain) => chain.complete);
  assert.ok(
    complete.some((chain) => chain.page && chain.hops.some((hop) => JSON.stringify(hop).includes('itemsApi.load'))),
    chained.stdout,
  );
});

const CONTENT_API = [
  "import { httpClient } from '../http/httpClient';",
  '',
  "const REVISIONS_URL = '/content/v1/revisions';",
  "const NOTES_ROOT = '/content/v1';",
  'const NOTES_URL = `${NOTES_ROOT}/notes`;',
  'const HOST = window.location.host;',
  '',
  'export function loadRevision(id: string, rev: number) {',
  '  const url = `${REVISIONS_URL}?contentId=${encodeURIComponent(id)}&rev=${rev}`;',
  '  return httpClient.getGatewayClient().get(url);',
  '}',
  '',
  'export function loadDraft() {',
  "  const DRAFTS = '/content/v1/' + 'drafts';",
  '  return httpClient.getGatewayClient().get(`${DRAFTS}/latest`);',
  '}',
  '',
  'export function loadNote(id: string) {',
  '  return httpClient.getGatewayClient().get(`${NOTES_URL}/${id}`);',
  '}',
  '',
  'export function loadMirror(id: string) {',
  '  return httpClient.getGatewayClient().get(`${HOST}/content/v1/mirror/${id}`);',
  '}',
  '',
  'export function loadAnything(param: string) {',
  '  const url = `${param}?a=1`;',
  '  return httpClient.getGatewayClient().get(url);',
  '}',
  '',
].join('\n');

const CONTENT_BACKEND = controller('ContentController', 'content/v1', [
  ['Get', 'revisions', 'GetRevision'],
  ['Get', 'drafts/latest', 'GetLatestDraft'],
  ['Get', 'notes/{id}', 'GetNote'],
  ['Get', 'unrelated', 'GetUnrelated'],
]);

function gatewayAt(dir, method) {
  return ofType(factsOf(dir), 'gateway_call').find((entry) => entry.method === method);
}

function callsFrom(dir, method) {
  return flowOf(dir).edges.filter((edge) => edge.kind === 'calls' && edge.from.ref.endsWith(`.${method}`));
}

function contentRepo(t, extra = {}) {
  return buildRepo(t, {
    'flowtrace.config.json': config([WEB, BACKEND]),
    'web/src/http/httpClient.ts': GATEWAY_CLIENT,
    'web/src/api/contentApi.ts': CONTENT_API,
    'backend/src/ContentController.cs': CONTENT_BACKEND,
    ...extra,
  });
}

test('Web extractor reach AC-5: a URL built from a literal const joins the route the const names', (t) => {
  const dir = contentRepo(t);
  extractAndJoin(dir);
  const revision = gatewayAt(dir, 'loadRevision');
  assert.equal(revision.template, '/content/v1/revisions?contentId=${encodeURIComponent(id)}&rev=${rev}');
  assert.equal(revision.resolved, true);
  assert.deepEqual(
    callsFrom(dir, 'loadRevision').map((edge) => `${edge.to.ref} ${edge.match}`),
    ['ContentController.GetRevision exact'],
    'the query string is no part of the join',
  );
  assert.equal(gatewayAt(dir, 'loadDraft').template, '/content/v1/drafts/latest', 'a local const counts as a module one does');
  assert.deepEqual(callsFrom(dir, 'loadDraft').map((edge) => `${edge.to.ref} ${edge.match}`), ['ContentController.GetLatestDraft exact']);
  assert.equal(gatewayAt(dir, 'loadNote').template, '/content/v1/notes/${id}', 'a const composed from another const is a literal too');
  assert.deepEqual(callsFrom(dir, 'loadNote').map((edge) => edge.to.ref), ['ContentController.GetNote']);
  assert.equal(gatewayAt(dir, 'loadMirror').template, '${HOST}/content/v1/mirror/${id}', 'a const holding a runtime value stays as written');
});

test('Web extractor reach AC-6: a URL built only from a runtime value stays without a caller edge', (t) => {
  const dir = contentRepo(t);
  extractAndJoin(dir);
  const call = gatewayAt(dir, 'loadAnything');
  assert.equal(call.template, '${param}?a=1');
  assert.deepEqual(callsFrom(dir, 'loadAnything'), []);
  const { unjoined } = flowOf(dir);
  assert.ok(
    unjoined.mobile_calls_without_route.some((entry) => entry.fact.method === 'loadAnything' && entry.fact.line === call.line),
    'the call stays in the caller bucket with its fact',
  );
  assert.ok(
    unjoined.routes_without_caller.some((entry) => entry.key === 'GET content/v1/unrelated'),
    'an unrelated route is not handed to the runtime URL',
  );
});

const HELPER_API = [
  "import { httpClient } from '../http/httpClient';",
  '',
  'function feedUrl(suffix: string) {',
  '  const handler = () => {',
  "    return '/elsewhere';",
  '  };',
  '  return `/feed/v1/recommendations${suffix}`;',
  '}',
  '',
  'const itemUrl = (id: string) => `/feed/v1/items/${id}`;',
  '',
  'function listUrl(kind: string) {',
  "  if (kind === 'top') {",
  "    return '/feed/v1/lists/top';",
  '  }',
  '  return `/feed/v1/lists/${kind}/recent`;',
  '}',
  '',
  'function hostUrl(host: string) {',
  '  return `${host}/feed/v1/items`;',
  '}',
  '',
  'function tail(name: string) {',
  "  return 'v1/' + name;",
  '}',
  '',
  'export function loadFeed(suffix: string) {',
  '  return httpClient.getGatewayClient().get(feedUrl(suffix));',
  '}',
  '',
  'export function loadItem(id: string) {',
  '  const url = itemUrl(id);',
  '  return httpClient.getGatewayClient().get(url);',
  '}',
  '',
  'export function loadList(kind: string) {',
  '  return httpClient.getGatewayClient().get(listUrl(kind));',
  '}',
  '',
  'export function loadHosted(host: string) {',
  '  return httpClient.getGatewayClient().get(hostUrl(host));',
  '}',
  '',
  'export function loadTail() {',
  "  return httpClient.getGatewayClient().get('/feed/' + tail('items'));",
  '}',
  '',
].join('\n');

test('Web extractor reach AC-8: a URL a helper of the file returns resolves to the text its returns share', (t) => {
  const dir = buildRepo(t, {
    'flowtrace.config.json': config([WEB, BACKEND]),
    'web/src/http/httpClient.ts': GATEWAY_CLIENT,
    'web/src/api/feedApi.ts': HELPER_API,
    'backend/src/FeedController.cs': controller('FeedController', 'feed/v1', [
      ['Get', 'recommendations', 'GetRecommendations'],
      ['Get', 'items/{id}', 'GetItem'],
      ['Get', 'lists/{kind}/recent', 'GetRecentList'],
    ]),
  });
  extractAndJoin(dir);
  const read = (method) => {
    const call = gatewayAt(dir, method);
    return `${call.template} ${call.resolved}`;
  };
  assert.equal(read('loadFeed'), '/feed/v1/recommendations${suffix} true', 'a return inside a nested function is not a return of the helper');
  assert.deepEqual(callsFrom(dir, 'loadFeed').map((edge) => `${edge.to.ref} ${edge.match}`), ['FeedController.GetRecommendations prefix']);
  assert.equal(read('loadItem'), '/feed/v1/items/${id} true', 'a const arrow with an expression body, reached through a local const');
  assert.deepEqual(callsFrom(dir, 'loadItem').map((edge) => edge.to.ref), ['FeedController.GetItem']);
  assert.equal(read('loadList'), '/feed/v1/lists/* true', 'returns that differ keep the text up to their last common slash');
  assert.deepEqual(callsFrom(dir, 'loadList').map((edge) => `${edge.to.ref} ${edge.match}`), ['FeedController.GetRecentList prefix']);
  assert.equal(read('loadHosted'), '${hostUrl(host)} false', 'a helper with a runtime prefix stays unresolved');
  assert.deepEqual(callsFrom(dir, 'loadHosted'), []);
  assert.equal(read('loadTail'), "/feed/${tail('items')} false", 'a helper inside a + part keeps its reading');
});

const AXIOS_SOURCES = {
  'web/src/api/defaultImport.ts': [
    "import http from 'axios';",
    '',
    'interface Item {',
    '  id: string;',
    '}',
    '',
    'export function loadA(id: string) {',
    '  return http.get<Item>(`/shop/v1/a/${id}`);',
    '}',
    '',
    'export function readUri() {',
    '  return http.getUri({});',
    '}',
    '',
  ].join('\n'),
  'web/src/api/instance.ts': [
    "import axios from 'axios';",
    '',
    "const client = axios.create({ baseURL: '/' });",
    '',
    'export function loadB(body: unknown) {',
    "  return client.post('/shop/v1/b', body);",
    '}',
    '',
  ].join('\n'),
  'web/src/api/classes.ts': [
    "import axios, { AxiosInstance } from 'axios';",
    '',
    'export class FieldApi {',
    '  private http = axios.create();',
    '',
    '  loadC(id: string) {',
    '    return this.http.put(`/shop/v1/c/${id}`);',
    '  }',
    '}',
    '',
    'export class AssignedApi {',
    '  client: AxiosInstance;',
    '',
    '  constructor() {',
    '    this.client = axios.create();',
    '  }',
    '',
    '  loadD(id: string) {',
    '    return this.client.delete(`/shop/v1/d/${id}`);',
    '  }',
    '}',
    '',
    'export class TypedApi {',
    '  constructor(private readonly api: AxiosInstance) {}',
    '',
    '  loadE(id: string) {',
    '    return this.api.patch(`/shop/v1/e/${id}`, {});',
    '  }',
    '}',
    '',
  ].join('\n'),
  'web/src/api/negatives.ts': [
    'const axios = { get: (url: string) => url };',
    'const store = { get: (key: string) => key };',
    '',
    'export function fakeA() {',
    "  return axios.get('/shop/v1/a/1');",
    '}',
    '',
    'export function fromStore() {',
    "  return store.get('/shop/v1/b');",
    '}',
    '',
  ].join('\n'),
  'backend/src/ShopController.cs': controller('ShopController', 'shop/v1', [
    ['Get', 'a/{id}', 'GetA'],
    ['Post', 'b', 'PostB'],
    ['Put', 'c/{id}', 'PutC'],
    ['Delete', 'd/{id}', 'DeleteD'],
    ['Patch', 'e/{id}', 'PatchE'],
  ]),
};

test('Web extractor reach AC-2: a call on axios or on an axios instance gives a gateway call named by its receiver', (t) => {
  const dir = buildRepo(t, { 'flowtrace.config.json': config([WEB, BACKEND]), ...AXIOS_SOURCES });
  extractAndJoin(dir);
  const calls = ofType(factsOf(dir), 'gateway_call').map(
    (entry) => `${entry.file} ${entry.service} ${entry.method} ${entry.verb} ${entry.template} ${entry.resolved}`,
  );
  assert.deepEqual(calls.sort(), [
    'src/api/classes.ts api loadE PATCH /shop/v1/e/${id} true',
    'src/api/classes.ts client loadD DELETE /shop/v1/d/${id} true',
    'src/api/classes.ts http loadC PUT /shop/v1/c/${id} true',
    'src/api/defaultImport.ts http loadA GET /shop/v1/a/${id} true',
    'src/api/instance.ts client loadB POST /shop/v1/b true',
  ], 'a non-verb member, a plain object and a local axios that is not the import give none');
  const joined = flowOf(dir).edges.filter((edge) => edge.kind === 'calls').map((edge) => `${edge.from.ref} -> ${edge.to.ref}`).sort();
  assert.deepEqual(joined, [
    'api.loadE -> ShopController.PatchE',
    'client.loadB -> ShopController.PostB',
    'client.loadD -> ShopController.DeleteD',
    'http.loadA -> ShopController.GetA',
    'http.loadC -> ShopController.PutC',
  ]);
});

const WRAPPER_SOURCES = {
  'web/src/client/ApiClient.js': [
    "import axios from 'axios';",
    '',
    'export class ApiClient {',
    '  constructor() {',
    "    this.http = axios.create({ baseURL: '/' });",
    '  }',
    '',
    '  get(url) {',
    '    return this.http.get(url);',
    '  }',
    '}',
    '',
  ].join('\n'),
  'web/src/items/itemsApi.js': [
    'export function makeItemsApi(apiClient) {',
    '  return async (id) => apiClient.get(`/api/v2/items/${id}`);',
    '}',
    '',
    'export class ItemsStore {',
    '  constructor(apiClient) {',
    '    this.apiClient = apiClient;',
    '  }',
    '',
    '  refresh(id) {',
    '    return this.apiClient.get(`/api/v2/items/${id}`);',
    '  }',
    '}',
    '',
  ].join('\n'),
  'backend/src/ItemsController.cs': controller('ItemsController', 'api/v2/items', [['Get', '{id}', 'GetItem']]),
};

test('Web extractor reach AC-3: a receiver the repository lists in httpClients gives a gateway call', (t) => {
  const listed = buildRepo(t, {
    'flowtrace.config.json': config([BACKEND, { ...WEB, httpClients: ['apiClient'] }]),
    ...WRAPPER_SOURCES,
  });
  extractAndJoin(listed);
  const read = (dir) =>
    ofType(factsOf(dir), 'gateway_call')
      .map((entry) => `${entry.file}:${entry.line} ${entry.service} ${entry.method} ${entry.verb} ${entry.template} ${entry.resolved}`)
      .sort();
  assert.deepEqual(read(listed), [
    'src/client/ApiClient.js:9 http get GET ${url} false',
    'src/items/itemsApi.js:11 apiClient refresh GET /api/v2/items/${id} true',
    'src/items/itemsApi.js:2 apiClient makeItemsApi GET /api/v2/items/${id} true',
  ]);
  const calls = flowOf(listed).edges.filter((edge) => edge.kind === 'calls');
  assert.deepEqual(
    calls.map((edge) => `${edge.from.file}:${edge.from.line} ${edge.key} ${edge.to.ref}`).sort(),
    [
      'src/items/itemsApi.js:11 GET api/v2/items/* ItemsController.GetItem',
      'src/items/itemsApi.js:2 GET api/v2/items/* ItemsController.GetItem',
    ],
    'the forwarding call inside the wrapper stays unjoined',
  );

  const unlisted = buildRepo(t, { 'flowtrace.config.json': config([BACKEND, WEB]), ...WRAPPER_SOURCES });
  extractAndJoin(unlisted);
  assert.deepEqual(read(unlisted), ['src/client/ApiClient.js:9 http get GET ${url} false'], 'without the key the injected receiver is unknown');
});

test('Web extractor reach AC-4: a bad httpClients value or the key off a web repository is refused', (t) => {
  const dir = buildRepo(t, { 'web/src/a.ts': 'export const a = 1;\n' });
  const run = (repo) => {
    writeFileSync(join(dir, 'flowtrace.config.json'), JSON.stringify({ out: 'out', repos: [repo] }));
    return cli(dir, ['extract']);
  };
  const shape = /config .*flowtrace\.config\.json: "repos\[0\]\.httpClients" must be an array of JavaScript identifier names\n/;
  for (const value of ['apiClient', [''], ['api-client'], [3], { apiClient: true }, null, ['ok', ' padded']]) {
    const result = run({ ...WEB, httpClients: value });
    assert.equal(result.status, 2, JSON.stringify(value));
    assert.match(result.stderr, shape, JSON.stringify(value));
    assert.equal(result.stderr.match(/httpClients/g).length, 1, 'one error names the key');
  }
  const backend = run({ ...BACKEND, root: 'web', httpClients: ['apiClient'] });
  assert.equal(backend.status, 2);
  assert.match(backend.stderr, /"repos\[0\]\.httpClients" applies to a web repository only \(kind "backend"\)/);
  for (const value of [[], ['apiClient', '$http', '_client', 'kliënt']]) {
    const loaded = run({ ...WEB, httpClients: value });
    assert.equal(loaded.status, 0, loaded.stderr);
  }
});

const FUNCTION_STARTS = {
  'flowtrace.config.json': config([BACKEND, WEB]),
  'web/src/http/httpClient.ts': GATEWAY_CLIENT,
  'web/src/api/itemsApi.ts': [
    "import { httpClient } from '../http/httpClient';",
    '',
    'export const fetchItem = async (id: string) =>',
    '  httpClient.getGatewayClient().get(`/api/v1/items/${id}`);',
    '',
    'export function sharedName() {',
    "  return httpClient.getGatewayClient().get('/api/v1/shared');",
    '}',
    '',
  ].join('\n'),
  'web/src/api/otherApi.ts': [
    "import { httpClient } from '../http/httpClient';",
    '',
    'export function sharedName() {',
    "  return httpClient.getGatewayClient().get('/api/v1/shared');",
    '}',
    '',
  ].join('\n'),
  'web/src/pages/DetailPage.tsx': [
    "import React from 'react';",
    "import { httpClient } from '../http/httpClient';",
    '',
    'function loadDetail(id: string) {',
    '  return httpClient.getGatewayClient().get(`/api/v1/details/${id}`);',
    '}',
    '',
    'export class DetailPage extends React.Component {',
    '  render() {',
    '    return <div>detail</div>;',
    '  }',
    '}',
    '',
  ].join('\n'),
  'web/src/components/ListPanel.tsx': [
    "import React from 'react';",
    "import { httpClient } from '../http/httpClient';",
    '',
    'export function ListPanel() {',
    '  const onPick = () => {',
    "    httpClient.getGatewayClient().get('/api/v1/shared');",
    '  };',
    '  return <button onClick={onPick}>pick</button>;',
    '}',
    '',
  ].join('\n'),
  'web/src/components/Badge.tsx': "import React from 'react';\n\nexport function Badge() {\n  return <span>badge</span>;\n}\n",
  'web/src/util/badge.ts': [
    "import { httpClient } from '../http/httpClient';",
    '',
    'export function Badge() {',
    "  return httpClient.getGatewayClient().get('/api/v1/shared');",
    '}',
    '',
  ].join('\n'),
  'backend/src/ItemsController.cs': controller('ItemsController', 'api/v1', [
    ['Get', 'items/{id}', 'GetItem'],
    ['Get', 'details/{id}', 'GetDetail'],
    ['Get', 'shared', 'GetShared'],
  ]),
};

function traceJson(dir, start) {
  const result = cli(dir, ['trace', start, '--repo', 'web', '--json']);
  return { status: result.status, stderr: result.stderr, json: result.status === 0 ? JSON.parse(result.stdout) : null };
}

test('Web extractor reach AC-14: a web module-level function a span names is a trace start', (t) => {
  const dir = buildRepo(t, FUNCTION_STARTS);
  extractAndJoin(dir);
  const reach = (json) => json.nodes.map((node) => `${node.repo} ${node.kind} ${node.ref}`);
  const shape = (node) => `${node.repo} ${node.kind} ${node.class}.${node.method} ${node.file}`;

  const bare = traceJson(dir, 'fetchItem');
  assert.equal(bare.status, 0, bare.stderr);
  assert.equal(shape(bare.json.root), 'web method ItemsApi.fetchItem src/api/itemsApi.ts');
  assert.ok(reach(bare.json).includes('backend route GET api/v1/items/*'), JSON.stringify(reach(bare.json)));
  assert.ok(reach(bare.json).includes('backend action ItemsController.GetItem'), JSON.stringify(reach(bare.json)));

  const dotted = traceJson(dir, 'ItemsApi.fetchItem');
  assert.equal(dotted.status, 0, dotted.stderr);
  assert.equal(shape(dotted.json.root), shape(bare.json.root));
  assert.ok(reach(dotted.json).includes('backend action ItemsController.GetItem'));

  const inComponentFile = traceJson(dir, 'loadDetail');
  assert.equal(inComponentFile.status, 0, inComponentFile.stderr);
  assert.equal(shape(inComponentFile.json.root), 'web method DetailPage.loadDetail src/pages/DetailPage.tsx', 'a helper of a class component file takes the component as its class');
  assert.ok(reach(inComponentFile.json).includes('backend action ItemsController.GetDetail'));

  const twice = cli(dir, ['trace', 'sharedName', '--repo', 'web']);
  assert.notEqual(twice.status, 0);
  assert.match(twice.stderr, /src\/api\/itemsApi\.ts/);
  assert.match(twice.stderr, /src\/api\/otherApi\.ts/);

  const component = traceJson(dir, 'Badge');
  assert.equal(component.status, 0, component.stderr);
  assert.equal(`${component.json.root.kind} ${component.json.root.file}`, 'component src/components/Badge.tsx', 'a component of the same name keeps its precedence');

  const nested = cli(dir, ['trace', 'onPick', '--repo', 'web']);
  assert.notEqual(nested.status, 0);
  assert.match(nested.stderr, /no page, component, service, route, method or class matches "onPick"/);
});

const REVISION_API = [
  "import { httpClient } from '../http/httpClient';",
  '',
  "const REVISIONS_URL = '/content/v1/revisions';",
  '',
  'export function loadRevision(id: string, rev: number) {',
  '  const url = `${REVISIONS_URL}?contentId=${encodeURIComponent(id)}&rev=${rev}`;',
  '  return httpClient.getGatewayClient().get(url);',
  '}',
  '',
].join('\n');

const REVISION_BACKEND = controller('ContentController', 'content/v1', [['Get', 'revisions', 'GetRevision']]);

const PLAYWRIGHT_SPEC = "import { test } from '@playwright/test';\n\ntest('reads a revision', async ({ page }) => {\n  await page.goto('/');\n});\n";

const CYPRESS_REVISION_SPEC = "describe('revisions', () => {\n  it('loads', () => {\n    cy.intercept('GET', '/content/v1/revisions*');\n  });\n});\n";

/** The report keys of `affected --json` without `--dotnet-filter`, as at the base. */
const AFFECTED_KEYS = 'area,universe,changed,routes,seeds,specs,changedSpecs,uncovered,suites,reasons,fallbacks,fullSuite,widened,widenDropped,braked,stale,exit';

function unmappedLine(path) {
  return `unmapped: ${path} — no configured root holds this path, so it selects nothing`;
}

/** An edit that git sees and that the grammar of the file still reads. */
function edited(path, text, n) {
  if (path.endsWith('.json')) return `${JSON.stringify({ ...JSON.parse(text), edit: n }, null, 2)}\n`;
  if (path.endsWith('.yml')) return `${text}# edit ${n}\n`;
  return `${text}// edit ${n}\n`;
}

/**
 * One git checkout that holds `files`, with `repos` as its configuration. `change(paths, mode)`
 * edits each path (or adds it, when `files` has no text for it) and reads the diff in that
 * mode: a commit read as `HEAD~1..HEAD`, the index, or the working tree. The facts are
 * extracted at the commit that each read starts from, so no stale rung fires.
 */
function gitCheckout(t, repos, files) {
  const dir = buildRepo(t, { 'flowtrace.config.json': config(repos), '.gitignore': 'out/\n', ...files });
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  };
  git('init', '-q');
  git('config', 'user.email', 'selftest@example.invalid');
  git('config', 'user.name', 'flowtrace selftest');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  const extract = () => {
    const result = cli(dir, ['extract']);
    assert.equal(result.status, 0, result.stderr);
  };
  extract();
  let edits = 0;
  const change = (paths, mode = 'range', extra = []) => {
    edits += 1;
    for (const path of paths) {
      const target = join(dir, ...path.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, files[path] === undefined
        ? `export const added${edits} = ${edits};\n`
        : edited(path, readFileSync(target, 'utf8'), edits));
    }
    let args;
    if (mode === 'range') {
      git('add', '-A');
      git('commit', '-q', '-m', `edit ${edits}`);
      extract();
      args = ['--diff', 'HEAD~1..HEAD'];
    } else if (mode === 'staged') {
      git('add', '-A');
      args = ['--staged'];
    } else {
      args = [];
    }
    const result = cli(dir, ['affected', ...args, '--all-routes', '--json', ...extra]);
    const json = JSON.parse(result.stdout);
    assert.equal(result.status, json.exit, result.stderr);
    if (mode !== 'range') {
      git('add', '-A');
      git('commit', '-q', '-m', `edit ${edits} kept`);
      extract();
    }
    return json;
  };
  return { dir, change };
}

function answer(json) {
  return {
    exit: json.exit,
    files: json.changed.files.map((file) => `${file.repo}:${file.path}:${file.kind}`),
    specs: json.changedSpecs.map((spec) => `${spec.repo}:${spec.spec}`),
    routes: json.routes.map((route) => route.key),
    fallbacks: json.fallbacks.map((entry) => `${entry.rung}[${entry.scope}]`),
    reasons: json.reasons,
  };
}

const ATTRIBUTION_FILES = {
  'web/src/http/httpClient.ts': GATEWAY_CLIENT,
  'web/src/api/revisionApi.ts': REVISION_API,
  'backend/src/ContentController.cs': REVISION_BACKEND,
  'e2e/tests/a.spec.ts': PLAYWRIGHT_SPEC,
  'e2e/tests/helper.ts': 'export const pause = 1;\n',
  'tools/notes.ts': 'export const note = 1;\n',
  'tools/x.config.json': '{ "a": 1 }\n',
};

function attributionRepos(backendRoot) {
  return [
    { id: 'web', kind: 'web', root: 'web' },
    { ...BACKEND, root: backendRoot },
    { id: 'e2e', kind: 'playwright', root: 'e2e' },
  ];
}

const HARNESS_LINE = 'harness-change [e2e]: 1 changed harness file — no route walk reaches one, so they select nothing';

test('Web extractor reach AC-20: a diff root in a subfolder attributes each path from the checkout top level, in the three modes', (t) => {
  const { change } = gitCheckout(t, attributionRepos('backend'), ATTRIBUTION_FILES);
  for (const mode of ['range', 'staged', 'worktree']) {
    const web = change(['web/src/api/revisionApi.ts'], mode);
    assert.deepEqual(answer(web).files, ['web:src/api/revisionApi.ts:source'], `${mode}: a web file beside the backend root is the web file`);
    assert.equal(Object.keys(web).join(','), AFFECTED_KEYS);
    assert.deepEqual(answer(change(['backend/src/ContentController.cs'], mode)), {
      exit: 0, files: ['backend:src/ContentController.cs:source'], specs: [], routes: ['GET content/v1/revisions'], fallbacks: [], reasons: [],
    }, `${mode}: a path inside the diff root keeps its base entry and report`);
  }
  assert.deepEqual(answer(change(['web/src/api/added.ts', 'backend/src/Added.cs'], 'worktree')).files, [
    'backend:src/Added.cs:source',
    'web:src/api/added.ts:source',
  ], 'an untracked file beside the diff root and one inside it each get their owner');
  assert.deepEqual(answer(change(['e2e/tests/helper.ts'])), {
    exit: 4, files: ['e2e:tests/helper.ts:harness'], specs: [], routes: [], fallbacks: ['harness-only[e2e]'], reasons: [HARNESS_LINE],
  });
  assert.deepEqual(answer(change(['e2e/tests/a.spec.ts'])), {
    exit: 0, files: ['e2e:tests/a.spec.ts:spec'], specs: ['e2e:tests/a.spec.ts'], routes: [], fallbacks: [],
    reasons: ['spec-only: 1 changed spec file, no production source'],
  });
  assert.deepEqual(answer(change(['tools/notes.ts'])), {
    exit: 3, files: ['null:tools/notes.ts:unmapped'], specs: [], routes: [], fallbacks: [], reasons: [unmappedLine('tools/notes.ts')],
  });
  assert.deepEqual(answer(change(['tools/x.config.json'])), {
    exit: 4, files: ['null:tools/x.config.json:unmapped'], specs: [], routes: [], fallbacks: ['config-only[backend]'], reasons: [],
  }, 'a configuration file under no root keeps the config-only answer and gets no reason line');
});

test('Web extractor reach AC-20: a diff root at the checkout top level keeps the base report', (t) => {
  const { change } = gitCheckout(t, attributionRepos('.'), ATTRIBUTION_FILES);
  for (const mode of ['range', 'staged', 'worktree']) {
    assert.deepEqual(answer(change(['web/src/api/revisionApi.ts'], mode)).files, ['web:src/api/revisionApi.ts:source']);
    assert.deepEqual(answer(change(['backend/src/ContentController.cs'], mode)), {
      exit: 0, files: ['backend:backend/src/ContentController.cs:source'], specs: [], routes: ['GET content/v1/revisions'], fallbacks: [], reasons: [],
    });
  }
  assert.deepEqual(answer(change(['tools/notes.ts'])), {
    exit: 3, files: ['backend:tools/notes.ts:source'], specs: [], routes: [], fallbacks: [], reasons: [],
  });
  assert.deepEqual(answer(change(['tools/x.config.json'])), {
    exit: 4, files: ['backend:tools/x.config.json:config'], specs: [], routes: [], fallbacks: ['config-only[backend]'], reasons: [],
  });
  assert.deepEqual(answer(change(['e2e/tests/helper.ts'])).fallbacks, ['harness-only[e2e]']);
  assert.deepEqual(answer(change(['e2e/tests/a.spec.ts'])).specs, ['e2e:tests/a.spec.ts']);
});

test('Web extractor reach AC-20: a path under no configured root keeps each whole-suite answer and states the rest in one reason line', (t) => {
  const { dir, change } = gitCheckout(t, [
    BACKEND,
    { id: 'web', kind: 'web', root: 'web', cypressSubpath: 'cypress' },
    { id: 'e2e', kind: 'playwright', root: 'e2e' },
  ], {
    'backend/src/ContentController.cs': REVISION_BACKEND,
    'web/src/a.ts': 'export const a = 1;\n',
    'web/package.json': '{ "name": "web" }\n',
    'web/cypress/e2e/rev.cy.ts': CYPRESS_REVISION_SPEC,
    'e2e/tests/a.spec.ts': PLAYWRIGHT_SPEC,
    'e2e/tests/helper.ts': 'export const pause = 1;\n',
    'tools/notes.ts': 'export const note = 1;\n',
    'tools/a.spec.ts': PLAYWRIGHT_SPEC,
    '.github/workflows/ci.yml': 'name: ci\n',
    'generated/api.ts': 'export const g = 1;\n',
    'libs/Web/BaseController.cs': 'namespace Lib\n{\n    public class BaseController { }\n}\n',
    'src/ContentController.cs': REVISION_BACKEND,
  });
  const cases = [
    [['tools/a.spec.ts'], { exit: 3, specs: [], fallbacks: [], reasons: [unmappedLine('tools/a.spec.ts')] }],
    [['tools/notes.ts', 'e2e/tests/a.spec.ts'], { exit: 0, specs: ['e2e:tests/a.spec.ts'], fallbacks: [], reasons: [unmappedLine('tools/notes.ts')] }],
    [['e2e/tests/helper.ts', 'tools/notes.ts'], { exit: 3, specs: [], fallbacks: [], reasons: [HARNESS_LINE, unmappedLine('tools/notes.ts')] }],
    [['.github/workflows/ci.yml'], { exit: 4, specs: [], fallbacks: ['config-only[backend]'], reasons: [] }],
    [['generated/api.ts'], { exit: 4, specs: [], fallbacks: ['config-only[backend]'], reasons: [] }],
    [['web/package.json'], { exit: 4, specs: [], fallbacks: ['config-only[web]'], reasons: [] }],
    [['.github/workflows/ci.yml', 'tools/notes.ts'], {
      exit: 3, specs: [], fallbacks: [], reasons: [unmappedLine('.github/workflows/ci.yml'), unmappedLine('tools/notes.ts')],
    }],
    [['libs/Web/BaseController.cs'], { exit: 4, specs: [], fallbacks: ['unindexed[backend]'], reasons: [] }],
    [['src/ContentController.cs'], { exit: 4, specs: [], fallbacks: ['unindexed[backend]'], reasons: [] }],
    [['backend/src/ContentController.cs', 'tools/notes.ts'], {
      exit: 4, specs: [], fallbacks: ['max-share[web]'], reasons: [unmappedLine('tools/notes.ts')],
    }],
  ];
  for (const [paths, expected] of cases) {
    const { files, routes, ...rest } = answer(change(paths));
    assert.deepEqual(rest, expected, paths.join(' '));
    assert.ok(files.every((file) => !file.startsWith('backend:') || file === 'backend:src/ContentController.cs:source'), files.join(' '));
    assert.deepEqual(routes, paths.includes('backend/src/ContentController.cs') ? ['GET content/v1/revisions'] : [],
      `${paths.join(' ')}: no route through a backend file with the same relative path`);
  }
  change(['tools/notes.ts']);
  rmSync(join(dir, 'out', 'facts', 'backend.json'));
  const result = cli(dir, ['affected', '--diff', 'HEAD~1..HEAD', '--all-routes', '--json']);
  const noFacts = answer(JSON.parse(result.stdout));
  assert.deepEqual([noFacts.exit, noFacts.fallbacks, noFacts.reasons], [4, ['no-facts[backend]'], []], 'no-facts reads the path and states no line');
});

test('Web extractor reach AC-20: a path with the relative path of a backend file that the route reaches selects no route', (t) => {
  const service = 'namespace Sample.Api.Services\n{\n    public class ContentService\n    {\n        public string Load(string id) { return id; }\n    }\n}\n';
  const injected = REVISION_BACKEND
    .replace('    {\n        [HttpGet', '    {\n        private readonly ContentService _service;\n        public ContentController(ContentService service) { _service = service; }\n        [HttpGet')
    .replace('return Ok();', 'return Ok(_service.Load(id));');
  const { change } = gitCheckout(t, [BACKEND, { id: 'web', kind: 'web', root: 'web', cypressSubpath: 'cypress' }], {
    'backend/src/Controllers/ContentController.cs': injected,
    'backend/src/Services/ContentService.cs': service,
    'src/Services/ContentService.cs': service,
    'web/src/a.ts': 'export const a = 1;\n',
    'web/cypress/e2e/rev.cy.ts': CYPRESS_REVISION_SPEC,
  });
  assert.deepEqual(answer(change(['backend/src/Services/ContentService.cs'])).routes, ['GET content/v1/revisions'],
    'the route walk reaches the backend service');
  assert.deepEqual(answer(change(['src/Services/ContentService.cs'])), {
    exit: 3, files: ['null:src/Services/ContentService.cs:unmapped'], specs: [], routes: [], fallbacks: [],
    reasons: [unmappedLine('src/Services/ContentService.cs')],
  });
});

test('Web extractor reach AC-20: --dotnet-filter reads a C# path under no configured root as a file under no project', (t) => {
  const { change } = gitCheckout(t, [BACKEND, { id: 'other', kind: 'backend', root: 'other' }, { id: 'web', kind: 'web', root: 'web' }], {
    'backend/Api/Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"><ItemGroup><ProjectReference Include="../../libs/Common/Common.csproj" /></ItemGroup></Project>\n',
    'backend/Api/Controllers/ThingController.cs': controller('ThingController', 'things', [['Get', 'list', 'List']]),
    'backend/Api.Tests/Api.Tests.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>\n',
    'backend/Api.Tests/ThingTests.cs': 'using Common;\nusing Xunit;\n\nnamespace Sample.Api.Tests\n{\n    public class ThingTests\n    {\n        [Fact]\n        public void MakesAThing() { var t = new Thing(); }\n    }\n}\n',
    'libs/Common/Common.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>\n',
    'libs/Common/Thing.cs': 'namespace Common\n{\n    public class Thing { }\n}\n',
    'libs/Common/generated/Thing.cs': 'namespace Common.Generated\n{\n    public class GeneratedThing { }\n}\n',
    'Api/Shared.cs': 'namespace Sample.Api\n{\n    public class Shared { }\n}\n',
    'other/src/Helper.cs': 'namespace Other\n{\n    public class Helper { }\n}\n',
    'web/src/a.ts': 'export const a = 1;\n',
    'web/src/a.spec.ts': PLAYWRIGHT_SPEC,
  });
  const outOfScope = (path) => `out-of-scope: ${path} — a changed file under no project of the solution, so which tests compile against it is unknown`;
  const filter = (paths) => {
    const json = change(paths, 'range', ['--dotnet-filter']);
    return { ...answer(json), dotnet: json.dotnetFilter };
  };
  const unmappedLines = (got) => got.reasons.filter((line) => line.startsWith('unmapped:'));

  const libs = filter(['libs/Common/Thing.cs']);
  assert.deepEqual([libs.exit, libs.files, libs.dotnet.fallback, libs.dotnet.reason, libs.dotnet.expression, unmappedLines(libs)],
    [4, ['null:libs/Common/Thing.cs:unmapped'], true, outOfScope('libs/Common/Thing.cs'), '', []]);
  const shared = filter(['Api/Shared.cs']);
  assert.deepEqual([shared.exit, shared.dotnet.reason, unmappedLines(shared)], [4, outOfScope('Api/Shared.cs'), []]);
  const generated = filter(['libs/Common/generated/Thing.cs']);
  assert.deepEqual([generated.exit, generated.fallbacks, generated.dotnet.reason, unmappedLines(generated)],
    [4, ['config-only[backend]'], outOfScope('libs/Common/generated/Thing.cs'), []]);
  const withSpec = filter(['libs/Common/generated/Thing.cs', 'web/src/a.spec.ts']);
  assert.deepEqual([withSpec.exit, withSpec.specs, withSpec.dotnet.reason, unmappedLines(withSpec)],
    [4, ['web:src/a.spec.ts'], outOfScope('libs/Common/generated/Thing.cs'), []]);
  const withRoute = filter(['libs/Common/Thing.cs', 'backend/Api/Controllers/ThingController.cs']);
  assert.deepEqual([withRoute.exit, withRoute.dotnet.reason, unmappedLines(withRoute)], [4, outOfScope('libs/Common/Thing.cs'), []]);
  const helper = filter(['other/src/Helper.cs']);
  assert.deepEqual([helper.files, unmappedLines(helper)], [['other:src/Helper.cs:source'], []],
    'a path that another configured backend holds is a file of that backend');
  const plain = answer(change(['libs/Common/Thing.cs']));
  assert.deepEqual([plain.exit, plain.reasons], [3, [unmappedLine('libs/Common/Thing.cs')]]);
});

const UNMAPPED_SERVICE = { repo: null, path: 'src/Services/ContentService.cs', kind: 'unmapped' };

/** A backend that declares `ContentService` at the relative path of the unmapped file, with a wide fan-in. */
function twinFacts() {
  const injectors = Array.from({ length: 30 }, (_, i) => ({ type: 'ctor_field', file: `src/C${i}.cs`, line: 1, class: `C${i}`, paramType: 'IContentService' }));
  return [{
    repo: 'backend',
    facts: [
      { type: 'method_span', file: 'src/Services/ContentService.cs', line: 1, endLine: 3, class: 'ContentService', method: 'Load' },
      { type: 'di_binding', file: 'src/Startup.cs', line: 1, iface: 'IContentService', impl: 'ContentService' },
      ...injectors,
    ],
  }];
}

test('Web extractor reach AC-20: an unmapped path calls no impact, adds no shared dependency and keeps the base report without diffRepo', () => {
  const calls = [];
  const impact = (root, path) => {
    calls.push(`${root} ${path}`);
    const edges = [{ file: 'src/Widened.cs', via: 'iface' }];
    edges.braked = [{ iface: 'IContentService' }];
    return edges;
  };
  const repos = [{ id: 'backend', kind: 'backend', root: '/checkout/backend' }];
  const run = (changed, extra = {}) => affected(twinFacts(), {
    changed, repos, stale: [], hops: 1, memberScoped: true, impact, diffRepo: 'backend', ...extra,
  });

  const unmapped = run([UNMAPPED_SERVICE]);
  assert.deepEqual(calls, [], 'no impact call for an unmapped path, also with a backend file at the same relative path');
  assert.deepEqual([unmapped.widened, unmapped.widenDropped, unmapped.braked], [[], [], []]);
  assert.ok(!unmapped.reasons.some((line) => line.startsWith('shared-dependency:')), unmapped.reasons.join('\n'));
  assert.deepEqual([unmapped.exit, unmapped.reasons.at(-1)], [3, unmappedLine('src/Services/ContentService.cs')]);

  const owned = run([{ repo: 'backend', path: 'src/Services/ContentService.cs', kind: 'source' }]);
  assert.deepEqual(calls, ['/checkout/backend src/Services/ContentService.cs'], 'the owned path keeps its impact call');
  assert.ok(owned.reasons.some((line) => line.startsWith('shared-dependency: ContentService')), owned.reasons.join('\n'));
  assert.deepEqual(owned.braked.map((entry) => entry.iface), ['IContentService'], 'the owned path keeps its brake entry');
  assert.ok(!owned.reasons.some((line) => line.startsWith('unmapped:')));

  const changed = [UNMAPPED_SERVICE, { repo: null, path: '.github/ci.yml', kind: 'unmapped' }];
  const base = affected(twinFacts(), { changed, repos, stale: [] });
  assert.deepEqual([base.exit, base.reasons, base.fallbacks], [3, [], []], 'without diffRepo an unmapped path reads as at the base');
  assert.deepEqual(affected(twinFacts(), { changed, repos, stale: [], diffRepo: null }), base);

  const stale = run([UNMAPPED_SERVICE], { stale: [{ kind: 'head', message: 'backend: the facts are behind the repository HEAD' }] });
  assert.equal(stale.exit, 4);
  assert.equal(stale.reasons.at(-1), unmappedLine('src/Services/ContentService.cs'));
});

test('Web extractor reach AC-20: the Nx union reads the same projects and the reason line comes last', (t) => {
  const workspace = buildRepo(t, {
    'nx.json': {},
    'apps/shop/project.json': { name: 'shop', root: 'apps/shop', targets: { e2e: { options: { specs: 'apps/shop/e2e/a.cy.ts' } } } },
  });
  const nx = { repo: 'web', root: workspace, ref: 'HEAD~1', run: () => '["shop"]' };
  const facts = [{ repo: 'backend', facts: [] }];
  const report = affected(facts, { changed: [{ repo: null, path: 'tools/notes.ts', kind: 'unmapped' }], stale: [], nx, diffRepo: 'backend' });
  const owned = affected(facts, { changed: [{ repo: 'backend', path: 'tools/notes.ts', kind: 'source' }], stale: [], nx });
  assert.deepEqual(report.nx, owned.nx, 'the Nx union is the union of the base attribution');
  assert.deepEqual(report.nx.added, ['apps/shop/e2e/a.cy.ts']);
  assert.deepEqual(report.reasons, [...owned.reasons, unmappedLine('tools/notes.ts')]);

  const spec = affected(facts, { changed: [{ repo: null, path: 'tools/a.spec.ts', kind: 'unmapped' }], stale: [], nx, diffRepo: 'backend' });
  assert.deepEqual([spec.nx, spec.exit, spec.reasons], [undefined, 3, [unmappedLine('tools/a.spec.ts')]],
    'an unmapped spec is no spec-only diff, and the return for a diff with no source comes before the union');
});
