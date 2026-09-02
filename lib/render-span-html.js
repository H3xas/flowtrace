/**
 * One entry route's span as a standalone HTML page, written for a tester rather than for
 * the engineer who owns the code.
 *
 * The page states behaviour first and code second: every row is one observable outcome in
 * plain words, and the `file:line`, class and method that produce it sit inside a per-row
 * expander so they are one click away and never in the reading path. Four sections, in
 * this order: the span map, the test ledger, the assertion surface, the honesty strip.
 *
 * Nothing here derives a fact. The model arrives from `lib/span.js`, which builds it out of
 * `cover`'s seeds, `exception_map`, the cover overlay and `cases`' own generators; this
 * module only decides what a reader sees first. Two things are quoted verbatim from another
 * generator and are marked so a test can recover them: the Gherkin draft on an untested row
 * is `cases`' `renderScenarioBlock` output byte for byte, carried inside `class="gk"` runs
 * exactly as `render-tree-html` carries the terminal's own bytes inside `class="tt"`.
 *
 * The assertion-surface section is the same posture applied to a different derivation: the
 * groups and the gap rows are `lib/assertion-surface.js`'s own rows, folded by `span`, and
 * this module picks none of them. A gap prints as a gap — its kind, the sentence that names
 * what stopped the walk, and the evidence behind it — and a route deriving nothing says so
 * in one line rather than dropping the section, because an absent section reads as "no gap"
 * to every reader who does not know the section exists.
 *
 * An observation point in that section carries a fourth thing when `span` was given
 * `--verdict-facts`: a cached `surface_verdict` read, never derived, here — a
 * confirmed correlation names the field, a refusal quotes the note it was refused for, and a
 * point nobody has read yet says "judgment pending" rather than looking like an open
 * question no reader has noticed. The three states reuse the ledger's tag classes. Without
 * the flag no point gains an annotation, so the plain page contains no verdict surface.
 *
 * Self-contained by construction: inline CSS, no script, no asset URL, no fetch. It opens
 * off disk under a strict CSP, and a test asserts it.
 */

import { joins } from './render-tree-html.js';

const { escapeHtml } = joins;

const TIER_LABEL = Object.freeze({
  tested: 'tested',
  'inherited-only': 'inherited only',
  untested: 'untested',
});

const TIER_CLASS = Object.freeze({
  tested: 't-tested',
  'inherited-only': 't-inherited',
  untested: 't-untested',
});

const TIER_TITLE = Object.freeze({
  tested: 'a verifying test asserts the status this outcome answers on this route, so the outcome was observed — the same join the trace page draws as "direct"',
  'inherited-only': 'a test names this route and covers the path, but nothing pins this outcome; never counted as tested in any total on this page',
  untested: 'nothing names this outcome — the draft below is what a test for it would say',
});

/** The repository's own `plural`, plus the `-es` a word like "branch" actually takes. */
function plural(count, noun) {
  if (count === 1) return `${count} ${noun}`;
  return `${count} ${noun}${/(s|x|z|ch|sh)$/.test(noun) ? 'es' : 's'}`;
}

function tag(tier) {
  return `<span class="tag ${TIER_CLASS[tier]}" title="${escapeHtml(TIER_TITLE[tier])}">${escapeHtml(TIER_LABEL[tier])}</span>`;
}

function code(text) {
  return `<code>${escapeHtml(text)}</code>`;
}

function site(entry) {
  if (!entry || !entry.file) return '';
  return `${entry.file}${entry.line ? `:${entry.line}` : ''}`;
}

/** The per-row expander: where the behaviour is written, never in the reading path. */
function whereBlock(row) {
  const mapped = row.mapping
    ? `<div class="where-row"><span class="where-phrase">${escapeHtml(`${row.mapping.type} → ${row.mapping.status}`)}</span><span class="where-kind">${escapeHtml(`exception_map ${row.mapping.scope}`)}</span><div class="where-site">${escapeHtml(site(row.mapping))}</div></div>`
    : '';
  if (row.where.length === 0) {
    return `<details class="where"><summary>where this is written</summary><div class="where-body">${mapped}<div class="where-row">no deciding branch — this is the route's own happy path</div></div></details>`;
  }
  const rows = row.where
    .map(
      (entry) =>
        `<div class="where-row"><span class="where-phrase">${escapeHtml(entry.phrase)}</span>` +
        `<span class="where-kind">${escapeHtml(`${entry.kind} ${entry.disposition}`)}</span>` +
        `<div class="where-code">${escapeHtml(entry.text || '')}</div>` +
        `<div class="where-site">${escapeHtml(`${entry.class || ''}${entry.method ? `.${entry.method}` : ''} — ${site(entry)}`)}</div></div>`,
    )
    .join('');
  return `<details class="where"><summary>where this is written (${plural(row.where.length, 'branch')})</summary><div class="where-body">${rows}${mapped}</div></details>`;
}

function mappingNote(row) {
  if (!row.mapping) return '';
  const scope =
    row.mapping.scope === 'action'
      ? `${row.mapping.via} catches it in this action, so the mapping holds here only`
      : `${row.mapping.via} is registered globally, so it converts this exception everywhere`;
  const from = row.remapped
    ? `the trace tree prints ${row.stated || '500'} because an escaping exception is a ${row.stated || '500'}; this one does not escape. `
    : '';
  return `<div class="map">${escapeHtml(`${from}${row.mapping.type} → ${row.mapping.status}: ${scope}. Read from an exception_map fact — the expander below says which.`)}</div>`;
}

function expectList(row) {
  return `<ul class="expect">${row.expected.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`;
}

function preconditionList(row) {
  return `<ul class="pre">${row.preconditions.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`;
}

