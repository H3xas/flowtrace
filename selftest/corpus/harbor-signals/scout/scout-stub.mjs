#!/usr/bin/env node
/**
 * A stand-in for the code index behind `scout.bin`. It answers the three lookups the
 * wrapper makes — `refs <symbol>`, `refs <symbol> --json` and `impact <file> --hops N
 * --json` — from `answers.json` beside this file, and appends one line per process to the
 * file `FLOWTRACE_STUB_LOG` names so a test can count processes, find duplicate lookups
 * and measure how many ran at once.
 *
 * A symbol or file the table does not name answers the indexer's own "no symbol matches"
 * page, which is what a real index prints for a symbol it does not hold.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const answers = JSON.parse(readFileSync(join(HERE, 'answers.json'), 'utf8'));
const args = process.argv.slice(2);
const started = Date.now();

/** A synchronous sleep: the process must hold its slot open while a test observes it. */
function sleep(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const delay = Number(process.env.FLOWTRACE_STUB_DELAY_MS || 0);
sleep(delay);

function record() {
  const log = process.env.FLOWTRACE_STUB_LOG;
  if (!log) return;
  appendFileSync(log, `${JSON.stringify({ pid: process.pid, cwd: process.cwd(), args, start: started, end: Date.now() })}\n`);
}

function finish(text, code) {
  record();
  if (text) process.stdout.write(text);
  process.exit(code);
}

const [command, name] = args;

if (typeof name === 'string' && name.endsWith('__signal')) {
  record();
  process.kill(process.pid, 'SIGTERM');
  await new Promise(() => {});
}
if (typeof name === 'string' && name.endsWith('__timeout')) {
  // A pending promise alone does not keep Node alive, so the timer does.
  await new Promise((hold) => {
    setInterval(hold, 1000);
  });
}
if (typeof name === 'string' && name.endsWith('__flood')) {
  record();
  process.stdout.write('x'.repeat(200000));
  // Held open, so the caller's output limit ends the process and never a race with its own
  // exit: a pipe write is asynchronous on some platforms, and an early exit could win.
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}

if (command === 'refs' && !args.includes('--json')) {
  const edges = answers.outbound[name] || [];
  if (edges.length === 0) finish('no symbol matches\n', 0);
  const byKind = new Map();
  for (const edge of edges) {
    if (!byKind.has(edge.kind)) byKind.set(edge.kind, []);
    byKind.get(edge.kind).push(edge);
  }
  const lines = ['outbound:'];
  for (const [kind, rows] of byKind) {
    lines.push(`  ${kind} (${rows.length}):`);
    for (const row of rows) lines.push(`    ${row.file}:${row.line}  ${kind}  -> ${row.target}`);
  }
  finish(`${lines.join('\n')}\n`, 0);
}

if (command === 'refs' && args.includes('--json')) {
  const entry = answers.inbound[name];
  if (!entry) finish('no symbol matches\n', 0);
  finish(`${JSON.stringify({ status: 'resolved', inbound: entry })}\n`, 0);
}

if (command === 'impact') {
  const entry = answers.impact[name];
  if (!entry) finish('no file match\n', 4);
  finish(`${JSON.stringify({ status: 'resolved', rows: entry.rows || [], braked: entry.braked || [] })}\n`, 0);
}

finish(`unknown command ${args.join(' ')}\n`, 2);
