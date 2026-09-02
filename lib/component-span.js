/**
 * Component-rooted span (web only) — resolves a component through the chain the web
 * extractor already establishes: component → handler or method body →
 * `action_dispatch` → `action_def` → `effect_handler` → `gateway_call` → route. The
 * result is one page: a header naming the component, the routes it resolves to and the
 * arms that do not, and one `lib/span.js` section per resolved route, reused verbatim —
 * this module never re-derives a route's own behaviour, only the join that reaches it.
 *
 * The only trace surface this module reads specifically for this join is `stopAtRoutes` —
 * a route
 * reached from a component is a leaf here, because the backend behaviour behind it is
 * `span()`'s own walk, not this one; without it the same call re-expands the whole
 * backend under every route and blows the walk's node budget on work this page discards.
 * `stopAtRoutes` also folds a revisited subtree the same way `--expand`'s inventory mode
 * already does, so the same shared child component reached from two different handlers is
 * walked once, not twice.
 *
 * An arm is unresolved for exactly four reasons, and no others:
 *
 * - **`no-route-match`** — the gateway call's `verb template` matches no route fact at
 *   all; the walk already carries this as `route.unresolved`.
 * - **`template-not-resolved`** — the gateway call itself carries `resolved: false` (the
 *   extractor could not pin the template to a literal), even when `matchRoute`'s own
 *   prefix or suffix heuristic happens to land on a route anyway. Trusting that landing
 *   would add a silent inference beyond the recorded evidence: the
 *   extractor would not vouch for the template, so this page will not either.
 * - **`no-effect`** — the action a dispatch or a bound prop names reaches zero
 *   `effect_handler` facts; the walk calls this a leaf, not an error, and it still is — it
 *   just is not a *resolved* arm, so it prints rather than vanishing.
 * - **`walk-limit`** — the same dead end, but because the walk's own depth or node budget
 *   was spent before it could be explored, not because nothing answers it. Named
 *   separately so the page never states a shortage as if it were the fact store's own.
 *
 * Anything the walk did not reach at all — a handler with no dispatch, an unresolved
 * handler body — is outside this join's vocabulary, not an additional kind of gap, and prints
 * nowhere on this page, exactly as it prints nowhere in `trace`'s own component-start
 * inventory today.
 *
 * A name declared in more than one file is never silently picked for you:
 * `--file <path-substring>` is the qualifier, `resolveComponentStart` does the
 * disambiguation, and both are documented at that function.
 */

import { routeSlugFor } from './cases.js';
import { span } from './span.js';
import { resolveStart, trace } from './trace.js';

/** How many arms a route section or a gap row names outright before folding the rest. */
export const ARM_CAP = 6;