/**
 * A merged outcome's two fact sources, named rather than collapsed. `span` merges a throw row
 * and the row seeded inside the `catch` that answers it only on the evidence this block prints
 * — the `exception_map` clause both resolve through, and the line range that clause covers — so
 * a reader can re-walk the merge and take it apart again.
 *
 * It prints in both sections the way every other row detail on this page does: the outcome
 * section names the arms, and the ledger row carries their branch chains and their drafted
 * scenarios, which is where a per-seed draft lives. So each arm's `cases` draft is
 * quoted exactly once on the page — the merge removes a duplicate rather than adding one.
 */
function dedupBlock(row, full = false) {
  if (!row.dedup) return '';
  const clause = row.dedup.clause;
  const arms = row.dedup.arms
    .map((arm) => {
      const head =
        `<div class="arm-head"><span class="arm-src">${escapeHtml(`${arm.source} site`)}</span>` +
        `<span class="what">${escapeHtml(arm.headline)}</span>` +
        `<span class="seedkey">${escapeHtml(`${arm.id} #${arm.key || '—'}`)}</span></div>` +
        `<ul class="expect">${arm.expected.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`;
      if (!full) return `<div class="arm">${head}</div>`;
      const where = arm.where
        .map(
          (entry) =>
            `<div class="where-row"><span class="where-phrase">${escapeHtml(entry.phrase)}</span>` +
            `<span class="where-kind">${escapeHtml(`${entry.kind} ${entry.disposition}`)}</span>` +
            `<div class="where-code">${escapeHtml(entry.text || '')}</div>` +
            `<div class="where-site">${escapeHtml(`${entry.class || ''}${entry.method ? `.${entry.method}` : ''} — ${site(entry)}`)}</div></div>`,
        )
        .join('');
      const draft = arm.gherkin
        ? `<details class="draft"><summary>what a test for this arm would say — <code>cases --gherkin-draft</code>, quoted</summary><pre class="gherkin"><span class="gk">${escapeHtml(arm.gherkin)}</span></pre></details>`
        : '';
      return `<div class="arm">${head}<details class="where"><summary>where this arm is written (${plural(
        arm.where.length,
        'branch',
      )})</summary><div class="where-body">${where}</div></details>${draft}</div>`;
    })
    .join('');
  return `<div class="dedup"><div class="dedup-why">${escapeHtml(
    `One observable contract, seen from ${plural(row.dedup.arms.length, 'fact source')}: ` +
      `${clause.via} catches ${clause.exception} and answers ${clause.status}, so the row seeded at the throw and the row seeded at the ` +
      `catch's own return are the same refusal. Merged on that clause alone — ${clause.file}:${clause.line}, running to line ${clause.endLine} — ` +
      `and on both arms answering ${clause.status} under the same tag. Both arms are named below; neither is dropped, and both still ` +
      `count in the reconciliation with cover.`,
  )}</div><details class="where"><summary>${escapeHtml(
    `both arms of this outcome (${row.dedup.arms.length})`,
  )}</summary><div class="where-body">${arms}</div></details></div>`;
}

function outcomeRow(row) {
  const status = row.status ? `<span class="status">${escapeHtml(row.status)}</span>` : '<span class="status off">no status stated</span>';
  const jump = row.tier === 'untested' ? ` <a class="jump" href="#seed-${escapeHtml(row.key || row.id)}">what to write →</a>` : '';
  return `<div class="row row-${row.outcomeKind}">
<div class="row-head">${status}<span class="what">${escapeHtml(row.headline)}</span>${tag(row.tier)}</div>
${mappingNote(row)}
<div class="row-body"><div class="col"><div class="col-k">given</div>${preconditionList(row)}</div>
<div class="col"><div class="col-k">then</div>${expectList(row)}</div></div>
<div class="row-foot"><span class="seedkey">${escapeHtml(`${row.id} #${row.key || '—'}`)}</span>${jump}</div>
${dedupBlock(row)}${whereBlock(row)}
</div>`;
}

function callersBlock(model) {
  if (!model.entry.resolved) {
    return `<div class="plain">Nothing in the extracted client repositories calls this route, so the chain starts at the endpoint's own identity, ${code(model.route.key)}. A caller bound at runtime — a configuration-registered handler, a deploy-time binding — is not visible to a source read.</div>`;
  }
  const rows = model.entry.callers
    .map(
      (caller) =>
        `<div class="chain-row"><span class="chain-name">${escapeHtml(`${caller.repo} › ${caller.service || '(no service)'}.${caller.method || '(no method)'}`)}</span>` +
        `<span class="chain-verb">${escapeHtml(caller.resolved ? 'literal url' : 'url built at runtime')}</span></div>`,
    )
    .join('');
  const more = model.entry.callersMore > 0 ? `<div class="chain-row more">+${model.entry.callersMore} more</div>` : '';
  const sites = model.entry.callers
    .map((caller) => `<div class="where-site">${escapeHtml(`${caller.repo} — ${site(caller)} — ${caller.template}`)}</div>`)
    .join('');
  return `<div class="chain">${rows}${more}</div><details class="where"><summary>where these calls are written</summary><div class="where-body">${sites}</div></details>`;
}

function ownersBlock(model) {
  const services = model.owners.services.map((entry) => entry.ref);
  const stores = model.owners.repositories.filter((entry) => !entry.infra);
  const serviceText =
    services.length > 0
      ? `Owned by ${escapeHtml(services.join(', '))}.`
      : 'No service beyond the controller resolved on this walk.';
  const storeText =
    stores.length > 0
      ? `Stores touched: ${stores
          .map((entry) => `${escapeHtml(entry.ref)} <span class="acc acc-${entry.access}">${escapeHtml(entry.access)}</span>`)
          .join(', ')}.`
      : 'No store write or read resolved on this walk.';
  return `<div class="plain">${serviceText} ${storeText}</div>`;
}

