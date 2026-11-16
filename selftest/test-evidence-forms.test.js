/**
 * The closed lists of source forms that the handler, visit, subject, template and sender
 * readers support. Each listed form has a row with its exact result, beside a row of the same
 * shape that the list leaves out, which gives the safe result of its fact.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { isExcluded } from '../lib/affected.js';
import { walk } from '../lib/walk.js';
import { extractRepoFacts, writeRepo } from './helpers.js';

const CONTROLLER = `using Microsoft.AspNetCore.Mvc;

namespace Tidepool.Api.Controllers
{
    [ApiController]
    [Route("api/items")]
    public class ItemController : ControllerBase
    {
        [HttpGet]
        public IActionResult List() { return Ok(); }
    }
}
`;

const RUNNER_REPOS = [
  { id: 'api', kind: 'backend', root: 'backend', role: ['api'] },
  { id: 'web', kind: 'web', root: 'web', cypressSubpath: 'cypress' },
  { id: 'mobile', kind: 'mobile', root: 'mobile' },
  { id: 'suite', kind: 'playwright', root: 'suite' },
];

const indent = (code) => code.split('\n').map((line) => `    ${line}`).join('\n');

const HANDLER_DECLARATIONS = `function namedFunction(req) {
  req.reply({ body: [] });
}
const namedConst = (req) => req.destroy();
let namedLet = function (req) { req.reply('ok'); };
var namedVar = (req) => { req.continue(); };
const twice = (req) => req.reply();
function twice(req) { req.destroy(); }
const madeHandler = makeHandler();
`;

// [row, handler argument or null for none, word]
const HANDLER_ROWS = [
  ['none', null, 'spy'],
  ['string', "'plain text'", 'fulfill'],
  ['string-joined', "'plain ' + text", 'unresolved'],
  ['template', '`plain text`', 'fulfill'],
  ['template-joined', '`plain` + text', 'unresolved'],
  ['array', '[{ id: 1 }]', 'fulfill'],
  ['array-called', '[{ id: 1 }].concat(more)', 'unresolved'],
  ['object', '{ body: [] }', 'fulfill'],
  ['object-quoted-key', "{ 'statusCode': 200, \"body\": [] }", 'fulfill'],
  ['object-shorthand', '{ body, statusCode: 200, }', 'fulfill'],
  ['object-member', '{ body: [] }.body', 'unresolved'],
  ['object-spread', '{ body: [], ...extra }', 'unresolved'],
  ['object-computed', '{ [key]: true, body: [] }', 'unresolved'],
  ['object-method', '{ body: [], headers() { return {}; } }', 'unresolved'],
  ['object-accessor', '{ get body() { return []; } }', 'unresolved'],
  ['error-true', '{ forceNetworkError: true }', 'abort'],
  ['error-quoted-true', "{ 'forceNetworkError': true }", 'abort'],
  ['error-false', '{ forceNetworkError: false, body: [] }', 'fulfill'],
  ['error-twice', '{ forceNetworkError: false, forceNetworkError: true }', 'unresolved'],
  ['error-spread', '{ forceNetworkError: false, ...{ forceNetworkError: true } }', 'unresolved'],
  ['error-name', '{ forceNetworkError: offline }', 'unresolved'],
  ['error-shorthand', '{ forceNetworkError }', 'unresolved'],
  ['error-nested', '{ body: { forceNetworkError: true } }', 'fulfill'],
  ['arrow-reply', '(req) => req.reply()', 'fulfill'],
  ['arrow-bare-param', 'req => req.destroy()', 'abort'],
  ['arrow-optional-call', '(req) => { req?.reply(); }', 'fulfill'],
  ['arrow-bound', '((req) => req.destroy()).bind(null)', 'unresolved'],
  ['arrow-no-plain-param', '({ reply }) => reply()', 'unresolved'],
  ['function-reply', 'function (req) { req.reply(200, []); }', 'fulfill'],
  ['reply-error', '(req) => req.reply({ forceNetworkError: true })', 'abort'],
  ['reply-error-twice', '(req) => req.reply({ forceNetworkError: false, forceNetworkError: true })', 'unresolved'],
  ['reply-spread', '(req) => req.reply({ ...canned })', 'unresolved'],
  ['continue-send', '(req) => { req.continue((res) => { res.send([]); }); }', 'fetch-fulfill'],
  ['continue-look', '(req) => { req.continue((res) => { expect(res.statusCode).to.eq(200); }); }', 'spy'],
  ['continue-bare', '(req) => { req.continue(); }', 'spy'],
  ['on-response-send', "(req) => { req.on('response', (res) => res.send(200)); }", 'fetch-fulfill'],
  ['on-before-response-send', "(req) => { req.on('before:response', (res) => res.send(200)); }", 'fetch-fulfill'],
  ['on-response-look', "(req) => { req.on('response', (res) => { expect(res).to.exist; }); }", 'spy'],
  ['on-other-event', "(req) => { req.on('request', (res) => res.send(200)); }", 'spy'],
  ['strongest', '(req) => { req.destroy(); req.reply(); }', 'fulfill'],
  ['handed-on', '(req) => { handOff(req); }', 'unresolved'],
  ['looks-only', '(req) => { expect(req.body).to.exist; }', 'spy'],
  ['named-function', 'namedFunction', 'fulfill'],
  ['named-const', 'namedConst', 'abort'],
  ['named-let', 'namedLet', 'fulfill'],
  ['named-var', 'namedVar', 'spy'],
  ['named-twice', 'twice', 'unresolved'],
  ['named-not-function', 'madeHandler', 'unresolved'],
  ['named-undeclared', 'importedHandler', 'unresolved'],
];

test('Test evidence AC-10: each listed handler form gives its word, and each named unlisted form gives unresolved, in both Cypress readers', (t) => {
  const intercepts = HANDLER_ROWS.map(([row, handler]) =>
    `cy.intercept('GET', '**/api/${row}'${handler === null ? '' : `, ${handler}`});`,
  ).join('\n');
  const spec = `${HANDLER_DECLARATIONS}
describe('handlers', () => {
  it('reads each handler form', () => {
${indent(intercepts)}
  });
});
`;
  const dir = writeRepo(
    t,
    { 'backend/src/Controllers/ItemController.cs': CONTROLLER, 'web/cypress/e2e/handlers.cy.ts': spec, 'mobile/cypress/e2e/handlers.cy.ts': spec },
    { repos: RUNNER_REPOS.slice(0, 3) },
  );
  const expected = HANDLER_ROWS.map(([row, , word]) => [row, word]);
  for (const repo of ['web', 'mobile']) {
    const handlers = extractRepoFacts(dir, repo)
      .filter((fact) => fact.type === 'cypress_intercept')
      .map((fact) => [fact.pattern.replace('**/api/', ''), fact.handler]);
    assert.deepEqual(handlers, expected, repo);
  }
});