function compare(a, b) {
  const left = a || '';
  const right = b || '';
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function componentKindOf(role) {
  if (role === 'page') return 'page';
  if (role === 'service') return 'service';
  return 'component';
}

/**
 * Every `component`-type fact declaring `name` in `repo`, read straight off the raw fact
 * sets rather than through `trace.js`'s own index. The index keeps every declaration
 * under its `repo|name` key, but a walk continuing past a resolved start still lands on
 * the last-processed one; this scan hands `resolveComponentStart` the full per-file
 * list — deduplicated by `file:line`, stably ordered — so it can name the ambiguity
 * outright or let `--file` pick exactly one declaration.
 */
function componentDeclarations(factSets, repo, name) {
  const seen = new Map();
  for (const set of factSets) {
    if (set.repo !== repo) continue;
    for (const fact of set.facts || []) {
      if (fact.type !== 'component' || fact.name !== name) continue;
      const key = `${fact.file}:${fact.line}`;
      if (!seen.has(key)) seen.set(key, fact);
    }
  }
  return [...seen.values()].sort((a, b) => compare(a.file, b.file) || (a.line || 0) - (b.line || 0));
}

function declarationLabel(name, repo, fact) {
  return `${name} (${fact.role || 'component'}) ${repo} ${fact.file}:${fact.line}`;
}

/**
 * Resolve `--from-component`'s name through the same chain every other start resolves
 * through, restricted to what this verb accepts: a `component`, `page` or `service` node,
 * in a `web`-kind repository. A mobile-kind hit is refused with its own reason instead of
 * walked: the chain this join resolves arms through is the one the web extractor
 * establishes end-to-end, and nothing in this module verifies that a mobile fact set
 * carries that chain the same way. A page that resolved a handful of a mobile screen's
 * arms and silently dropped the rest is exactly the failure this refusal exists to
 * prevent, so a mobile start is refused outright rather than walked partially.
 *
 * `options.file` disambiguates a name declared more than once in the resolving
 * repo — a walk continuing past its start otherwise lands on the last-processed
 * declaration. When more than one declaration exists, absent `--file` this returns
 * `{error, candidates}` naming every declaring file rather than guessing one; given
 * `--file`, it matches the declaration whose file path contains the substring and still
 * errors, listing the same full candidate set, if that leaves anything other than
 * exactly one.
 */
export function resolveComponentStart(factSets, name, options = {}) {
  const resolved = resolveStart(factSets, name, { repo: options.repo });
  if (resolved.error) return { error: resolved.error };
  if (resolved.candidates) return { candidates: resolved.candidates };
  const { node, index } = resolved;
  if (node.kind !== 'component' && node.kind !== 'page' && node.kind !== 'service') {
    return {
      error: `"${name}" resolved to a ${node.kind}, not a component, page or service — span --from-component only accepts one of those`,
    };
  }
  const repoKind = index.repos.get(node.repo);
  if (repoKind === 'mobile') {
    return {
      refused:
        `"${name}" is a mobile component. --from-component covers the web kind only: the ` +
        'component → handler → action_dispatch → effect_handler → gateway_call → route chain this join walks is ' +
        'the one the web extractor establishes, and this verb does not verify it against a mobile fact set. ' +
        'A mobile-kind start is refused outright rather than walked into a page that resolves a handful of arms ' +
        'and leaves the rest silent.',
    };
  }
  if (repoKind !== 'web') {
    return { error: `"${name}" resolved to a "${repoKind || 'unknown'}"-kind repository, not web` };
  }
  const declarations = componentDeclarations(factSets, node.repo, name);
  if (declarations.length > 1 || options.file) {
    const filtered = options.file
      ? declarations.filter((fact) => String(fact.file || '').includes(options.file))
      : declarations;
    if (filtered.length !== 1) {
      return {
        error: options.file
          ? `"${name}" — --file "${options.file}" matches ${filtered.length} of ${declarations.length} declarations, not exactly one`
          : `"${name}" is declared in ${declarations.length} files — pass --file <path-substring> to pick one`,
        candidates: declarations.map((fact) => declarationLabel(name, node.repo, fact)),
      };
    }
    const chosen = filtered[0];
    return { node: { ...node, file: chosen.file, line: chosen.line, kind: componentKindOf(chosen.role) }, index };
  }
  return { node, index };
}

/** The breadcrumb an arm is owed: every hop's kind, name and how the walk crossed it. */
function breadcrumbOf(path, node) {
  return path.concat([{ kind: node.kind, ref: node.ref, via: node.via }]).map((entry) => ({
    kind: entry.kind,
    ref: entry.ref,
    via: entry.via,
  }));
}

/**
 * Every arm the component's own walk reaches, from `trace(..., { stopAtRoutes: true })`'s
 * tree: one row per terminal the chain produced, grouped into resolved routes (keyed by
 * route key, a fan-out keeping every arm that reaches it) and the unresolved list above.
 * A `.cycle` node is a revisit `stopAtRoutes` folded — the subtree it would
 * have walked was already walked in full on its first visit, so it contributes no arm of
 * its own; whatever that first visit resolved to is already recorded.
 */
export function collectArms(root) {
  const resolved = new Map();
  const unresolved = [];
  const stack = [{ node: root, path: [] }];
  while (stack.length > 0) {
    const { node, path } = stack.shift();
    if (node.cycle) continue;
    if (node.kind === 'route') {
      const breadcrumb = breadcrumbOf(path, node);
      const site = { file: node.callerFile ?? node.file, line: node.callerLine ?? node.line };
      if (!node.unresolved && node.templateResolved !== false) {
        const arm = { key: node.ref, via: node.via, breadcrumb, ...site, route: node.route };
        const list = resolved.get(node.ref) || [];
        list.push(arm);
        resolved.set(node.ref, list);
        continue;
      }
      unresolved.push({
        reason: node.unresolved ? 'no-route-match' : 'template-not-resolved',
        attempted: node.ref,
        caller: node.caller ?? null,
        breadcrumb,
        ...site,
      });
      continue;
    }
    if (node.kind === 'store_action' && (!node.children || node.children.length === 0)) {
      unresolved.push({
        reason: node.leaf === true ? 'walk-limit' : 'no-effect',
        attempted: node.ref,
        caller: null,
        breadcrumb: breadcrumbOf(path, node),
        file: node.file,
        line: node.line,
      });
    }
    const nextPath = path.concat([{ kind: node.kind, ref: node.ref, via: node.via }]);
    for (const kid of node.children || []) stack.push({ node: kid, path: nextPath });
  }
  return { resolved, unresolved };
}

const UNRESOLVED_REASON_TEXT = Object.freeze({
  'no-route-match': 'no route in the fact store matches this gateway call’s verb and template',
  'template-not-resolved':
    'the gateway call carries resolved: false — the extractor never pinned this template to a literal, so the route below is what it would land on, not what it is trusted to',
  'no-effect': 'no effect_handler answers this action',
  'walk-limit': "the walk's own depth or node budget was spent before this action could be explored further",
});

export function reasonText(reason) {
  return UNRESOLVED_REASON_TEXT[reason] || reason;
}

/**
 * One component's whole span: the header counts, one `lib/span.js` model per distinct
 * resolved route (fan-out arms folded into that route's own arm list), and the unresolved
 * arms in a fixed, readable order. `options.trace` and `options.span` replace the walker
 * and the per-route builder in tests, the same override shape `lib/span.js` itself takes.
 */
export function componentSpan(factSets, name, options = {}) {
  const sets = factSets || [];
  const resolved = resolveComponentStart(sets, name, { repo: options.repo, file: options.file });
  if (resolved.refused) return { refused: resolved.refused, component: { name } };
  if (resolved.error) return { error: resolved.error, candidates: resolved.candidates, component: { name } };
  if (resolved.candidates) return { candidates: resolved.candidates, component: { name } };

  const { node, index } = resolved;
  const tracer = options.trace || trace;
  const walked = tracer(sets, null, {
    ...(options.traceOptions || {}),
    index,
    startNode: node,
    inventory: false,
    stopAtRoutes: true,
  });

  const { resolved: resolvedRoutes, unresolved } = collectArms(walked.root);
  const spanner = options.span || span;
  const routeKeys = [...resolvedRoutes.keys()].sort(compare);
  const routes = routeKeys.map((key) => ({
    key,
    arms: resolvedRoutes.get(key).slice().sort((a, b) => compare(a.file, b.file) || (a.line || 0) - (b.line || 0)),
    model: spanner(sets, key, {
      aliases: options.aliases,
      specs: options.specs,
      traceOptions: options.traceOptions,
    }),
  }));

  const broken = routes.find((entry) => entry.model.error);
  if (broken) {
    throw new Error(
      `component-span: route "${broken.key}" resolved from "${name}" but span() could not build it: ${broken.model.error}`,
    );
  }

  const unresolvedOrdered = unresolved
    .slice()
    .sort(
      (a, b) =>
        compare(a.reason, b.reason) || compare(a.attempted, b.attempted) || compare(a.file, b.file) || (a.line || 0) - (b.line || 0),
    );
  const armsResolved = routes.reduce((total, entry) => total + entry.arms.length, 0);

  return {
    component: { name, repo: node.repo, kind: node.kind, file: node.file, line: node.line },
    slug: routeSlugFor(`component-${name}`),
    header: {
      routesResolved: routes.length,
      armsResolved,
      armsUnresolved: unresolvedOrdered.length,
    },
    routes,
    unresolved: unresolvedOrdered,
    limits: {
      budgetHit: Boolean(walked.stats && walked.stats.budgetHit),
      depth: walked.stats ? walked.stats.depth : null,
    },
  };
}
