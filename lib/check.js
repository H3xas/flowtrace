/**
 * Check step — a gate that fails a build on seed-coverage regression against a
 * committed per-area baseline.
 *
 * The comparison rides the same two axes `cover --json` already reports for an area:
 * seed totals (how many seeds this area's routes cover, in aggregate) and per-route
 * parity (whether each route still holds the mechanical coverage state — and, where a
 * Cypress or Playwright suite is configured, its parity state — it held when the
 * baseline was captured). A drop on either axis is a regression. A baseline stamped from
 * facts older than the ones this run reads, or facts already behind the repository HEAD,
 * is refused rather than trusted — the same "never gate on stale facts" rule `affected`
 * already applies to its own staleness gate, reused here instead of a second one.
 *
 * `check` never builds a baseline on its own initiative during a compare run. A baseline
 * is either written explicitly (`--write-baseline`) or read back as committed fact; a
 * compare run that finds no baseline file has nothing to trust and refuses exactly as a
 * stale one would.
 */

import { STATE_ORDER, cover } from './cover.js';
import { staleFactsWarnings } from './facts.js';

/**
 * Exit codes, reusing `affected`'s own contract rather than inventing a new one: a clean
 * compare, a real regression, a CLI usage error, and a baseline (or the facts underneath
 * it) too stale to trust — the one code the ticket calls out by name and that a compare
 * run must never substitute a `0` for.
 */
export const EXIT = Object.freeze({ ok: 0, regression: 1, usage: 2, stale: 4 });