// [row, first argument text or null for none, path or null for not-literal]
const VISIT_ROWS = [
  ['string', "'/items'", '/items'],
  ['string-escapes', '"/caf\\u00e9\\x21"', '/café!'],
  ['string-holding-dollar-brace', "'/items/${id}'", '/items/${id}'],
  ['string-joined', "'/items/' + id", null],
  ['template', '`/items`', '/items'],
  ['template-escapes', '`/caf\\u00e9`', '/café'],
  ['template-interpolated', '`/items/${id}`', null],
  ['template-escaped-interpolation', '`/items/\\${id}`', null],
  ['no-argument', null, null],
  ['name', 'itemsPath', null],
  ['call', "pathFor('items')", null],
  ['options-object', "{ url: '/items' }", null],
];

function visitSpecs(rows) {
  const pw = rows
    .map(([row, arg]) => `test('${row}', async ({ page }) => {\n  await page.goto(${arg ?? ''});\n});\n`)
    .join('\n');
  const cy = rows.map(([row, arg]) => `  it('${row}', () => {\n    cy.visit(${arg ?? ''});\n  });`).join('\n');
  return {
    'suite/e2e/visits.pw.ts': `import { test } from '@playwright/test';\n\n${pw}`,
    'web/cypress/e2e/visits.cy.ts': `describe('visits', () => {\n${cy}\n});\n`,
  };
}

