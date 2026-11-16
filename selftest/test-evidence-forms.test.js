/**
 * The closed lists of source forms that the handler, visit, subject, template and sender
 * readers support. Each listed form has a row with its exact result, beside a row of the same
 * shape that the list leaves out, which gives the safe result of its fact.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
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