function messagesBlock(model) {
  if (model.messages.length === 0) {
    return '<div class="plain">This route publishes nothing to the bus on the traced path.</div>';
  }
  return model.messages
    .map((message) => {
      const answered =
        message.answeredBy.length === 0
          ? '<div class="answer none">nothing in the extracted repositories answers this message today</div>'
          : message.answeredBy
              .map((entry) => {
                const effects =
                  entry.effects.length === 0
                    ? '<li class="off">no observable effect resolved past this one</li>'
                    : entry.effects
                        .map((effect) => `<li>${escapeHtml(`${effect.words} ${effect.ref}`)} <span class="eff-repo">${escapeHtml(effect.repo)}</span></li>`)
                        .join('');
                const more = entry.effectsMore > 0 ? `<li class="off">+${entry.effectsMore} more</li>` : '';
                return `<div class="answer"><div class="answer-head"><span class="answer-kind">${escapeHtml(entry.kind)}</span>${escapeHtml(`${entry.repo} › ${entry.ref}`)}${entry.workType ? `<span class="worktype">${escapeHtml(entry.workType)}</span>` : ''}</div><ul class="eff">${effects}${more}</ul><details class="where"><summary>where this is written</summary><div class="where-body"><div class="where-site">${escapeHtml(site(entry))}</div></div></details></div>`;
              })
              .join('');
      return `<div class="msg"><div class="msg-head"><span class="msg-name">${escapeHtml(message.message)}</span><span class="msg-contract">${escapeHtml(message.contract === 'none' ? 'no message contract declared' : 'contract declared')}</span></div>${answered}<details class="where"><summary>where this is published</summary><div class="where-body"><div class="where-site">${escapeHtml(site(message))}</div><div class="where-site">${escapeHtml(message.fqn || '')}</div></div></details></div>`;
    })
    .join('');
}

/** A resolved `case_id` fact's ids, rendered beside the test that carries them. */
function caseIdBadge(entry) {
  if (!entry.caseIds || entry.caseIds.length === 0) return '';
  return `<span class="caseid">${escapeHtml(`case ${entry.caseIds.join(', ')}`)}</span>`;
}

function testsBlock(row) {
  if (row.tests.length === 0) return '';
  const heading =
    row.tier === 'tested'
      ? `asserted by ${plural(row.tests.length, 'test')}`
      : `on a path ${plural(row.tests.length, 'test')} already drive — none of them pins this outcome`;
  const rows = row.tests
    .slice(0, 4)
    .map((entry) => {
      const instances =
        entry.titles.length > 1
          ? `<span class="insts">${plural(entry.titles.length, 'instance')}: ${escapeHtml(entry.titles.join(' · '))}</span>`
          : '';
      return `<div class="test-row">${escapeHtml(`${entry.repo} › ${entry.spec} › ${entry.titles[0]}`)}<span class="mech mech-${entry.mechanism}">${escapeHtml(entry.mechanism)}</span>${caseIdBadge(entry)}${instances}</div>`;
    })
    .join('');
  const more = row.tests.length > 4 ? `<div class="test-row off">+${row.tests.length - 4} more</div>` : '';
  const anyCaseIds = row.tests.some((entry) => entry.caseIds && entry.caseIds.length > 0);
  const noid = anyCaseIds
    ? ''
    : '<div class="noid">no case id: no case_id fact resolved for this test — a case-id annotation, a configured call or a same-file table row would surface one here.</div>';
  return `<div class="tests"><div class="tests-head">${escapeHtml(heading)}</div>${rows}${more}${noid}</div>`;
}

/**
 * The Gherkin an untested row is owed, quoted from `cases --gherkin-draft` rather than written
 * again here. Every character of it sits in a `gk` run and nothing this module adds ever
 * does, so a test can strip the markup back and assert byte-equality against the generator.
 */
function draftBlock(row) {
  // A merged outcome's drafts are printed once each, under the arm each was drafted for, so
  // the ledger row never quotes the same scenario twice on a page whose subject is a dedup.
  if (!row.gherkin || row.dedup) return '';
  const anchor = escapeHtml(row.key || row.id);
  return `<details class="draft" id="draft-${anchor}"><summary>what a test for this would say — <code>cases --gherkin-draft</code>, quoted</summary><pre class="gherkin"><span class="gk">${escapeHtml(row.gherkin)}</span></pre></details>`;
}

