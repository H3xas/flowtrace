/**
 * The seed outputs of the existing corpora, captured once and compared on every run: the
 * `trace <route> --seeds --json` of each route key the corpus declares, and one
 * `cover --json` over all of them. A walk change that should leave a corpus alone has to
 * leave these bytes alone; one that moves a corpus on purpose moves its golden in the same
 * diff, written by the command below.
 *
 *   node selftest/seed-goldens.js --write
 *
 * Each corpus is copied to a temporary directory and extracted there, so the capture never
 * writes into the tracked fixture.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const CLI = join(REPO_ROOT, 'bin', 'flowtrace.js');
export const GOLDEN_DIR = join(HERE, 'corpus', 'seed-goldens');

export const GOLDEN_CORPORA = Object.freeze([
  { name: 'gizmo-shop', source: join(HERE, 'corpus', 'gizmo-shop'), config: 'gizmo.config.json' },
  { name: 'greenhouse-alerts', source: join(HERE, 'corpus', 'greenhouse-alerts'), config: 'greenhouse.config.json' },
  { name: 'demo-shop', source: join(REPO_ROOT, 'examples', 'demo-shop'), config: 'flowtrace.config.json' },
  { name: 'nursery-mobile', source: join(HERE, 'corpus', 'nursery-mobile'), config: 'nursery.config.json' },
  { name: 'kettle-market', source: join(HERE, 'corpus', 'kettle-market'), config: 'kettle.config.json' },
]);

function cli(args, cwd) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`flowtrace ${args.join(' ')} exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

function routeKeys(dir) {
  const keys = new Set();
  const factsDir = join(dir, 'out', 'facts');
  for (const name of readdirSync(factsDir).sort()) {
    const set = JSON.parse(readFileSync(join(factsDir, name), 'utf8'));
    for (const fact of set.facts || []) {
      if (fact.type === 'route') keys.add(`${fact.verb} ${fact.template}`);
    }
  }
  return [...keys].sort();
}

/** `{ keys, trace: { key: stdout }, cover: stdout }` for one corpus, at the code as it is now. */
export function captureSeedGoldens(corpus) {
  const dir = mkdtempSync(join(tmpdir(), 'flowtrace-goldens-'));
  try {
    cpSync(corpus.source, dir, { recursive: true });
    rmSync(join(dir, 'out'), { recursive: true, force: true });
    cli(['extract', '--config', corpus.config], dir);
    const keys = routeKeys(dir);
    const traces = {};
    for (const key of keys) traces[key] = cli(['trace', key, '--seeds', '--json', '--config', corpus.config], dir);
    writeFileSync(join(dir, 'golden-area.txt'), `${keys.join('\n')}\n`);
    const cover = cli(['cover', '--config', corpus.config, '--area', 'golden-area.txt', '--json'], dir);
    return { keys, trace: traces, cover };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function readSeedGolden(name) {
  return JSON.parse(readFileSync(join(GOLDEN_DIR, `${name}.json`), 'utf8'));
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes('--write')) {
  for (const corpus of GOLDEN_CORPORA) {
    const golden = captureSeedGoldens(corpus);
    writeFileSync(join(GOLDEN_DIR, `${corpus.name}.json`), `${JSON.stringify(golden, null, 2)}\n`);
    process.stdout.write(`${corpus.name}: ${golden.keys.length} route keys\n`);
  }
}
