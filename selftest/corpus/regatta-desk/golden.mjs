#!/usr/bin/env node
/**
 * Writes the base captures of this corpus: the web fact set the base extractor writes
 * (`base-facts/web.json`) and the `trace`, `span --from-component` and `chains` output the
 * base code prints over it (`base-capture.json`). Run with the CLI of the commit the
 * captures pin, so a later walk can be compared with it on the same input:
 *
 *   node selftest/corpus/regatta-desk/golden.mjs --cli <checkout>/bin/flowtrace.js
 *
 * The corpus is copied into a temporary directory first, so it never gains an `out/`
 * directory.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const CONFIG = 'regatta.config.json';

export const STARTS = [
  'RegattaPage',
  'RegattaHeader',
  'ResultsBoard',
  'CrewRoster',
  'SignupPanel',
  'BoatList',
  'BoatRow',
  'MarkBoard',
  'DriftNotice',
  'WindBox',
  'GroupShell',
  'RaceDayPage',
  'ProtestChipComponent',
];

export const ROUTES = [
  'GET regattas/v1/{id}',
  'GET regattas/v1/{id}/entries',
  'GET regattas/v1/results',
  'GET regattas/v1/{id}/standings',
  'GET crews/v1/{id}',
  'POST crews/v1/{id}/signup',
  'GET crews/v1/signups',
  'POST crews/v1/{id}/release',
  'GET boats/v1/all',
  'POST boats/v1/{id}/pick',
  'DELETE boats/v1/{id}',
  'POST boats/v1/{id}/inspect',
  'POST marks/v1/{id}/round',
  'POST marks/v1/{id}/skip',
  'GET marks/v1/{id}',
  'GET weather/v1/wind',
  'GET weather/v1/tide',
  'GET groups/v1/{id}',
];

/** One `trace --json` node, without its walk id, at the path of refs that reaches it. */
export function traceNodes(document) {
  const byId = new Map(document.nodes.map((node) => [node.id, node]));
  const parentOf = new Map(document.edges.map((edge) => [edge.to, edge.from]));
  const pathOf = (id) => {
    const parts = [];
    for (let at = id; at; at = parentOf.get(at)) parts.unshift(`${byId.get(at).kind} ${byId.get(at).ref}`);
    return parts.join(' > ');
  };
  return document.nodes.map((node) => ({
    path: pathOf(node.id),
    kind: node.kind,
    ref: node.ref,
    via: node.via ?? null,
    file: node.file ?? null,
    line: node.line ?? null,
    entry: node.entry ?? null,
    keys: Object.keys(node).filter((key) => key !== 'id').sort(),
  }));
}

/** One chain as its entry, request and hop sites. */
export function chainSites(document) {
  return document.chains.map((chain) => ({
    entry: chain.entry,
    request: chain.request,
    gaps: chain.gaps,
    hops: chain.hops.map((hop) => `${hop.kind} ${hop.fact || hop.reason} ${hop.file}:${hop.line} ${hop.ref}`),
  }));
}

function run(cli, cwd, args) {
  const result = spawnSync(process.execPath, [cli, ...args, '--config', CONFIG], { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function json(cli, cwd, args) {
  const result = run(cli, cwd, [...args, '--json']);
  if (result.status !== 0) throw new Error(`${args.join(' ')} exited ${result.status}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

/** The captures of one fact set, already extracted into `work`. */
export function capture(cli, work) {
  const out = { trace: {}, span: {}, chains: {} };
  for (const start of STARTS) {
    out.trace[start] = traceNodes(json(cli, work, ['trace', start]));
    const span = json(cli, work, ['span', '--from-component', start]);
    out.span[start] = { header: span.header, entries: span.entries.map((entry) => entry.identity) };
  }
  for (const key of ROUTES) out.chains[key] = chainSites(json(cli, work, ['chains', key]));
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--cli');
  const cli = at === -1 ? join(REPO_ROOT, 'bin', 'flowtrace.js') : resolve(process.argv[at + 1]);
  const work = mkdtempSync(join(tmpdir(), 'flowtrace-golden-'));
  try {
    const skip = new Set(['out', 'base-facts', 'base-capture.json']);
    cpSync(HERE, work, { recursive: true, filter: (source) => !source.split(/[\\/]/).some((part) => skip.has(part)) });
    const extract = run(cli, work, ['extract']);
    if (extract.status !== 0) throw new Error(`extract failed: ${extract.stderr}`);
    mkdirSync(join(HERE, 'base-facts'), { recursive: true });
    writeFileSync(join(HERE, 'base-facts', 'web.json'), readFileSync(join(work, 'out', 'facts', 'web.json')));
    writeFileSync(join(HERE, 'base-capture.json'), `${JSON.stringify(capture(cli, work), null, 2)}\n`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
