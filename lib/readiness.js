/**
 * Readiness step — a readiness sheet per feature area, built entirely from facts
 * flowtrace already computes. No new graph walking happens here: an external area
 * inventory (an area name plus a mobile file-path glob, one row per glob) is joined to
 * `component` facts on `file`; every route a matched component reaches is read off
 * `trace()`'s own inventory walk (the same reading `resolveStart` + `trace(...,
 * {inventory: true})` already gives a page/component/service start); every route's
 * seed reachability and sinks are read off `trace(..., {seeds: true})` (the same
 * walker `cover()` calls); Cypress/Playwright evidence, when present, is read off
 * `cover.js`'s own `buildEvidenceIndex`/`stateOf`.
 *
 * The inventory format is deliberately the simplest thing that can join on a path: a
 * CSV row `area,glob` (or the equivalent two-column markdown table row), blank lines
 * and `#` comments dropped. `glob` is either a plain directory prefix or a `*`/`**`
 * pattern matched against a `component` fact's repository-relative `file`.
 */

import { normalizeAliases } from './join.js';
import { NOMINAL_DISPOSITIONS, resolveStart, trace } from './trace.js';
import { buildEvidenceIndex, stateOf } from './cover.js';

/**
 * Sink classes a readiness sheet reports, in the fixed order every render uses.
 * `push-other` is a Redis (or other non-SignalR) push — `trace()` folds both into one
 * `push` outcome kind, so this module tells them apart itself (see `sinkTallyFor`)
 * rather than silently dropping the non-SignalR half.
 */
export const SINK_CLASSES = Object.freeze([
  'db-write', 'db-read', 'publish', 'worker', 'signalr', 'push-other', 'infra-only',
]);

/** Seed reachability levels, in the fixed order every render uses (`lib/trace.js` §REACHABILITY). */
export const REACHABILITY_ORDER = Object.freeze(['reachable', 'edge', 'unreachable', 'unknown']);

/** A heading line never runs past this many characters — the same rule `lib/cases.js` keeps. */
export const MAX_HEADING_CHARS = 120;

const COVER_FACT_TYPES = Object.freeze(['cypress_test', 'cypress_intercept', 'pw_test', 'pw_request']);

/**
 * Repository kinds whose `component` facts an area inventory joins. The inventory rows
 * are mobile file-path globs, so a `web` component can never match one: counting them
 * would report every React component in the system as an unmatched join gap the moment
 * `out/facts/web.json` exists. A caller wanting a different repository set passes `options.kinds`;
 * a fact set carrying no `kind` at all is always read, so hand-written fixtures are
 * unaffected.
 */
export const DEFAULT_KINDS = Object.freeze(['mobile']);

function collect(factSets, type, kinds = null) {
  const out = [];
  for (const set of factSets) {
    if (kinds && set.kind && !kinds.includes(set.kind)) continue;
    for (const fact of set.facts || []) {
      if (fact.type === type) out.push({ repo: set.repo, fact });
    }
  }
  return out;
}

/**
 * Parse the simple inventory format: `area,glob` per line, or the equivalent
 * `| area | glob |` markdown table row. Blank lines, `#` comments, a markdown
 * separator row (`|---|---|`) and a literal `area,glob`-shaped header are dropped.
 * One area may repeat across several rows — every glob it names is kept.
 */
export function readInventory(text) {
  const rows = [];
  for (const raw of String(text == null ? '' : text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('|')) {
      const inner = line.replace(/^\|/, '').replace(/\|$/, '');
      if (/^[\s|:-]+$/.test(inner)) continue;
      const cells = inner.split('|').map((cell) => cell.trim());
      if (cells.length < 2 || !cells[0] || !cells[1]) continue;
      if (rows.length === 0 && /^area$/i.test(cells[0])) continue;
      rows.push({ area: cells[0], glob: cells[1] });
      continue;
    }
    const comma = line.indexOf(',');
    if (comma < 0) continue;
    const area = line.slice(0, comma).trim();
    const glob = line.slice(comma + 1).trim();
    if (!area || !glob) continue;
    if (rows.length === 0 && /^area$/i.test(area) && /^(glob|component|path)/i.test(glob)) continue;
    rows.push({ area, glob });
  }
  return rows;
}

