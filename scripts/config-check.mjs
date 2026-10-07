#!/usr/bin/env node
/**
 * Keeps the shipped configuration example in step with the loader the CLI runs and with the
 * document a reader is sent to for it.
 *
 *   node scripts/config-check.mjs [path]     default: flowtrace.config.example.json
 *
 * The example is the only configuration file this repository ships, and it is the shape a
 * reader copies. It is checked through `validateConfig`, the CLI's own entry point for a
 * config file, so an example that describes a shape flowtrace rejects fails here: a missing
 * `out`, a repository kind that does not exist, an unknown field inside a block. It is then
 * checked against `docs/configuration.md`, so a key can never appear in the example without
 * being described somewhere a reader can find it.
 *
 * A contributor's own `flowtrace.config.json` is machine-local and never part of this
 * repository, so it is never read here.
 *
 * Zero dependencies: Node built-ins and the repository's own loader.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateConfig } from '../lib/config.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_EXAMPLE = join(ROOT, 'flowtrace.config.example.json');
const DOCUMENT = join(ROOT, 'docs', 'configuration.md');

/** Every key the example sets at the top level or in a `repos[]` entry, sorted. */
export function exampleKeys(example) {
  const keys = new Set(Object.keys(example));
  for (const repo of Array.isArray(example.repos) ? example.repos : []) {
    for (const key of Object.keys(repo)) keys.add(key);
  }
  return [...keys].sort();
}

/**
 * Keys the example sets that the document never names. A key is documented when it appears
 * in code spans in the document; every key the example uses is described that way today, so
 * a miss is drift rather than style.
 */
export function undocumentedKeys(example, document) {
  return exampleKeys(example).filter((key) => !document.includes(`\`${key}\``));
}

/** The shipped example reads as a repository path; anything else is named where it is. */
function displayPath(path) {
  const inside = relative(ROOT, path);
  return !inside || inside.startsWith('..') ? path : inside;
}

export function exampleProblems({ examplePath = DEFAULT_EXAMPLE, documentPath = DOCUMENT } = {}) {
  const shown = displayPath(examplePath);
  const problems = [];
  if (!existsSync(examplePath)) {
    problems.push(`${shown} is missing; restore it or drop it from the "files" list in package.json`);
    return problems;
  }
  let text;
  try {
    text = readFileSync(examplePath, 'utf8');
  } catch (error) {
    problems.push(`${shown} cannot be read (${error.message}); restore it or fix its permissions`);
    return problems;
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    problems.push(`${shown} is not valid JSON (${error.message}); fix the syntax`);
    return problems;
  }
  const document = existsSync(documentPath) ? readFileSync(documentPath, 'utf8') : '';
  try {
    validateConfig(raw, { baseDir: dirname(examplePath), file: shown });
  } catch (error) {
    problems.push(`${shown} is rejected by the loader: ${error.message}`);
  }
  for (const key of undocumentedKeys(raw, document)) {
    problems.push(
      `${shown} sets "${key}" and ${relative(ROOT, documentPath)} never mentions it; ` +
        'document the key or drop it from the example',
    );
  }
  return problems;
}

function main(argv) {
  const examplePath = argv[0] ? resolve(argv[0]) : DEFAULT_EXAMPLE;
  const problems = exampleProblems({ examplePath });
  if (problems.length > 0) {
    console.error('config-check: failed');
    for (const problem of problems) console.error(`  ${problem}`);
    return 1;
  }
  console.log(`config-check: ok — ${relative(ROOT, examplePath)} loads and every key is documented`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
