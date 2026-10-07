/**
 * Browser-path lookup over `page_route` and `page_mount` facts.
 *
 * A nested URL is answered by composing, at query time, every chain of route declarations the
 * web facts state: a `<Route>` under its JSX parent, a component's own `<Routes>` under the
 * route that renders it, that route under whatever mounts its owner. Each segment of a chain
 * keeps the site it was read from. Where source does not say how a routed tree is mounted, the
 * configuration may (`repos[].mounts`); failing that, the tree is read from `/` and, when the
 * extractor inferred a prefix from `navigate()` literals, behind that prefix too — both
 * labelled as the guesses they are, never as a declaration.
 *
 * A URL either resolves to one page entry, or fails with one of four reasons: no matching
 * declaration, missing mount information, an unsupported expression on the way, or ambiguous
 * candidates. Conditions a route sits under are carried, not evaluated: two routes in the two
 * arms of one condition stay alternatives unless the configuration supplies the condition's
 * value (`repos[].routeAssumptions`), and every value used is reported with the answer.
 */

const MAX_CONTEXTS = 64;
const MAX_REDIRECTS = 3;
const SCORE = { static: 10, dynamic: 3, splat: -2, index: 2 };

function segmentsOf(path) {
  return String(path || '')
    .split('/')
    .filter((part) => part !== '');
}

function joinPath(segments) {
  return `/${segments.join('/')}`;
}