const GLOB_SPECIAL = /[.+^${}()|[\]\\]/g;

/**
 * Compile one inventory glob into a matcher against a repository-relative `file`. No
 * wildcard at all is a directory prefix (`features/widgets` matches itself and
 * everything under it); `*` stands for one path segment, `**` for any number.
 */
export function compileGlob(pattern) {
  const text = String(pattern || '').trim();
  if (!text.includes('*')) {
    const prefix = text.endsWith('/') ? text : `${text}/`;
    return { pattern: text, test: (file) => file === text || file.startsWith(prefix) };
  }
  const escaped = text.replace(GLOB_SPECIAL, '\\$&');
  const source = escaped.replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '.*');
  const regex = new RegExp(`^${source}$`);
  return { pattern: text, test: (file) => regex.test(file) };
}

function compileRows(rows) {
  return rows.map((row) => ({ area: row.area, glob: row.glob, matcher: compileGlob(row.glob) }));
}

/** The first inventory row (in file order) whose glob matches `file`, or `null`. */
function areaFor(file, compiled) {
  for (const row of compiled) {
    if (row.matcher.test(file)) return row.area;
  }
  return null;
}

/** For a zero-component area: which earlier area's glob already claimed a component this
 * area's own glob would also match (first-match-wins in `areaFor`), or `null` if it
 * genuinely matches nothing. */
function subsumedByFor(area, componentEntries, compiled) {
  const own = compiled.filter((row) => row.area === area).map((row) => row.matcher);
  const claimed = componentEntries.find((entry) => own.some((matcher) => matcher.test(entry.fact.file)));
  return claimed ? areaFor(claimed.fact.file, compiled) : null;
}

function outcomeIdentity(key, outcome) {
  return `${key}|${outcome.kind}|${outcome.ref}|${outcome.method || ''}`;
}

function emptySinkTally() {
  const tally = {};
  for (const cls of SINK_CLASSES) tally[cls] = 0;
  return tally;
}

function emptySeedTally() {
  const tally = {};
  for (const level of REACHABILITY_ORDER) tally[level] = 0;
  return tally;
}

function addSinkTally(into, from) {
  for (const cls of SINK_CLASSES) into[cls] += from[cls] || 0;
}

function addSeedTally(into, from) {
  for (const level of REACHABILITY_ORDER) into[level] += from[level] || 0;
}

/**
 * Turn every route key's own outcomes (and its `always`/infra outcomes) into the fixed
 * sink tally. A `message` outcome with a `worker_processor` consumer counts as both
 * `publish` and `worker` — a Worker leg is a bus publish first. `push` is split
 * `signalr` vs everything else (Redis) by cross-referencing the raw `signalr_push`
 * fact's own `(repo, file, line)` — the only place that distinction still exists once
 * `trace()` has folded both into one `push` kind.
 */
function sinkTallyFor(routeKeys, routeWalks, signalrLocations) {
  const tally = emptySinkTally();
  const seenPrimary = new Set();
  const seenInfra = new Set();
  for (const key of routeKeys) {
    const walked = routeWalks.get(key);
    for (const seed of (walked && walked.seeds) || []) {
      for (const outcome of seed.outcomes || []) {
        const id = outcomeIdentity(key, outcome);
        if (seenPrimary.has(id)) continue;
        seenPrimary.add(id);
        if (outcome.kind === 'db') {
          tally[outcome.access === 'read' ? 'db-read' : 'db-write'] += 1;
        } else if (outcome.kind === 'message') {
          tally.publish += 1;
          if ((outcome.consumers || []).some((consumer) => consumer.kind === 'processor')) tally.worker += 1;
        } else if (outcome.kind === 'push') {
          const loc = `${outcome.repo}|${outcome.file}|${outcome.line}`;
          tally[signalrLocations.has(loc) ? 'signalr' : 'push-other'] += 1;
        }
      }
      for (const outcome of seed.always || []) {
        const id = outcomeIdentity(key, outcome);
        if (seenInfra.has(id)) continue;
        seenInfra.add(id);
        tally['infra-only'] += 1;
      }
    }
  }
  return tally;
}