test('Test evidence AC-15: each listed visit argument gives its path, and each named unlisted argument gives not-literal', (t) => {
  const dir = writeRepo(t, { 'backend/src/Controllers/ItemController.cs': CONTROLLER, ...visitSpecs(VISIT_ROWS) }, { repos: RUNNER_REPOS });
  const expected = VISIT_ROWS.map(([row, , path]) => [row, path, path === null ? 'not-literal' : null]);
  for (const [repo, type] of [['suite', 'pw_visit'], ['web', 'cypress_visit']]) {
    const visits = extractRepoFacts(dir, repo)
      .filter((fact) => fact.type === type)
      .map((fact) => [fact.test, fact.path, fact.reason ?? null]);
    assert.deepEqual(visits, expected, repo);
  }
});

// [row, statements before the read, read argument, subject or null for unreadable-subject].
// `readText` takes its subject at index 0 and `readMail` at index 0, key `subject`.
const SUBJECT_ROWS = [
  ['string', '', "readText('Welcome')", 'Welcome'],
  ['string-escapes', '', "readText('It\\'s \\x41\\u{42}')", "It's AB"],
  ['string-joined', '', "readText('Welcome ' + member)", null],
  ['template', '', 'readText(`Code ${code}!`)', 'Code *!'],
  ['template-joined', '', 'readText(`Code` + code)', null],
  ['const', "const subject = 'Welcome';", 'readText(subject)', 'Welcome'],
  ['const-typed', "const subject: string = 'Welcome';", 'readText(subject)', 'Welcome'],
  ['const-template', 'const subject = `Hi ${name}`;', 'readText(subject)', 'Hi *'],
  ['const-line-end', "const subject = 'Welcome'", 'readText(subject)', 'Welcome'],
  ['const-long-comment', "const subject = 'Welcome' /* a comment that runs well past forty characters */;", 'readText(subject)', 'Welcome'],
  ['const-in-outer-block', "const subject = 'Welcome';\nif (ready) {", 'readText(subject);\n}', 'Welcome'],
  ['const-joined-past-comment', "const subject = 'Welcome ' /* a comment that runs well past forty characters */ + member;", 'readText(subject)', null],
  ['const-joined-next-line', "const subject = 'Welcome'\n  + member;", 'readText(subject)', null],
  ['const-member-next-line', "const subject = 'Welcome'\n  .trim();", 'readText(subject)', null],
  ['const-two-declarators', "const subject = 'Welcome', other = 'Other';", 'readText(subject)', null],
  ['const-second-declarator', "const prefix = 'unused', subject = 'Welcome';", 'readText(subject)', null],
  ['const-call', 'const subject = subjectFor(member);', 'readText(subject)', null],
  ['let', "let subject = 'Welcome';", 'readText(subject)', null],
  ['const-in-closed-block', "{\n  const subject = 'Inner';\n}", 'readText(subject)', null],
  ['const-nearer-let', "const subject = 'Outer';\n{\n  let subject = 'Inner';", 'readText(subject);\n}', null],
  ['const-nearer-var', "const subject = 'Outer';\nitems.forEach(() => {\n  var subject = 'Inner';", 'readText(subject);\n});', null],
  ['const-nearer-arrow-param', "const subject = 'Outer';\nitems.forEach((subject) => {", 'readText(subject);\n});', null],
  ['const-nearer-bare-param', "const subject = 'Outer';\nitems.forEach(subject =>", 'readText(subject));', null],
  ['const-nearer-function-param', "const subject = 'Outer';\nitems.forEach(function (subject) {", 'readText(subject);\n});', null],
  ['const-nearer-const', "const subject = 'Outer';\nif (ready) {\n  const subject = 'Inner';", 'readText(subject);\n}', 'Inner'],
  ['object', '', "readMail({ subject: 'Welcome' })", 'Welcome'],
  ['object-quoted-key', '', "readMail({ 'subject': 'Welcome', to: inbox })", 'Welcome'],
  ['object-template', '', 'readMail({ "subject": `Code ${code}` })', 'Code *'],
  ['object-shorthand', "const subject = 'Welcome';", 'readMail({ subject, })', 'Welcome'],
  ['object-key-twice', '', "readMail({ subject: 'Welcome', subject: 'Other' })", null],
  ['object-spread-after', '', "readMail({ subject: 'Welcome', ...extra })", null],
  ['object-spread-before', '', "readMail({ ...base, subject: 'Welcome' })", null],
  ['object-computed', '', "readMail({ [key]: 'x', subject: 'Welcome' })", null],
  ['object-method', '', "readMail({ subject: 'Welcome', to() { return inbox; } })", null],
  ['object-accessor', '', "readMail({ get subject() { return 'Welcome'; } })", null],
  ['object-no-key', '', 'readMail({ to: inbox })', null],
  ['object-not-literal', '', 'readMail(options)', null],
  ['object-shorthand-unbound', '', 'readMail({ subject })', null],
];