/** A start as compared: leading slash, no trailing `/*` and no trailing slash. */
export function normaliseUrl(value) {
  const trimmed = String(value || '').trim().replace(/[?#].*$/, '');
  if (!trimmed.startsWith('/')) return null;
  const stripped = trimmed.replace(/\/\*+$/, '').replace(/\/+$/, '');
  return stripped === '' ? '/' : stripped;
}

function routeKey(fact) {
  return `${fact.file}:${fact.line}:${fact.column ?? 0}`;
}

function siteOf(fact) {
  return `${fact.file}:${fact.line}`;
}

/** Everything the lookup reads, per web repository that states `page_route` facts. */
export function buildPageRouteIndex(factSets) {
  const repos = new Map();
  for (const set of factSets) {
    if (set.kind !== 'web') continue;
    const facts = set.facts || [];
    if (!facts.some((fact) => fact.type === 'page_route')) continue;
    const repo = {
      id: set.repo,
      routes: [],
      routesByKey: new Map(),
      routesByOwner: new Map(),
      mounts: [],
      inferred: null,
      components: [],
      componentsByName: new Map(),
      componentsByFile: new Map(),
      rendersTo: new Map(),
      routeElementSites: new Set(),
    };
    for (const fact of facts) {
      if (fact.type === 'page_route') {
        repo.routes.push(fact);
        const key = routeKey(fact);
        if (!repo.routesByKey.has(key)) repo.routesByKey.set(key, []);
        repo.routesByKey.get(key).push(fact);
        const ownerKey = `${fact.file}|${fact.owner}`;
        if (!repo.routesByOwner.has(ownerKey)) repo.routesByOwner.set(ownerKey, []);
        repo.routesByOwner.get(ownerKey).push(fact);
        if (fact.element) repo.routeElementSites.add(`${fact.file}|${fact.element}|${fact.elementLine}`);
      } else if (fact.type === 'page_mount') {
        if (fact.source === 'inferred') repo.inferred = fact;
        else repo.mounts.push(fact);
      } else if (fact.type === 'component') {
        repo.components.push(fact);
        if (!repo.componentsByName.has(fact.name)) repo.componentsByName.set(fact.name, []);
        repo.componentsByName.get(fact.name).push(fact);
        if (!repo.componentsByFile.has(fact.file)) repo.componentsByFile.set(fact.file, []);
        repo.componentsByFile.get(fact.file).push(fact);
      } else if (fact.type === 'renders') {
        if (!repo.rendersTo.has(fact.to)) repo.rendersTo.set(fact.to, []);
        repo.rendersTo.get(fact.to).push(fact);
      }
    }
    repos.set(set.repo, repo);
  }
  return repos;
}

/** The component a lazy binding stands for, when its import resolved to a declared one. */
export function lazyTarget(components, binding) {
  if (!binding || !binding.lazy || !binding.lazyFile || !binding.lazyName) return null;
  return components.find((fact) => fact.file === binding.lazyFile && fact.name === binding.lazyName && !fact.lazy) || null;
}

/**
 * The declaration a route element or an owner names: by the file and name the extractor
 * resolved when it could, else by a name only one non-lazy declaration carries.
 */
function resolveComponent(repo, name, file, declaredName) {
  if (file) {
    const inFile = (repo.componentsByFile.get(file) || []).filter((fact) => !fact.lazy);
    if (declaredName) {
      const named = inFile.find((fact) => fact.name === declaredName);
      if (named) return { component: named };
    } else if (inFile.length === 1) {
      return { component: inFile[0] };
    }
  }
  const byName = (repo.componentsByName.get(declaredName || name) || []).filter((fact) => !fact.lazy);
  if (byName.length === 1) return { component: byName[0] };
  if (byName.length > 1) return { ambiguous: byName };
  return null;
}

const elementMemo = new WeakMap();

function elementOf(repo, route) {
  if (!route.element) return null;
  if (!elementMemo.has(route)) elementMemo.set(route, resolveComponent(repo, route.element, route.elementFile, route.elementName));
  return elementMemo.get(route);
}

function ownsRoutes(repo, component) {
  return repo.routesByOwner.has(`${component.file}|${component.name}`);
}

/** The supported routes that name each component as their element, built once per repository. */
function routesRendering(repo, component) {
  if (!repo.rendering) {
    repo.rendering = new Map();
    for (const route of repo.routes) {
      if (!route.element || route.unsupported || route.redirect !== undefined) continue;
      const resolved = elementOf(repo, route);
      if (!resolved || !resolved.component) continue;
      if (!repo.rendering.has(resolved.component)) repo.rendering.set(resolved.component, []);
      repo.rendering.get(resolved.component).push(route);
    }
  }
  return repo.rendering.get(component) || [];
}

function configuredMounts(repoConfig) {
  const mounts = repoConfig && repoConfig.mounts && typeof repoConfig.mounts === 'object' ? repoConfig.mounts : {};
  return mounts;
}

/**
 * The lookup over one index. `options.repos` is the configuration's repository list, read
 * for `mounts` and `routeAssumptions`; `options.repo` scopes the lookup to one repository.
 */
export function createPageLookup(routeIndex, options = {}) {
  const configById = new Map((options.repos || []).map((repo) => [repo.id, repo]));
  const ownerMemo = new Map();
  const routeMemo = new Map();
  // Counts cycle cuts, so a result computed while one was in force is never reused: in a
  // mount cycle every member may be the root, and which one depends on where the walk began.
  let cuts = 0;

  function repoConfig(repo) {
    return configById.get(repo.id) || null;
  }

  function limit(list) {
    return list.length > MAX_CONTEXTS ? list.slice(0, MAX_CONTEXTS) : list;
  }

  /** Every way the component owning a `<Routes>` is itself reached from a browser path. */
  function ownerContexts(repo, ownerName, ownerFile, visiting) {
    const key = `${ownerFile}|${ownerName}`;
    if (ownerMemo.has(key)) return ownerMemo.get(key);
    if (visiting.has(key)) {
      cuts += 1;
      return [];
    }
    const cutsBefore = cuts;
    visiting.add(key);
    const owner = (repo.componentsByFile.get(ownerFile) || []).find((fact) => fact.name === ownerName && !fact.lazy) || null;
    const declared = [];

    if (owner) {
      for (const route of routesRendering(repo, owner)) {
        for (const context of routeContexts(repo, route, visiting)) {
          const splat = context.segs[context.segs.length - 1] === '*';
          declared.push({
            ...context,
            segs: splat ? context.segs.slice(0, -1) : context.segs,
            open: splat,
            chain: [...context.chain, ...lazySegment(route)],
          });
        }
      }
    }

    const ownerMounts = repo.mounts.filter((mount) => mount.component === ownerName);
    for (const mount of ownerMounts) {
      if (mount.unsupported) continue;
      declared.push({
        base: segmentsOf(mount.path),
        segs: [],
        open: true,
        chain: [],
        guards: [],
        host: { source: 'declared', path: mount.path, root: ownerName, file: mount.file, line: mount.line },
      });
    }

    for (const render of repo.rendersTo.get(ownerName) || []) {
      if (render.from === ownerName) continue;
      if (repo.routeElementSites.has(`${render.file}|${ownerName}|${render.line}`)) continue;
      const parents = (repo.componentsByName.get(render.from) || []).filter((fact) => fact.file === render.file && !fact.lazy);
      for (const parent of parents) {
        for (const context of ownerContexts(repo, parent.name, parent.file, visiting)) {
          declared.push({
            ...context,
            chain: [...context.chain, { kind: 'render', from: parent.name, element: ownerName, file: render.file, line: render.line, source: 'declared' }],
          });
        }
      }
    }

    const configured = [];
    const mounts = configuredMounts(repoConfig(repo));
    if (Object.hasOwn(mounts, ownerName)) {
      const path = mounts[ownerName];
      configured.push({
        base: segmentsOf(path),
        segs: [],
        open: true,
        chain: [],
        guards: [],
        host: { source: 'configuration', path, root: ownerName, key: `repos[${repo.id}].mounts.${ownerName}` },
      });
    }

    const unsupported = ownerMounts.filter((mount) => mount.unsupported).map((mount) => ({
      base: [],
      segs: [],
      open: true,
      chain: [],
      guards: [],
      host: { source: 'unsupported', root: ownerName, file: mount.file, line: mount.line, unsupported: mount.unsupported },
    }));
    let result = [...declared, ...configured, ...unsupported];
    const cyclic = cuts !== cutsBefore;
    const anchored = result.some((context) => context.host.source === 'declared' || context.host.source === 'configuration');
    if (unsupported.length === 0 && (result.length === 0 || (cyclic && !anchored))) {
      result.push({
        base: [],
        segs: [],
        open: true,
        chain: [],
        guards: [],
        host: {
          source: 'assumed',
          path: '/',
          root: ownerName,
          boundary: `the host mount of ${ownerName} is not declared in source; its routes are read from "/"`,
        },
      });
      if (repo.inferred) {
        result.push({
          base: segmentsOf(repo.inferred.path),
          segs: [],
          open: true,
          chain: [],
          guards: [],
          host: {
            source: 'inferred',
            path: repo.inferred.path,
            root: ownerName,
            file: repo.inferred.file,
            line: repo.inferred.line,
            evidence: repo.inferred.evidence,
          },
        });
      }
    }
    result = limit(result);
    visiting.delete(key);
    if (!cyclic) ownerMemo.set(key, result);
    return result;
  }

  function parentRoute(repo, route) {
    if (route.parentLine === undefined) return null;
    const key = `${route.file}:${route.parentLine}:${route.parentColumn ?? 0}`;
    const parents = repo.routesByKey.get(key) || [];
    return parents[0] || null;
  }

  /** The contexts a route's own path composes into: its parent's, extended by its segment. */
  function routeContexts(repo, route, visiting) {
    const key = `${routeKey(route)}|${route.element || ''}|${JSON.stringify(route.guards || [])}`;
    if (routeMemo.has(key)) return routeMemo.get(key);
    if (route.unsupported) return [];
    const cutsBefore = cuts;
    const parent = parentRoute(repo, route);
    const incoming = parent
      ? routeContexts(repo, parent, visiting).map((context) => ({
          ...context,
          segs: context.segs[context.segs.length - 1] === '*' ? context.segs.slice(0, -1) : context.segs,
          open: true,
        }))
      : ownerContexts(repo, route.owner, route.file, visiting);
    const out = [];
    const own = segmentsOf(route.path);
    const absolute = String(route.path || '').startsWith('/');
    // A route written as a child of another `<Route>` states an absolute path from the host
    // root; one rendered by a descendant `<Routes>` — a component's own, or a route array it
    // maps — is resolved against the path its host already matched, leading slash or not.
    const nested = parent !== null;
    for (const context of incoming) {
      let segs;
      if (route.index || own.length === 0) {
        if (absolute && context.segs.length > 0) continue;
        segs = context.segs;
      } else if (absolute && nested) {
        if (context.host.source === 'inferred' && context.segs.length === 0 && startsWith(own, context.base)) continue;
        if (context.segs.length > 0 && !startsWith(own, context.segs)) continue;
        segs = own;
      } else {
        if (!context.open) continue;
        if (absolute && context.host.source === 'inferred' && context.segs.length === 0 && startsWith(own, context.base)) continue;
        segs = [...context.segs, ...own];
      }
      out.push({
        ...context,
        segs,
        open: true,
        guards: [...context.guards, ...(route.guards || []).map((guard) => ({ ...guard, file: guard.file ?? route.file }))],
        chain: [
          ...context.chain,
          {
            kind: route.index ? 'index' : 'route',
            path: route.path,
            owner: route.owner,
            ...(route.element ? { element: route.element } : {}),
            file: route.file,
            line: route.pathLine ?? route.line,
            ...(route.entryFile ? { entryFile: route.entryFile, entryLine: route.entryLine } : {}),
            source: 'declared',
          },
        ],
      });
    }
    const result = limit(out);
    if (cuts === cutsBefore) routeMemo.set(key, result);
    return result;
  }

  function lazySegment(route) {
    if (route.lazyLine === undefined) return [];
    return [{ kind: 'lazy', specifier: route.lazySpecifier, element: route.element, file: route.file, line: route.lazyLine, source: 'declared' }];
  }

  function assumptionOf(repo, guard) {
    const values = repoConfig(repo) && repoConfig(repo).routeAssumptions;
    if (!values || typeof values !== 'object') return undefined;
    const known = (key) => Object.hasOwn(values, key) && typeof values[key] === 'boolean';
    const text = guard.text;
    if (known(text)) return { condition: text, value: values[text], holds: values[text] };
    const inner = text.startsWith('!') ? text.slice(1).trim() : null;
    if (inner !== null && known(inner)) return { condition: inner, value: values[inner], holds: !values[inner] };
    if (known(`!${text}`)) return { condition: `!${text}`, value: values[`!${text}`], holds: !values[`!${text}`] };
    return undefined;
  }

  /** Every leaf a URL could land on in one repository, before ranking. */
  function matchesIn(repo, wanted, depth) {
    const matches = [];
    const visiting = new Set();
    for (const route of repo.routes) {
      if (route.unsupported || route.layout) continue;
      const redirect = route.redirect !== undefined;
      let target = null;
      let descends = false;
      if (!redirect) {
        target = elementOf(repo, route);
        descends = Boolean(target && target.component && ownsRoutes(repo, target.component));
      }
      for (const context of routeContexts(repo, route, visiting)) {
        if (context.host.source === 'unsupported') continue;
        const template = [...context.base, ...context.segs];
        const matched = matchSegments(template, wanted);
        if (!matched) continue;
        // A component holding its own <Routes> is the page only at its own path; below it, its routes answer.
        if (descends && matched.remainder) continue;
        matches.push({ repo, route, context, template, target, redirect, score: matched.score + (route.index ? SCORE.index : 0), remainder: matched.remainder, depth });
      }
    }
    return matches;
  }

  function applyAssumptions(match) {
    const assumptions = [];
    for (const guard of match.context.guards) {
      if (guard.kind !== 'condition') continue;
      const assumed = assumptionOf(match.repo, guard);
      if (!assumed) continue;
      const wantsTrue = guard.branch !== 'else';
      if (assumed.holds !== wantsTrue) return null;
      assumptions.push({ condition: assumed.condition, value: assumed.value, source: 'configuration', file: guard.file, line: guard.line });
    }
    return { ...match, assumptions };
  }

  function redirectTarget(match) {
    const to = String(match.route.redirect);
    if (to.startsWith('/')) return [...match.context.base, ...segmentsOf(to)];
    const parentSegs = match.context.segs.slice(0, match.context.segs.length - segmentsOf(match.route.path).length);
    const out = [...match.context.base, ...parentSegs];
    for (const part of segmentsOf(to)) {
      if (part === '..') out.pop();
      else if (part !== '.') out.push(part);
    }
    return out;
  }

  function guardLabel(guard) {
    if (guard.kind === 'wrapper') return `[wrapped by ${guard.text}]`;
    return guard.branch === 'else' ? `[unless ${guard.text}]` : `[when ${guard.text}]`;
  }

  function candidateLabel(match) {
    const guards = match.context.guards.map(guardLabel).join(' ');
    const where = `mounted at ${siteOf(match.route)}`;
    if (match.target && match.target.component) {
      const component = match.target.component;
      return `${component.name} (page ${joinPath(match.template)}) ${match.repo.id} ${component.file}:${component.line}${guards ? ` ${guards}` : ''} ${where}`;
    }
    return `${match.route.element || '(element)'} (page ${joinPath(match.template)}) ${match.repo.id} unresolved element${guards ? ` ${guards}` : ''} ${where}`;
  }

  function signature(match) {
    const component = match.target && match.target.component ? `${match.target.component.file}:${match.target.component.line}` : match.route.element;
    return `${match.repo.id}|${component}|${match.context.chain.map((segment) => `${segment.kind}@${segment.file}:${segment.line}`).join('>')}|${JSON.stringify(match.context.host)}`;
  }

  function frontierFor(repo, wanted) {
    const frontier = [];
    const visiting = new Set();
    for (const route of repo.routes) {
      if (!route.unsupported) continue;
      const parent = parentRoute(repo, route);
      const contexts = parent ? routeContexts(repo, parent, visiting) : ownerContexts(repo, route.owner, route.file, visiting);
      const known = knownLeadingSegments(route.path);
      const absolute = String(route.path || '').startsWith('/');
      for (const context of contexts) {
        const segs = context.segs[context.segs.length - 1] === '*' ? context.segs.slice(0, -1) : context.segs;
        const prefix = absolute ? [...context.base, ...known] : [...context.base, ...segs, ...known];
        if (!matchPrefix(prefix, wanted)) continue;
        frontier.push({
          repo: repo.id,
          file: route.file,
          line: route.line,
          owner: route.owner,
          unsupported: route.unsupported,
          ...(route.pathText ? { pathText: route.pathText } : {}),
          ...(route.elementText ? { elementText: route.elementText } : {}),
          context: joinPath(prefix),
          host: context.host.source,
        });
        break;
      }
    }
    return frontier;
  }

  function mountGaps(repo, wanted) {
    const gaps = [];
    const visiting = new Set();
    for (const route of repo.routes) {
      if (route.unsupported || route.layout || route.redirect !== undefined) continue;
      for (const context of routeContexts(repo, route, visiting)) {
        if (context.host.source !== 'assumed') continue;
        for (let skip = 1; skip < wanted.length; skip += 1) {
          if (!matchSegments(context.segs, wanted.slice(skip))) continue;
          gaps.push({
            repo: repo.id,
            root: context.host.root,
            unmatched: joinPath(wanted.slice(0, skip)),
            route: `${route.file}:${route.line}`,
            element: route.element || null,
            reads: joinPath(context.segs),
          });
          break;
        }
      }
    }
    return dedupe(gaps, (gap) => `${gap.repo}|${gap.root}|${gap.route}|${gap.unmatched}`);
  }

  function mountFrontier(repo, wanted) {
    const frontier = [];
    const visiting = new Set();
    for (const route of repo.routes) {
      if (route.unsupported || route.layout || route.redirect !== undefined) continue;
      for (const context of routeContexts(repo, route, visiting)) {
        if (context.host.source !== 'unsupported') continue;
        for (let skip = 0; skip <= wanted.length; skip += 1) {
          if (!matchSegments(context.segs, wanted.slice(skip))) continue;
          frontier.push({
            repo: repo.id,
            file: context.host.file,
            line: context.host.line,
            root: context.host.root,
            unsupported: context.host.unsupported,
            context: joinPath(wanted.slice(0, skip)),
          });
          break;
        }
      }
    }
    return dedupe(frontier, (entry) => `${entry.repo}|${entry.file}|${entry.line}|${entry.root}|${entry.context}`);
  }

  function resolveIn(repos, wanted, depth) {
    let matches = [];
    for (const repo of repos) matches.push(...matchesIn(repo, wanted, depth));
    const excluded = [];
    const kept = [];
    for (const match of matches) {
      const applied = applyAssumptions(match);
      if (applied) kept.push(applied);
      else excluded.push(match);
    }
    matches = kept;
    if (matches.length === 0) return { matches: [], excluded };
    const best = Math.max(...matches.map((match) => match.score));
    let top = matches.filter((match) => match.score === best);
    // Among equally specific readings, a mount the source declares or the configuration names
    // answers; a prefix guessed from navigation literals never outranks it, so one path read
    // both ways is one answer rather than two candidates.
    const anchored = top.filter((match) => match.context.host.source === 'declared' || match.context.host.source === 'configuration');
    if (anchored.length > 0) top = anchored;
    return { matches: dedupe(top, signature), excluded };
  }

  /**
   * Resolve `start` to a page node, `{ candidates, reason }`, or `{ error, reason, frontier }`.
   * Returns null when no web repository in scope states `page_route` facts, so the caller can
   * keep its older reading for fact sets extracted before route declarations were recorded.
   */
  function lookup(start) {
    const url = normaliseUrl(start);
    if (url === null) return null;
    const repos = [...routeIndex.values()].filter((repo) => !options.repo || repo.id === options.repo);
    if (repos.length === 0) return null;
    const wanted = segmentsOf(url);
    let chainPrefix = [];
    let current = wanted;
    let outcome = resolveIn(repos, current, 0);
    for (let hop = 0; hop < MAX_REDIRECTS && outcome.matches.length === 1 && outcome.matches[0].redirect; hop += 1) {
      const match = outcome.matches[0];
      const target = redirectTarget(match);
      chainPrefix = [
        ...chainPrefix,
        ...match.context.chain,
        { kind: 'redirect', from: joinPath(current), to: joinPath(target), file: match.route.file, line: match.route.redirectLine ?? match.route.line, source: 'declared' },
      ];
      current = target;
      outcome = resolveIn(repos, current, hop + 1);
    }

    if (outcome.matches.length === 1 && !outcome.matches[0].redirect) {
      const match = outcome.matches[0];
      if (match.target && match.target.component) return { node: pageNode(match, url, chainPrefix) };
      return {
        error: `"${start}" matches a route whose element ${match.route.element ? `<${match.route.element}>` : ''} is not a component this repository declares`.replace(/ {2,}/g, ' '),
        reason: 'unsupported-expression',
        frontier: [
          {
            repo: match.repo.id,
            file: match.route.file,
            line: match.route.line,
            owner: match.route.owner,
            unsupported: match.target && match.target.ambiguous ? 'element-ambiguous' : 'element-unresolved',
            elementText: match.route.element || match.route.elementText || '',
            context: joinPath(match.template),
            host: match.context.host.source,
          },
        ],
      };
    }
    if (outcome.matches.length > 1) {
      const labels = outcome.matches.map(candidateLabel).sort();
      return { candidates: [...new Set(labels)], reason: 'ambiguous' };
    }
    if (outcome.matches.length === 1 && outcome.matches[0].redirect) {
      return {
        error: `"${start}" follows more than ${MAX_REDIRECTS} redirects`,
        reason: 'unsupported-expression',
        frontier: [{ repo: outcome.matches[0].repo.id, file: outcome.matches[0].route.file, line: outcome.matches[0].route.line, unsupported: 'redirect-chain' }],
      };
    }

    const gaps = repos.flatMap((repo) => mountGaps(repo, current));
    if (gaps.length > 0) {
      return {
        error: `"${start}" — missing mount information: it ends in a path declared below ${[...new Set(gaps.map((gap) => gap.root))].join(', ')}, whose host mount is not declared in source; name it in repos[].mounts`,
        reason: 'missing-mount',
        frontier: gaps,
      };
    }
    const frontier = repos.flatMap((repo) => [...mountFrontier(repo, current), ...frontierFor(repo, current)]);
    if (frontier.length > 0) {
      return {
        error: `"${start}" — unsupported expression: no supported declaration matches, and ${frontier.length === 1 ? 'a declaration' : `${frontier.length} declarations`} on the way cannot be read`,
        reason: 'unsupported-expression',
        frontier,
      };
    }
    const excludedNote =
      outcome.excluded.length > 0
        ? `; the only declarations matching are excluded by configured assumptions (${outcome.excluded.map((match) => siteOf(match.route)).join(', ')})`
        : '';
    return {
      error: `no page, component, service, route, method or class matches "${start}"${excludedNote}`,
      reason: 'no-declaration',
      ...(outcome.excluded.length > 0 ? { frontier: outcome.excluded.map((match) => ({ repo: match.repo.id, file: match.route.file, line: match.route.line, excludedBy: 'assumption' })) } : {}),
    };
  }

  function pageNode(match, url, chainPrefix) {
    const component = match.target.component;
    const host = match.context.host;
    const inferred = host.source === 'assumed' || host.source === 'inferred';
    const guards = match.context.guards.map((guard) => {
      const record = { kind: guard.kind, text: guard.text };
      if (guard.kind === 'condition') record.branch = guard.branch;
      record.file = guard.file;
      record.line = guard.line;
      return record;
    });
    const mount = {
      host,
      chain: [...chainPrefix, ...match.context.chain, ...lazySegment(match.route)],
      guards,
      assumptions: match.assumptions,
    };
    if (match.remainder) mount.remainder = match.remainder;
    const frontier = frontierFor(match.repo, segmentsOf(url));
    if (frontier.length > 0) mount.frontier = frontier;
    return {
      repo: match.repo.id,
      kind: 'page',
      ref: component.name,
      file: component.file,
      line: component.line,
      pagePath: joinPath(match.template),
      url,
      inferred,
      ...(host.source === 'inferred' ? { mountPrefix: host.path } : {}),
      mount,
    };
  }

  return { lookup };
}

/** The segments of a partly readable path before its first unreadable one. */
function knownLeadingSegments(path) {
  const known = [];
  for (const part of segmentsOf(path)) {
    if (part.includes('${') || part === '*' || part.includes('?')) break;
    known.push(part);
  }
  return known;
}

function startsWith(list, prefix) {
  if (prefix.length > list.length) return false;
  return prefix.every((part, index) => part === list[index]);
}

function dedupe(list, keyOf) {
  const seen = new Map();
  for (const item of list) {
    const key = keyOf(item);
    if (!seen.has(key)) seen.set(key, item);
  }
  return [...seen.values()];
}

function segmentMatches(template, wanted) {
  if (template.startsWith(':')) {
    if (wanted === undefined || wanted === '') return null;
    return SCORE.dynamic;
  }
  if (wanted === undefined || wanted.startsWith(':')) return null;
  return template.toLowerCase() === wanted.toLowerCase() ? SCORE.static : null;
}

/** How `wanted` matches a composed template, React Router's ranking in miniature, or null. */
export function matchSegments(template, wanted) {
  let score = 0;
  for (let index = 0; index < template.length; index += 1) {
    const part = template[index];
    if (part === '*') {
      if (index !== template.length - 1) return null;
      return { score: score + SCORE.splat, remainder: wanted.slice(index).join('/') };
    }
    const gained = segmentMatches(part, wanted[index]);
    if (gained === null) return null;
    score += gained;
  }
  if (wanted.length !== template.length) return null;
  return { score, remainder: null };
}

function matchPrefix(prefix, wanted) {
  if (prefix.length > wanted.length) return false;
  return prefix.every((part, index) => segmentMatches(part, wanted[index]) !== null);
}
