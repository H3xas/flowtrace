/**
 * Component-rooted span (web only) — resolves a component through the chain the web
 * extractor already establishes: component → entry → handler or method body →
 * `action_dispatch` → `action_def` → `effect_handler` → `gateway_call` → route. The
 * result is one page: a header naming the component, the routes it resolves to and the
 * arms that do not, and one `lib/span.js` section per resolved route, reused verbatim —
 * this module never re-derives a route's own behaviour, only the join that reaches it.
 *
 * Every arm is attributed to the **entry** that reached it — one way execution reaches the
 * component, named by its component, trigger kind, source site and guards. A mount-time
 * request and a request a button click makes are two entries with two arm sets, never one
 * list of steps a reader could mistake for a sequence. An arm the walk reached without
 * crossing an entry belongs to no entry and is reported as such rather than filed under one.
 *
 * The only trace surface this module reads specifically for this join is `stopAtRoutes` —
 * a route
 * reached from a component is a leaf here, because the backend behaviour behind it is
 * `span()`'s own walk, not this one; without it the same call re-expands the whole
 * backend under every route and blows the walk's node budget on work this page discards.
 * `stopAtRoutes` also folds a revisited subtree the same way `--expand`'s inventory mode
 * already does, so a chain two arms of one entry share is walked once, not twice. The fold
 * starts over at every entry: two entries reach a shared thunk as two answers, and folding
 * the second into the first would credit one entry with the other's arms.
 *
 * An arm is unresolved for exactly five reasons, and no others:
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
 * - **`entry-unresolved`** — a trigger the extractor stated but could not follow: a hook it
 *   does not read, a callback written as an expression rather than a literal, or an entry
 *   whose named handler resolves to no single method. The entry's own cause travels with
 *   the arm, so the page says which of those it is instead of leaving the trigger silent.
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
 * A `.cycle` node is a revisit the walk folded — the subtree it would have walked was
 * walked in full on its first visit — so it contributes no arm of its own; whatever that
 * first visit resolved to is already recorded. A folded revisit is always inside one
 * entry's own scope, because the walk starts its memoisation over at every entry: two
 * entries that call the same thunk are two answers, never one.
 */
export function collectArms(root) {
  const resolved = new Map();
  const unresolved = [];
  const entries = new Map();
  const stack = [{ node: root, path: [], entry: null }];
  while (stack.length > 0) {
    const { node, path, entry } = stack.shift();
    if (node.cycle) continue;
    const current = node.entry || entry;
    if (current) entries.set(current.id, current);
    const entryId = current ? current.id : null;
    if (node.kind === 'entry' && node.unresolved) {
      unresolved.push({
        reason: 'entry-unresolved',
        cause: (current && current.unresolved) || 'no-target',
        attempted: node.ref,
        caller: null,
        breadcrumb: breadcrumbOf(path, node),
        entry: entryId,
        file: node.file,
        line: node.line,
      });
      continue;
    }
    if (node.kind === 'route') {
      const breadcrumb = breadcrumbOf(path, node);
      const site = { file: node.callerFile ?? node.file, line: node.callerLine ?? node.line };
      if (!node.unresolved && node.templateResolved !== false) {
        const arm = { key: node.ref, via: node.via, breadcrumb, entry: entryId, ...site, route: node.route };
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
        entry: entryId,
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
        entry: entryId,
        file: node.callerFile ?? node.file,
        line: node.callerLine ?? node.line,
        ...(node.continuedBy ? { continuedBy: node.continuedBy, outcome: node.outcome } : {}),
      });
    }
    const nextPath = path.concat([{ kind: node.kind, ref: node.ref, via: node.via }]);
    for (const kid of node.children || []) stack.push({ node: kid, path: nextPath, entry: current });
  }
  return { resolved, unresolved, entries };
}

/**
 * The file name one component page is written under. The declaring file goes into it, and
 * so does a selected entry's own identity — kind, trigger, handler and the site it was
 * written at, line and column — because that is exactly where two selections differ: one
 * name declared in two files, two `useEffect` declarations on one line, or a cleanup
 * returned by the second of them, are different journeys, and a name that dropped either
 * field would let the later selection overwrite the page the earlier one wrote.
 *
 * The identity is spelled out field by field rather than taken from the entry id, whose
 * `component:kind:trigger:handler:@file:site` spelling puts the site behind the path. The
 * file-name rule still caps a key at 120 characters, so a source path deep enough to spend
 * that budget leaves the site to be truncated like any other tail.
 */
function componentSlug(name, file, identity) {
  return [
    'component',
    name,
    file,
    identity ? identity.kind : null,
    identity ? identity.trigger : null,
    identity ? identity.handler : null,
    identity ? identity.line : null,
    identity ? identity.column : null,
  ]
    .filter((part) => part !== undefined && part !== null && part !== '')
    .join('-');
}

