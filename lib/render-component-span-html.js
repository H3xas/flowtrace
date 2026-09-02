/**
 * `span --from-component`'s page — a header naming the component, the
 * routes it resolves to and the arms that do not, above one `lib/span.js` section per
 * resolved route.
 *
 * Nothing here re-renders a route's own behaviour: each section is
 * `render-span-html.js`'s own `buildContent(model)`, quoted unchanged
 * through its `joins` export, so a route embedded on this page and that same route's own standalone
 * `span "<route key>"` page are byte-identical past their own `<h1>`. This module only
 * adds the header strip, the per-route arm breadcrumbs and the unresolved-arm ledger —
 * the join this module adds on top of the route page, never a second copy of what that page renders.
 */

import { internals } from './render-span-html.js';
import { reasonText } from './component-span.js';

const { buildContent, STYLE, escapeHtml, site, plural } = internals;

const HOP_LABEL = Object.freeze({
  start: 'start',
  template: 'renders',
  handler: 'handler',
  props: 'props',
  dispatch: 'dispatch',
  effect: 'effect',
  body: 'body',
  di: 'di',
  literal: 'literal',
  prefix: 'prefix match',
  suffix: 'suffix match',
  alias: 'alias match',
  ctor: 'ctor',
});

function hopLabel(via) {
  return HOP_LABEL[via] || via || '?';
}

/** The chain an arm was reached by, one hop per breadcrumb entry, in plain words. */
function breadcrumbHtml(breadcrumb) {
  const steps = (breadcrumb || [])
    .map((entry) => `<span class="hop">${escapeHtml(entry.ref)}</span><span class="hop-via">${escapeHtml(hopLabel(entry.via))}</span>`)
    .join('<span class="hop-sep">→</span>');
  return `<div class="crumb">${steps}</div>`;
}

function armsBlock(arms) {
  const shown = arms.slice(0, 6);
  const more = arms.length - shown.length;
  const rows = shown
    .map(
      (arm) =>
        `<div class="arm-row">${breadcrumbHtml(arm.breadcrumb)}<div class="where-site">${escapeHtml(site(arm))}</div></div>`,
    )
    .join('');
  const moreRow = more > 0 ? `<div class="arm-row off">+${escapeHtml(plural(more, 'arm'))} more</div>` : '';
  return `<details class="where arms"><summary>${escapeHtml(plural(arms.length, 'arm'))} reach this route</summary><div class="where-body">${rows}${moreRow}</div></details>`;
}

function routeSectionHtml(entry, position, total) {
  return `<section class="route-section" id="route-${position}">
<div class="route-divider"><span class="route-pos">route ${position} of ${total}</span><span class="route-key">${escapeHtml(entry.key)}</span></div>
${armsBlock(entry.arms)}
${buildContent(entry.model)}
</section>`;
}

const REASON_LABEL = Object.freeze({
  'no-route-match': 'no route match',
  'template-not-resolved': 'template not resolved',
  'no-effect': 'no effect answers',
  'walk-limit': 'walk limit reached',
});

function unresolvedRow(arm) {
  return `<div class="lrow lrow-t-untested">
<div class="lrow-head"><span class="tag t-untested" title="${escapeHtml(reasonText(arm.reason))}">${escapeHtml(REASON_LABEL[arm.reason] || arm.reason)}</span><span class="what">${escapeHtml(arm.attempted)}</span></div>
<div class="plain">${escapeHtml(reasonText(arm.reason))}</div>
${breadcrumbHtml(arm.breadcrumb)}
<div class="where-site">${escapeHtml(site(arm))}</div>
</div>`;
}

function unresolvedSectionHtml(model) {
  if (model.unresolved.length === 0) {
    return '<div class="plain">Every arm the walk reached resolved to a route.</div>';
  }
  return model.unresolved.map(unresolvedRow).join('\n');
}

function componentHeaderHtml(model) {
  const c = model.component;
  const cells = [
    ['component', c.name],
    ['kind', c.kind],
    ['repository', c.repo],
    ['declared at', `${c.file}:${c.line}`],
    ['routes resolved', String(model.header.routesResolved)],
    ['arms resolved', String(model.header.armsResolved)],
    ['arms unresolved', String(model.header.armsUnresolved), model.header.armsUnresolved > 0 ? 'warn' : 'ok'],
  ];
  return `<div class="strip">${cells
    .map(
      ([k, v, cls]) =>
        `<div class="cell"><span class="k">${escapeHtml(k)}</span><span class="v${cls ? ` ${cls}` : ''}">${escapeHtml(v)}</span></div>`,
    )
    .join('')}</div>`;
}

const COMPONENT_STYLE = `
.route-section { border-top: 3px solid var(--edge); padding-top: 18px; margin-top: 26px; }
.route-divider { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 10px; }
.route-pos { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .08em; }
.route-key { font-family: var(--mono); color: var(--cyan); font-size: 13px; }
.crumb { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px; font-size: 11.5px; }
.hop { color: var(--bold); font-family: var(--mono); }
.hop-via { color: var(--off); font-size: 10px; text-transform: uppercase; letter-spacing: .05em; }
.hop-sep { color: var(--off); margin: 0 2px; }
.arm-row { margin-bottom: 6px; }
.arm-row.off { color: var(--off); font-size: 11.5px; }
details.arms > summary { color: var(--muted); }
`;

function buildComponentContent(model) {
  const total = model.routes.length;
  return `<div class="wrap">
<h1>flowtrace span · <span class="route">${escapeHtml(model.component.name)}</span></h1>
<p class="sub">Resolved through component → handler or body → action_dispatch → effect_handler → gateway_call → route. Every arm below is traceable to the fact it was read from — an arm the join could not resolve prints as a gap, never a guess.</p>

${componentHeaderHtml(model)}

<h2>Routes resolved (${total})</h2>
${total > 0 ? model.routes.map((entry, index) => routeSectionHtml(entry, index + 1, total)).join('\n') : '<div class="plain">No arm the walk reached resolves to a route.</div>'}

<h2>Arms unresolved (${model.header.armsUnresolved})</h2>
<div class="plain">Every arm below either reaches a gateway call the extractor left <code>resolved: false</code>, matches no route in the fact store, or dispatches an action no <code>effect_handler</code> answers. Nothing here is a guess at what the arm would have reached.</div>
${unresolvedSectionHtml(model)}

<p class="foot">${escapeHtml(
    `${plural(total, 'route')} resolved · ${plural(model.header.armsResolved, 'arm')} resolved · ${plural(model.header.armsUnresolved, 'arm')} unresolved` +
      (model.limits.budgetHit ? ' · the walk hit its own node budget before finishing — this page may undercount arms' : ''),
  )}</p>
</div>`;
}

/**
 * One self-contained page for one component. Inline CSS only, nothing fetched, no
 * timestamp, so two runs over the same facts produce byte-identical files — the same
 * discipline `renderSpanHtml` holds its own page to.
 */
export function renderComponentSpanHtml(model, { title = 'flowtrace span' } = {}) {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${STYLE}${COMPONENT_STYLE}</style>`,
    '</head><body>',
    buildComponentContent(model),
    '</body></html>',
    '',
  ].join('\n');
}