function ledgerRow(row, position) {
  const anchor = escapeHtml(row.key || row.id);
  const status = row.status ? `<span class="status">${escapeHtml(row.status)}</span>` : '<span class="status off">—</span>';
  return `<div class="lrow lrow-${TIER_CLASS[row.tier]}" id="seed-${anchor}">
<div class="lrow-head"><span class="ord">${position}</span>${tag(row.tier)}${status}<span class="what">${escapeHtml(row.headline)}</span><span class="seedkey">${escapeHtml(`${row.id} #${row.key || '—'}`)}</span></div>
${testsBlock(row)}
${dedupBlock(row, true)}${draftBlock(row)}
</div>`;
}

const LEG_TITLE = Object.freeze({
  sync: 'the endpoint writes this state before it answers, so the read-back can happen on the same request',
  async: 'the write happens past a published message, so a read-back has to poll until it lands rather than assume it already has',
});

/** The state a group is named after, the leg it is written on, and the carrier of that leg. */
function surfaceHead(group, extra = '') {
  const state = group.state === null || group.state === undefined ? 'no state written' : group.state;
  const leg = group.leg
    ? `<span class="leg leg-${escapeHtml(group.leg)}" title="${escapeHtml(LEG_TITLE[group.leg] || '')}">${escapeHtml(group.leg)}</span>`
    : '';
  const via = group.through ? `<span class="surf-via">${escapeHtml(`via ${group.through.ref}`)}</span>` : '';
  return `<div class="surf-head"><span class="surf-state">${escapeHtml(state)}</span>${leg}${via}${extra}</div>`;
}

/** Where a group's own facts are written — the write site, then each endpoint's declaration. */
function surfaceWhere(group) {
  const wrote = group.writes && group.writes.length > 0 ? ` — ${group.writes.join(', ')}` : '';
  const rows = [
    `<div class="where-site">${escapeHtml(`${group.state} write: ${site(group) || 'no site on the write fact'}${wrote}`)}</div>`,
    ...group.observe.map(
      (entry) => `<div class="where-site">${escapeHtml(`${entry.observe} — ${entry.repo || ''} — ${site(entry) || 'no site on the route fact'}`)}</div>`,
    ),
  ].join('');
  const more =
    group.observeMore > 0
      ? `<div class="where-site">${escapeHtml(`+${group.observeMore} further observation point${group.observeMore === 1 ? '' : 's'} — surface --json carries every one`)}</div>`
      : '';
  return `<details class="where"><summary>where this state is written, and where each endpoint is declared</summary><div class="where-body">${rows}${more}</div></details>`;
}

/**
 * Which response field reflects the write is a judgment, not a walk: read one way
 * or the other, or not read at all. `point.verdict` is missing outright when `span` was never
 * given `--verdict-facts` — this returns `''` then, the one branch that keeps a no-flag page
 * byte-identical — `null` when the flag was given but nothing was cached for this exact
 * point, and the cached fact otherwise. No new CSS: confirmed/refused/pending reuse the
 * ledger's own tag classes, so the stylesheet is unchanged either way.
 */
function verdictMark(point) {
  if (point.verdict === undefined) return '';
  if (point.verdict === null) {
    return ' <span class="tag t-inherited" title="no surface_verdict fact cached for this observation point">judgment pending</span>';
  }
  if (point.verdict.reflects === true) {
    return ` <span class="tag t-tested" title="${escapeHtml(`cached verdict, read at ${site(point.verdict)}`)}">confirmed: ${escapeHtml(point.verdict.field)}</span>`;
  }
  return ' <span class="tag t-untested" title="cached verdict — this endpoint does not reflect the write">refused</span>';
}

/** The refusal's own note, quoted rather than summarised — absent for every other verdict. */
function verdictNote(point) {
  if (!point.verdict || point.verdict.reflects !== false) return '';
  return `<div class="gap-why">${escapeHtml(point.verdict.note || '')}</div>`;
}

/** One state, one leg, and the safe-verb endpoints a test could read the write back on. */
function surfaceGroup(group) {
  const points = group.observe
    .map(
      (entry) =>
        `<li>${escapeHtml(entry.observe)} <span class="hops">${escapeHtml(plural(entry.hops, 'hop'))}</span>${verdictMark(entry)}${verdictNote(entry)}</li>`,
    )
    .join('');
  const more = group.observeMore > 0 ? `<li class="off">+${group.observeMore} more</li>` : '';
  return `<div class="surf">
${surfaceHead(group)}
<div class="surf-at"><span class="surf-k">assert at:</span><ul class="obs">${points}${more}</ul></div>
${surfaceWhere(group)}
</div>`;
}

/** A chain the derivation could not close, printed as the row it is rather than filled in. */
function surfaceGap(gap) {
  const evidence =
    gap.evidence.length > 0
      ? gap.evidence.map((row) => `<li>${escapeHtml(`${row.via} ${row.ref}`)}</li>`).join('')
      : '<li class="off">no evidence row — the walk found nothing to name at the point it stopped</li>';
  const more = gap.evidenceMore > 0 ? `<li class="off">+${gap.evidenceMore} more</li>` : '';
  const sites = gap.evidence
    .map((row) => `<div class="where-site">${escapeHtml(`${row.via} ${row.ref} — ${site(row) || 'no site on this fact'}`)}</div>`)
    .join('');
  return `<div class="surf surf-gap">
${surfaceHead(gap, `<span class="gapkind">${escapeHtml(gap.reason)}</span>`)}
<div class="gap-why">${escapeHtml(gap.detail)}</div>
<div class="surf-at"><span class="surf-k">evidence:</span><ul class="obs">${evidence}${more}</ul></div>
<details class="where"><summary>where the chain stopped</summary><div class="where-body"><div class="where-site">${escapeHtml(`${gap.state || 'no state'} — ${site(gap) || 'no site on this fact'}`)}</div>${sites}</div></details>
</div>`;
}

/**
 * The assertion-surface section: one group per state the route changes, then the gaps. A
 * route deriving no group at all says so in one line — the section is never silently empty,
 * and no endpoint is ever invented to fill a gap.
 */
function surfaceBlock(model) {
  const surface = model.surface || {};
  const groups = surface.groups || [];
  const gaps = surface.gaps || [];
  const counts = surface.counts || {};
  const limits = surface.limits || {};
  const verbs = limits.verbs || 'GET, HEAD';
  const hops = limits.hops === undefined || limits.hops === null ? null : plural(limits.hops, 'hop');
  const intro =
    groups.length > 0
      ? `Where the state this route changes can be read back. ${plural(counts.states || 0, 'state')} written, ` +
        `${groups.length} of them readable through a ${verbs} route${hops ? ` inside ${hops}` : ''}, ` +
        `${plural(gaps.length, 'gap')}. Each endpoint below was reached by walking read call sites up to the route that declares them; the expanders carry every hop's file:line.`
      : counts.states === 0
        ? `No assertion surface derives for this route: the walk reaches no store write at all, so there is no changed state to read back and nothing below is an endpoint.`
        : `No assertion surface derives for this route: ${plural(counts.states || 0, 'state')} written, none of them read back by a ${verbs} route${hops ? ` inside ${hops}` : ''}, so every row below is a gap and no endpoint is guessed to fill one.`;
  return `<div class="plain">${escapeHtml(intro)}</div>
${groups.map(surfaceGroup).join('\n')}
${gaps.map(surfaceGap).join('\n')}`;
}

