/**
 * The pages a component is shown on.
 *
 * A component reaches a page in one of three ways: a route names it as its element, a render
 * of it lies inside the element of a route, or a component that reaches a page renders it.
 * `chains` climbs these steps above each request, and `trace` lists the pages of a component
 * start, so both read the same reverse render maps and the same one-level step here.
 */

import { createPageLookup, routeHoldingRender, routesNaming } from './page-routes.js';
import { renderTarget } from './trace.js';

/** A climb past this many components is cut, so a wide render graph never stalls a start. */
const MAX_PAGE_STEPS = 512;

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

/** Empty reverse render maps, filled by `addRender`. */
export function emptyRenderMaps() {
  return { rendersOf: new Map(), ambiguousRenders: new Map(), mobileRenders: new Map() };
}

/**
 * One `renders` fact in the reverse maps: by the declaration it settles on, by each file it
 * could mean when two files declare the name, or by selector in a mobile repository.
 */
export function addRender(maps, index, repo, web, fact) {
  if (!web) {
    pushInto(maps.mobileRenders, `${repo}|${fact.to}`, fact);
    return;
  }
  if (fact.from === fact.to) return;
  const { target, candidates } = renderTarget(index, repo, fact);
  if (target) pushInto(maps.rendersOf, target.fact, fact);
  else if (candidates) {
    for (const file of candidates) pushInto(maps.ambiguousRenders, `${repo}|${file}`, { render: fact, candidates });
  }
}

export function sortRenderMaps(maps) {
  for (const map of [maps.rendersOf, maps.mobileRenders]) {
    for (const list of map.values()) list.sort(bySite);
  }
  for (const list of maps.ambiguousRenders.values()) list.sort((a, b) => bySite(a.render, b.render));
}

/** The reverse render maps of every web and mobile fact set. */
export function buildRenderMaps(index, factSets) {
  const maps = emptyRenderMaps();
  for (const set of factSets || []) {
    const kind = index.repos.get(set.repo);
    if (kind !== 'web' && kind !== 'mobile') continue;
    for (const fact of set.facts || []) {
      if (fact.type === 'renders') addRender(maps, index, set.repo, kind === 'web', fact);
    }
  }
  sortRenderMaps(maps);
  return maps;
}

/** The last non-lazy declaration of a component name, in `file` when one is given. */
export function declarationOf(index, repo, name, file) {
  const found = (index.componentByName.get(`${repo}|${name}`) || []).filter(
    (entry) => entry.fact.lazy === undefined && (!file || entry.fact.file === file),
  );
  return found[found.length - 1] || null;
}

function isElementSite(pageIndex, repo, render) {
  const routes = pageIndex.get(repo);
  return Boolean(routes && routes.routeElementSites.has(`${render.file}|${render.to}|${render.line}`));
}

function rendersName(declaration, render) {
  const exported = render.imported !== undefined && render.imported !== 'default' ? render.imported : render.to;
  return declaration.fact.name === exported || (declaration.fact.exports || []).includes(render.imported ?? render.to);
}

/**
 * Each way one step up from a component goes: a page (`mobile-page`, or `page` with the
 * render a route element holds), a render by a parent component, or the reason it stops
 * (`page-ambiguous`, `component-ambiguous`). No step at all means the component has no page.
 */
export function pageSteps(context, declaration) {
  const { index, maps, pageIndex } = context;
  const repo = declaration.repo;
  const steps = [];
  if (index.repos.get(repo) === 'mobile') {
    if (declaration.fact.role === 'page') steps.push({ kind: 'mobile-page' });
    else if (declaration.fact.selector) {
      for (const render of maps.mobileRenders.get(`${repo}|${declaration.fact.selector}`) || []) {
        const parent = declarationOf(index, repo, render.from, null);
        if (parent) steps.push({ kind: 'render', render, parent });
      }
    }
    return steps;
  }
  for (const route of routesNaming(pageIndex, repo, declaration.fact).sort(bySite)) steps.push({ kind: 'page', route });
  for (const render of maps.rendersOf.get(declaration.fact) || []) {
    if (isElementSite(pageIndex, repo, render)) continue;
    const held = routeHoldingRender(pageIndex, repo, render);
    if (held && held.route) steps.push({ kind: 'page', route: held.route, render });
    else if (held && held.ambiguous) steps.push({ kind: 'page-ambiguous', render, routes: held.ambiguous });
    else {
      const parent = declarationOf(index, repo, render.from, render.file);
      if (parent) steps.push({ kind: 'render', render, parent });
    }
  }
  for (const { render, candidates } of maps.ambiguousRenders.get(`${repo}|${declaration.fact.file}`) || []) {
    if (rendersName(declaration, render)) steps.push({ kind: 'component-ambiguous', render, candidates: candidates.slice() });
  }
  return steps;
}

/** `file:line`, with the column when two routes share a line. */
export function routeSite(route) {
  return `${route.file}:${route.line}${Number.isInteger(route.column) ? `:${route.column}` : ''}`;
}

/**
 * Every page a web component start is shown on, with the composed browser paths of each,
 * and every reason a way up stops before a page. A page reached down two render paths is
 * one page.
 */
export function pagesOf(factSets, start, options = {}) {
  const index = options.index;
  const declaration = declarationOf(index, start.repo, start.ref, start.file);
  if (!declaration || index.repos.get(start.repo) !== 'web') return null;
  const pageIndex = index.pageRoutes;
  const context = { index, maps: options.maps || buildRenderMaps(index, factSets), pageIndex };
  const lookup = createPageLookup(pageIndex, { repos: options.repos });
  const pages = new Map();
  const reasons = new Map();
  let steps = 0;

  const addReason = (reason) => {
    const key = JSON.stringify(reason);
    if (!reasons.has(key)) reasons.set(key, reason);
  };

  const climb = (current, path) => {
    const guard = `${current.repo}|${current.fact.name}|${current.fact.file}`;
    if (path.has(guard) || steps >= MAX_PAGE_STEPS) return;
    steps += 1;
    path.add(guard);
    const found = pageSteps(context, current);
    if (found.length === 0) {
      addReason({ reason: 'no-page', repo: current.repo, file: current.fact.file, line: current.fact.line, ref: current.fact.name });
    }
    for (const step of found) {
      if (step.kind === 'page') {
        const key = `${current.repo}|${routeSite(step.route)}`;
        if (!pages.has(key)) {
          pages.set(key, {
            repo: current.repo,
            file: step.route.file,
            line: step.route.line,
            ...(Number.isInteger(step.route.column) ? { column: step.route.column } : {}),
            path: step.route.path ?? null,
            owner: step.route.owner,
            element: step.route.element ?? null,
            paths: lookup.routePaths(current.repo, step.route),
          });
        }
      } else if (step.kind === 'render') {
        climb(step.parent, path);
      } else if (step.kind === 'page-ambiguous') {
        addReason({
          reason: 'page-ambiguous',
          repo: current.repo,
          file: step.render.file,
          line: step.render.line,
          ref: `${step.render.from} -> ${step.render.to}`,
          candidates: step.routes.map(routeSite),
        });
      } else if (step.kind === 'component-ambiguous') {
        addReason({
          reason: 'component-ambiguous',
          repo: current.repo,
          file: step.render.file,
          line: step.render.line,
          ref: `${step.render.from} -> ${step.render.to}`,
          candidates: step.candidates,
        });
      }
    }
    path.delete(guard);
  };
  climb(declaration, new Set());
  return {
    pages: [...pages.values()].sort(bySite),
    reasons: [...reasons.values()].sort(bySite),
  };
}
