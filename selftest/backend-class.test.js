import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { copyFixture, runCli, writeJsonFile } from './helpers.js';

const CORPUS = 'kettle-market';
const BACKEND_REFUSAL =
  '"backend" must be an object with optional "mockCalls" and "patchCalls", each an array of call names ' +
  '(an identifier or a dotted chain of identifiers), with no name in both';

function corpusConfig(dir) {
  return JSON.parse(readFileSync(join(dir, 'kettle.config.json'), 'utf8'));
}

/** Writes `name` as the corpus configuration with `backend` replaced, or removed for `undefined`. */
function writeBackendConfig(dir, name, backend) {
  const config = corpusConfig(dir);
  if (backend === undefined) delete config.backend;
  else config.backend = backend;
  writeJsonFile(dir, name, config);
}

test('Backend class AC-10: every malformed backend value is one refusal with the configuration exit code', (t) => {
  const dir = copyFixture(t, CORPUS);
  const malformed = {
    'not an object': 'mockAllEndpoints',
    'an array': ['mockAllEndpoints'],
    'an unknown key': { mockCalls: [], spyCalls: [] },
    'a list that is not an array': { mockCalls: 'stubEveryEndpoint' },
    'an empty name': { patchCalls: [' '] },
    'a name that is not a callee': { mockCalls: ['stub every endpoint'] },
    'a name that is not a string': { mockCalls: [7] },
    'a name in both lists': { mockCalls: ['stubEveryEndpoint'], patchCalls: [' stubEveryEndpoint'] },
  };
  for (const [label, backend] of Object.entries(malformed)) {
    writeBackendConfig(dir, 'malformed.config.json', backend);
    for (const args of [
      ['extract', '--config', 'malformed.config.json'],
      ['check', '--config', 'malformed.config.json', '--area', 'kettle.area.txt'],
    ]) {
      const result = runCli(args, { cwd: dir });
      assert.equal(result.status, 2, `${label} (${args[0]}): ${result.stderr}`);
      const first = result.stderr.split('\n')[0];
      assert.ok(first.endsWith(`malformed.config.json: ${BACKEND_REFUSAL}`), `${label} (${args[0]}): ${first}`);
    }
  }
});

test('Backend class AC-10: an empty backend, one list and names with outer spaces load', (t) => {
  const dir = copyFixture(t, CORPUS);
  for (const backend of [{}, { mockCalls: ['stubEveryEndpoint'] }, { patchCalls: ['  seedBasket ', 'seedBasket'] }]) {
    writeBackendConfig(dir, 'loads.config.json', backend);
    const result = runCli(['extract', '--config', 'loads.config.json'], { cwd: dir });
    assert.equal(result.status, 0, `${JSON.stringify(backend)}: ${result.stderr}`);
  }
});
