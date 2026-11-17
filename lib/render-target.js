/**
 * The component a web or mobile `renders` fact lands on, shared by `join` and `trace` so the
 * two choose one target for one fact. It reads only the `component` facts, through indexes
 * that `buildComponentTargets` builds for `join` and `trace` builds as part of its own index.
 */

import { posix } from 'node:path';

function pushInto(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * `componentByName` keeps every declaration under a `repo|name` key so `resolveStart` can
 * see a same-repo duplicate as ambiguous. A walk continuing past a resolved
 * start — a DI field, a mobile `injects` edge target, a web name declared once — still
 * wants one component to land on; it takes the last-processed declaration while name
 * resolution reports the complete candidate list. A web `renders` target goes through
 * `renderTarget` instead.
 */
export function lastComponent(index, key) {
  const entries = index.componentByName.get(key);
  return entries && entries.length > 0 ? entries[entries.length - 1] : undefined;
}

export const MODULE_EXT_RE = /\.(?:[cm]?[jt]sx?)$/;

/** The repository path a relative module specifier written in `file` names, extension dropped. */
function importedModule(file, specifier) {
  if (!specifier || !/^\.\.?(?:\/|$)/.test(specifier)) return null;
  return posix.normalize(posix.join(posix.dirname(file), specifier)).replace(MODULE_EXT_RE, '');
}

/**
 * What a statement chain settles: `name` as written in `file`, which that file declares
 * itself or imports from `specifier` under `exported` (`default` for a default import). A
 * module is followed to the one file it names, and binds only a component whose `exports`
 * states the imported name; a `lazy()` binding stands for the default export of the module it
 * loads. `{ target }` is the declaration reached. `{}` is a module the facts settle that binds
 * nothing under that name — a component it declares without exporting, a name it does not
 * export, a relative path no component file answers for a default import, or a file whose
 * facts state no exports at all — and anything a followed file names that cannot be followed
 * on, so nothing may stand in for it under the same name elsewhere. `{ candidates }` is a path
 * more than one file answers. Undefined only when the rendering file itself names no file to
 * follow: a tag it neither declares nor imports, a module outside relative reach, a named
 * import whose path no component file answers (a barrel re-exporting it, say), or its own
 * chain coming back on itself.
 */
function settledDeclaration(index, repo, fact) {
  const visited = new Set();
  let file = fact.file;
  let name = fact.to;
  let specifier = fact.source;
  let exported = fact.imported ?? fact.to;
  let unsettled;
  while (!visited.has(`${file}|${name}`)) {
    visited.add(`${file}|${name}`);
    const here = (index.componentsInFile.get(`${repo}|${file}`) || []).filter((entry) => entry.fact.name === name);
    const body = here.find((entry) => entry.fact.lazy === undefined);
    if (body) return { target: body };
    if (here.length > 0) {
      specifier = here[0].fact.lazy;
      exported = 'default';
    } else if (unsettled) {
      return unsettled;
    }
    const module = importedModule(file, specifier);
    if (!module) return unsettled;
    const files = [module, `${module}/index`].flatMap((stem) => [...(index.componentModules.get(`${repo}|${stem}`) || [])]);
    if (files.length > 1) return { candidates: files.sort() };
    if (files.length === 0) return exported === 'default' ? {} : unsettled;
    [file] = files;
    const binding = index.componentsInFile
      .get(`${repo}|${file}`)
      .find((entry) => Array.isArray(entry.fact.exports) && entry.fact.exports.includes(exported));
    if (!binding) return {};
    name = binding.fact.name;
    specifier = undefined;
    unsettled = {};
  }
  return unsettled;
}

/**
 * The declaration a web `renders` edge lands on. What the rendering file itself says comes
 * first: its own declaration of the tag, or the module it imports the tag from and the name
 * that module exports it under — so a child imported under another local name is the child
 * its module declares, and a child its module does not export is an unknown target, never a
 * declaration elsewhere that merely shares the name. Only where no statement names a file
 * to follow is the name the child is exported under looked up instead: the tag itself, or
 * `A` for `{ A as B }`. An import reaching that lookup (a path alias, a barrel) can only bind
 * a declaration its module exports, so a component that states no export is no candidate. A
 * name declared once is that declaration; a name declared in more than one file is
 * `{ candidates }`, every declaring file, so the walk states an unknown target at the site
 * instead of entering whichever was read last.
 */
export function renderTarget(index, repo, fact) {
  const settled = settledDeclaration(index, repo, fact);
  if (settled) return settled;
  const exported = fact.imported !== undefined && fact.imported !== 'default' ? fact.imported : fact.to;
  const key = `${repo}|${exported}`;
  if (fact.source === undefined) {
    if (!index.sharedComponents.has(key)) {
      return { target: lastComponent(index, key) || index.componentBySelector.get(exported) };
    }
    return { candidates: [...new Set(index.componentByName.get(key).map((entry) => entry.fact.file))].sort() };
  }
  const bound = (index.componentByName.get(key) || []).filter((entry) => entry.fact.exports?.length > 0);
  const files = [...new Set(bound.map((entry) => entry.fact.file))].sort();
  return files.length > 1 ? { candidates: files } : { target: bound[bound.length - 1] };
}

/**
 * The indexes `renderTarget` reads beside `componentByName`: the names more than one file of a
 * web or mobile repository declares, the components of each file, and the files of each module
 * path with its extension dropped. `repoKinds` maps a repository to its kind.
 */
export function addComponentModules(index, repoKinds) {
  index.sharedComponents = new Set();
  index.componentsInFile = new Map();
  index.componentModules = new Map();
  for (const [key, entries] of index.componentByName) {
    const kindOfRepo = repoKinds.get(entries[0].repo);
    if (kindOfRepo !== 'web' && kindOfRepo !== 'mobile') continue;
    if (new Set(entries.map((entry) => entry.fact.file)).size > 1) index.sharedComponents.add(key);
    for (const entry of entries) {
      pushInto(index.componentsInFile, `${entry.repo}|${entry.fact.file}`, entry);
      const stem = `${entry.repo}|${entry.fact.file.replace(MODULE_EXT_RE, '')}`;
      if (!index.componentModules.has(stem)) index.componentModules.set(stem, new Set());
      index.componentModules.get(stem).add(entry.fact.file);
    }
  }
  return index;
}

/** The component indexes of `factSets` alone, for a reader that needs no trace index. */
export function buildComponentTargets(factSets) {
  const index = { componentByName: new Map(), componentBySelector: new Map() };
  const repoKinds = new Map();
  for (const set of factSets) {
    repoKinds.set(set.repo, set.kind);
    for (const fact of set.facts || []) {
      if (fact.type !== 'component') continue;
      const entry = { repo: set.repo, fact };
      pushInto(index.componentByName, `${set.repo}|${fact.name}`, entry);
      if (fact.selector) index.componentBySelector.set(fact.selector, entry);
    }
  }
  return addComponentModules(index, repoKinds);
}
