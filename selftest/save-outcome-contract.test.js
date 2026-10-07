/**
 * What the save endpoint answers when it refuses, as the page a QA reader gets states it.
 * A status is a claim about the backend: it may be made where the source returns one or an
 * `exception_map` fact maps one, and nowhere else. The web caller's own reading of the
 * response body is a different claim about a different thing, and neither may be printed as
 * the other.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT, runCli } from './helpers.js';

const FIXTURE = join(REPO_ROOT, 'selftest', 'corpus', 'greenhouse-alerts');
const ROUTE = 'PUT glasshouse/v1/zones/*/watchers';
let pack = '';
let config = '';
let page = '';

before(() => {
  pack = mkdtempSync(join(tmpdir(), 'flowtrace-save-outcomes-'));
  cpSync(FIXTURE, pack, { recursive: true });
  config = join(pack, 'greenhouse.config.json');
  assert.equal(runCli(['extract', '--config', config]).status, 0);
  assert.equal(runCli(['join', '--config', config]).status, 0);
  const written = runCli(['span', ROUTE, '--config', config]);
  assert.equal(written.status, 0, written.stderr);
  const target = written.stdout.slice(written.stdout.lastIndexOf(' -> ') + 4).trim();
  page = readFileSync(target, 'utf8');
});

after(() => {
  rmSync(pack, { recursive: true, force: true });
});

test('a fault the pack maps to no status is stated as unhandled, never mapped', () => {
  assert.match(page, /ArgumentException is unhandled/);
  assert.doesNotMatch(page, /ArgumentException → \d\d\d/);
});

test('a status the source returns itself is stated as the source states it', () => {
  assert.match(page, /400 BadRequest/);
});

test('the backend page names no web-side notice key', () => {
  assert.doesNotMatch(page, /watchers-saved|watchers-unconfirmed|watchers-failed/);
});

/**
 * The three feedback paths are static claims about source this pack cannot execute, so they are
 * read as source: the gateway's answer has to be the shape the thunk reads, the endpoint has to be
 * able to answer stored and not-stored under one status, and each notice has to answer a state
 * those two can actually produce. A pack that asserts reachability across layers it never lines up
 * would pin three arms, two of which could not happen.
 */
const source = (relPath) => readFileSync(join(FIXTURE, relPath), 'utf8');

test('the thunk asks whether the watchers were stored of the answer, never of a status', () => {
  const thunk = source('web/src/actions/watchers.ts');
  const gateway = source('web/src/http/httpClient.ts');
  assert.match(thunk, /if \(!response\.stored\)/, 'the stored question is asked of the answer');
  assert.doesNotMatch(thunk, /response\.status|response\.body/, 'the caller reads no status and no wrapped body');
  assert.match(
    gateway,
    /return response\.status === 204 \? null : response\.json\(\);/,
    'the gateway resolves the caller with the parsed body, and with nothing where the endpoint answers no body',
  );
});

test('the endpoint answers stored or not-stored under the same status', () => {
  const controller = source('backend/src/Controllers/ZoneWatchersController.cs');
  const service = source('backend/src/Services/WatcherService.cs');
  assert.match(controller, /return Ok\(result\);/, 'the replace answers a body, not an empty status');
  assert.doesNotMatch(controller, /NoContent\(\)/);
  assert.match(
    service,
    /Stored = eligible\.Count == growerIds\.Count/,
    'stored reports whether every requested watcher was kept, so a filtered selection answers false',
  );
});

test('each notice answers a state this source can produce', () => {
  const thunk = source('web/src/actions/watchers.ts');
  const gateway = source('web/src/http/httpClient.ts');
  const eligibility = source('backend/src/Eligibility/WatcherEligibility.cs');
  assert.match(thunk, /dispatch\(showNotice\('watchers-saved'\)\)/);
  assert.match(thunk, /dispatch\(showNotice\('watchers-unconfirmed'\)\)/);
  assert.match(thunk, /\.catch\(\(\) => dispatch\(showNotice\('watchers-failed'\)\)\)/);
  assert.match(
    eligibility,
    /growerIds\.Where\(/,
    'the filter can keep fewer than were selected, which is the false the saved notice does not answer',
  );
  assert.match(gateway, /throw new Error/, 'a rejected request reaches the rejection handler');
});
