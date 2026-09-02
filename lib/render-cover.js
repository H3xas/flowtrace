/**
 * Rendering for the cover step — the terminal matrix and the markdown page.
 *
 * One block per route: the route key, a glyph strip, then one line per seed with its
 * disposition vector, its effects, the level reached and the tests that reached it.
 * The strip is uniform inside a block on purpose — mechanical evidence attaches to a
 * route, not to a way through it — and both renderers say so above the first block.
 */

import { STATE_GLYPHS } from './cover.js';

const COLORS = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m',
};

const STATE_COLORS = { disposition: 'green', path: 'green', route: 'green', skipped: 'yellow', none: 'red' };
const SINK_CAP = 3;
const ALWAYS_CAP = 6;
const SEED_ID_CAP = 5;
const GAP_CAP = 15;

const SHARED_EVIDENCE =
  'evidence is per route: an intercept proves the request reached the route, not which way through it,';
const SHARED_EVIDENCE_TAIL =
  'so every seed of a route carries that route\'s evidence. path and disposition need a reader.';
const PRIORITY_KEY =
  'branch weight  error_return · validation 3 · toggle 2 · guard 1 · plain 0   ·   sink weight  db write 3 · publish 2 · push · http 1 · db read · nothing 0';
const SORT_KEY =
  'key (level, branch, sink): level ascending, then branch weight descending, then sink weight descending, then route key — tiers, never a sum';

/** True when the current process may write ANSI colour to stdout. */
export function colorEnabled(stream = process.stdout, env = process.env) {
  return Boolean(stream && stream.isTTY) && !env.NO_COLOR;
}

