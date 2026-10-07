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

test('the response-body check the caller makes is not printed as a status', () => {
  assert.doesNotMatch(page, /watchers-unconfirmed/);
  assert.doesNotMatch(page, /response\.body\.stored/);
});
