/**
 * Route chains — every fact-backed path from a web or mobile screen down to one backend
 * route. The walk starts at the callers `span` lists for the route and climbs each hop rule
 * the forward component walk follows, turned around: a request to the body that holds it,
 * a body to its callers, its dispatchers and its entries, an entry to its component, and a
 * component to the first page above it. The forward helpers of `lib/trace.js` decide every
 * step, so a chain with no gap is an arm the forward walk from its component also reaches.
 *
 * A break in a chain is a gap hop with one reason from a closed list, never a guess. A body
 * of a component that no event, hook or caller reaches is a gap, and the chain still climbs
 * to its page, because which screen a request sits under is the answer a reader wants even
 * when the trigger is unknown.
 *
 * Depth is spent as the forward walk spends it: an entry, a call, a dispatch, a bound prop
 * and an effect each cost one, and renders, pages and self calls cost none. A chain that the
 * forward walk could not reach within `--depth N` from its component ends in `walk-limit`
 * here too, so the two walks agree at every depth, not only at the default.
 */

import { createHash } from 'node:crypto';

import { factSetIdentity, factState } from './facts.js';
import { normalizeAliases } from './join.js';
import { createPageLookup, routeHoldingRender, routesNaming } from './page-routes.js';
import { buildStatus, frontierLines, raisedByOf, statusLines } from './result-status.js';
import { callersOf } from './span.js';
import { mobileDeclarationIndex, resolveMobileOwner } from './mobile-declarations.js';
import {
  DEFAULT_DEPTH,
  DEFAULT_MAX_NODES,
  GRAPH_FANOUT,
  INTERFACE_FANOUT_CAP,
  MAX_SEEDS,
  MOBILE_LIFECYCLE_KINDS,
  buildTraceIndex,
  entryIdentity,
  entryRef,
  eventEntry,
  factSite,
  innermostSpan,
  namedSpans,
  ownPropTarget,
  ownSpan,
  renderTarget,
  resolveStart,
} from './trace.js';

export const CHAINS_SCHEMA_VERSION = 1;

export const HOP_KINDS = Object.freeze(['page', 'render', 'entry', 'call', 'dispatch', 'bind', 'effect', 'request', 'gap']);

export const GAP_REASONS = Object.freeze([
  'template-not-resolved',
  'entry-unresolved',
  'no-entry',
  'no-caller',
  'component-ambiguous',
  'page-ambiguous',
  'no-page',
  'walk-limit',
]);

/** The roles whose body is a screen's own code, so a body of one with no entry still has a page. */
const COMPONENT_ROLES = new Set(['page', 'container', 'component']);

