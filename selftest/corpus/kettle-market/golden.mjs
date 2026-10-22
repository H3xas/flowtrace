#!/usr/bin/env node
/**
 * Prints the `pw_stub` and `pw_test` facts of this corpus's `suite` repository and of the
 * worked example's `e2e` repository, as one JSON document, with every `pw_stub.handler`
 * removed. Run with the CLI of the commit the golden pins, so a later extractor can be
 * compared with it on the same input:
 *
 *   node selftest/corpus/kettle-market/golden.mjs --cli <checkout>/bin/flowtrace.js > base-facts.json
 *
 * The inputs are copied into a temporary directory first, so neither the corpus nor the
 * worked example gains an `out/` directory.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const KEPT_TYPES = new Set(['pw_stub', 'pw_test']);

const INPUTS = [
  { key: 'suite', dir: HERE, config: 'kettle.config.json' },
  { key: 'e2e', dir: join(REPO_ROOT, 'examples', 'demo-shop'), config: 'flowtrace.config.json' },
];

/** One repository's stub and test facts, `handler` removed, in extraction order. */
export function stubAndTestFacts(facts) {
  return facts
    .filter((candidate) => KEPT_TYPES.has(candidate.type))
    .map((candidate) => {
      if (candidate.type !== 'pw_stub') return candidate;
      const { handler, ...rest } = candidate;
      return rest;
    });
}

export function goldenFacts(cli) {
  const golden = {};
  for (const input of INPUTS) {
    const work = mkdtempSync(join(tmpdir(), 'flowtrace-golden-'));
    try {
      cpSync(input.dir, work, { recursive: true, filter: (source) => !source.split(/[\\/]/).includes('out') });
      const run = spawnSync(process.execPath, [cli, 'extract', '--config', input.config, '--repo', input.key], {
        cwd: work,
        encoding: 'utf8',
      });
      if (run.status !== 0) throw new Error(`extract ${input.key} failed: ${run.stderr}`);
      const document = JSON.parse(readFileSync(join(work, 'out', 'facts', `${input.key}.json`), 'utf8'));
      golden[input.key] = stubAndTestFacts(document.facts);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  return golden;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--cli');
  const cli = at === -1 ? join(REPO_ROOT, 'bin', 'flowtrace.js') : resolve(process.argv[at + 1]);
  process.stdout.write(`${JSON.stringify(goldenFacts(cli), null, 2)}\n`);
}