const FILE_CONST = "const SUBJECT = 'File level';";
const FILE_ROW = ['const-outside-test-region', '', 'readText(SUBJECT)', null];

function readSpecs(rows) {
  const pw = rows
    .map(([row, before, read]) => `test('${row}', async () => {\n${indent([before, `await ${read};`].filter(Boolean).join('\n'))}\n});\n`)
    .join('\n');
  const cy = rows
    .map(([row, before, read]) => `  it('${row}', () => {\n${indent(indent([before, `cy.${read};`].filter(Boolean).join('\n')))}\n  });`)
    .join('\n');
  return {
    'suite/e2e/reads.pw.ts': `import { test } from '@playwright/test';\n${FILE_CONST}\n\n${pw}`,
    'web/cypress/e2e/reads.cy.ts': `${FILE_CONST}\ndescribe('reads', () => {\n${cy}\n});\n`,
  };
}

test('Test evidence AC-18: each listed subject form gives its subject, and each named unlisted form gives unreadable-subject', (t) => {
  const rows = [...SUBJECT_ROWS, FILE_ROW];
  const dir = writeRepo(t, { 'backend/src/Controllers/ItemController.cs': CONTROLLER, ...readSpecs(rows) }, {
    repos: RUNNER_REPOS,
    email: {
      reads: [
        { call: 'readText', subject: 0 },
        { call: 'readMail', subject: '0.subject' },
      ],
    },
  });
  const expected = rows.map(([row, , , subject]) => [row, subject, subject === null ? 'unreadable-subject' : null]);
  for (const repo of ['suite', 'web']) {
    const reads = extractRepoFacts(dir, repo)
      .filter((fact) => fact.type === 'email_read')
      .map((fact) => [fact.test, fact.subject, fact.reason ?? null]);
    assert.deepEqual(reads, expected, repo);
  }
});

test('Test evidence AC-19: the exclusion globs of walk and affected keep the release answers', (t) => {
  assert.equal(isExcluded('a.stories.ts', ['**/*.stories.ts']), false, 'affected keeps the root file a.stories.ts');
  assert.equal(isExcluded('src/b.ts', ['src/**/b.ts']), false, 'affected keeps src/b.ts');
  assert.equal(isExcluded('src/c/b.ts', ['src/**/b.ts']), true, 'affected excludes a nested src/c/b.ts');
  const root = mkdtempSync(join(tmpdir(), 'flowtrace-walk-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ['src/automock/a.ts', 'src/mock/b.ts', 'src/kept/c.ts']) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), 'export {};\n');
  }
  const found = walk(root, { extensions: ['.ts'], exclude: ['**/mock'] }).map((path) => path.slice(root.length + 1)).sort();
  assert.deepEqual(found, ['src/kept/c.ts'], 'walk skips the directory src/automock');
});
