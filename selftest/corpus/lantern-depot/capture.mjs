#!/usr/bin/env node
/**
 * Prints the `pw_test`, `pw_request`, `pw_assert` and `pw_stub` facts of the other Playwright
 * corpora and of the worked example's `e2e` repository, as one JSON document keyed by input.
 * Run with the CLI of the commit the file pins, so a later extractor can be compared with it
 * on the same input:
 *
 *   node selftest/corpus/lantern-depot/capture.mjs --cli <checkout>/bin/flowtrace.js > base-facts.json
 *
 * The inputs are copied into a temporary directory first, so no corpus gains an `out/`
 * directory.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const KEPT_TYPES = new Set(['pw_test', 'pw_request', 'pw_assert', 'pw_stub']);

export const INPUTS = [
  { name: 'widget-cart', dir: join(HERE, '..', 'widget-cart'), config: 'widget.config.json', repo: 'e2e' },
  { name: 'widget-kiosk', dir: join(HERE, '..', 'widget-kiosk'), config: 'widget.config.json', repo: 'e2e' },
  { name: 'kettle-market', dir: join(HERE, '..', 'kettle-market'), config: 'kettle.config.json', repo: 'suite' },
  { name: 'demo-shop', dir: join(REPO_ROOT, 'examples', 'demo-shop'), config: 'flowtrace.config.json', repo: 'e2e' },
];

export function keptFacts(facts) {
  return facts.filter((candidate) => KEPT_TYPES.has(candidate.type));
}

export function captureFacts(cli) {
  const captured = {};
  for (const input of INPUTS) {
    const work = mkdtempSync(join(tmpdir(), 'flowtrace-capture-'));
    try {
      cpSync(input.dir, work, { recursive: true, filter: (source) => !source.split(/[\\/]/).includes('out') });
      const run = spawnSync(process.execPath, [cli, 'extract', '--config', input.config, '--repo', input.repo], {
        cwd: work,
        encoding: 'utf8',
      });
      if (run.status !== 0) throw new Error(`extract ${input.name} failed: ${run.stderr}`);
      const document = JSON.parse(readFileSync(join(work, 'out', 'facts', `${input.repo}.json`), 'utf8'));
      captured[input.name] = keptFacts(document.facts);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  return captured;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--cli');
  const cli = at === -1 ? join(REPO_ROOT, 'bin', 'flowtrace.js') : resolve(process.argv[at + 1]);
  process.stdout.write(`${JSON.stringify(captureFacts(cli), null, 2)}\n`);
}