function seedTallyFor(routeKeys, routeWalks) {
  const tally = emptySeedTally();
  for (const key of routeKeys) {
    const walked = routeWalks.get(key);
    for (const seed of (walked && walked.seeds) || []) {
      if (tally[seed.reachability] !== undefined) tally[seed.reachability] += 1;
    }
  }
  return tally;
}

/**
 * A seed that forces nothing away from its nominal side is always `reachable` — that
 * is the plain happy path, which a black-box caller can always drive and is not what
 * "unreachable-only" is asking about. This is the same nominal check
 * `seedReachability` itself applies, so a seed counts here exactly when it counts
 * there.
 */
function isNontrivial(seed) {
  return (seed.dispositions || []).some(
    (entry) => entry.kind !== 'toggle' && NOMINAL_DISPOSITIONS[entry.kind] !== entry.disposition,
  );
}

/**
 * True when every route a component reaches has at least one seed that forces
 * something away from nominal, and every one of those forced seeds is `unreachable` —
 * the caller can always hit the happy path, but every deviation needs a JWT claim or
 * an injected dependency no black-box fixture can supply.
 */
function isUnreachableOnly(routeKeys, routeWalks) {
  let sawNontrivial = false;
  for (const key of routeKeys) {
    const walked = routeWalks.get(key);
    for (const seed of (walked && walked.seeds) || []) {
      if (!isNontrivial(seed)) continue;
      sawNontrivial = true;
      if (seed.reachability !== 'unreachable') return false;
    }
  }
  return sawNontrivial;
}

/**
 * Walk every route key in the system that at least one component reaches, once each
 * (`options.trace` substitutes the walker in tests, exactly like `cover()`'s own hook).
 */
function walkRoutes(factSets, keys, traceOptions, walker, index) {
  const routeWalks = new Map();
  for (const key of keys) {
    routeWalks.set(key, walker(factSets, key, { ...traceOptions, index, seeds: true }));
  }
  return routeWalks;
}

/**
 * Turn `readiness()`'s per-area records into one estate rollup: totals a reader can
 * quote without re-summing every area table.
 */
function estateSummary(areas, join, hasCoverFacts) {
  const sinks = emptySinkTally();
  const seeds = emptySeedTally();
  let zeroReach = 0;
  let unreachableOnly = 0;
  const allRoutes = new Set();
  for (const area of areas) {
    addSinkTally(sinks, area.sinks);
    addSeedTally(seeds, area.seeds);
    zeroReach += area.zeroReach.length;
    unreachableOnly += area.unreachableOnly.length;
    for (const key of area.routeKeys) allRoutes.add(key);
  }
  const coverage = hasCoverFacts ? { route: 0, skipped: 0, none: 0 } : null;
  if (coverage) {
    for (const area of areas) {
      if (!area.coverage) continue;
      coverage.route += area.coverage.route;
      coverage.skipped += area.coverage.skipped;
      coverage.none += area.coverage.none;
    }
  }
  return {
    areas: areas.length,
    components: areas.reduce((total, area) => total + area.components, 0),
    routes: allRoutes.size,
    sinks,
    seeds,
    zeroReach,
    unreachableOnly,
    coverage,
    join,
  };
}

/**
 * Join an area inventory (`options.rows: [{area, glob}]`) to the estate's `component`
 * facts, walk every route the matched components reach, and return one record per
 * area plus an estate summary. `options.aliases` and `options.traceOptions` are the
 * same values `bin/flowtrace.js` already builds for `cover`/`cases`; `options.trace`
 * and `options.resolveStart` substitute the walker/resolver in tests. `options.kinds`
 * names the repository kinds whose components the inventory joins (`DEFAULT_KINDS`).
 */