function stripHtml(model) {
  const counts = model.ledger.counts;
  const cells = [
    ['route', model.route.key],
    ['owning action', `${model.route.controller || '—'}${model.route.action ? `.${model.route.action}` : ''}`],
    ['outcomes', String(counts.total)],
    ['tested', String(counts.tested), counts.tested > 0 ? 'ok' : 'off'],
    ['inherited only', String(counts['inherited-only']), counts['inherited-only'] > 0 ? 'warn' : 'off'],
    ['untested', String(counts.untested), counts.untested > 0 ? 'warn' : 'ok'],
    ['route evidence tier', model.evidence.tier],
    ['reconciles with cover', `${model.reconcile.ledgerRows}/${model.reconcile.coverSeeds} seeds`],
  ];
  if (model.reconcile.deduped > 0) {
    cells.splice(2, 0, [
      'seeds merged',
      `${model.reconcile.deduped} into ${model.reconcile.outcomes}`,
      'warn',
    ]);
  }
  return `<div class="strip">${cells
    .map(
      ([k, v, cls]) =>
        `<div class="cell"><span class="k">${escapeHtml(k)}</span><span class="v${cls ? ` ${cls}` : ''}">${escapeHtml(v)}</span></div>`,
    )
    .join('')}</div>`;
}

/**
 * The assertion-surface layer's own ceiling, stated in the same strip as every other one.
 * The two sentences that bound it are the model's, quoted rather than paraphrased, so the
 * page and `surface --json` never disagree about what a surface is worth.
 */
function surfaceHonesty(model) {
  const surface = model.surface;
  if (!surface) return '';
  const counts = surface.counts || {};
  const limits = surface.limits || {};
  const gaps = counts.gaps || 0;
  const gapText =
    gaps > 0
      ? `${plural(gaps, 'gap row')} in that section ${gaps === 1 ? 'stands' : 'stand'} where a chain stopped, and a gap is never filled with the most plausible endpoint.`
      : 'No gap row stands in that section, which says every state this route writes reached a safe-verb reader — not that the reader returns the field a test should assert on.';
  const verdicts = surface.verdictCounts;
  const verdictText = verdicts
    ? ` Of ${plural(verdicts.total, 'observation point')} named outright above, ${verdicts.confirmed} ${verdicts.confirmed === 1 ? 'carries' : 'carry'} a confirmed correlation, ${verdicts.refused} ${verdicts.refused === 1 ? 'carries' : 'carry'} a cached refusal, and ${plural(verdicts.pending, 'point')} ${verdicts.pending === 1 ? 'carries' : 'carry'} no ${code('surface_verdict')} fact — read as judgment pending, never assumed.`
    : '';
  return `<br><b>Field-level correlation is a judgment, not a walk.</b> An assertion surface names an endpoint, never a field:
${escapeHtml(limits.correlation || '')}. Nor is a hop a payload: ${escapeHtml(limits.carrier || '')}. The reverse walk behind that section is
bounded at ${escapeHtml(String(limits.hops ?? '—'))} receiver hops and observes only ${escapeHtml(limits.verbs || 'GET, HEAD')}, so a reader further away than that, or one
reachable only behind a state-changing verb, is absent from the section rather than approximated into it. ${escapeHtml(gapText)}${verdictText}`;
}

function honestyHtml(model) {
  const truncated =
    model.limits.seedsTruncated > 0
      ? `<br><b>This route was too crowded to seed in full.</b> ${escapeHtml(plural(model.limits.seedsTruncated, 'seed'))} were dropped by the walker's own cap before this page saw them, so the outcomes below are a subset, not the whole route.`
      : '';
  const specs =
    model.limits.specs.length > 0
      ? `<br><b>Evidence was filtered.</b> <code>--specs</code> narrowed it to ${escapeHtml(plural(model.limits.specs.length, 'selector'))}: <code>${escapeHtml(model.limits.specs.join(', '))}</code>, so every tag on this page answers "what does that selection alone prove".`
      : '';
  return `<div class="note" id="honesty"><b>What this page cannot know.</b>
<br><b>Every edge here is source-inferred; none is runtime-confirmed.</b> The page is built by reading code, not by watching a request. The
runtime-confirmed-edge minimum that would let a page claim otherwise is not part of this tool, so nothing below is evidence that
a request actually took this path in any environment.
<br><b>Feature flags and tenant configuration decide branches a static read cannot evaluate.</b> An outcome listed here may be unreachable in a
given tenant, and one that is reachable in that tenant may be missing from this list entirely. Treat the list as the shape of the endpoint, not
as its behaviour in front of you.
<br><b>Runtime fan-out is invisible.</b> A consumer bound at deploy time, a handler registered by configuration, a processor selected by a
runtime work type — none of them is visible to a source read, so the consumers named below are the ones written down, not necessarily the ones
that run.
<br><b>Outcome-symmetric branches stay unattributable.</b> Where both sides of a decision end in the same observable outcome, nothing here can
say which side a test drove; per-branch certainty for those needs the per-test runtime line hits <code>cover --runtime</code> joins. Those rows read
<em>inherited only</em>, and that is the ceiling, not a gap in the join.
<br><b>Case ids are best-effort.</b> A tested row shows a case id only when a <code>case_id</code> fact resolves one at that test's declaration
line — a case-id annotation, a literal configured call or a same-file table row. A subscript, a computed value, a template or a cross-file
table stays absent rather than guessed, so a row showing no case id may still carry one flowtrace refused to read rather than fabricate.
<br><b>Two limits inherited unchanged from the evidence index.</b> A skipped test is not evidence in any tier, and Cypress evidence can never
reach <em>asserted</em> because the fact schema records no Cypress assertion fact — only Playwright's.${surfaceHonesty(model)}${truncated}${specs}</div>`;
}

