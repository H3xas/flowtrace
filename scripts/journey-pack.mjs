#!/usr/bin/env node
/**
 * Capture a journey pack's sources into a pinned bundle, then replay its cases from that bundle.
 *
 *   node scripts/journey-pack.mjs capture --config <file> --bundle <dir>
 *   node scripts/journey-pack.mjs replay  --config <file> --bundle <dir> --cases <ledger> --out <dir>
 *                                          [--expect <observed> | --write <observed>]
 *
 * Exit codes: 0 success; 1 the projection drifted from `--expect`, or a classification there
 * contradicts its observations; 2 usage, or a ledger that is invalid or no longer anchored to
 * its source; 3 a named refusal (a capture that cannot be promoted, a bundle that cannot be
 * replayed); 4 an unexpected internal error. Every diagnostic is printed as
 * `journey-pack: <name>: <detail>`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capture } from './journey-pack/capture.mjs';
import { replay } from './journey-pack/replay.mjs';

const HARNESS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE_TEXT = [
  'usage: journey-pack capture --config <file> --bundle <dir>',
  '       journey-pack replay --config <file> --bundle <dir> --cases <ledger> --out <dir> [--expect <observed> | --write <observed>]',
].join('\n');

function usage(reason) {
  process.stderr.write(`journey-pack: usage: ${reason}\n${USAGE_TEXT}\n`);
  return 2;
}

function parse(argv) {
  const [command, ...rest] = argv;
  const options = {};
  const valued = new Set(['--config', '--bundle', '--cases', '--out', '--expect', '--write']);
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!valued.has(arg)) return { error: `unknown argument ${JSON.stringify(arg)}` };
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) return { error: `${arg} needs a value` };
    options[arg.slice(2)] = value;
    index += 1;
  }
  return { command, options };
}

function print(diagnostics) {
  for (const diagnostic of diagnostics) {
    process.stderr.write(`journey-pack: ${diagnostic.name}: ${diagnostic.detail}\n`);
  }
}

function readableConfig(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && Array.isArray(parsed.repos) ? null : 'has no repos array';
  } catch (error) {
    return error.message;
  }
}

function main(argv) {
  const parsed = parse(argv);
  if (parsed.error) return usage(parsed.error);
  const { command, options } = parsed;
  if (options.config) {
    const problem = readableConfig(options.config);
    if (problem) return usage(`configuration ${options.config} cannot be read (${problem})`);
  }
  if (command === 'capture') {
    if (!options.config || !options.bundle) return usage('capture needs --config and --bundle');
    if (options.cases || options.out || options.expect || options.write) return usage('capture takes only --config and --bundle');
    const result = capture({ config: options.config, bundle: options.bundle, harnessRoot: HARNESS_ROOT });
    print(result.diagnostics);
    if (result.exit === 0) process.stdout.write(`journey-pack: promoted ${result.generation}\n`);
    return result.exit;
  }
  if (command === 'replay') {
    if (!options.config || !options.bundle || !options.cases || !options.out) {
      return usage('replay needs --config, --bundle, --cases and --out');
    }
    if (options.expect && options.write) return usage('--expect and --write are exclusive');
    const result = replay({ ...options, harnessRoot: HARNESS_ROOT });
    print(result.diagnostics);
    if (result.report) process.stdout.write(result.report);
    return result.exit;
  }
  return usage(command ? `unknown command ${JSON.stringify(command)}` : 'no command');
}

// A signal reaches the running flowtrace child as well; the capture's own cleanup removes its
// staging and lock before this handler can run, and a harder kill leaves only a stale lock and
// staging that the next capture sweeps.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(130));

// An unexpected failure must not exit 1, which callers read as a drifted projection.
try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`journey-pack: internal-error: ${error && error.message ? error.message : String(error)}\n`);
  process.exitCode = 4;
}