export function readiness(factSets, options = {}) {
  const rows = Array.isArray(options.rows) ? options.rows : [];
  const aliases = normalizeAliases(options.aliases || []);
  const traceOptions = { ...(options.traceOptions || {}), aliases };
  const walker = options.trace || trace;
  const resolver = options.resolveStart || resolveStart;
  const unmatchedCap = Number.isInteger(options.unmatchedCap) ? options.unmatchedCap : 50;
  const kinds = Array.isArray(options.kinds) && options.kinds.length > 0 ? options.kinds : DEFAULT_KINDS;

  const compiled = compileRows(rows);
  const areaNames = [...new Set(compiled.map((row) => row.area))];

  const componentEntries = collect(factSets, 'component', kinds);
  const byArea = new Map(areaNames.map((name) => [name, { area: name, components: [] }]));
  const unmatched = [];
  for (const entry of componentEntries) {
    const area = areaFor(entry.fact.file, compiled);
    if (area && byArea.has(area)) byArea.get(area).components.push(entry);
    else unmatched.push(entry);
  }

  const signalrLocations = new Set(
    collect(factSets, 'signalr_push').map((entry) => `${entry.repo}|${entry.fact.file}|${entry.fact.line}`),
  );

  let sharedIndex;
  const reachCache = new Map();
  function reachOf(entry) {
    const cacheKey = `${entry.repo}|${entry.fact.name}`;
    if (reachCache.has(cacheKey)) return reachCache.get(cacheKey);
    const resolved = resolver(factSets, entry.fact.name, { index: sharedIndex, repo: entry.repo });
    if (!sharedIndex && resolved.index) sharedIndex = resolved.index;
    let record;
    if (resolved.candidates || resolved.error) {
      record = { routeKeys: [], unresolved: 0, startIssue: resolved.error || 'ambiguous start' };
    } else {
      const walked = walker(factSets, entry.fact.name, {
        ...traceOptions,
        index: sharedIndex,
        startNode: resolved.node,
        repo: entry.repo,
        inventory: true,
        seeds: false,
      });
      const routeNodes = (walked.nodes || []).filter((node) => node.kind === 'route');
      const routeKeys = [...new Set(routeNodes.filter((node) => !node.unresolved).map((node) => node.ref))].sort();
      const unresolvedCount = routeNodes.filter((node) => node.unresolved).length;
      record = { routeKeys, unresolved: unresolvedCount, startIssue: null };
    }
    reachCache.set(cacheKey, record);
    return record;
  }

  for (const record of byArea.values()) {
    const routeKeySet = new Set();
    record.zeroReach = [];
    record.reach = [];
    let dynamicCalls = 0;
    for (const entry of record.components) {
      const reach = reachOf(entry);
      record.reach.push({ entry, reach });
      dynamicCalls += reach.unresolved;
      for (const key of reach.routeKeys) routeKeySet.add(key);
      if (reach.routeKeys.length === 0 && reach.unresolved === 0 && !reach.startIssue) {
        record.zeroReach.push(entry);
      }
    }
    record.routeKeys = [...routeKeySet].sort();
    record.dynamicCalls = dynamicCalls;
  }

  const uniqueKeys = [...new Set([...byArea.values()].flatMap((record) => record.routeKeys))];
  const routeWalks = walkRoutes(factSets, uniqueKeys, traceOptions, walker, sharedIndex);

  const hasCoverFacts = COVER_FACT_TYPES.some((type) => collect(factSets, type).length > 0);
  const evidenceIndex = hasCoverFacts ? buildEvidenceIndex(factSets, { aliases: options.aliases || [] }) : null;

  // One record per route key, independent of which area(s) reach it — an area's own
  // sink/seed tallies are the sum of its member routes' records, and the per-route
  // markdown row reads straight off the same map.
  const routes = {};
  for (const key of uniqueKeys) {
    routes[key] = {
      key,
      seeds: seedTallyFor([key], routeWalks),
      sinks: sinkTallyFor([key], routeWalks, signalrLocations),
      coverage: hasCoverFacts ? stateOf(evidenceIndex.byRoute.get(key) || []) : null,
    };
  }

  const areas = [...byArea.values()].map((record) => {
    const unreachableOnly = record.reach
      .filter(({ reach }) => isUnreachableOnly(reach.routeKeys, routeWalks))
      .map(({ entry }) => ({ name: entry.fact.name, file: entry.fact.file }));
    const startIssues = record.reach
      .filter(({ reach }) => reach.startIssue)
      .map(({ entry, reach }) => ({ name: entry.fact.name, file: entry.fact.file, issue: reach.startIssue }));
    let coverage = null;
    if (hasCoverFacts) {
      coverage = { route: 0, skipped: 0, none: 0 };
      for (const key of record.routeKeys) {
        coverage[stateOf(evidenceIndex.byRoute.get(key) || [])] += 1;
      }
    }
    return {
      area: record.area,
      components: record.components.length,
      routeKeys: record.routeKeys,
      routes: record.routeKeys.length,
      dynamicCalls: record.dynamicCalls,
      sinks: sinkTallyFor(record.routeKeys, routeWalks, signalrLocations),
      seeds: seedTallyFor(record.routeKeys, routeWalks),
      coverage,
      zeroReach: record.zeroReach.map((entry) => ({ name: entry.fact.name, file: entry.fact.file })),
      unreachableOnly,
      startIssues,
      subsumedBy: record.components.length === 0 ? subsumedByFor(record.area, componentEntries, compiled) : null,
    };
  });

  const totalComponents = componentEntries.length;
  const matched = totalComponents - unmatched.length;
  const join = {
    components: totalComponents,
    matched,
    unmatched: unmatched.length,
    rate: totalComponents > 0 ? matched / totalComponents : 1,
    unmatchedList: unmatched.slice(0, unmatchedCap).map((entry) => ({ name: entry.fact.name, file: entry.fact.file })),
    unmatchedMore: Math.max(0, unmatched.length - unmatchedCap),
  };

  return {
    areas,
    routes,
    join,
    estate: estateSummary(areas, join, hasCoverFacts),
    hasCoverFacts,
  };
}

