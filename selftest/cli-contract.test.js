/**
 * The CLI's outer contract: argument parsing, --help, and the usage-error shape every
 * command shares. None of this touches extraction or the walk — see json-contract.test.js
 * and affected.test.js for that.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { runCli } from './helpers.js';

const DOCUMENTED_COMMANDS = [
  'extract', 'join', 'render', 'trace', 'routes-of', 'span', 'surface', 'skeleton',
  'cover', 'affected', 'scaffold', 'cases', 'readiness', 'all',
];

test('--help exits 0, prints usage to stdout, and lists every documented command', () => {
  const { status, stdout, stderr } = runCli(['--help']);
  assert.equal(status, 0);
  assert.equal(stderr, '');
  assert.match(stdout, /^usage: flowtrace <command> \[options\]/);
  for (const command of DOCUMENTED_COMMANDS) {
    assert.match(stdout, new RegExp(`^  ${command}\\b`, 'm'), `--help should list "${command}"`);
  }
});

test('-h is the same help as --help', () => {
  const long = runCli(['--help']);
  const short = runCli(['-h']);
  assert.equal(short.status, 0);
  assert.equal(short.stdout, long.stdout);
});

test('no command given exits 2 with the reason on stderr and nothing on stdout', () => {
  const { status, stdout, stderr } = runCli([]);
  assert.equal(status, 2);
  assert.equal(stdout, '');
  assert.match(stderr, /^flowtrace: no command given\n/);
  assert.match(stderr, /^usage: flowtrace <command> \[options\]/m);
});

test('an unrecognised command exits 2 and names the command it did not recognise', () => {
  const { status, stdout, stderr } = runCli(['not-a-real-flowtrace-command']);
  assert.equal(status, 2);
  assert.equal(stdout, '');
  assert.match(stderr, /^flowtrace: unknown command "not-a-real-flowtrace-command"\n/);
});

test('a missing --config file exits 2 with an actionable message, not a stack trace', () => {
  const { status, stdout, stderr } = runCli(['extract', '--config', '/no/such/flowtrace.config.json']);
  assert.equal(status, 2);
  assert.equal(stdout, '');
  assert.match(stderr, /no configuration file at \/no\/such\/flowtrace\.config\.json/);
  assert.match(stderr, /--config <path>/);
  assert.doesNotMatch(stderr, /at Object\.<anonymous>/, 'a usage error should not leak a stack trace');
});
