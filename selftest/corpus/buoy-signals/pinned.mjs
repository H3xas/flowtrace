/**
 * What the serial pins are made of. `pin.mjs` reads this module to write `expected/` from
 * the base commit, and the selftest reads it to run the same invocations and the same
 * lookup cases against the branch, so the two can never drift apart.
 */
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

export const CONFIG = 'harbor.scout.config.json';

/**
 * One run per verb. `touch` runs it in a checkout with one changed source file, because
 * `affected` reads its answer from the diff. `chains` names the dependent lookups the run
 * must make: in each chain, a lookup is asked only after the one before it answered.
 */
export const INVOCATIONS = [
  { name: 'check', args: ['check', '--area', 'harbor.area.txt'], chains: ['outbound'] },
  { name: 'trace', args: ['trace', 'GET glasshouse/v1/zones/{zoneId}/watchers'], chains: ['outbound'] },
  { name: 'trace-area', args: ['trace', '--area', 'harbor.area.txt'], chains: ['outbound'] },
  { name: 'span', args: ['span', 'GET glasshouse/v1/zones/{zoneId}/watchers', '--out', 'span/page.html'], chains: ['outbound'] },
  { name: 'component-span', args: ['span', '--from-component', 'WatcherNotesPanel', '--out', 'span-panel/page.html'], chains: ['outbound'] },
  { name: 'surface', args: ['surface', 'GET glasshouse/v1/zones/{zoneId}/watchers'], chains: ['outbound'] },
  { name: 'skeleton', args: ['skeleton', 'GET glasshouse/v1/zones/{zoneId}/watchers', '--stub'], chains: ['outbound'] },
  { name: 'cover', args: ['cover', '--area', 'harbor.area.txt', '--packets', 'packets', '--md', 'cover.md'], chains: ['outbound'] },
  { name: 'scope', args: ['scope', '--area', 'harbor.area.txt'], chains: ['outbound'] },
  { name: 'affected', args: ['affected', '--area', 'harbor.area.txt', '--json'], touch: true, chains: ['outbound'] },
  {
    name: 'affected-widened',
    args: ['affected', '--area', 'harbor.area.txt', '--hops', '2', '--dotnet-filter', '--json'],
    touch: true,
    chains: ['outbound', 'impact-inbound'],
  },
  { name: 'scaffold', args: ['scaffold', '--area', 'harbor.area.txt'], chains: ['outbound'] },
  { name: 'cases', args: ['cases', '--area', 'harbor.area.txt'], chains: ['outbound'] },
  { name: 'readiness', args: ['readiness', '--areas', 'harbor.areas.txt'], chains: ['outbound'] },
];

/** The stub's dependent lookups, in the order each answer makes the next one known. */
export const CHAINS = {
  outbound: ['refs HarborBridge', 'refs SignalRelay', 'refs RelaySink'],
  'impact-inbound': [
    'impact src/Controllers/ZoneWatchersController.cs --hops 2 --json',
    'refs WatcherService --json',
  ],
};

export const BIN = '/fixture/bin/scout';
export const REPO = { id: 'api', kind: 'backend', root: '/fixture/backend', scout: true };
export const ROOT = REPO.root;

const OUT_TEXT = ['outbound:', '  uses-type (1):', '    Backend/A.cs:4  uses-type  -> Backend/B.cs', ''].join('\n');
const INBOUND_JSON = JSON.stringify({
  status: 'resolved',
  inbound: { 'ctor-di': { total: 1, dropped: 0, rows: [{ file: 'Tests/A.cs', line: 3 }] } },
});
const INBOUND_EMPTY = JSON.stringify({ status: 'resolved', inbound: {} });
const IMPACT_JSON = JSON.stringify({
  status: 'resolved',
  rows: [{ file: 'Tests/A.cs', hop: 1 }],
  braked: [{ iface: 'IZoneFeed', fanin: 40 }],
});
const IMPACT_EMPTY = JSON.stringify({ status: 'resolved', rows: [], braked: [] });
const CANDIDATES = [
  'ambiguous: 2 symbols match',
  '  Greenhouse.Alerts.Controllers.ZoneWatchersController  src/Controllers/ZoneWatchersController.cs:9',
  '  Greenhouse.Legacy.ZoneWatchersController  src/Legacy/ZoneWatchersController.cs:4',
  '',
].join('\n');
const FILE_CANDIDATES = ['ambiguous: 2 files match', '  src/Services/ZoneReadingService.cs', '  src/Legacy/ZoneReadingService.cs', ''].join('\n');