function compare(a, b) {
  const left = a || '';
  const right = b || '';
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * The fields of `cover`'s report worth persisting as a baseline: enough to reconstruct
 * every comparison `check` makes, nothing that carries a local file path or a timestamp
 * finer than the run itself. Key order is fixed by construction, never left to
 * `JSON.stringify`'s own traversal, so two runs over identical facts commit identical
 * bytes save for `generatedAt`.
 */
export function buildBaseline({ area, factSets, report }) {
  const facts = (factSets || [])
    .filter((set) => set && set.headSha)
    .map((set) => ({ repo: set.repo, headSha: set.headSha, dirty: Boolean(set.dirty) }))
    .sort((a, b) => compare(a.repo, b.repo));

  const routes = (report.routes || [])
    .map((route) => ({
      key: route.key,
      state: route.state,
      seeds: route.seeds.length,
      parityCypress: route.parity.cypress,
      parityPlaywright: route.parity.playwright,
    }))
    .sort((a, b) => compare(a.key, b.key));

  return {
    area,
    generatedAt: new Date().toISOString(),
    facts,
    totals: {
      routes: report.totals.routes,
      observed: report.totals.observed,
      skippedOnly: report.totals.skippedOnly,
      none: report.totals.none,
      seeds: report.totals.seeds,
      seedsObserved: report.totals.seedsObserved,
      seedsSkipped: report.totals.seedsSkipped,
      seedsNone: report.totals.seedsNone,
      parity: {
        cypressOnly: report.totals.parity.cypressOnly,
        playwrightOnly: report.totals.parity.playwrightOnly,
        both: report.totals.parity.both,
        neither: report.totals.parity.neither,
      },
    },
    routes,
  };
}

/**
 * Rung 1: a baseline stamped from a fact snapshot older than the one this run reads.
 * `factSets` is what the current run loaded; `baseline.facts` is what an earlier run
 * stamped. A repo the baseline never recorded (no `headSha` at capture time, or one the
 * current run's facts do not carry) is silently skipped — the same "nothing trustworthy
 * to compare" rule `staleFactsWarnings` itself applies to a legacy or non-git fact set.
 */
function staleBaselineReasons(baseline, factSets) {
  const current = new Map((factSets || []).map((set) => [set.repo, set]));
  const reasons = [];
  for (const entry of baseline.facts || []) {
    const now = current.get(entry.repo);
    if (!now || !now.headSha) continue;
    if (now.headSha !== entry.headSha) {
      reasons.push(
        `flowtrace: baseline for ${entry.repo} was captured at ${entry.headSha.slice(0, 7)}, facts now at ` +
          `${now.headSha.slice(0, 7)} — re-run flowtrace check --write-baseline once a real drop is confirmed`,
      );
    }
  }
  return reasons;
}

/**
 * Rung 2: the two comparisons the gate makes. `seedsObserved`/`observed` dropping
 * in aggregate catches a regression a totals-only reading would report; the per-route
 * walk catches one route regressing while another improves enough to hide it in the
 * totals — the case an aggregate-only gate would miss. `parityCypress`/`parityPlaywright`
 * ride the same per-route walk, at the state ordering `cover` itself ranks with
 * (`STATE_ORDER`), since a parity drop is a coverage drop in its own right. A baseline route absent from the current walk (dropped from the area file) is
 * never asserted as a regression — that is a reviewed, visible area-file change per
 * `areas/README.md`, not a coverage question `check` can answer — but is named so a
 * reviewer sees it rather than losing it silently.
 */
function regressionsOf(baseline, report) {
  const regressions = [];
  for (const field of ['seedsObserved', 'observed']) {
    const before = baseline.totals[field];
    const after = report.totals[field];
    if (typeof before === 'number' && after < before) {
      regressions.push({ kind: 'totals', field, before, after });
    }
  }

  const byKey = new Map(report.routes.map((route) => [route.key, route]));
  const dropped = [];
  for (const entry of baseline.routes || []) {
    const route = byKey.get(entry.key);
    if (!route) {
      dropped.push(entry.key);
      continue;
    }
    if (STATE_ORDER[route.state] < STATE_ORDER[entry.state]) {
      regressions.push({ kind: 'route-state', key: entry.key, before: entry.state, after: route.state });
    }
    if (STATE_ORDER[route.parity.cypress] < STATE_ORDER[entry.parityCypress]) {
      regressions.push({
        kind: 'route-parity-cypress',
        key: entry.key,
        before: entry.parityCypress,
        after: route.parity.cypress,
      });
    }
    if (STATE_ORDER[route.parity.playwright] < STATE_ORDER[entry.parityPlaywright]) {
      regressions.push({
        kind: 'route-parity-playwright',
        key: entry.key,
        before: entry.parityPlaywright,
        after: route.parity.playwright,
      });
    }
  }
  return { regressions, dropped: dropped.sort(compare) };
}

/**
 * Run the gate. `options.baseline` is the parsed committed file, or `null` when
 * `options.writeBaseline` asks for a fresh one instead of a compare. Facts behind the
 * repository HEAD are refused before either mode runs: a written baseline would be
 * exactly as untrustworthy as a compared one if it rested on stale facts, so the same
 * rung guards both.
 */
export function check(factSets, options = {}) {
  const {
    area = null,
    keys = [],
    aliases = [],
    traceOptions = {},
    trace,
    repos = [],
    baseline = null,
    writeBaseline = false,
  } = options;

  const mode = writeBaseline ? 'write' : 'compare';
  const stale = options.stale || staleFactsWarnings(factSets, repos);
  if (stale.length > 0) {
    return { area, mode, exit: EXIT.stale, stale, regressions: [], dropped: [] };
  }

  const report = cover(factSets, { area: area || 'area', keys, aliases, traceOptions, trace });

  if (writeBaseline) {
    return {
      area,
      mode,
      exit: EXIT.ok,
      stale: [],
      regressions: [],
      dropped: [],
      totals: report.totals,
      baseline: buildBaseline({ area, factSets, report }),
    };
  }

  if (!baseline) {
    return {
      area,
      mode,
      exit: EXIT.stale,
      stale: [`flowtrace: no baseline for ${area} — run flowtrace check --area ${area} --write-baseline first`],
      regressions: [],
      dropped: [],
      totals: report.totals,
    };
  }

  const baselineStale = staleBaselineReasons(baseline, factSets);
  if (baselineStale.length > 0) {
    return { area, mode, exit: EXIT.stale, stale: baselineStale, regressions: [], dropped: [], totals: report.totals };
  }

  const { regressions, dropped } = regressionsOf(baseline, report);
  return {
    area,
    mode,
    exit: regressions.length > 0 ? EXIT.regression : EXIT.ok,
    stale: [],
    regressions,
    dropped,
    totals: report.totals,
    baselineTotals: baseline.totals,
  };
}

export function renderCheck(result) {
  const lines = [];
  const area = result.area || 'area';

  if (result.stale.length > 0) {
    lines.push(`check ${area} — stale, refusing to gate`);
    for (const reason of result.stale) lines.push(`  ${reason}`);
    return lines.join('\n');
  }

  if (result.mode === 'write') {
    lines.push(
      `check ${area} — baseline written (${result.totals.observed}/${result.totals.routes} routes observed, ` +
        `${result.totals.seedsObserved}/${result.totals.seeds} seeds)`,
    );
    return lines.join('\n');
  }

  if (result.regressions.length > 0) {
    lines.push(`check ${area} — ${plural(result.regressions.length, 'regression')} against the committed baseline`);
    for (const entry of result.regressions) {
      lines.push(
        entry.kind === 'totals'
          ? `  totals.${entry.field}: ${entry.before} -> ${entry.after}`
          : `  ${entry.key}: ${entry.kind} ${entry.before} -> ${entry.after}`,
      );
    }
  } else {
    lines.push(
      `check ${area} — no regression (${result.totals.observed}/${result.totals.routes} routes observed, ` +
        `${result.totals.seedsObserved}/${result.totals.seeds} seeds)`,
    );
  }

  if (result.dropped && result.dropped.length > 0) {
    lines.push(
      `  ${plural(result.dropped.length, 'baseline route')} no longer in this area's cover: ${result.dropped.join(', ')}`,
    );
  }

  return lines.join('\n');
}