/**
 * What the seed count and the outcome count differ by, said in the sentence that claims the
 * reconciliation rather than in a footnote. With nothing merged the two are equal and no
 * qualification is needed.
 */
function dedupNote(model) {
  if (!model.reconcile.deduped) return '';
  return escapeHtml(
    `, which together account for all ${model.reconcile.ledgerRows} — ${plural(model.reconcile.deduped, 'seed')} merged into an outcome ` +
      `already on the page as its second arm, never dropped from it`,
  );
}

function ledgerNote(model) {
  return `<div class="plain">Every outcome above appears here exactly once, tagged with exactly one of three tags, ordered by what to do first:
untested fault contracts, then untested branches, then inherited-only, then the outcomes a test already pins. Inside a tier the route's own seed
order decides. The three counts sum to ${escapeHtml(plural(model.reconcile.outcomes, 'outcome'))}${dedupNote(model)} — reconciling with the
${escapeHtml(plural(model.reconcile.coverSeeds, 'seed'))} <code>cover --json</code> reports for this route, which is asserted by a test rather
than claimed here. An <em>inherited only</em> row is never counted as tested in any total on this page.</div>`;
}

const STYLE = `
:root {
  --bg: #0d1117;
  --panel: #12181f;
  --edge: #232c37;
  --fg: #c9d1d9;
  --muted: #7d8794;
  --bold: #f0f6fc;
  --cyan: #56b6c2;
  --magenta: #c678dd;
  --ok: #56c07a;
  --warn: #d8a13a;
  --red: #e06c6c;
  --off: #6b7581;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace;
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font-family: var(--sans); font-size: 14px; line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 1180px; margin: 0 auto; padding: 30px 22px 72px; }
h1 { font-size: 17px; margin: 0 0 4px; color: var(--bold); font-weight: 600; }
h1 .route { font-family: var(--mono); color: var(--cyan); }
h2 { font-size: 13px; margin: 30px 0 10px; color: var(--bold); font-weight: 600; text-transform: uppercase; letter-spacing: .09em; }
h3 { font-size: 12px; margin: 18px 0 8px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: .08em; }
.sub { color: var(--muted); margin: 0 0 16px; font-size: 12.5px; }
.sub a { color: var(--warn); }
code { font-family: var(--mono); font-size: 12px; color: var(--cyan); }
.strip {
  display: flex; flex-wrap: wrap; gap: 0; border: 1px solid var(--edge); border-radius: 6px;
  background: var(--panel); margin-bottom: 14px; overflow: hidden;
}
.cell { padding: 9px 16px; border-right: 1px solid var(--edge); min-width: 0; }
.cell:last-child { border-right: 0; }
.cell .k { display: block; color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .09em; }
.cell .v { display: block; color: var(--bold); font-size: 13px; margin-top: 2px; font-family: var(--mono); word-break: break-word; }
.v.ok { color: var(--ok); } .v.warn { color: var(--warn); } .v.off { color: var(--off); }
.note {
  border: 1px solid var(--edge); border-left: 3px solid var(--warn); border-radius: 6px;
  background: var(--panel); padding: 12px 16px; margin: 14px 0; font-size: 12.5px;
}
.note b { color: var(--warn); font-weight: 600; }
.plain { color: var(--muted); font-size: 12.5px; margin: 0 0 12px; }
.chain { border: 1px solid var(--edge); border-radius: 6px; background: var(--panel); margin-bottom: 12px; overflow: hidden; }
.chain-row { display: flex; justify-content: space-between; gap: 14px; padding: 7px 14px; border-bottom: 1px solid var(--edge); }
.chain-row:last-child { border-bottom: 0; }
.chain-name { color: var(--bold); font-family: var(--mono); font-size: 12.5px; overflow-wrap: anywhere; }
.chain-verb { color: var(--off); font-size: 11px; white-space: nowrap; }
.chain-row.more { color: var(--muted); }
.endpoint {
  border: 1px solid var(--edge); border-left: 3px solid var(--cyan); border-radius: 6px;
  background: var(--panel); padding: 11px 16px; margin-bottom: 12px;
}
.endpoint .verb { font-family: var(--mono); font-size: 14px; color: var(--bold); font-weight: 700; }
.endpoint .path { font-family: var(--mono); font-size: 14px; color: var(--cyan); overflow-wrap: anywhere; }
.endpoint .owning { color: var(--muted); font-size: 12.5px; margin-top: 3px; }
.acc { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; padding: 0 5px; border-radius: 7px; }
.acc-write { color: var(--warn); border: 1px solid rgba(216,161,58,.45); background: rgba(216,161,58,.10); }
.acc-read { color: var(--off); border: 1px solid rgba(107,117,129,.40); background: rgba(107,117,129,.08); }
.row {
  border: 1px solid var(--edge); border-radius: 6px; background: var(--panel);
  padding: 11px 15px; margin-bottom: 9px;
}
.row-fault { border-left: 3px solid var(--red); }
.row-success { border-left: 3px solid var(--ok); }
.row-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; }
.status {
  font-family: var(--mono); font-weight: 700; color: var(--bold); font-size: 13px;
  border: 1px solid var(--edge); border-radius: 5px; padding: 0 7px; white-space: nowrap;
}
.status.off { color: var(--off); font-weight: 400; }
.what { flex: 1 1 260px; color: var(--fg); }
.tag {
  font-size: 10px; text-transform: uppercase; letter-spacing: .07em; padding: 1px 8px;
  border-radius: 9px; border: 1px solid transparent; white-space: nowrap; cursor: help; font-weight: 700;
}
.t-tested { color: #06210f; background: var(--ok); border-color: var(--ok); }
.t-inherited { color: var(--warn); background: none; border-color: rgba(216,161,58,.55); font-weight: 400; }
.t-untested { color: var(--red); background: rgba(224,108,108,.10); border-color: rgba(224,108,108,.50); }
.map { color: var(--magenta); font-size: 12px; margin: 6px 0 2px; }
.row-body { display: flex; flex-wrap: wrap; gap: 8px 34px; margin-top: 6px; }
.col { flex: 1 1 300px; min-width: 0; }
.col-k { color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .09em; }
ul.pre, ul.expect, ul.eff { margin: 2px 0 0; padding-left: 18px; }
ul.pre li, ul.expect li, ul.eff li { font-size: 12.5px; overflow-wrap: anywhere; }
ul.expect li { color: var(--bold); }
li.off { color: var(--off); }
.row-foot { margin-top: 7px; display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline; }
.seedkey { color: var(--off); font-family: var(--mono); font-size: 11px; }
.jump { color: var(--warn); font-size: 11.5px; text-decoration: none; }
.jump:hover { text-decoration: underline; }
details.where, details.draft { margin-top: 7px; }
details.where > summary, details.draft > summary {
  cursor: pointer; color: var(--muted); font-size: 11.5px; list-style: none;
}
details.where > summary::before, details.draft > summary::before { content: "▸ "; }
details[open].where > summary::before, details[open].draft > summary::before { content: "▾ "; }
.where-body { border-left: 2px solid var(--edge); margin-top: 5px; padding: 2px 0 2px 12px; }
.where-row { margin-bottom: 7px; }
.where-phrase { color: var(--fg); font-size: 12.5px; }
.where-kind { margin-left: 8px; color: var(--off); font-size: 10px; text-transform: uppercase; letter-spacing: .07em; }
.where-code { font-family: var(--mono); font-size: 11.5px; color: var(--magenta); overflow-wrap: anywhere; }
.where-site { font-family: var(--mono); font-size: 11px; color: var(--off); overflow-wrap: anywhere; }
.msg { border: 1px solid var(--edge); border-left: 3px solid var(--magenta); border-radius: 6px; background: var(--panel); padding: 11px 15px; margin-bottom: 9px; }
.msg-head { display: flex; flex-wrap: wrap; gap: 10px; align-items: baseline; }
.msg-name { font-family: var(--mono); font-size: 13px; color: var(--bold); font-weight: 700; }
.msg-contract { color: var(--off); font-size: 11px; }
.answer { margin: 7px 0 0 12px; border-left: 2px solid var(--edge); padding-left: 12px; }
.answer.none { color: var(--off); font-size: 12px; }
.answer-head { color: var(--fg); font-size: 12.5px; font-family: var(--mono); overflow-wrap: anywhere; }
.answer-kind { color: var(--cyan); font-size: 10px; text-transform: uppercase; letter-spacing: .07em; margin-right: 8px; }
.worktype { color: var(--off); font-size: 11px; margin-left: 8px; }
.eff-repo { color: var(--off); font-size: 10.5px; }
.lrow { border: 1px solid var(--edge); border-radius: 6px; background: var(--panel); padding: 10px 15px; margin-bottom: 8px; }
.lrow-t-untested { border-left: 3px solid var(--red); }
.lrow-t-inherited { border-left: 3px solid rgba(216,161,58,.55); }
.lrow-t-tested { border-left: 3px solid var(--ok); }
.lrow-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; }
.ord { color: var(--off); font-family: var(--mono); font-size: 11px; min-width: 2.2em; }
.tests { margin-top: 7px; border-left: 2px solid var(--edge); padding: 2px 0 2px 12px; }
.tests-head { color: var(--muted); font-size: 10.5px; text-transform: uppercase; letter-spacing: .08em; }
.test-row { font-size: 12px; overflow-wrap: anywhere; }
.test-row.off { color: var(--off); }
.mech { margin-left: 8px; font-size: 9.5px; letter-spacing: .05em; text-transform: uppercase; padding: 0 5px; border-radius: 7px; }
.mech-listed { color: var(--cyan); border: 1px solid rgba(86,182,194,.40); background: rgba(86,182,194,.10); }
.mech-raw { color: var(--off); border: 1px solid rgba(107,117,129,.40); background: rgba(107,117,129,.08); }
.caseid { margin-left: 8px; font-size: 9.5px; letter-spacing: .05em; color: var(--magenta); border: 1px solid rgba(198,120,221,.40); background: rgba(198,120,221,.10); padding: 0 5px; border-radius: 7px; }
.insts { display: block; color: var(--cyan); font-size: 11px; }
.noid { color: var(--off); font-size: 11px; margin-top: 4px; }
pre.gherkin {
  margin: 6px 0 0; padding: 11px 13px; background: #0a0e14; border: 1px solid var(--edge);
  border-radius: 5px; overflow-x: auto; font-family: var(--mono); font-size: 12px;
  white-space: pre-wrap; overflow-wrap: anywhere; color: var(--fg);
}
.surf { border: 1px solid var(--edge); border-left: 3px solid var(--cyan); border-radius: 6px; background: var(--panel); padding: 10px 15px; margin-bottom: 8px; }
.surf-gap { border-left-color: var(--red); }
.surf-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; }
.surf-state { font-family: var(--mono); font-size: 13px; color: var(--bold); font-weight: 700; overflow-wrap: anywhere; }
.surf-via { color: var(--magenta); font-size: 11.5px; overflow-wrap: anywhere; }
.leg { font-size: 10px; text-transform: uppercase; letter-spacing: .07em; padding: 0 6px; border-radius: 8px; white-space: nowrap; cursor: help; }
.leg-sync { color: var(--cyan); border: 1px solid rgba(86,182,194,.45); background: rgba(86,182,194,.10); }
.leg-async { color: var(--magenta); border: 1px solid rgba(198,120,221,.45); background: rgba(198,120,221,.10); }
.gapkind { font-size: 10px; text-transform: uppercase; letter-spacing: .07em; font-weight: 700; padding: 1px 8px; border-radius: 9px; color: var(--red); border: 1px solid rgba(224,108,108,.50); background: rgba(224,108,108,.10); white-space: nowrap; }
.surf-at { margin-top: 5px; }
.surf-k { color: var(--muted); font-size: 10.5px; text-transform: uppercase; letter-spacing: .08em; }
ul.obs { margin: 2px 0 0; padding-left: 18px; }
ul.obs li { font-size: 12.5px; font-family: var(--mono); overflow-wrap: anywhere; color: var(--fg); }
ul.obs li.off { font-family: var(--sans); color: var(--off); }
.hops { color: var(--off); font-family: var(--sans); font-size: 10.5px; margin-left: 6px; }
.gap-why { color: var(--red); font-size: 12.5px; margin-top: 4px; }
.dedup { margin-top: 8px; border-left: 2px solid var(--edge); padding-left: 10px; }
.dedup-why { color: var(--muted); font-size: 12px; line-height: 1.5; }
.arm { margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--edge); }
.arm:first-child { border-top: 0; padding-top: 0; }
.arm-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }
.arm-src { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
.foot { margin-top: 22px; color: var(--off); font-size: 11px; }
@media (max-width: 720px) { .wrap { padding: 18px 12px 48px; } .row-body { gap: 8px; } }
`;