const UNRESOLVED_REASON_TEXT = Object.freeze({
  'no-route-match': 'no route in the fact store matches this gateway call’s verb and template',
  'template-not-resolved':
    'the gateway call carries resolved: false — the extractor never pinned this template to a literal, so the route below is what it would land on, not what it is trusted to',
  'no-effect': 'no effect_handler answers this action',
  'walk-limit': "the walk's own depth or node budget was spent before this action could be explored further",
  'entry-unresolved':
    'this trigger was read but not followed — the extractor stated the entry and could not resolve what it runs',
});

/** The one-line cause an entry-carried unresolved arm names, in the reader's words. */
export const ENTRY_CAUSE_TEXT = Object.freeze({
  'custom-hook': 'the component calls a hook this extractor does not read',
  'dynamic-callback': 'the callback is an expression, not a literal this extractor can follow',
  'no-target': 'the entry names a handler that resolves to no single method',
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

  const collected = collectArms(walked.root);
  const allEntries = [...collected.entries.values()].sort((a, b) => compare(a.id, b.id));
  const chosen = options.entry === undefined ? null : selectEntry(allEntries, String(options.entry));
  if (chosen && chosen.error) return { error: chosen.error, candidates: chosen.candidates, component: { name } };
  const keep = chosen ? chosen.identity.id : null;
  const resolvedRoutes = new Map();
  for (const [key, arms] of collected.resolved) {
    const kept = keep === null ? arms : arms.filter((arm) => arm.entry === keep);
    if (kept.length > 0) resolvedRoutes.set(key, kept);
  }
  const unresolved = keep === null ? collected.unresolved : collected.unresolved.filter((arm) => arm.entry === keep);

  const entryViews = (chosen ? [chosen.identity] : allEntries).map((identity) => {
    const keys = new Set();
    for (const [key, arms] of resolvedRoutes) {
      if (arms.some((arm) => arm.entry === identity.id)) keys.add(key);
    }
    return {
      identity,
      routes: [...keys].sort(compare),
      arms: [...resolvedRoutes.values()].reduce(
        (total, arms) => total + arms.filter((arm) => arm.entry === identity.id).length,
        0,
      ),
      unresolved: unresolved.filter((arm) => arm.entry === identity.id).length,
    };
  });
  const orphanRoutes = [...resolvedRoutes.keys()].filter((key) => resolvedRoutes.get(key).some((arm) => arm.entry === null)).sort(compare);
  const orphanArms = [...resolvedRoutes.values()].reduce(
    (total, arms) => total + arms.filter((arm) => arm.entry === null).length,
    0,
  ) + unresolved.filter((arm) => arm.entry === null).length;

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
    slug: routeSlugFor(
      componentSlug(name, chosen ? chosen.identity.file : node.file, chosen ? chosen.identity : null),
    ),
    header: {
      routesResolved: routes.length,
      armsResolved,
      armsUnresolved: unresolvedOrdered.length,
      entries: entryViews.length,
      armsWithoutEntry: orphanArms,
    },
    entries: entryViews,
    selectedEntry: chosen ? chosen.identity : null,
    orphans: { routes: orphanRoutes, arms: orphanArms },
    routes,
    unresolved: unresolvedOrdered,
    limits: {
      budgetHit: Boolean(walked.stats && walked.stats.budgetHit),
      depth: walked.stats ? walked.stats.depth : null,
    },
  };
}

/**
 * The entry `--entry` names. An operator may write the full id, the trigger as written
 * (`componentDidMount`, `useEffect`), a trigger qualified by its line (`useEffect@15`), or
 * the handler name (`handleSave`). Exactly one entry must match; anything else lists every
 * entry this component has, because a selector that half-matches is a question, not a
 * choice.
 */
function selectEntry(entries, selector) {
  const exact = entries.filter((identity) => identity.id === selector);
  if (exact.length === 1) return { identity: exact[0] };
  const loose = entries.filter(
    (identity) =>
      identity.trigger === selector ||
      identity.handler === selector ||
      `${identity.trigger}@${identity.line}` === selector,
  );
  if (loose.length === 1) return { identity: loose[0] };
  const matched = exact.length + loose.length;
  return {
    error:
      matched === 0
        ? `no entry matches "${selector}"`
        : `"${selector}" matches ${matched} entries, not exactly one`,
    candidates: entries.map(
      (identity) =>
        `${identity.id} (${identity.kind} ${identity.trigger}${identity.handler ? ` → ${identity.handler}` : ''})`,
    ),
  };
}