function compare(a, b) {
  const left = a ?? '';
  const right = b ?? '';
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function bySite(a, b) {
  return compare(a.file, b.file) || (a.line || 0) - (b.line || 0) || (a.column || 0) - (b.column || 0);
}

function pushInto(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function site(fact) {
  return `${fact.file}:${fact.line}`;
}

/**
 * Every reverse edge the climb reads, built once from the same helpers the forward rules
 * call, so one forward edge gives exactly one reverse edge.
 */
function mobileOwnerSite(fact) {
  return { file: fact.file, ...(fact.componentFile !== undefined ? { componentFile: fact.componentFile } : {}) };
}

/**
 * The declaration a mobile template fact proves, `{ candidates }` when declarations of the
 * name exist but the facts prove none of them, or `{}` when no declaration has the name.
 */
function mobileOwner(declarations, repo, name, fact) {
  const owner = resolveMobileOwner(declarations, repo, name, mobileOwnerSite(fact));
  if (owner.target) return { target: owner.target };
  const files = [...new Set((declarations.byName.get(`${repo}|${name}`) || []).map((declaration) => declaration.file))].sort();
  if (files.length === 0) return {};
  return { candidates: owner.candidates && owner.candidates.length > 0 ? owner.candidates.slice() : files };
}

function buildReverse(index, factSets) {
  const reverse = {
    callers: new Map(),
    effects: new Map(),
    dispatches: new Map(),
    binds: new Map(),
    propEntries: new Map(),
    propCalls: new Map(),
    entries: new Map(),
    ambiguousEntries: new Map(),
    rendersOf: new Map(),
    ambiguousRenders: new Map(),
    mobileRenders: new Map(),
    gateways: new Map(),
  };
  const declarations = index.mobileDeclarations || mobileDeclarationIndex(factSets);
  const bound = new Set();
  for (const set of factSets) {
    const repo = set.repo;
    const kind = index.repos.get(repo);
    if (kind !== 'web' && kind !== 'mobile') continue;
    const web = kind === 'web';
    for (const fact of set.facts || []) {
      switch (fact.type) {
        case 'method_call':
          if (fact.field === 'this') {
            if (fact.calledMethod !== fact.method) {
              pushInto(reverse.callers, `${repo}|${fact.class}|${fact.calledMethod}`, { fact, cost: 0, file: web ? fact.file : null });
            }
          } else if (!web) {
            // A static call names a class, not an injected field. The climb from a helper
            // body to the class that calls it is not one of the forward rules it turns around.
            if (fact.static === true) break;
            pushInto(reverse.callers, `${repo}|${fact.field}|${fact.calledMethod}`, { fact, cost: 1, file: null });
          } else if (fact.field === 'props') {
            pushInto(reverse.propCalls, `${repo}|${fact.class}|${fact.calledMethod}`, fact);
          } else {
            const spans = namedSpans(index, repo, fact.calledMethod, fact.class, fact.file);
            if (spans.length === 1) {
              pushInto(reverse.callers, `${repo}|${spans[0].class}|${spans[0].method}`, { fact, cost: 1, file: spans[0].file });
            }
          }
          break;
        case 'gateway_call':
          pushInto(reverse.gateways, `${repo}|${fact.file}|${fact.line}`, fact);
          break;
        case 'action_dispatch':
          pushInto(reverse.dispatches, `${repo}|${fact.action}`, fact);
          break;
        case 'effect_handler':
          pushInto(reverse.effects, `${repo}|${fact.class}|${fact.field}`, fact);
          break;
        case 'props_bind':
          if (web) pushInto(reverse.binds, `${repo}|${fact.target}`, fact);
          break;
        case 'template_handler': {
          if (web ? fact.kind === 'assign' : fact.kind !== 'call') break;
          const binding = `${repo}|${fact.component}|${fact.event}|${fact.handler}|${fact.file}:${factSite(fact)}`;
          if (bound.has(binding)) break;
          bound.add(binding);
          const entry = {
            repo,
            fact,
            factType: 'template_handler',
            identity: eventEntry(fact.component, fact),
            component: fact.component,
            componentFile: web ? fact.file : null,
          };
          if (!web) {
            // The owner is the declaration the template facts prove, never the last
            // same-named declaration in the fact list.
            const owner = mobileOwner(declarations, repo, fact.component, fact);
            const proven = owner.target
              ? { componentFile: owner.target.file }
              : owner.candidates
                ? { ownerCandidates: owner.candidates }
                : {};
            pushInto(reverse.entries, `${repo}|${fact.component}|${fact.handler}`, { ...entry, ...proven, cost: 1, file: null });
            break;
          }
          const span = ownSpan(index, repo, fact.component, fact.handler, fact.file);
          const prop = ownPropTarget(index, repo, fact.component, fact.handler, fact.file);
          if (fact.kind === 'prop' || (!span && prop)) {
            if (prop) pushInto(reverse.propEntries, prop.fact, { ...entry, cost: 0 });
          } else if (span) {
            pushInto(reverse.entries, `${repo}|${fact.component}|${fact.handler}`, { ...entry, cost: 1, file: span.file });
          }
          break;
        }
        case 'component_entry': {
          if (!web || fact.unresolved !== undefined) break;
          const entry = {
            repo,
            fact,
            factType: 'component_entry',
            identity: entryIdentity(fact),
            component: fact.component,
            componentFile: fact.file,
            cost: 1,
          };
          if (fact.method) {
            pushInto(reverse.entries, `${repo}|${fact.component}|${fact.method}`, { ...entry, file: fact.file });
            break;
          }
          const spans = fact.handler ? namedSpans(index, repo, fact.handler, fact.component, fact.file) : [];
          if (spans.length === 1) {
            pushInto(reverse.entries, `${repo}|${spans[0].class}|${spans[0].method}`, { ...entry, file: spans[0].file });
          } else {
            const candidates = spans.map(site).sort();
            for (const span of spans) {
              pushInto(reverse.ambiguousEntries, `${repo}|${span.class}|${span.method}`, { ...entry, file: span.file, candidates });
            }
          }
          break;
        }
        case 'method_span': {
          if (web || !MOBILE_LIFECYCLE_KINDS.has(fact.method)) break;
          const declared = (index.componentByName.get(`${repo}|${fact.class}`) || []).some((found) => found.fact.file === fact.file);
          if (!declared) break;
          const hook = { component: fact.class, kind: MOBILE_LIFECYCLE_KINDS.get(fact.method), trigger: fact.method, file: fact.file, line: fact.line };
          pushInto(reverse.entries, `${repo}|${fact.class}|${fact.method}`, {
            repo,
            fact,
            factType: 'method_span',
            identity: entryIdentity(hook),
            component: fact.class,
            componentFile: fact.file,
            cost: 1,
            file: null,
          });
          break;
        }
        case 'renders':
          if (!web) {
            pushInto(reverse.mobileRenders, `${repo}|${fact.to}`, fact);
            break;
          }
          if (fact.from === fact.to) break;
          {
            const { target, candidates } = renderTarget(index, repo, fact);
            if (target) pushInto(reverse.rendersOf, target.fact, fact);
            else if (candidates) {
              for (const file of candidates) pushInto(reverse.ambiguousRenders, `${repo}|${file}`, { render: fact, candidates });
            }
          }
          break;
        default:
          break;
      }
    }
  }
  for (const map of [reverse.dispatches, reverse.effects, reverse.binds, reverse.propCalls, reverse.rendersOf, reverse.mobileRenders]) {
    for (const list of map.values()) list.sort(bySite);
  }
  for (const map of [reverse.callers, reverse.entries, reverse.ambiguousEntries, reverse.propEntries]) {
    for (const list of map.values()) list.sort((a, b) => bySite(a.fact, b.fact));
  }
  for (const list of reverse.ambiguousRenders.values()) list.sort((a, b) => bySite(a.render, b.render));
  return reverse;
}

/**
 * The model of one route's chains, or `{ error, reason }` / `{ candidates, reason }` when the
 * key does not resolve to exactly one route.
 */
export function routeChains(factSets, start, options = {}) {
  const sets = factSets || [];
  const index = options.index || buildTraceIndex(sets);
  const resolved = resolveStart(sets, start, { index, strictComponentNames: true });
  if (resolved.candidates) return { candidates: resolved.candidates, reason: 'ambiguous' };
  if (resolved.error) {
    return { error: resolved.error, reason: resolved.reason || 'no-declaration', ...(resolved.frontier ? { frontier: resolved.frontier } : {}) };
  }
  const node = resolved.node;
  if (node.kind !== 'route') {
    return { error: `"${start}" resolves to a ${node.kind} (${node.ref}), not a route`, reason: 'not-a-route' };
  }

  const depth = Number.isInteger(options.depth) ? options.depth : DEFAULT_DEPTH;
  const maxNodes = Number.isInteger(options.maxNodes) ? options.maxNodes : DEFAULT_MAX_NODES;
  const aliases = options.aliases || [];
  const reverse = buildReverse(index, sets);
  const declarations = index.mobileDeclarations || mobileDeclarationIndex(sets);
  const pageIndex = index.pageRoutes;
  const lookup = createPageLookup(pageIndex, { repos: options.repos });
  const raw = [];
  let spent = 0;

  const callers = callersOf(sets, node.ref, aliases).filter((caller) => {
    const kind = index.repos.get(caller.repo);
    return kind === 'web' || kind === 'mobile';
  });

  function charge(count) {
    if (spent + count > maxNodes) return false;
    spent += count;
    return true;
  }

  function emit(hops) {
    raw.push(hops);
  }

  function gap(reason, repo, at, ref, extra = {}) {
    return { kind: 'gap', fact: null, repo, file: at.file, line: at.line, ref, reason, ...extra };
  }

  function limitGap(cause, at) {
    return gap('walk-limit', at.repo, at, at.ref, { cause });
  }

  /**
   * One climb step: the hops it adds above the chain so far and the depth they cost. A step
   * the depth or the node budget cannot pay for ends the chain at a `walk-limit` gap.
   */
  function step(hops, cost, acc, below, next) {
    if (acc + cost >= depth) {
      emit([limitGap('depth', hops[0]), ...below]);
      return;
    }
    if (!charge(hops.length)) {
      emit([limitGap('node-budget', hops[0]), ...below]);
      return;
    }
    next([...hops, ...below], acc + cost);
  }

  /** A render or a page: free of depth, never of the node budget. */
  function freeStep(hops, below, next) {
    if (!charge(hops.length)) {
      emit([limitGap('node-budget', hops[0]), ...below]);
      return;
    }
    next([...hops, ...below]);
  }

  const sameFile = (repo, owner, recorded, file) =>
    !recorded || !file || !index.sharedComponents.has(`${repo}|${owner}`) || recorded === file;

  function requestHop(repo, fact) {
    return {
      kind: 'request',
      fact: 'gateway_call',
      repo,
      file: fact.file,
      line: fact.line,
      ref: `${fact.verb} ${fact.template}`,
      verb: fact.verb,
      template: fact.template,
      resolved: fact.resolved === true,
    };
  }

  function callHop(repo, fact) {
    return {
      kind: 'call',
      fact: 'method_call',
      repo,
      file: fact.file,
      line: fact.line,
      ref: `${fact.class}.${fact.method} -> ${fact.calledMethod}`,
      class: fact.class,
      method: fact.method,
      calledMethod: fact.calledMethod,
    };
  }

  function dispatchHop(repo, fact) {
    return {
      kind: 'dispatch',
      fact: 'action_dispatch',
      repo,
      file: fact.file,
      line: fact.line,
      ref: `${fact.class}.${fact.method} -> ${fact.action}`,
      class: fact.class,
      method: fact.method,
      action: fact.action,
    };
  }

  function bindHop(repo, fact) {
    return {
      kind: 'bind',
      fact: 'props_bind',
      repo,
      file: fact.file,
      line: fact.line,
      ref: `${fact.component}.props.${fact.prop} -> ${fact.target}`,
      component: fact.component,
      prop: fact.prop,
      target: fact.target,
    };
  }

  function effectHop(repo, fact) {
    return {
      kind: 'effect',
      fact: 'effect_handler',
      repo,
      file: fact.file,
      line: fact.line,
      ref: `${fact.class}.${fact.field}`,
      class: fact.class,
      field: fact.field,
      actions: (fact.actions || []).slice(),
    };
  }

  function entryHop(entry) {
    const identity = entry.identity;
    return {
      kind: 'entry',
      fact: entry.factType,
      repo: entry.repo,
      file: entry.fact.file,
      line: entry.fact.line,
      ref: entryRef({ component: identity.component, trigger: identity.trigger, line: identity.line, column: identity.column }),
      id: identity.id,
      component: identity.component,
      entryKind: identity.kind,
      trigger: identity.trigger,
      handler: identity.handler,
    };
  }

  function renderHop(repo, fact) {
    return {
      kind: 'render',
      fact: 'renders',
      repo,
      file: fact.file,
      line: fact.line,
      ref: `${fact.from} -> ${fact.to}`,
      from: fact.from,
      to: fact.to,
    };
  }

  function webPageHop(repo, route) {
    return {
      kind: 'page',
      fact: 'page_route',
      repo,
      file: route.file,
      line: route.line,
      ref: route.path ?? '',
      path: route.path ?? null,
      paths: lookup.routePaths(repo, route),
      owner: route.owner,
      element: route.element ?? null,
    };
  }

  function mobilePageHop(declaration) {
    return {
      kind: 'page',
      fact: 'component',
      repo: declaration.repo,
      file: declaration.fact.file,
      line: declaration.fact.line,
      ref: declaration.fact.name,
      component: declaration.fact.name,
    };
  }

  /** The site a body is written at: its own span, else the fact the climb reached it by. */
  function bodySite(body) {
    const span = ownSpan(index, body.repo, body.class, body.method, body.file);
    return span ? { file: span.file, line: span.line } : body.site;
  }

  /** The component a body is the screen code of, declared in the body's own file. */
  function holderOf(body) {
    const file = body.file || bodySite(body).file;
    const found = (index.componentByName.get(`${body.repo}|${body.class}`) || []).filter(
      (entry) => entry.fact.file === file && entry.fact.lazy === undefined,
    );
    const holder = found[found.length - 1];
    return holder && COMPONENT_ROLES.has(holder.fact.role) ? holder : null;
  }

  function declarationOf(repo, name, file) {
    const found = (index.componentByName.get(`${repo}|${name}`) || []).filter(
      (entry) => entry.fact.lazy === undefined && (!file || entry.fact.file === file),
    );
    return found[found.length - 1] || null;
  }

  function climbRequest(caller) {
    const fact = (reverse.gateways.get(`${caller.repo}|${caller.file}|${caller.line}`) || []).find(
      (found) => found.template === caller.template && (found.method || null) === caller.method,
    );
    const request = requestHop(caller.repo, fact);
    if (!charge(1)) {
      emit([limitGap('node-budget', request), request]);
      return;
    }
    const below = fact.resolved === true ? [request] : [gap('template-not-resolved', caller.repo, fact, request.ref), request];
    let body = null;
    if (index.repos.get(caller.repo) === 'web') {
      const span = innermostSpan(index, caller.repo, fact.file, fact.line);
      if (span) body = { repo: caller.repo, class: span.class, method: span.method, file: span.file, site: { file: span.file, line: span.line } };
    } else {
      body = { repo: caller.repo, class: fact.service, method: fact.method, file: null, site: { file: fact.file, line: fact.line } };
    }
    if (!body) {
      emit([gap('no-caller', caller.repo, fact, request.ref), ...below]);
      return;
    }
    climbBody(body, below, 0, new Set());
  }

  function climbBody(body, below, acc, path) {
    const guard = `body|${body.repo}|${body.class}|${body.method}|${body.file ?? ''}`;
    if (path.has(guard)) return;
    path.add(guard);
    const repo = body.repo;
    const key = `${repo}|${body.class}|${body.method}`;
    const mine = (records) => records.filter((record) => sameFile(repo, body.class, record.file, body.file));
    let branches = 0;

    for (const record of mine(reverse.callers.get(key) || [])) {
      branches += 1;
      const call = record.fact;
      const caller = { repo, class: call.class, method: call.method, file: index.repos.get(repo) === 'web' ? call.file : null, site: call };
      step([callHop(repo, call)], record.cost, acc, below, (hops, next) => climbBody(caller, hops, next, path));
    }

    const effects = (reverse.effects.get(key) || []).filter((fact) => sameFile(repo, body.class, fact.file, body.file));
    for (const effect of effects) {
      const effectAt = effectHop(repo, effect);
      for (const action of [...new Set(effect.actions || [])].sort()) {
        for (const dispatch of reverse.dispatches.get(`${repo}|${action}`) || []) {
          branches += 1;
          const bind = (reverse.binds.get(`${repo}|${action}`) || []).find(
            (fact) => fact.component === dispatch.class && fact.file === dispatch.file,
          );
          const hops = [dispatchHop(repo, dispatch), ...(bind ? [bindHop(repo, bind)] : []), effectAt];
          const caller = { repo, class: dispatch.class, method: dispatch.method, file: index.repos.get(repo) === 'web' ? dispatch.file : null, site: dispatch };
          step(hops, 2, acc, below, (next, cost) => climbBody(caller, next, cost, path));
        }
        for (const bind of reverse.binds.get(`${repo}|${action}`) || []) {
          for (const entry of reverse.propEntries.get(bind) || []) {
            branches += 1;
            step([entryHop(entry), bindHop(repo, bind), effectAt], 2, acc, below, (next) => climbEntry(entry, next, path));
          }
          const calls = (reverse.propCalls.get(`${repo}|${bind.component}|${bind.prop}`) || []).filter(
            (call) => ownPropTarget(index, repo, call.class, call.calledMethod, call.file)?.fact === bind,
          );
          for (const call of calls) {
            branches += 1;
            const caller = { repo, class: call.class, method: call.method, file: call.file, site: call };
            step([callHop(repo, call), bindHop(repo, bind), effectAt], 2, acc, below, (next, cost) => climbBody(caller, next, cost, path));
          }
        }
      }
    }

    for (const entry of mine(reverse.entries.get(key) || [])) {
      branches += 1;
      step([entryHop(entry)], entry.cost, acc, below, (next) => climbEntry(entry, next, path));
    }

    for (const entry of mine(reverse.ambiguousEntries.get(key) || [])) {
      branches += 1;
      const unresolved = gap('entry-unresolved', repo, entry.fact, entryHop(entry).ref, { cause: 'no-target', candidates: entry.candidates });
      step([unresolved], entry.cost, acc, below, (next) => climbEntry(entry, next, path));
    }

    if (branches === 0) {
      const at = bodySite(body);
      const holder = holderOf(body);
      if (holder) {
        climbComponent(holder, [gap('no-entry', repo, at, `${body.class}.${body.method}`, { component: holder.fact.name }), ...below], path);
      } else {
        emit([gap('no-caller', repo, at, `${body.class}.${body.method}`), ...below]);
      }
    }
    path.delete(guard);
  }

  function climbEntry(entry, below, path) {
    if (entry.ownerCandidates) {
      emit([gap('component-ambiguous', entry.repo, entry.fact, entry.component, { candidates: entry.ownerCandidates.slice() }), ...below]);
      return;
    }
    const mobile = index.repos.get(entry.repo) === 'mobile';
    const declaration =
      declarationOf(entry.repo, entry.component, entry.componentFile) ||
      (mobile ? null : declarationOf(entry.repo, entry.component, null));
    if (!declaration) {
      emit([gap('no-page', entry.repo, entry.fact, entry.component, { component: entry.component }), ...below]);
      return;
    }
    climbComponent(declaration, below, path);
  }

  function isElementSite(repo, render) {
    const routes = pageIndex.get(repo);
    return Boolean(routes && routes.routeElementSites.has(`${render.file}|${render.to}|${render.line}`));
  }

  function rendersName(declaration, render) {
    const exported = render.imported !== undefined && render.imported !== 'default' ? render.imported : render.to;
    return declaration.fact.name === exported || (declaration.fact.exports || []).includes(render.imported ?? render.to);
  }

  function climbComponent(declaration, below, path) {
    const guard = `component|${declaration.repo}|${declaration.fact.name}|${declaration.fact.file}`;
    if (path.has(guard)) return;
    path.add(guard);
    const repo = declaration.repo;
    let branches = 0;
    if (index.repos.get(repo) === 'mobile') {
      if (declaration.fact.role === 'page') {
        branches += 1;
        freeStep([mobilePageHop(declaration)], below, emit);
      } else if (declaration.fact.selector) {
        for (const render of reverse.mobileRenders.get(`${repo}|${declaration.fact.selector}`) || []) {
          const owner = mobileOwner(declarations, repo, render.from, render);
          if (owner.candidates) {
            branches += 1;
            emit([gap('component-ambiguous', repo, render, `${render.from} -> ${render.to}`, { candidates: owner.candidates }), ...below]);
            continue;
          }
          if (!owner.target) continue;
          const parent = declarationOf(repo, render.from, owner.target.file);
          if (!parent) continue;
          branches += 1;
          freeStep([renderHop(repo, render)], below, (next) => climbComponent(parent, next, path));
        }
      }
    } else {
      const routes = routesNaming(pageIndex, repo, declaration.fact).sort(bySite);
      for (const route of routes) {
        branches += 1;
        freeStep([webPageHop(repo, route)], below, emit);
      }
      for (const render of reverse.rendersOf.get(declaration.fact) || []) {
        if (isElementSite(repo, render)) continue;
        const held = routeHoldingRender(pageIndex, repo, render);
        if (held && held.route) {
          branches += 1;
          freeStep([webPageHop(repo, held.route), renderHop(repo, render)], below, emit);
        } else if (held && held.ambiguous) {
          branches += 1;
          const candidates = held.ambiguous.map((route) => `${site(route)}${Number.isInteger(route.column) ? `:${route.column}` : ''}`);
          emit([gap('page-ambiguous', repo, render, `${render.from} -> ${render.to}`, { candidates }), ...below]);
        } else {
          const parent = declarationOf(repo, render.from, render.file);
          if (!parent) continue;
          branches += 1;
          freeStep([renderHop(repo, render)], below, (next) => climbComponent(parent, next, path));
        }
      }
      for (const { render, candidates } of reverse.ambiguousRenders.get(`${repo}|${declaration.fact.file}`) || []) {
        if (!rendersName(declaration, render)) continue;
        branches += 1;
        emit([gap('component-ambiguous', repo, render, `${render.from} -> ${render.to}`, { candidates: candidates.slice() }), ...below]);
      }
    }
    if (branches === 0) {
      emit([gap('no-page', repo, declaration.fact, declaration.fact.name, { component: declaration.fact.name }), ...below]);
    }
    path.delete(guard);
  }

  for (const caller of callers) climbRequest(caller);

  const chains = collapse(raw);
  const route = node.route || {};
  const scope = {
    start: { repo: node.repo, kind: 'route', ref: node.ref, file: node.file ?? null, line: node.line ?? null },
    mode: 'to-pages',
    fromHandler: null,
    unscoped: false,
    graph: false,
    seeds: false,
    entries: true,
  };
  const limits = { depth, maxNodes, seedCap: MAX_SEEDS, interfaceFanOut: INTERFACE_FANOUT_CAP, graphFanOut: GRAPH_FANOUT };
  const identity = `sha256:${createHash('sha256')
    .update(
      JSON.stringify([
        sets.map((set) => factSetIdentity(set)),
        scope.start,
        scope,
        limits,
        {
          aliases: normalizeAliases(aliases),
          repos: (options.repos || []).map((repo) => ({ id: repo.id, kind: repo.kind, role: repo.role || [] })),
        },
      ]),
    )
    .digest('hex')}`;
  const freshness = options.freshness || factState(sets, options.repos || []);

  return {
    schemaVersion: CHAINS_SCHEMA_VERSION,
    route: {
      key: node.ref,
      verb: route.verb ?? null,
      path: route.template ?? null,
      controller: route.controller ?? null,
      action: route.action ?? null,
      repo: node.repo,
      file: node.file ?? null,
      line: node.line ?? null,
    },
    status: chainStatus(chains, { freshness, scope, limits, identity }),
    counts: chainCounts(chains, callers.length),
    chains,
  };
}

function isPage(hop) {
  return hop.kind === 'page';
}

/**
 * Chains that share their repository, their top hop and every hop below the renders are one
 * chain. The kept one has the fewest renders, then the render sites that sort first from the
 * top, and `variants` counts the render paths it stands for.
 */
function collapse(raw) {
  const unique = new Map();
  for (const hops of raw) unique.set(JSON.stringify(hops), hops);
  const groups = new Map();
  for (const hops of unique.values()) {
    let below = 1;
    while (below < hops.length && hops[below].kind === 'render') below += 1;
    const repo = hops[hops.length - 1].repo;
    const key = JSON.stringify([repo, hops[0], hops.slice(below)]);
    const group = groups.get(key) || [];
    group.push({ hops, renders: hops.slice(1, below) });
    groups.set(key, group);
  }
  const chains = [];
  for (const group of groups.values()) {
    group.sort((a, b) => a.renders.length - b.renders.length || compareRenders(a.renders, b.renders));
    chains.push(chainOf(group[0].hops, group.length));
  }
  chains.sort(
    (a, b) =>
      compare(a.repo, b.repo) ||
      compare(a.hops[0].file, b.hops[0].file) ||
      a.hops[0].line - b.hops[0].line ||
      compare(a.entry ? a.entry.id : '', b.entry ? b.entry.id : '') ||
      compare(a.request.file, b.request.file) ||
      a.request.line - b.request.line ||
      compare(JSON.stringify(a.hops), JSON.stringify(b.hops)),
  );
  return chains;
}

function compareRenders(a, b) {
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const order = compare(a[index].file, b[index].file) || a[index].line - b[index].line;
    if (order !== 0) return order;
  }
  return a.length - b.length;
}

function chainOf(hops, variants) {
  const gaps = hops.filter((hop) => hop.kind === 'gap').map((hop) => hop.reason);
  const entry = hops.find((hop) => hop.kind === 'entry');
  const request = hops[hops.length - 1];
  return {
    repo: request.repo,
    complete: gaps.length === 0,
    variants,
    gaps,
    page: isPage(hops[0]) ? hops[0] : null,
    entry: entry
      ? {
          id: entry.id,
          component: entry.component,
          kind: entry.entryKind,
          trigger: entry.trigger,
          handler: entry.handler,
          file: entry.file,
          line: entry.line,
        }
      : null,
    request: { file: request.file, line: request.line },
    hops,
  };
}

function chainCounts(chains, callers) {
  const gaps = {};
  for (const reason of GAP_REASONS) gaps[reason] = 0;
  for (const chain of chains) {
    for (const reason of chain.gaps) gaps[reason] += 1;
  }
  const complete = chains.filter((chain) => chain.complete).length;
  return { callers, chains: chains.length, complete, withGap: chains.length - complete, gaps };
}

/**
 * The walk's status in the shape every walk states. Only a limit makes it short of
 * complete: every other gap is a break the facts themselves hold, and the chain names it.
 */
function chainStatus(chains, { freshness, scope, limits, identity }) {
  const frontier = [];
  const stops = {};
  const evidence = { 'source-supported': 0, inferred: 0 };
  for (const chain of chains) {
    chain.hops.forEach((hop, position) => {
      if (hop.kind !== 'gap') {
        const guessed =
          hop.kind === 'page' &&
          Array.isArray(hop.paths) &&
          hop.paths.length > 0 &&
          hop.paths.every((entry) => entry.host === 'assumed' || entry.host === 'inferred');
        evidence[guessed ? 'inferred' : 'source-supported'] += 1;
        return;
      }
      if (hop.reason !== 'walk-limit') return;
      const caller = chain.hops[position + 1];
      frontier.push({
        reason: hop.cause,
        repo: hop.repo,
        target: hop.ref,
        caller: caller ? { ref: caller.ref, file: caller.file ?? null, line: caller.line ?? null } : null,
        callSite: { file: hop.file ?? null, line: hop.line ?? null },
        via: null,
        remaining: null,
        raisedBy: raisedByOf(hop.cause),
      });
      stops[hop.cause] = (stops[hop.cause] || 0) + 1;
    });
  }
  return buildStatus({
    freshness: { value: freshness.value, sets: freshness.sets },
    evidence,
    scope,
    limits,
    schedule: { order: 'depth-first' },
    stops,
    frontier,
    identity,
  });
}

function hopLine(hop) {
  const parts = [hop.kind.padEnd(8), (hop.kind === 'gap' ? hop.reason : hop.fact).padEnd(21), hop.repo, `${hop.file}:${hop.line}`, hop.ref];
  if (hop.cause) parts.push(`cause ${hop.cause}`);
  if (hop.component && hop.kind === 'gap') parts.push(`component ${hop.component}`);
  if (hop.candidates) parts.push(`candidates ${hop.candidates.join(', ')}`);
  if (hop.paths && hop.paths.length > 0) parts.push(`paths ${hop.paths.map((entry) => `${entry.path} (${entry.host})`).join(', ')}`);
  return `  ${parts.join('  ')}`;
}

/** The terminal form: one summary line, the status header, then one block per chain. */
export function renderChains(model) {
  const { counts } = model;
  const lines = [
    `chains ${model.route.key}: ${plural(counts.chains, 'chain')}, ${counts.complete} without a gap, from ${plural(counts.callers, 'caller')}`,
    ...statusLines(model.status),
  ];
  if (model.status.traversal !== 'complete') lines.push(...frontierLines(model.status));
  model.chains.forEach((chain, position) => {
    const top = chain.hops[0];
    const label = top.kind === 'gap' ? `gap ${top.reason}` : `${top.kind} ${top.ref}`;
    lines.push('');
    lines.push(
      `chain ${position + 1} of ${model.chains.length}: ${chain.repo} ${label} ${top.file}:${top.line}` +
        (chain.variants > 1 ? `, ${chain.variants} render variants` : ''),
    );
    for (const hop of chain.hops) lines.push(hopLine(hop));
  });
  return lines.join('\n');
}