function buildContent(model) {
  const counts = model.ledger.counts;
  const success = model.outcomes.success;
  const fault = model.outcomes.fault;
  const surface = model.surface || { groups: [], gaps: [] };
  return `<div class="wrap">
<h1>flowtrace span · <span class="route">${escapeHtml(model.route.key)}</span></h1>
<p class="sub">What this endpoint can do that somebody could observe, and which of those a test already pins. Code sits behind the expanders. <a href="#honesty">What this page cannot know →</a></p>

${stripHtml(model)}

<h2>1 · Span map</h2>

<h3>Who calls it</h3>
${callersBlock(model)}

<h3>The endpoint</h3>
<div class="endpoint"><span class="verb">${escapeHtml(model.route.verb || 'ANY')}</span> <span class="path">${escapeHtml(model.route.path)}</span>
<div class="owning">answered by ${escapeHtml(`${model.route.controller || 'no resolved controller'}${model.route.action ? `.${model.route.action}` : ''}`)}</div>
<details class="where"><summary>where this is written, and the chain it walks</summary><div class="where-body"><div class="where-site">${escapeHtml(site(model.route))}</div><div class="where-site">${escapeHtml(model.route.chain)}</div></div></details></div>
${ownersBlock(model)}

<h3>Success outcomes (${success.length})</h3>
${success.length > 0 ? success.map(outcomeRow).join('\n') : '<div class="plain">No success outcome is traced for this route — every seed the walk produced ends in a refusal or a fault.</div>'}

<h3>Fault outcomes (${fault.length})</h3>
${fault.length > 0 ? fault.map(outcomeRow).join('\n') : '<div class="plain">No refusal or fault outcome is traced for this route.</div>'}

<h3>Messages published, and what answers them</h3>
${messagesBlock(model)}

<h2>2 · Test ledger</h2>
${ledgerNote(model)}
${model.ledger.rows.map((row, position) => ledgerRow(row, position + 1)).join('\n')}

<h2>3 · Assertion surface</h2>
${surfaceBlock(model)}

<h2>4 · Honesty strip</h2>
${honestyHtml(model)}

<p class="foot">${escapeHtml(
    `${plural(counts.total, 'outcome')} · ${counts.tested} tested · ${counts['inherited-only']} inherited only · ${counts.untested} untested · reconciles with cover: ${model.reconcile.ledgerRows}/${model.reconcile.coverSeeds} seeds${model.reconcile.deduped ? ` (${model.reconcile.deduped} merged into an outcome as a second arm)` : ''} · assertion surface: ${plural((surface.groups || []).length, 'state group')} observed, ${plural((surface.gaps || []).length, 'gap')} · outcomes from the trace walk, tiers from the cover overlay and the branch-outcome / asserted-status join, drafts quoted from cases --gherkin-draft, observation points from the assertion-surface walk`,
  )}</p>
</div>`;
}

/**
 * One self-contained page per entry route. Inline CSS only, nothing fetched, no timestamp,
 * so two runs over the same facts produce byte-identical files.
 */
export function renderSpanHtml(model, { title = 'flowtrace span' } = {}) {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${STYLE}</style>`,
    '</head><body>',
    buildContent(model),
    '</body></html>',
    '',
  ].join('\n');
}

/**
 * The pieces `lib/render-component-span-html.js` reuses rather than
 * reimplementing: one route's own section content, unwrapped from the page shell around
 * it, and the same inline stylesheet, so a page carrying several routes still opens under
 * one strict CSP with one `<style>` block.
 */
export const internals = { buildContent, STYLE, escapeHtml, site, plural };