function painter(enabled) {
  if (!enabled) return (text) => text;
  return (text, color) => `${COLORS[color] || ''}${text}${COLORS.reset}`;
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function pad(text, width) {
  const value = String(text);
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function shortSpec(spec) {
  const parts = String(spec).split('/');
  return parts[parts.length - 1] || spec;
}

/** The same, uncapped, for markdown cells that are not width-bound. */
function fullSinkText(seed) {
  const written = (seed.sinks || []).join(', ');
  const reads = seed.reads || 0;
  if (reads === 0) return written || '—';
  return written ? `${written} · reads ${reads}` : `reads ${reads}`;
}

/** Writes, publishes and pushes listed one by one; reads collapse to a single count. */
function sinkText(seed) {
  const sinks = seed.sinks || [];
  const reads = seed.reads || 0;
  const head = sinks.slice(0, SINK_CAP).join(', ');
  const written = sinks.length > SINK_CAP ? `${head} +${sinks.length - SINK_CAP}` : head;
  if (reads === 0) return written || '—';
  return written ? `${written} · reads ${reads}` : `reads ${reads}`;
}

/**
 * A seed's evidence is a mechanical label (`spec :: test`) until a reader verdict
 * upgrades it, at which point it becomes the verdict's own evidence records
 * (`{spec, test, line, reason}`) — the specific reason the seed reached that level.
 * Both shapes render here; `full` keeps the whole spec path for markdown, where width
 * is not bound.
 */
function evidenceEntryText(entry, full) {
  if (typeof entry === 'string') {
    const [spec, test] = entry.split(' :: ');
    return `${full ? spec : shortSpec(spec)} :: ${test}`;
  }
  const spec = full ? entry.spec : shortSpec(entry.spec);
  return `${spec} :: ${entry.test} (${entry.line}) — ${entry.reason}`;
}

function evidenceText(seed, full = false) {
  const list = seed.evidence || [];
  if (list.length === 0) return '—';
  const head = list.map((entry) => evidenceEntryText(entry, full));
  return seed.evidenceMore > 0 ? `${head.join(' | ')} +${seed.evidenceMore}` : head.join(' | ');
}

function alwaysText(route) {
  const always = route.always || [];
  if (always.length === 0) return null;
  const head = always.slice(0, ALWAYS_CAP).join(', ');
  return always.length > ALWAYS_CAP ? `${head} +${always.length - ALWAYS_CAP}` : head;
}

/** `(none, b3, s0)` — the tiers that placed this row, in the order they were applied. */
function keyTuple(gap) {
  return `(${gap.state}, b${gap.branchWeight}, s${gap.sinkWeight})`;
}

/** `<route>#U4` for a single seed, `<route>#U17,U22 ×2` for a collapsed group. */
function gapLabel(gap) {
  const seeds = gap.seeds || [gap.seed];
  if (seeds.length === 1) return `${gap.route}#${seeds[0]}`;
  const shown = seeds.slice(0, SEED_ID_CAP).join(',');
  const ids = seeds.length > SEED_ID_CAP ? `${shown},+${seeds.length - SEED_ID_CAP}` : shown;
  return `${gap.route}#${ids} ×${seeds.length}`;
}

function glyphStrip(route) {
  if (route.seeds.length === 0) return STATE_GLYPHS[route.state];
  return route.seeds.map((seed) => STATE_GLYPHS[seed.level || seed.state]).join('');
}

function routeHeadline(route) {
  const parts = [`${plural(route.seeds.length, 'seed')}`];
  if (route.evidence.intercepts > 0) {
    parts.push(
      `${plural(route.evidence.intercepts, 'intercept')} (${route.evidence.executing} executing, ${route.evidence.skipped} skipped)`,
    );
    parts.push(`match ${route.evidence.match.join('/')}`);
  } else {
    parts.push('no intercept evidence');
  }
  if (route.parity) {
    parts.push(
      `cypress ${route.parity.cypress} (${route.evidence.cypressSpecs.length})`,
      `playwright ${route.parity.playwright} (${route.evidence.playwrightSpecs.length})`,
    );
  }
  if (route.seedsTruncated > 0) parts.push(`+${route.seedsTruncated} seeds not enumerated`);
  if (route.crowded) parts.push('above the 24-seed cap — flagged for a reader');
  if (route.error) parts.push(`not traced: ${route.error}`);
  if (route.candidates) parts.push(`ambiguous start (${route.candidates.length} candidates)`);
  return parts.join(' · ');
}

/**
 * `6 handlers · 4 routes · pw 3/4` — what one web page contributes to this area. A page
 * line is deliberately unlike a route line: it opens with the word `page` instead of a
 * glyph strip, because a screen has no seeds, no dispositions and no evidence of its own.
 */
function pageText(page) {
  const parts = [plural(page.handlers, 'handler'), plural(page.routes.length, 'route'), `pw ${page.playwright}/${page.routes.length}`];
  if (page.inferredMount) parts.push('inferred mount');
  return parts.join(' · ');
}

const PAGE_NOTE = 'a page is a screen, not a route: it never enters the route index below, and carries only the coverage of the routes it reaches.';

/** `cypress-only 3 · playwright-only 1 · both 2 · neither 4 · 5 opaque stubs (never joined)`. */
function parityText(parity) {
  return (
    `cypress-only ${parity.cypressOnly} · playwright-only ${parity.playwrightOnly} · ` +
    `both ${parity.both} · neither ${parity.neither} · ${plural(parity.opaqueStubs, 'opaque stub')} (never joined)`
  );
}

/** The terminal matrix: one block per route, then the gap list. */
export function renderCover(report, options = {}) {
  const paint = painter(options.color === true);
  const lines = [];
  lines.push(`${paint(`area ${report.area}`, 'bold')}   ${report.headline}`);
  lines.push(paint(`${SHARED_EVIDENCE} ${SHARED_EVIDENCE_TAIL}`, 'dim'));
  lines.push(
    paint(
      `glyphs  ${STATE_GLYPHS.route} route observed · ${STATE_GLYPHS.path} path (reader) · ${STATE_GLYPHS.disposition} disposition (reader) · ${STATE_GLYPHS.skipped} skipped-only · ${STATE_GLYPHS.none} none`,
      'dim',
    ),
  );
  lines.push('');

  const pages = report.pages || [];
  if (pages.length > 0) {
    for (const page of pages) {
      lines.push(
        `${paint('page', 'yellow')}  ${paint(page.path, 'bold')}  ${page.component}  (${page.kind})  ${paint(pageText(page), 'dim')}`,
      );
    }
    lines.push(paint(PAGE_NOTE, 'dim'));
    lines.push('');
  }

  for (const route of report.routes) {
    lines.push(
      `${paint(glyphStrip(route), STATE_COLORS[route.state])}  ${paint(route.key, 'bold')}  ${paint(routeHeadline(route), 'dim')}`,
    );
    for (const seed of route.seeds) {
      const level = seed.level || seed.state;
      lines.push(
        `  ${paint(STATE_GLYPHS[level], STATE_COLORS[level])} ${pad(seed.id, 4)}${pad(seed.dispositions, 46)}  ${pad(sinkText(seed), 44)}  ${pad(`${level} b${seed.branchWeight}/s${seed.sinkWeight}`, 16)}  ${evidenceText(seed)}`,
      );
    }
    if (route.seeds.length === 0) lines.push(`  ${paint('no seeds', 'dim')}`);
    const always = alwaysText(route);
    if (always) lines.push(`  ${paint(`always (infrastructure)  ${always}`, 'dim')}`);
    lines.push('');
  }

  const gaps = report.gapGroups.slice(0, GAP_CAP);
  lines.push(
    paint(
      `gaps  ${plural(report.gaps.length, 'uncovered seed')} in ${plural(report.gapGroups.length, 'group')}, top ${gaps.length}`,
      'bold',
    ),
  );
  lines.push(paint(SORT_KEY, 'dim'));
  lines.push(paint(PRIORITY_KEY, 'dim'));
  for (const gap of gaps) {
    lines.push(
      `  ${paint(STATE_GLYPHS[gap.state], STATE_COLORS[gap.state])} ${pad(keyTuple(gap), 20)}${pad(gapLabel(gap), 58)}  ${pad(gap.dispositions, 42)}  ${sinkText(gap)}`,
    );
  }
  const reader = report.routes.reduce((sum, route) => sum + route.levels.path.candidates.length, 0);
  lines.push('');
  lines.push(
    paint(
      `levels path and disposition: needs-reader on every route · ${plural(reader, 'candidate test')} attached`,
      'dim',
    ),
  );
  lines.push(
    paint(
      `intercepts skipped as evidence: ${report.notes.intercepts.noPath} with no path · ${report.notes.intercepts.unmatched} matching no route`,
      'dim',
    ),
  );
  if (report.totals.parity) {
    lines.push('');
    lines.push(paint(`parity  ${parityText(report.totals.parity)}`, 'bold'));
  }
  return lines.join('\n');
}

function mdCell(text) {
  return String(text).replace(/\|/g, '\\|');
}

function percent(share) {
  return `${Math.round(share * 100)}%`;
}

/** The markdown page: the matrix, the gap list, and what the suite focuses on. */
export function renderCoverMarkdown(report) {
  const lines = [];
  lines.push(`# coverage — area ${report.area}`);
  lines.push('');
  lines.push(`**${report.headline}**`);
  lines.push('');
  lines.push(`${SHARED_EVIDENCE} ${SHARED_EVIDENCE_TAIL}`);
  lines.push('');
  lines.push(
    `Glyphs: \`${STATE_GLYPHS.route}\` route observed · \`${STATE_GLYPHS.path}\` path (reader) · \`${STATE_GLYPHS.disposition}\` disposition (reader) · \`${STATE_GLYPHS.skipped}\` skipped-only · \`${STATE_GLYPHS.none}\` none.`,
  );
  lines.push('');

  if ((report.pages || []).length > 0) {
    lines.push('## Pages');
    lines.push('');
    lines.push(PAGE_NOTE.charAt(0).toUpperCase() + PAGE_NOTE.slice(1));
    lines.push('');
    lines.push('| page | component | repo | handlers | routes | pw |');
    lines.push('|---|---|---|---|---|---|');
    for (const page of report.pages) {
      lines.push(
        `| \`${mdCell(page.path)}\`${page.inferredMount ? ' (inferred mount)' : ''} | ${mdCell(page.component)} | ${mdCell(page.repo)} | ${page.handlers} | ${page.routes.length} | ${page.playwright}/${page.routes.length} |`,
      );
    }
    lines.push('');
  }

  lines.push('## Matrix');
  for (const route of report.routes) {
    lines.push('');
    lines.push(`### ${glyphStrip(route)} \`${route.key}\``);
    lines.push('');
    lines.push(`${route.ref}${route.file ? ` — \`${route.file}:${route.line ?? 0}\`` : ''}`);
    lines.push('');
    lines.push(routeHeadline(route));
    lines.push('');
    if (route.seeds.length === 0) {
      lines.push('No seeds.');
      continue;
    }
    lines.push('| seed | dispositions | sinks | level | branch | sink | evidence |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const seed of route.seeds) {
      const level = seed.level || seed.state;
      lines.push(
        `| ${seed.id} | ${mdCell(seed.dispositions)} | ${mdCell(sinkText(seed))} | ${STATE_GLYPHS[level]} ${level} | ${seed.branchWeight} | ${seed.sinkWeight} | ${mdCell(evidenceText(seed, true))} |`,
      );
    }
    const always = alwaysText(route);
    if (always) {
      lines.push('');
      lines.push(`always (infrastructure): ${always}`);
    }
  }

  lines.push('');
  lines.push('## Gaps');
  lines.push('');
  lines.push(SORT_KEY);
  lines.push('');
  lines.push(PRIORITY_KEY);
  lines.push('');
  lines.push('| level | branch | sink | seeds | dispositions | sinks |');
  lines.push('|---|---|---|---|---|---|');
  for (const gap of report.gapGroups) {
    lines.push(
      `| ${STATE_GLYPHS[gap.state]} ${gap.state} | ${gap.branchWeight} | ${gap.sinkWeight} | \`${gapLabel(gap)}\` | ${mdCell(gap.dispositions)} | ${mdCell(fullSinkText(gap))} |`,
    );
  }

  lines.push('');
  lines.push('## What the suite focuses on');
  lines.push('');
  lines.push('Intercepts per area route — how much of the suite points at each route.');
  lines.push('');
  lines.push('| route | intercepts | executing | skipped | specs |');
  lines.push('|---|---|---|---|---|');
  const byIntercepts = [...report.routes].sort(
    (a, b) => b.evidence.intercepts - a.evidence.intercepts || (a.key < b.key ? -1 : 1),
  );
  for (const route of byIntercepts) {
    lines.push(
      `| \`${route.key}\` | ${route.evidence.intercepts} | ${route.evidence.executing} | ${route.evidence.skipped} | ${route.evidence.specs.length} |`,
    );
  }
  lines.push('');
  lines.push('Tests per spec, for every spec that names an area route.');
  lines.push('');
  lines.push('| spec | tests | skipped | skipped share | intercepts | area routes |');
  lines.push('|---|---|---|---|---|---|');
  for (const spec of report.specs) {
    lines.push(
      `| \`${spec.spec}\` | ${spec.tests} | ${spec.skipped} | ${percent(spec.skippedShare)} | ${spec.intercepts} | ${spec.routes} |`,
    );
  }

  lines.push('');
  lines.push('## Levels that need a reader');
  lines.push('');
  lines.push(
    `\`path\` and \`disposition\` are reported as \`needs-reader\` on every route. What would promote them:`,
  );
  lines.push('');
  const sample = report.routes[0];
  if (sample) {
    lines.push(`- \`path\` — ${sample.levels.path.promotedBy}`);
    lines.push(`- \`disposition\` — ${sample.levels.disposition.promotedBy}`);
  }
  lines.push('');
  lines.push(
    `Intercepts skipped as evidence: ${report.notes.intercepts.noPath} with no path, ${report.notes.intercepts.unmatched} matching no route.`,
  );
  lines.push('');

  if (report.totals.parity) {
    const parity = report.totals.parity;
    lines.push('## Cypress vs Playwright parity');
    lines.push('');
    lines.push(
      'Per route: an executing `cypress_intercept` vs an executing `pw_stub` of kind `route` (not `opaque`) — ' +
        'the Playwright UI E2E harness, never the unrelated backend-API one.',
    );
    lines.push('');
    lines.push(parityText(parity) + '.');
    lines.push('');
    lines.push('| route | cypress | playwright | cypress specs | playwright specs |');
    lines.push('|---|---|---|---|---|');
    for (const route of report.routes) {
      lines.push(
        `| \`${route.key}\` | ${STATE_GLYPHS[route.parity.cypress]} ${route.parity.cypress} | ` +
          `${STATE_GLYPHS[route.parity.playwright]} ${route.parity.playwright} | ` +
          `${route.evidence.cypressSpecs.length} | ${route.evidence.playwrightSpecs.length} |`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}