/** Cap one heading line to `MAX_HEADING_CHARS`, folding the tail into an ellipsis. */
function capHeading(text, maxLen = MAX_HEADING_CHARS) {
  if (text.length <= maxLen) return text;
  if (maxLen <= 1) return text.slice(0, maxLen);
  return `${text.slice(0, maxLen - 1)}…`;
}

function mdCell(text) {
  return String(text).replace(/\|/g, '\\|');
}

/**
 * `prefix` plus a name list bounded so the *whole* line stays under `MAX_HEADING_CHARS`
 * — `nameList` alone only bounds itself, so a long prefix left the outer `capHeading`
 * to cut the tail mid-name instead of at the `+N more` fold.
 */
function boundedLine(prefix, entries) {
  const budget = Math.max(20, MAX_HEADING_CHARS - prefix.length);
  return capHeading(`${prefix}${nameList(entries, budget)}`);
}

function nameList(entries, maxLen = MAX_HEADING_CHARS) {
  if (entries.length === 0) return 'none';
  const names = entries.map((entry) => entry.name);
  const line = names.join(', ');
  if (line.length <= maxLen) return line;
  const kept = [];
  for (const name of names) {
    const next = kept.length === 0 ? name : `${kept.join(', ')}, ${name}`;
    if (next.length > maxLen - 12) break;
    kept.push(name);
  }
  const rest = names.length - kept.length;
  return rest > 0 ? capHeading(`${kept.join(', ')} +${rest} more`, maxLen) : capHeading(line, maxLen);
}

const SINK_HEADERS = Object.freeze({
  'db-write': 'DB write',
  'db-read': 'DB read',
  publish: 'Publish',
  worker: 'Worker',
  signalr: 'SignalR',
  'push-other': 'Push (other)',
  'infra-only': 'Infra-only',
});

function coverageCell(coverage) {
  if (!coverage) return 'n/a';
  return `${coverage.route} route · ${coverage.skipped} skipped · ${coverage.none} none`;
}

/**
 * One `## Area: <name>` section: a stats line, the pure-UI / unreachable-only / not-walked
 * component lists, then one route row per reached route (looked up in the shared `routes`
 * map `readiness()` returns, so a route reached by two areas is walked once and rendered
 * identically in both).
 */