/** Every answer a runner can give one lookup, per lookup kind. */
export const CASES = {
  outbound: [
    { name: 'edges', result: { status: 0, stdout: OUT_TEXT } },
    { name: 'ambiguous', result: { status: 1, stdout: CANDIDATES } },
    { name: 'exit 3', result: { status: 3, stdout: '' } },
    { name: 'no symbol matches', result: { status: 0, stdout: 'no symbol matches\n' } },
    { name: 'timeout', result: { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' } } },
    { name: 'output above the limit', result: { status: null, signal: 'SIGTERM', error: { code: 'ENOBUFS' } } },
    { name: 'exit by signal', result: { status: null, signal: 'SIGTERM', error: null, stdout: '' } },
    { name: 'start throws', throws: true },
  ],
  inbound: [
    { name: 'edges', result: { status: 0, stdout: INBOUND_JSON } },
    { name: 'exit 3 with a payload', result: { status: 3, stdout: INBOUND_JSON } },
    { name: 'exit 3 with an empty payload', result: { status: 3, stdout: INBOUND_EMPTY } },
    { name: 'ambiguous', result: { status: 1, stdout: CANDIDATES } },
    { name: 'no symbol matches', result: { status: 0, stdout: 'no symbol matches\n' } },
    { name: 'timeout', result: { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' } } },
    { name: 'output above the limit', result: { status: null, signal: 'SIGTERM', error: { code: 'ENOBUFS' } } },
    { name: 'exit by signal', result: { status: null, signal: 'SIGTERM', error: null, stdout: '' } },
    { name: 'start throws', throws: true },
  ],
  impact: [
    { name: 'edges', result: { status: 0, stdout: IMPACT_JSON } },
    { name: 'exit 3 with a payload', result: { status: 3, stdout: IMPACT_JSON } },
    { name: 'exit 3 with an empty payload', result: { status: 3, stdout: IMPACT_EMPTY } },
    { name: 'ambiguous', result: { status: 1, stdout: FILE_CANDIDATES } },
    { name: 'no file match', result: { status: 0, stdout: 'no file match\n' } },
    { name: 'timeout', result: { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' } } },
    { name: 'output above the limit', result: { status: null, signal: 'SIGTERM', error: { code: 'ENOBUFS' } } },
    { name: 'exit by signal', result: { status: null, signal: 'SIGTERM', error: null, stdout: '' } },
    { name: 'start throws', throws: true },
  ],
};

export const ARGUMENT = {
  outbound: ['ZoneWatchersController'],
  inbound: ['ZoneWatchersController'],
  impact: ['src/Services/ZoneReadingService.cs', { hops: 3, noIface: true }],
};

/** The part of a lookup's answer a caller reads, as plain JSON. */
export function shape(result) {
  return JSON.parse(JSON.stringify({
    edges: Array.from(result, (edge) => ({ ...edge })),
    unavailable: Boolean(result && result.unavailable),
    reason: result && result.reason ? result.reason : null,
    counts: result && result.counts ? result.counts : null,
    dropped: result && result.dropped !== undefined ? result.dropped : null,
    braked: result && result.braked ? result.braked : null,
  }));
}

/** A runner that answers one case and records every process it was asked to start. */
export function caseRunner(item) {
  const calls = [];
  const run = (bin, args, options) => {
    calls.push({ bin, args: [...args], cwd: options.cwd });
    if (item.throws) throw new Error('cannot start');
    return item.result;
  };
  return { calls, run, runAsync: async (...rest) => run(...rest) };
}

/** One case through the synchronous lookups of `createScout`, with the binary on disk. */
export function serialCase(createScout, kind, item) {
  const runner = caseRunner(item);
  const scout = createScout({ bin: BIN, outDir: 'out', repos: [REPO], run: runner.run, fileExists: () => true });
  return { ...shape(scout[kind](ROOT, ...ARGUMENT[kind])), calls: runner.calls };
}

/** One lookup kind with a binary path that is not on disk: no process may start. */
export function missingSerial(createScout, kind) {
  const runner = caseRunner(CASES[kind][0]);
  const scout = createScout({ bin: BIN, outDir: 'out', repos: [REPO], run: runner.run, fileExists: () => false });
  return { ...shape(scout[kind](ROOT, ...ARGUMENT[kind])), calls: runner.calls };
}

/** A bare command name is found on `PATH` when the process starts; this one is on no `PATH`. */
export const BARE_BIN = 'flowtrace-selftest-absent-indexer';
export const BARE_REPO = { id: 'api', kind: 'backend', root: resolve(tmpdir()), scout: true };

/** One lookup kind through the default runner, with a bare binary name that is not installed. */
export function bareSerial(createScout, kind) {
  const scout = createScout({ bin: BARE_BIN, outDir: 'out', repos: [BARE_REPO] });
  return shape(scout[kind](BARE_REPO.root, ...ARGUMENT[kind]));
}

/** Every pinned lookup answer of one `createScout`, keyed by kind and case. */
export function serialAnswers(createScout) {
  const answers = { cases: {}, missing: {}, bare: {} };
  for (const [kind, cases] of Object.entries(CASES)) {
    answers.cases[kind] = {};
    for (const item of cases) answers.cases[kind][item.name] = serialCase(createScout, kind, item);
    answers.missing[kind] = missingSerial(createScout, kind);
    answers.bare[kind] = bareSerial(createScout, kind);
  }
  return answers;
}