function renderAreaSection(area, routes) {
  const lines = [];
  lines.push(capHeading(`## Area: ${area.area}`));
  lines.push('');
  lines.push(
    `${area.components} component${area.components === 1 ? '' : 's'} · ${area.routes} distinct backend route${
      area.routes === 1 ? '' : 's'
    }${area.dynamicCalls > 0 ? ` · ${area.dynamicCalls} dynamic gateway call${area.dynamicCalls === 1 ? '' : 's'} (template not statically resolvable)` : ''}`,
  );
  lines.push('');
  lines.push(boundedLine('Zero backend reach (pure-UI, cheapest to cover): ', area.zeroReach));
  lines.push(boundedLine('Unreachable-only (JWT/body-gated, needs fixture data): ', area.unreachableOnly));
  if (area.startIssues.length > 0) {
    lines.push(boundedLine('Not walked (ambiguous or unresolved start): ', area.startIssues));
  }
  lines.push('');
  if (area.routeKeys.length === 0) {
    lines.push(
      area.components === 0 && area.subsumedBy
        ? `_No components matched — subsumed by earlier area \`${area.subsumedBy}\`._`
        : "_No backend route reached by this area's components._",
    );
    lines.push('');
    return lines.join('\n');
  }
  const header = ['Route', 'Reachable', 'Edge', 'Unreachable', 'Unknown', ...SINK_CLASSES.map((cls) => SINK_HEADERS[cls]), 'Coverage'];
  lines.push(`| ${header.join(' | ')} |`);
  lines.push(`|${header.map(() => '---').join('|')}|`);
  for (const key of area.routeKeys) {
    const route = routes[key];
    const cells = [
      mdCell(capHeading(key)),
      route.seeds.reachable,
      route.seeds.edge,
      route.seeds.unreachable,
      route.seeds.unknown,
      ...SINK_CLASSES.map((cls) => route.sinks[cls]),
      route.coverage === null ? 'n/a' : route.coverage,
    ];
    lines.push(`| ${cells.join(' | ')} |`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * The per-area tables plus one estate-summary table, in the fixed column order this
 * module always uses. `--json` mirrors the same `readiness()` report unrendered.
 */
export function renderReadinessMarkdown(report) {
  const lines = ['# Port readiness', ''];
  lines.push(
    `Join: ${report.join.matched}/${report.join.components} components matched to an area (${(report.join.rate * 100).toFixed(1)}%)` +
      (report.join.unmatched > 0 ? `, ${report.join.unmatched} unmatched` : ''),
  );
  if (report.join.unmatched > 0) {
    const shown = report.join.unmatchedList.map((entry) => ({ name: `${entry.name} (${entry.file})` }));
    const suffix = report.join.unmatchedMore > 0 ? ` +${report.join.unmatchedMore} more` : '';
    lines.push(boundedLine('Unmatched: ', shown) + suffix);
  }
  lines.push('');
  for (const area of report.areas) {
    lines.push(renderAreaSection(area, report.routes));
  }
  lines.push('## Estate summary');
  lines.push('');
  const header = ['Area', 'Components', 'Routes', 'Zero-reach', 'Unreachable-only', 'Reachable', 'Edge', 'Unreachable', 'Unknown', 'Coverage'];
  lines.push(`| ${header.join(' | ')} |`);
  lines.push(`|${header.map(() => '---').join('|')}|`);
  for (const area of report.areas) {
    lines.push(
      `| ${mdCell(capHeading(area.area))} | ${area.components} | ${area.routes} | ${area.zeroReach.length} | ${area.unreachableOnly.length} | ` +
        `${area.seeds.reachable} | ${area.seeds.edge} | ${area.seeds.unreachable} | ${area.seeds.unknown} | ${coverageCell(area.coverage)} |`,
    );
  }
  const estate = report.estate;
  lines.push(
    `| **Estate** | ${estate.components} | ${estate.routes} | ${estate.zeroReach} | ${estate.unreachableOnly} | ` +
      `${estate.seeds.reachable} | ${estate.seeds.edge} | ${estate.seeds.unreachable} | ${estate.seeds.unknown} | ${coverageCell(estate.coverage)} |`,
  );
  lines.push('');
  return lines.join('\n');
}
