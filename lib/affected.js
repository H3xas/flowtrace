/**
 * Affected step — turn a diff into the specs that must run.
 *
 * The selection is a **forward** intersection, never reverse reachability. Every route
 * in the universe is walked exactly as `trace --seeds` walks it — with the
 * primary window, shared dependencies demoted inside the walk — and a route counts as
 * affected when its walk touches a changed file. Reverse reachability starts at the
 * infrastructure those rules exist to demote, so it reaches half the system and selects
 * nothing; the direction is the whole argument.
 *
 * Evidence then comes from `cover`, unchanged: the specs whose `pw_request` or
 * `cypress_intercept` names an affected route, ranked by the strongest seed level they
 * hold. Routes that are affected and hold no evidence at all are a separate signal, and are
 * reported separately rather than folded into a count.
 *
 * Every widening is a printed rung of the fallback ladder, never a silent one, and any
 * rung that widens to a full suite sets exit 4 — the answer "run everything, here is
 * why" is always preferred to a narrowed list built on facts that cannot support it.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join as joinPath, relative, resolve, sep } from 'node:path';

import { cover, STATE_ORDER } from './cover.js';
import { DEFAULT_DOTNET_MAX_SHARE, buildDotnetFilter } from './dotnet.js';
import { staleFactsWarnings } from './facts.js';
import { routeKey } from './normalize.js';
import { trace as defaultTrace } from './trace.js';
import { walk } from './walk.js';

/** Above this selected share of a suite the narrowing has stopped paying for itself. */
export const DEFAULT_MAX_SHARE = 0.5;

export { DEFAULT_DOTNET_MAX_SHARE };

/** Distinct classes injecting one dependency, above which it counts as infrastructure. */
export const DEFAULT_INFRA_FANIN = 25;

/**
 * Exit codes, house style: a list was produced, nothing was affected (a real answer),
 * a fallback widened to a full suite.
 */
export const EXIT = Object.freeze({ ok: 0, nothing: 3, widened: 4 });

const SPEC_PATTERN = /\.(spec|cy|test)\.[cm]?[jt]sx?$/i;
const GENERATED_PATTERN = /(^|\/)(generated|\.openapi)(\/|$)|\.generated\./i;
const CONTROLLER_PATTERN = /(^|\/)Controllers(\/|$)|Controller[^/]*\.cs$/;
const CONFIG_EXTENSIONS = new Set([
  'json', 'yml', 'yaml', 'xml', 'config', 'props', 'targets', 'csproj', 'sln',
  'toml', 'ini', 'env', 'lock', 'md',
]);
const CONFIG_NAMES = new Set(['dockerfile', 'makefile', '.editorconfig', '.gitignore', '.dockerignore']);

/** Repository kinds that hold a suite rather than the system the suite runs against. */
const TEST_REPO_KINDS = new Set(['playwright', 'mobile']);

/** Provenance lines kept per spec row; past this the chain repeats itself. */
const WHY_CAP = 4;

/** Changed files named per affected route before the list stops being read. */
const CHANGED_CAP = 6;

function compare(a, b) {
  const left = a || '';
  const right = b || '';
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * `walk`'s exclusion rule, applied to a path git named rather than one the walker found:
 * a pattern matches as a plain substring of the repository-relative path, as a whole path
 * segment, or as a glob when it carries `*` or `?`.
 */
export function isExcluded(relativePath, exclude = []) {
  const segments = String(relativePath).split('/');
  return (exclude || []).some((raw) => {
    const pattern = String(raw ?? '').trim().replace(/^\.\//, '').replace(/\/+$/, '');
    if (pattern === '') return false;
    if (pattern.includes('*') || pattern.includes('?')) {
      const source = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '\u0000')
        .replace(/\*/g, '[^/]*')
        .replace(/\u0000/g, '.*')
        .replace(/\?/g, '[^/]');
      const expression = new RegExp(`^${source}$`);
      return expression.test(relativePath) || segments.some((segment) => expression.test(segment));
    }
    return relativePath.includes(pattern) || segments.includes(pattern);
  });
}

/**
 * What a changed path is, before any repository knows about it: a spec, a generated
 * artefact, configuration or infrastructure, or production source. Only `source` can
 * ever put a route on the run list; the other three decide a rung of the ladder.
 */
export function classifyPath(path) {
  const value = String(path || '');
  if (SPEC_PATTERN.test(value)) return 'spec';
  if (GENERATED_PATTERN.test(value)) return 'generated';
  const name = value.slice(value.lastIndexOf('/') + 1).toLowerCase();
  if (CONFIG_NAMES.has(name) || value.includes('/.github/') || value.startsWith('.github/')) return 'config';
  const dot = name.lastIndexOf('.');
  const extension = dot === -1 ? '' : name.slice(dot + 1);
  if (CONFIG_EXTENSIONS.has(extension)) return 'config';
  return 'source';
}

/** Resolve `.` and `..` inside a path without touching the filesystem. */
function flatten(path) {
  const out = [];
  for (const segment of String(path).split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return out.join('/');
}

function normalizeRoot(root) {
  return `/${flatten(root || '')}`;
}

function defaultGitDiffPrefix(root) {
  try {
    const output = execFileSync('git', ['rev-parse', '--show-prefix'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return String(output || '').trim();
  } catch {
    return null;
  }
}

/**
 * `git rev-parse --show-prefix`, run from `root`: the path of `root` relative to the top
 * of the git working tree it sits inside (trailing slash), or `''` when `root` **is**
 * that top level. `git diff --name-only` always reports paths relative to the top level of
 * the working tree, never to the directory the command was invoked from — so when `root`
 * is configured as a subdirectory of the git root a diff was taken against, this
 * is exactly the prefix baked into every path that diff prints. `null` when `root` is not
 * inside a git working tree, or git is not on PATH: the caller leaves the diff untouched.
 */
export function gitDiffPrefix(root, { run = defaultGitDiffPrefix } = {}) {
  if (typeof root !== 'string' || root.trim() === '') return null;
  return run(root);
}

/**
 * Attribute every path in one diff to the repository that owns it, longest root first so
 * a harness nested inside a backend checkout wins over the checkout. `root` is the
 * repository the diff was taken in; paths are relative to it — except that `git diff
 * --name-only` itself never honours that: it always reports paths relative to the top of
 * the git working tree, regardless of the directory the command ran in. When `root` equals
 * that top level (the common case) the two coincide and nothing changes; when `root` is
 * configured as a subdirectory of it (for example, a backend configured with `root` at
 * its `src/` directory), every path git names still carries that
 * subdirectory's own name as a leading segment, and comparing it against facts indexed
 * relative to `root` misses even a genuinely touched file. `prefix` (default: `gitDiffPrefix
 * (root)`) is stripped off the front of a path that carries it before anything below reads
 * it; a path that does not carry it was never inside `root` to begin with, and is left for
 * the match below to decide, unchanged. A path a repository's own `exclude` list drops
 * carries kind `excluded` — the extractor never saw it, so no fact can name it — and a path
 * under no configured root carries kind `unmapped`.
 */
export function attributeChanges(paths, repos = [], { root, prefix } = {}) {
  const base = normalizeRoot(root);
  const offset = flatten((prefix !== undefined ? prefix : gitDiffPrefix(root)) || '');
  const ordered = [...(repos || [])]
    .map((repo) => ({ ...repo, root: normalizeRoot(repo.root) }))
    .sort((a, b) => b.root.length - a.root.length);
  const files = [];
  for (const path of paths || []) {
    let relativeToBase = String(path).replace(/^\.\//, '');
    if (offset !== '' && relativeToBase.startsWith(`${offset}/`)) {
      relativeToBase = relativeToBase.slice(offset.length + 1);
    }
    const absolute = `/${flatten(base ? `${base}/${relativeToBase}` : relativeToBase)}`;
    const owner = ordered.find((repo) => repo.root !== '/' && absolute.startsWith(`${repo.root}/`));
    if (!owner) {
      files.push({ repo: null, path: relativeToBase, kind: 'unmapped' });
      continue;
    }
    const relative = absolute.slice(owner.root.length + 1);
    let kind = isExcluded(relative, owner.exclude) ? 'excluded' : classifyPath(relative);
    // Source inside a test harness is not production source: no route walk can reach a
    // fixture, a client or a builder, so it never selects and never counts as one.
    if (kind === 'source' && TEST_REPO_KINDS.has(owner.kind)) kind = 'harness';
    files.push({ repo: owner.id, path: relative, kind });
  }
  files.sort((a, b) => compare(a.repo, b.repo) || compare(a.path, b.path));
  return files;
}

/**
 * The paths one diff names, repository-relative. `diff` takes anything `git diff` takes;
 * `staged` reads the index; with neither, the working tree is read — tracked changes plus
 * files git does not track yet, because a new source file is exactly the kind of change a
 * selection must not miss. `null` when the directory is not a git repository, or git is
 * not on PATH: the caller refuses rather than selecting from an empty diff.
 */
export function changedPaths(root, { diff, staged } = {}) {
  const run = (args) => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return null;
    }
  };
  const lines = (text) => String(text || '').split('\n').map((line) => line.trim()).filter(Boolean);
  if (diff) {
    const output = run(['diff', '--name-only', diff]);
    return output === null ? null : [...new Set(lines(output))].sort();
  }
  if (staged) {
    const output = run(['diff', '--name-only', '--cached']);
    return output === null ? null : [...new Set(lines(output))].sort();
  }
  const tracked = run(['diff', '--name-only', 'HEAD']);
  if (tracked === null) return null;
  const untracked = run(['ls-files', '--others', '--exclude-standard']) ?? '';
  return [...new Set([...lines(tracked), ...lines(untracked)])].sort();
}

// --- The Nx project graph, unioned in ---------------------------------------
//
// The route walk above only ever sees a change that sits *inside* a route's traced call
// chain. A shared library the workspace's own build graph treats as a dependency of a
// dozen consumers is invisible to it — the facts are extracted per consuming component,
// not per library — so a library-only diff selects nothing even though every consumer
// should re-run. Nx already answers a coarser version of that question over its own
// project graph, and the four helpers below ask it and join the answer in.
//
// Every one of them is a lookup, never a second extraction: `nx.json` says where the
// workspace is, `nx show projects --affected` says which projects the diff touched, and
// each project's own `project.json` says which specs its `test`/`e2e` target runs. None
// of them ever throws, and none of them can narrow the route-derived list.

/** Directories no Nx workspace scan has any business descending into. */
const NX_SKIP = ['node_modules', 'coverage', 'tmp', '.nx', '.angular', '.cache'];

/** Target names whose specs a project owns. */
const NX_SPEC_TARGETS = ['test', 'e2e'];

/** Target options that name spec files literally rather than through a runner config. */
const NX_SPEC_OPTIONS = ['specs', 'spec', 'testFiles'];

/** Project names printed in one reason line before the list stops being read. */
const NX_NAME_CAP = 8;

/**
 * The `--base` ref Nx is asked for, read off the same diff resolution flowtrace's own
 * selection used, so the two can never disagree about what changed: the left-hand side of
 * a `--diff` range (`A..B` and `A...B` alike), the range itself when it names one ref, and
 * `HEAD` for `--staged` and for the working tree — which is exactly what those two are
 * read against.
 */
export function nxBaseRef({ diff } = {}) {
  if (typeof diff !== 'string' || diff.trim() === '') return 'HEAD';
  const base = diff.trim().split(/\.{2,3}/)[0].trim();
  return base === '' ? 'HEAD' : base;
}

/**
 * The Nx workspace root: the first directory at or above `start` holding an `nx.json`.
 * `null` when there is none — the configured repository is simply not in an Nx workspace,
 * which is a no-op rather than an error.
 */
export function nxWorkspaceRoot(start, { fileExists = existsSync } = {}) {
  if (typeof start !== 'string' || start.trim() === '') return null;
  let current = resolve(start);
  for (;;) {
    if (fileExists(joinPath(current, 'nx.json'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Every `project.json` in the workspace, keyed by the name Nx knows the project by — its
 * own `name` field, or its directory name when the file declares none, which is exactly
 * how Nx itself falls back. A file that will not parse is skipped rather than fatal: one
 * malformed project must not cost the whole union.
 */
export function nxProjects(workspaceRoot, { readFile = readFileSync, list = walk } = {}) {
  const byName = new Map();
  let files;
  try {
    files = list(workspaceRoot, { extensions: ['.json'], exclude: NX_SKIP });
  } catch {
    return byName;
  }
  for (const file of files) {
    if (!file.endsWith(`${sep}project.json`)) continue;
    let doc;
    try {
      doc = JSON.parse(readFile(file, 'utf8'));
    } catch {
      continue;
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) continue;
    const directory = flatten(relative(workspaceRoot, dirname(file)));
    const name = typeof doc.name === 'string' && doc.name.trim() !== ''
      ? doc.name.trim()
      : directory.split('/').filter(Boolean).pop();
    if (!name || byName.has(name)) continue;
    byName.set(name, {
      name,
      root: typeof doc.root === 'string' && doc.root.trim() !== '' ? flatten(doc.root) : directory,
      targets: doc.targets && typeof doc.targets === 'object' ? doc.targets : {},
    });
  }
  return byName;
}

/**
 * The specs one project owns, read off its own `test`/`e2e` targets — a lookup in the file
 * Nx already maintains, never a new extraction. A target that names its spec files
 * literally (`specs`, `spec`, `testFiles`) is taken at its word; a target that names them
 * through a runner configuration instead names nothing this side can read, so the
 * project's own root is the answer and every spec file under it belongs to the target.
 * Sorted and de-duplicated, first target wins, so the same workspace always answers the
 * same way.
 */
export function nxProjectSpecs(workspaceRoot, project, { list = walk } = {}) {
  const found = new Map();
  for (const target of NX_SPEC_TARGETS) {
    const definition = project.targets ? project.targets[target] : null;
    if (!definition || typeof definition !== 'object') continue;
    const options = definition.options && typeof definition.options === 'object' ? definition.options : {};
    const literal = [];
    for (const key of NX_SPEC_OPTIONS) {
      for (const value of [].concat(options[key] ?? [])) {
        if (typeof value !== 'string' || value.trim() === '' || /[*?]/.test(value)) continue;
        literal.push(flatten(value.trim()));
      }
    }
    const specs = [];
    if (literal.length > 0) {
      specs.push(...literal);
    } else {
      let files;
      try {
        files = list(joinPath(workspaceRoot, project.root), { exclude: NX_SKIP });
      } catch {
        files = [];
      }
      for (const file of files) {
        const path = flatten(relative(workspaceRoot, file));
        if (SPEC_PATTERN.test(path)) specs.push(path);
      }
    }
    for (const spec of specs) if (spec !== '' && !found.has(spec)) found.set(spec, { spec, target });
  }
  return [...found.values()].sort((a, b) => compare(a.spec, b.spec));
}

function defaultNxRun(workspaceRoot, args) {
  return execFileSync('nx', args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/**
 * `nx show projects --affected --base <ref> --json`, parsed into the project name list.
 *
 * Returns `{projects, reason}`: a sorted, de-duplicated list and a null reason when Nx
 * answered, and a null list with the reason when it did not. A missing binary, a non-zero
 * exit, empty output and a reply that is not a JSON array of strings are all the same
 * answer — "Nx said nothing" — and the caller falls back to the route-only list rather
 * than reporting a zero it cannot back.
 */
export function nxAffectedProjects(workspaceRoot, ref, { run = defaultNxRun } = {}) {
  const args = ['show', 'projects', '--affected', '--base', String(ref), '--json'];
  let output;
  try {
    output = run(workspaceRoot, args);
  } catch (error) {
    return {
      projects: null,
      reason: error && error.code === 'ENOENT'
        ? 'no nx binary on PATH'
        : 'nx show projects exited with an error',
    };
  }
  if (typeof output !== 'string' || output.trim() === '') {
    return { projects: null, reason: 'nx show projects printed nothing' };
  }
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    return { projects: null, reason: 'nx show projects did not answer with JSON' };
  }
  if (!Array.isArray(parsed) || parsed.some((name) => typeof name !== 'string')) {
    return { projects: null, reason: 'nx show projects answered with something other than a list of project names' };
  }
  return { projects: [...new Set(parsed.map((name) => name.trim()).filter(Boolean))].sort(), reason: null };
}

function named(names) {
  return names.length > NX_NAME_CAP
    ? `${names.slice(0, NX_NAME_CAP).join(', ')}, +${names.length - NX_NAME_CAP} more`
    : names.join(', ');
}

function collect(factSets, type) {
  const out = [];
  for (const set of factSets || []) {
    for (const entry of set.facts || []) {
      if (entry.type === type) out.push({ repo: set.repo, fact: entry });
    }
  }
  return out;
}

/** Every route key the fact sets declare — the `--all-routes` universe. */
export function allRouteKeys(factSets) {
  const keys = new Set();
  for (const { fact } of collect(factSets, 'route')) keys.add(routeKey(fact.verb, fact.template));
  return [...keys].sort();
}

/**
 * Which repository each spec name belongs to, so a run list can be split by suite —
 * `[mobile]` for the mobile repo's own Cypress, `[web]` for the web repo's (the sibling
 * Cypress remainder `web-cypress.js` reads via `cypressSubpath`), never one folded into
 * the other. The repo is read straight off the fact (`collect`'s `set.repo`), never
 * inferred from the fact *type* — `cypress_test`/`cypress_intercept` are emitted by both
 * the mobile and the web extractor, and a type-keyed guess would default every Cypress
 * spec to whichever of the two the config lists first.
 *
 * `cover`'s evidence carries the bare spec name only (`route.evidence.specs`, a
 * deduplicated set of strings — "Evidence then comes from cover, unchanged" per the
 * module docstring above), so a name two different repos both happen to use is
 * irreducibly ambiguous by the time it reaches here: the first repo a fact-type/factSet
 * order encounters keeps the attribution, but every such name is also
 * returned in `ambiguous` so the caller can say so rather than stay silent about it.
 */
function specRepos(factSets) {
  const owner = new Map();
  const claimants = new Map();
  for (const type of ['pw_test', 'cypress_test', 'pw_request', 'cypress_intercept']) {
    for (const { repo, fact } of collect(factSets, type)) {
      const set = claimants.get(fact.spec) || new Set();
      set.add(repo);
      claimants.set(fact.spec, set);
      if (!owner.has(fact.spec)) owner.set(fact.spec, repo);
    }
  }
  const ambiguous = new Map([...claimants].filter(([, repos]) => repos.size > 1));
  return { owner, ambiguous };
}

/**
 * How many spec files each suite holds — the denominator of "14 of 78" — and how many
 * tests each spec declares. A file that declares no test is not a spec file: it is a
 * support command that registers intercepts for other specs.
 */
function specCounts(factSets) {
  const perRepo = new Map();
  const perSpec = new Map();
  for (const type of ['pw_test', 'cypress_test']) {
    for (const { repo, fact } of collect(factSets, type)) {
      const byRepo = perRepo.get(repo) || new Set();
      byRepo.add(fact.spec);
      perRepo.set(repo, byRepo);
      perSpec.set(fact.spec, (perSpec.get(fact.spec) || 0) + 1);
    }
  }
  return { totals: new Map([...perRepo].map(([repo, specs]) => [repo, specs.size])), tests: perSpec };
}

/** A generic or nullable type annotation, reduced to the bare name the facts key on. */
function baseType(name) {
  return String(name ?? '').replace(/<.*$/, '').replace(/\?+$/, '').trim();
}

/**
 * Member-level receiver-scoped widening.
 *
 * The impact widening below unions a changed file's whole blast radius into the changed
 * set, which is a class-level reading: constructor injection is a list of what a class
 * *can* reach, not of what its bodies do. For a widened edge `from → to`, the member-scoped
 * rule keeps `to` only when one of its own
 * bodies calls, **through a constructor-injected field**, a member the changed file
 * actually declares.
 *
 * Three verdicts, and the two that drop are recorded separately because they are different
 * claims. `no-facts-for-file` — the fact set names the file nowhere, so no forward route
 * walk can read it either and unioning it in can select nothing (mostly the test files the
 * code index covers and the extractor excludes). `injected-not-called` — the file injects
 * the changed type and calls no member of it, so a whole-class inference would overstate
 * the edge. `no-receiver-scoped-call` — neither.
 *
 * The walk's own discipline about absence is kept: a changed file the facts declare no class
 * or no member for cannot be scoped on, so its widening is left whole and the caller is
 * told (`whole-class`) rather than silently narrowed on missing evidence. The receiver
 * shapes this tool deliberately leaves unrecorded — property injection, a static receiver, a local
 * built with `new` — are unrecorded here too, so an edge that exists only through one of
 * them is dropped; that is the recall cost of the tightening, and it is why the rule is a
 * flag rather than the default.
 */
export function receiverScopedIndex(factSets, repo = null) {
  const files = new Set();
  const typesByFile = new Map();
  const membersByFile = new Map();
  const ifacesByImpl = new Map();
  const fieldTypes = new Map();
  const calls = [];
  for (const set of factSets || []) {
    if (repo && set.repo !== repo) continue;
    for (const fact of set.facts || []) {
      const file = typeof fact.file === 'string' ? fact.file : null;
      if (file) files.add(file);
      const declared = fact.class || fact.controller;
      if (file && declared) {
        const names = typesByFile.get(file) || new Set();
        names.add(baseType(declared));
        typesByFile.set(file, names);
      }
      if (fact.type === 'method_span' && file && fact.method) {
        const members = membersByFile.get(file) || new Set();
        members.add(fact.method);
        membersByFile.set(file, members);
      } else if (fact.type === 'di_binding' && fact.impl && fact.iface) {
        const bound = ifacesByImpl.get(baseType(fact.impl)) || new Set();
        bound.add(baseType(fact.iface));
        ifacesByImpl.set(baseType(fact.impl), bound);
      } else if (fact.type === 'ctor_field' && file && fact.class && fact.field && fact.paramType) {
        fieldTypes.set(`${file}\x00${fact.class}\x00${fact.field}`, baseType(fact.paramType));
      } else if (fact.type === 'method_call' && file && fact.class && fact.field && fact.field !== 'this' && fact.calledMethod) {
        calls.push(fact);
      }
    }
  }

  const injectedByFile = new Map();
  for (const [key, paramType] of fieldTypes) {
    const file = key.slice(0, key.indexOf('\x00'));
    const injected = injectedByFile.get(file) || new Set();
    injected.add(paramType);
    injectedByFile.set(file, injected);
  }
  const calledByFile = new Map();
  for (const fact of calls) {
    const paramType = fieldTypes.get(`${fact.file}\x00${fact.class}\x00${fact.field}`);
    if (!paramType) continue;
    const perFile = calledByFile.get(fact.file) || new Map();
    const methods = perFile.get(paramType) || new Set();
    methods.add(fact.calledMethod);
    perFile.set(paramType, methods);
    calledByFile.set(fact.file, perFile);
  }

  // An extractor that records no constructor-injected receiver at all — the mobile and web
  // ones, whose `method_call.field` is an imported name rather than a ctor field — cannot
  // be scoped on, and narrowing on its silence would drop every edge it has. The file-level
  // drop below still stands there, because a file the facts name nowhere is a file no
  // forward route walk can read either.
  const scopable = fieldTypes.size > 0;

  const judge = (from, to) => {
    if (!files.has(to)) return { keep: false, reason: 'no-facts-for-file' };
    if (!scopable) return { keep: true, reason: 'no-receiver-facts' };
    const types = typesByFile.get(from);
    const members = membersByFile.get(from);
    if (!types || types.size === 0 || !members || members.size === 0) {
      return { keep: true, reason: 'whole-class' };
    }
    const wanted = new Set();
    for (const name of types) {
      wanted.add(name);
      for (const iface of ifacesByImpl.get(name) || []) wanted.add(iface);
    }
    for (const [paramType, methods] of calledByFile.get(to) || []) {
      if (!wanted.has(paramType)) continue;
      for (const method of methods) if (members.has(method)) return { keep: true, reason: 'member' };
    }
    const injected = injectedByFile.get(to);
    if (injected && [...wanted].some((name) => injected.has(name))) {
      return { keep: false, reason: 'injected-not-called' };
    }
    return { keep: false, reason: 'no-receiver-scoped-call' };
  };
  return { judge, scopable, files, typesByFile, membersByFile };
}

/**
 * Fan-in of every changed file's declaring classes, read from `ctor_field`: the injected
 * interface a `di_binding` maps the class onto, then the distinct classes that inject it.
 * A dependency above `infraFanIn` is infrastructure, and an edit to it widens by
 * construction — the rung prints the reason rather than pretending the selection is tight.
 */
export function sharedDependencies(factSets, changedFiles, { infraFanIn = DEFAULT_INFRA_FANIN } = {}) {
  const wanted = new Set(changedFiles);
  const classesByFile = new Map();
  for (const set of factSets || []) {
    for (const entry of set.facts || []) {
      const declared = entry.class || entry.controller;
      if (!declared || !wanted.has(entry.file)) continue;
      const names = classesByFile.get(entry.file) || new Set();
      names.add(declared);
      classesByFile.set(entry.file, names);
    }
  }
  const ifaceByImpl = new Map();
  for (const { fact } of collect(factSets, 'di_binding')) ifaceByImpl.set(fact.impl, fact.iface);
  const injectors = new Map();
  for (const { fact } of collect(factSets, 'ctor_field')) {
    const set = injectors.get(fact.paramType) || new Set();
    set.add(fact.class);
    injectors.set(fact.paramType, set);
  }
  const found = new Map();
  for (const [file, names] of classesByFile) {
    for (const name of names) {
      const iface = ifaceByImpl.get(name) || name;
      const fanIn = Math.max(injectors.get(iface)?.size ?? 0, injectors.get(name)?.size ?? 0);
      if (fanIn <= infraFanIn) continue;
      const previous = found.get(name);
      if (!previous || previous.fanIn < fanIn) found.set(name, { class: name, iface, fanIn, file });
    }
  }
  return [...found.values()].sort((a, b) => b.fanIn - a.fanIn || compare(a.class, b.class));
}

function strongestOf(levels) {
  let best = null;
  for (const candidate of levels) {
    if (!best || STATE_ORDER[candidate.level] > STATE_ORDER[best.level]) best = candidate;
  }
  return best;
}

/**
 * One row per spec that holds evidence for an affected route, ranked by the strongest
 * seed it covers, then by how many affected routes it touches, then by path. A seed level
 * above `route` is only ever reached through a verdict or a mechanical status promotion,
 * so the seed that carries it is named: the row states what the spec actually proves.
 */
function runList(routes, { specRepo, specTests, whyByRoute }) {
  const rows = new Map();
  for (const route of routes) {
    for (const spec of route.evidence.specs) {
      const row = rows.get(spec) || {
        repo: specRepo.get(spec) || null,
        spec,
        routes: [],
        seedKeys: [],
        levels: [],
        why: [],
      };
      row.routes.push(route.key);
      const named = route.seeds.filter((seed) =>
        (seed.evidence || []).some((label) => label.startsWith(`${spec} :: `)),
      );
      for (const seed of named) {
        row.levels.push({ level: seed.level, key: seed.key, route: route.key, response: seed.response });
        if (seed.key && !row.seedKeys.includes(seed.key)) row.seedKeys.push(seed.key);
      }
      if (named.length === 0) row.levels.push({ level: route.state, key: null, route: route.key, response: null });
      rows.set(spec, row);
    }
  }
  const list = [...rows.values()].map((row) => {
    const strongest = strongestOf(row.levels) || { level: 'none', key: null, route: row.routes[0] };
    const why = [];
    if (strongest.key) {
      why.push(`seed #${strongest.key}${strongest.response ? ` (${strongest.response}, ${strongest.level})` : ` (${strongest.level})`}`);
    }
    why.push(...(whyByRoute.get(strongest.route) || []).slice(0, WHY_CAP - why.length));
    return {
      repo: row.repo,
      spec: row.spec,
      // A file registering intercepts outside any test — a support command — is evidence
      // and must run, but it is not one of the suite's spec files and never counts as one.
      kind: (specTests.get(row.spec) || 0) > 0 ? 'spec' : 'support',
      routes: [...new Set(row.routes)].sort(),
      seedKeys: row.seedKeys.slice().sort(),
      level: strongest.level,
      seedKey: strongest.key,
      why,
    };
  });
  list.sort(
    (a, b) =>
      STATE_ORDER[b.level] - STATE_ORDER[a.level] ||
      b.routes.length - a.routes.length ||
      compare(a.spec, b.spec),
  );
  return list;
}

/**
 * Intersect a diff with the forward route walk and return the specs that hold evidence
 * for the affected routes.
 *
 * `changed` is the output of `attributeChanges`. `keys` is the universe — the reviewed
 * area by default, every route with `--all-routes` — and is walked with `seeds: true`
 * exactly once, the same walk `cover` then reads. `stale` defaults to `staleFactsWarnings`
 * (`lib/facts.js`), which now tells apart two kinds: `head`, a fact set behind a commit
 * this run has not seen, and `worktree`, one that only predates uncommitted edits at the
 * same commit. Only a `head` entry stops the run before a narrowed list exists — a
 * `worktree` one gates nothing, because the edits it predates are exactly what `changed`
 * already reads. Every entry, either kind, is still carried on `report.stale`.
 *
 * `hops` turns on impact widening (off by default, so a caller that never passes it gets
 * the pre-widening output byte for byte): for every changed **source** file, `impact(repo
 * root, path, {hops, noIface})` is called once and every file it returns is unioned into
 * that repository's changed set *before* the route walk below reads it, so a route whose
 * walk only ever touches the file through the interface hop — never the changed
 * file's own name — still counts as affected. Each union is recorded in `report.widened`
 * as `{from, to, via}`; a file scout's index does not cover (no binary, no `scout: true`
 * root, an unresolved seed) simply widens nothing, the same silent-empty discipline
 * `lib/scout.js` already applies everywhere else.
 *
 * `memberScoped` tightens that union onto the member-level receiver-scoped call facts
 * the walk uses: a widened file is kept only when one of its own bodies calls, through a
 * constructor-injected field, a member the changed file declares. Every dropped edge is
 * recorded in `report.widenDropped` with the verdict that dropped it, and the count is
 * stated as a reason line — a narrowing is printed as loudly as a widening. See
 * `receiverScopedIndex` for the rule and for what it deliberately cannot see.
 */
export function affected(factSets, options = {}) {
  const {
    area = null,
    keys = [],
    universeSource = 'area',
    changed = [],
    aliases = [],
    traceOptions = {},
    trace: walk = defaultTrace,
    repos = [],
    maxShare = DEFAULT_MAX_SHARE,
    infraFanIn = DEFAULT_INFRA_FANIN,
    hops = 0,
    noIface = false,
    impact = null,
    // Tighten the widening onto member-level receiver-scoped call facts
    // (`receiverScopedIndex` above). Only meaningful with `hops`; off by default, so a
    // widening run that never asks for it is unchanged.
    memberScoped = false,
    // When set, the C# test classes referencing the changed set are selected
    // as well, and the exit reports that answer: `{repo, root, refs, scopedDirs,
    // maxShare, suite}`. Absent, no .NET filter is computed or attached.
    dotnet = null,
    // When set, Nx's own affected-project list is unioned into the run list:
    // `{repo, root, ref, run}` (`run` only so tests can drive the command boundary). The
    // union is additive in both directions and never touches the backend side. Absent,
    // no Nx project lookup or union runs.
    nx = null,
    // Not CLI-exposed: a programmatic caller can keep only a subset of one impact call's
    // edges (by `via` or `hops`) without a second `scout impact` invocation.
    // `bin/flowtrace.js` never sets it.
    widenFilter = null,
  } = options;
  // `staleFactsWarnings` (and a caller's own `options.stale` override) may still hand back
  // plain strings — the shape every caller used before the head/worktree split — so a bare
  // string is read as `head`, the strict reading the tool has always applied, rather than
  // silently starting to trust an override nobody updated.
  const stale = (options.stale || staleFactsWarnings(factSets, repos)).map((entry) =>
    typeof entry === 'string' ? { message: entry, kind: 'head' } : entry,
  );

  const counts = { source: 0, spec: 0, harness: 0, config: 0, generated: 0, excluded: 0, unmapped: 0 };
  for (const file of changed) counts[file.kind] = (counts[file.kind] || 0) + 1;
  const report = {
    area,
    universe: { source: universeSource, routes: keys.length, seeds: 0 },
    changed: { files: changed, counts },
    routes: [],
    seeds: { affected: 0, universe: 0 },
    specs: [],
    changedSpecs: changed
      .filter((file) => file.kind === 'spec')
      .map((file) => ({ repo: file.repo, spec: file.path })),
    uncovered: [],
    suites: [],
    reasons: [],
    fallbacks: [],
    fullSuite: [],
    widened: [],
    widenDropped: [],
    braked: [],
    // Every stale warning this run saw, `head` and `worktree` alike, so a caller can see
    // what `affected` read even on the runs its own gate below lets through.
    stale,
    ...(dotnet ? { dotnetFilter: null } : {}),
    exit: EXIT.ok,
  };

  const widen = (rung, scope, reason) => {
    report.fallbacks.push({ rung, scope, action: 'full-suite', reason });
    if (scope && !report.fullSuite.includes(scope)) report.fullSuite.push(scope);
    report.exit = EXIT.widened;
  };

  // In `--dotnet-filter` mode the caller asked a different question, so the exit
  // reports the dotnet answer and nothing else: a filter (0), no referencing test class
  // (3), or a widening that emits no filter at all (4). Off, this is a no-op.
  const dotnetVerdict = (reason, fallback) => {
    report.dotnetFilter = {
      classes: [], expression: '', fallback, reason, source: 'none', suite: 0, share: 0, notes: [],
    };
  };
  const foldDotnetExit = () => {
    if (!dotnet || !report.dotnetFilter) return;
    report.exit = report.dotnetFilter.fallback
      ? EXIT.widened
      : report.dotnetFilter.classes.length > 0
        ? EXIT.ok
        : EXIT.nothing;
  };

  // Rung 1 — stale facts, `head`-stale only. Yesterday's graph selects yesterday's specs,
  // and that failure looks exactly like an answer, so nothing is selected at all — but
  // only when the facts are behind a commit this run has not seen. `worktree`-stale facts
  // (HEAD unchanged, only the working tree's dirty digest has moved on) gate nothing: the
  // uncommitted edits they predate are exactly what `changed` already reads for its own
  // diff, so the run below sees them either way. `report.stale` above still carries every
  // warning, `worktree` included, for a caller that wants to see it.
  const headStale = stale.filter((entry) => entry.kind !== 'worktree');
  if (headStale.length > 0) {
    for (const entry of headStale) widen('stale-index', null, entry.message);
    if (dotnet) dotnetVerdict('stale-index: the facts are behind the repository HEAD — nothing is selected at all', true);
    foldDotnetExit();
    return report;
  }

  const factRepos = new Set((factSets || []).map((set) => set.repo));
  const touched = [...new Set(changed.filter((file) => file.repo).map((file) => file.repo))].sort();

  // Rung 2 — a repository the diff touches has no facts at all: nothing can be selected
  // in it, so its suite runs whole.
  for (const repo of touched) {
    if (!factRepos.has(repo)) widen('no-facts', repo, `no facts for repo "${repo}" — nothing to select on`);
  }

  const sourceFiles = changed.filter((file) => file.kind === 'source');
  const specFiles = changed.filter((file) => file.kind === 'spec');
  const harnessFiles = changed.filter((file) => file.kind === 'harness');
  const configFiles = changed.filter((file) => file.kind === 'config' || file.kind === 'generated');
  const harnessRepos = [...new Set(harnessFiles.map((file) => file.repo))].sort();

  // A changed fixture, client or builder is reached by no route walk, so it selects
  // nothing. Whenever there is production source to walk the run list stands and the
  // change is stated; when there is not, the rung below widens instead.
  for (const repo of harnessRepos) {
    const count = harnessFiles.filter((file) => file.repo === repo).length;
    report.reasons.push(
      `harness-change [${repo}]: ${count} changed harness file${count === 1 ? '' : 's'} — no route walk reaches one, so they select nothing`,
    );
  }

  if (sourceFiles.length === 0) {
    // Rung 3 — the diff is specs and nothing else: run exactly those specs.
    if (specFiles.length > 0 && harnessFiles.length === 0) {
      report.reasons.push(
        `spec-only: ${specFiles.length} changed spec file${specFiles.length === 1 ? '' : 's'}, no production source`,
      );
      if (report.exit !== EXIT.widened) report.exit = EXIT.ok;
      if (dotnet) dotnetVerdict('nothing: the diff holds no C# source, so no test class is selected', false);
      foldDotnetExit();
      return report;
    }
    // Rung 4 — a harness change with nothing to walk: which specs import it is a question
    // flowtrace holds no fact about, so the suite runs whole.
    for (const repo of harnessRepos) {
      widen('harness-only', repo, `harness files changed and no production source — the specs importing them are unknown`);
    }
    // Rung 5 — configuration, infrastructure or generated output only.
    if (configFiles.length > 0 && harnessFiles.length === 0) {
      for (const repo of touched) {
        widen('config-only', repo, 'configuration, infrastructure or generated files only — no production source to walk');
      }
    }
    if (dotnet) {
      if (report.exit === EXIT.widened) {
        dotnetVerdict('no-source: configuration, harness or generated files only — no C# source to reference', true);
      } else {
        dotnetVerdict('nothing: the diff holds no C# source, so no test class is selected', false);
      }
    }
    if (report.exit !== EXIT.widened) report.exit = EXIT.nothing;
    foldDotnetExit();
    return report;
  }

  const changedByRepo = new Map();
  for (const file of sourceFiles) {
    const set = changedByRepo.get(file.repo) || new Set();
    set.add(file.path);
    changedByRepo.set(file.repo, set);
  }

  // Impact widening — union each changed source file's `scout impact` blast radius into
  // its repository's changed set, before the route walk below ever reads that set. A file
  // already in the diff widens nothing (it is already counted); one impact call per
  // changed file, never chained onto a file the widening itself just added.
  if (hops > 0 && typeof impact === 'function') {
    report.widenHops = hops;
    const rootByRepo = new Map((repos || []).map((repo) => [repo.id, repo.root]));
    const scopedByRepo = new Map();
    const unscopable = new Set();
    const unreadable = new Set();
    for (const file of sourceFiles) {
      const root = rootByRepo.get(file.repo);
      if (!root) continue;
      const edges = impact(root, file.path, { hops, noIface }) || [];
      const set = changedByRepo.get(file.repo);
      let scoped = null;
      if (memberScoped) {
        if (!scopedByRepo.has(file.repo)) scopedByRepo.set(file.repo, receiverScopedIndex(factSets, file.repo));
        scoped = scopedByRepo.get(file.repo);
      }
      for (const edge of edges) {
        if (!edge || typeof edge.file !== 'string' || set.has(edge.file)) continue;
        if (typeof widenFilter === 'function' && !widenFilter(edge)) continue;
        if (scoped) {
          const verdict = scoped.judge(file.path, edge.file);
          if (!verdict.keep) {
            report.widenDropped.push({
              from: file.path, to: edge.file, via: edge.via || 'direct', reason: verdict.reason,
            });
            continue;
          }
          if (verdict.reason === 'whole-class') unscopable.add(file.path);
          if (verdict.reason === 'no-receiver-facts') unreadable.add(file.repo);
        }
        set.add(edge.file);
        report.widened.push({ from: file.path, to: edge.file, via: edge.via || 'direct' });
      }
      // Interfaces the index's own broad-interface brake held back from widening
      // through for this seed file; surfaced, never silently dropped.
      for (const entry of edges.braked || []) {
        if (entry && typeof entry.iface === 'string') report.braked.push({ from: file.path, ...entry });
      }
    }
    // A narrowing is stated as loudly as a widening: the rung above prints why a run list
    // grew, and this prints why it did not.
    if (memberScoped) {
      // One row per file that was offered and never unioned in, so the dropped count reads
      // against the same denominator `+N files via impact` does. A file two changed files
      // both reach is judged for each of them and kept the moment one keeps it; recording
      // every judgment would count the same file twice and read as a bigger narrowing than
      // it is.
      const kept = new Set(report.widened.map((entry) => entry.to));
      const seen = new Set();
      report.widenDropped = report.widenDropped.filter((entry) => {
        if (kept.has(entry.to) || seen.has(entry.to)) return false;
        seen.add(entry.to);
        return true;
      });
      const byReason = new Map();
      for (const entry of report.widenDropped) byReason.set(entry.reason, (byReason.get(entry.reason) || 0) + 1);
      const offered = report.widened.length + report.widenDropped.length;
      const breakdown = [...byReason].sort((a, b) => b[1] - a[1] || compare(a[0], b[0]));
      report.reasons.push(
        `member-scoped: kept ${report.widened.length} of ${offered} widened file${offered === 1 ? '' : 's'} — ` +
        (breakdown.length > 0
          ? `dropped ${breakdown.map(([reason, count]) => `${count} ${reason}`).join(', ')}`
          : 'nothing dropped') +
        (unscopable.size > 0
          ? `; ${unscopable.size} changed file${unscopable.size === 1 ? '' : 's'} widened whole — the facts declare no member to scope on`
          : '') +
        (unreadable.size > 0
          ? `; widened whole in ${[...unreadable].sort().join(', ')} — that extractor records no constructor-injected receiver`
          : ''),
      );
    }
  }

  // The C# test classes referencing the changed set, read after widening so the
  // filter and the route walk consume one diff and one widening pass between them.
  if (dotnet) {
    const forDotnet = [...(changedByRepo.get(dotnet.repo) || [])].sort();
    // Every C# file the diff names, whatever kind it was classified as: a changed test
    // class runs itself, a changed test base class names the classes deriving from it, and
    // a generated `.cs` is still a type some test references.
    const changedCs = changed
      .filter((file) => file.repo === dotnet.repo && /\.cs$/i.test(file.path))
      .map((file) => file.path)
      .sort();
    const result = buildDotnetFilter({
      root: dotnet.root,
      changed: forDotnet,
      changedCs,
      braked: report.braked,
      refs: dotnet.refs,
      scopedDirs: dotnet.scopedDirs,
      maxShare: dotnet.maxShare ?? DEFAULT_DOTNET_MAX_SHARE,
      suite: dotnet.suite,
    });
    report.dotnetFilter = result;
    for (const note of result.notes || []) report.reasons.push(`dotnet-filter: ${note}`);
    if (result.fallback) widen('dotnet-filter', dotnet.repo, result.reason);
  }

  // Rung 6 — a changed controller declaring no route. The route exists, the facts do not
  // know it, and no spec can be selected for it.
  const routeFiles = new Set(collect(factSets, 'route').map((entry) => entry.fact.file));
  for (const file of sourceFiles) {
    if (!CONTROLLER_PATTERN.test(file.path) || routeFiles.has(file.path)) continue;
    widen('unindexed', file.repo, `unindexed: ${file.path} — a controller declaring no route fact`);
  }

  const memo = new Map();
  const walker = (sets, key, walkOptions) => {
    if (!memo.has(key)) memo.set(key, walk(sets, key, walkOptions));
    return memo.get(key);
  };
  const coverage = cover(factSets, { area: area || 'area', keys, aliases, traceOptions, trace: walker });

  const whyByRoute = new Map();
  const affectedKeys = new Set();
  for (const key of keys) {
    const walked = memo.get(key);
    const hits = new Set();
    for (const node of walked?.nodes || []) {
      if (!node.file) continue;
      if (changedByRepo.get(node.repo)?.has(node.file)) hits.add(node.file);
    }
    if (hits.size === 0) continue;
    affectedKeys.add(key);
    const files = [...hits].sort();
    const root = walked?.root;
    const at = root && root.file ? `${root.file}${root.line ? `:${root.line}` : ''}` : 'no declaring file';
    whyByRoute.set(key, [
      `${key}  (${at})`,
      ...files.slice(0, CHANGED_CAP).map((file) => `${file}  (changed)`),
    ]);
  }

  report.universe.seeds = coverage.totals.seeds;
  report.seeds.universe = coverage.totals.seeds;

  const affectedRoutes = coverage.routes.filter((route) => affectedKeys.has(route.key));
  report.routes = affectedRoutes.map((route) => ({
    key: route.key,
    ref: route.ref,
    file: route.file,
    line: route.line,
    state: route.state,
    seeds: route.seeds.length,
    changed: (whyByRoute.get(route.key) || []).slice(1).map((line) => line.replace(/ {2}\(changed\)$/, '')),
  }));
  report.seeds.affected = affectedRoutes.reduce((sum, route) => sum + route.seeds.length, 0);

  const counted = specCounts(factSets);
  const specOwners = specRepos(factSets);
  report.specs = runList(affectedRoutes, {
    specRepo: specOwners.owner,
    specTests: counted.tests,
    whyByRoute,
  });

  // A spec name claimed by more than one repo (only ever possible across two Cypress
  // harnesses today — mobile and web are the only repos that can share a bare file name)
  // is stated rather than silently resolved: the run list still lists it under one
  // bucket, but the ambiguity is on the record instead of looking like a clean match.
  const flaggedAmbiguous = new Set();
  for (const row of report.specs) {
    if (flaggedAmbiguous.has(row.spec)) continue;
    const claimants = specOwners.ambiguous.get(row.spec);
    if (!claimants) continue;
    flaggedAmbiguous.add(row.spec);
    report.reasons.push(
      `ambiguous-spec: "${row.spec}" names a file in more than one repo (${[...claimants].sort().join(', ')}) — ` +
        `cover's evidence carries the spec name only, so it is attributed here to [${row.repo}]; ` +
        'a genuine collision between two repos cannot be told apart from this one',
    );
  }

  report.uncovered = affectedRoutes
    .filter((route) => route.evidence.specs.length === 0)
    .map((route) => ({
      route: route.key,
      seeds: route.seeds.length,
      scaffold: `flowtrace scaffold${area ? ` --area ${area}` : ''}${route.seeds[0]?.key ? ` --seed ${route.seeds[0].key}` : ''}`,
    }))
    .sort((a, b) => b.seeds - a.seeds || compare(a.route, b.route));

  const selected = new Map();
  const support = new Map();
  for (const row of report.specs) {
    if (!row.repo) continue;
    const bucket = row.kind === 'support' ? support : selected;
    bucket.set(row.repo, (bucket.get(row.repo) || 0) + 1);
  }
  report.suites = [...counted.totals.keys()].sort().map((repo) => {
    const count = selected.get(repo) || 0;
    const total = counted.totals.get(repo) || 0;
    return { repo, selected: count, support: support.get(repo) || 0, total, share: total > 0 ? count / total : 0 };
  });

  for (const entry of sharedDependencies(factSets, [...changedByRepo.values()].flatMap((set) => [...set]), { infraFanIn })) {
    report.reasons.push(
      `shared-dependency: ${entry.class} (fanIn ${entry.fanIn} on ${entry.iface}) — an edit here widens by construction`,
    );
  }

  // Rung 7 — the narrowing stopped paying for itself. A run list that is most of the
  // suite is worse than "run everything", because it is trusted.
  for (const suite of report.suites) {
    if (suite.total === 0 || suite.selected === 0) continue;
    if (suite.share <= maxShare) continue;
    widen(
      'max-share',
      suite.repo,
      `selection saved nothing: ${suite.selected} of ${suite.total} specs (${Math.round(suite.share * 100)} %) above --max-share ${maxShare}`,
    );
  }

  // Nx's project graph, unioned in. Read after the max-share rung on purpose:
  // that rung guards a *narrowing* ("the selection saved nothing"), and a union is not one,
  // so Nx's answer can never push a run into a full-suite fallback. `report.suites` is left
  // alone for the same reason — it is the facts' own denominator, and a spec the facts have
  // never seen has no share of a suite they counted.
  if (nx) unionNxSpecs(report, nx);

  if (report.exit !== EXIT.widened && report.specs.length === 0 && report.changedSpecs.length === 0) {
    report.exit = affectedRoutes.length === 0 ? EXIT.nothing : EXIT.ok;
  }
  foldDotnetExit();
  return report;
}

/**
 * Union the specs Nx's affected-project list owns into `report.specs`.
 *
 * Additive in both directions, and only ever additive: a project Nx calls affected that
 * the route walk never reached is added unconditionally, and a route-derived spec Nx's
 * list does not name stays exactly where it was. A spec both sides name keeps its
 * route-derived row — its seed level, its routes and its `why` are the stronger evidence —
 * and is re-tagged `route+nx` so a reader can still tell that Nx agreed.
 *
 * Every way of not getting an answer lands on the same rung: no `nx.json` above the
 * configured root is a no-op with a stated reason, and a missing binary, a failing command
 * or a malformed reply all print `nx-unavailable` and leave the route-only list standing,
 * untagged and byte-for-byte itself. Neither ever changes the exit code, and neither is
 * ever a silent zero.
 */
function unionNxSpecs(report, nx) {
  const ref = nx.ref === undefined || nx.ref === null || String(nx.ref).trim() === '' ? 'HEAD' : String(nx.ref);
  const record = (reason, extra = {}) => {
    report.nx = { workspace: null, ref, projects: [], added: [], reason, ...extra };
    report.reasons.push(reason);
    return report.nx;
  };

  if (!nx.root) {
    record('nx: no web repository is configured — there is no Nx workspace to ask');
    return;
  }
  const workspace = nxWorkspaceRoot(nx.root);
  if (!workspace) {
    record('nx: no nx.json at or above the configured web repository — nothing to ask Nx about');
    return;
  }
  const { projects, reason } = nxAffectedProjects(workspace, ref, { run: nx.run });
  if (projects === null) {
    record(`nx-unavailable: ${reason} — the route-only list stands unchanged`, { workspace });
    return;
  }

  const index = nxProjects(workspace);
  const owned = new Map();
  const unknown = [];
  for (const name of projects) {
    const project = index.get(name);
    if (!project) {
      unknown.push(name);
      continue;
    }
    for (const entry of nxProjectSpecs(workspace, project)) {
      if (!owned.has(entry.spec)) owned.set(entry.spec, { ...entry, project: name });
    }
  }

  const existing = new Map(report.specs.map((row) => [row.spec, row]));
  for (const row of report.specs) row.via = 'route';
  const added = [];
  let agreed = 0;
  for (const entry of owned.values()) {
    const row = existing.get(entry.spec);
    if (row) {
      row.via = 'route+nx';
      agreed += 1;
      continue;
    }
    added.push({
      repo: nx.repo || null,
      spec: entry.spec,
      kind: 'spec',
      routes: [],
      seedKeys: [],
      level: 'none',
      seedKey: null,
      why: [`nx: project "${entry.project}" is affected (target ${entry.target})`],
      via: 'nx',
      project: entry.project,
      target: entry.target,
    });
  }
  report.specs.push(...added);
  report.specs.sort(
    (a, b) =>
      STATE_ORDER[b.level] - STATE_ORDER[a.level] ||
      b.routes.length - a.routes.length ||
      compare(a.spec, b.spec),
  );

  report.nx = {
    workspace,
    ref,
    projects,
    added: added.map((row) => row.spec),
    reason: null,
  };
  report.reasons.push(
    `nx: ${projects.length} affected project${projects.length === 1 ? '' : 's'}` +
      (projects.length > 0 ? ` (${named(projects)})` : '') +
      ` — +${added.length} spec${added.length === 1 ? '' : 's'} unioned into the run list` +
      (agreed > 0 ? `, ${agreed} already named by the route walk` : '') +
      (unknown.length > 0
        ? `; ${unknown.length} project${unknown.length === 1 ? '' : 's'} declare no project.json in the workspace (${named(unknown)})`
        : ''),
  );
}

function padded(text, width) {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function levelLabel(row) {
  // An Nx-only row holds no seed at all: what it holds is a reason, and the
  // column says so rather than printing the "none" that every seedless row would share.
  if (row.via === 'nx') return `nx: ${row.project}`;
  const level = STATE_ORDER[row.level] > STATE_ORDER.route && row.seedKey
    ? `${row.level} #${row.seedKey}`
    : row.level;
  return row.kind === 'support' ? `${level}  (support file)` : level;
}

function seedCount(count) {
  return `${count} seed${count === 1 ? '' : 's'}`;
}

/** The human page: headline, one run list per suite, the uncovered set, then every reason. */
export function renderAffected(report, { repo = null } = {}) {
  const lines = [];
  const changedSource = report.changed.counts.source || 0;
  const universe = report.area
    ? `area ${report.area} (${report.universe.routes} routes · ${report.universe.seeds} seeds)`
    : `${report.universe.routes} routes · ${report.universe.seeds} seeds`;
  lines.push(`affected — ${changedSource} changed source file${changedSource === 1 ? '' : 's'} · ${universe}`);

  const suites = report.suites.filter((suite) => (repo ? suite.repo === repo : suite.selected > 0));
  const summary = [
    `${report.routes.length} route${report.routes.length === 1 ? '' : 's'} affected`,
    seedCount(report.seeds.affected),
    ...suites.map(
      (suite) =>
        `${suite.selected} of ${suite.total} specs [${suite.repo}]` +
        (suite.support > 0 ? ` (+${suite.support} support)` : ''),
    ),
  ];
  if (report.widenHops) {
    summary.push(
      `+${report.widened.length} files via impact (hops ${report.widenHops})` +
      ((report.widenDropped || []).length > 0 ? ` -${report.widenDropped.length} not member-scoped` : ''),
    );
  }
  // A union that added nothing is stated in the reasons, never in the headline: the run
  // list is the same list either way, and the headline must read the same too.
  if (report.nx && report.nx.added.length > 0) {
    summary.push(`+${report.nx.added.length} spec${report.nx.added.length === 1 ? '' : 's'} via nx`);
  }
  lines.push(summary.join(' · '));

  if (report.braked.length > 0) {
    const byIface = new Map(report.braked.map((entry) => [entry.iface, entry.fanin]));
    const ranked = [...byIface].sort((a, b) => b[1] - a[1]);
    lines.push(
      `braked: ${ranked.length} interface${ranked.length === 1 ? '' : 's'} ` +
      `(${ranked.map(([iface, fanin]) => `${iface} ${fanin}`).join(', ')})`,
    );
  }

  const shown = report.specs.filter((row) => !repo || row.repo === repo);
  const byRepo = new Map();
  for (const row of shown) {
    const list = byRepo.get(row.repo) || [];
    list.push(row);
    byRepo.set(row.repo, list);
  }
  for (const [name, rows] of [...byRepo].sort((a, b) => compare(a[0], b[0]))) {
    const width = Math.max(24, ...rows.map((row) => row.spec.length)) + 2;
    lines.push('');
    lines.push(`${padded(`run list [${name}]`, width + 2)}routes  strongest seed`);
    for (const row of rows) {
      lines.push(`  ${padded(row.spec, width)}${String(row.routes.length).padStart(4)}  ${levelLabel(row)}`);
    }
  }

  const changedSpecs = report.changedSpecs.filter((entry) => !repo || entry.repo === repo);
  if (changedSpecs.length > 0) {
    lines.push('');
    lines.push(`changed specs — ${changedSpecs.length} in the diff, always run`);
    for (const entry of changedSpecs) lines.push(`  ${entry.spec}  [${entry.repo}]`);
  }

  if (report.uncovered.length > 0) {
    const seeds = report.uncovered.reduce((sum, entry) => sum + entry.seeds, 0);
    lines.push('');
    lines.push(
      `uncovered-change — ${report.uncovered.length} affected route${report.uncovered.length === 1 ? '' : 's'} hold no evidence (${seedCount(seeds)})`,
    );
    const width = Math.max(24, ...report.uncovered.map((entry) => entry.route.length)) + 2;
    for (const entry of report.uncovered) {
      lines.push(`  ${padded(entry.route, width)}${String(entry.seeds).padStart(3)} ${entry.seeds === 1 ? 'seed' : 'seeds'}`);
    }
    lines.push(`  scaffold: flowtrace scaffold${report.area ? ` --area ${report.area}` : ''} --seed <key> …`);
  }

  if (report.reasons.length > 0) {
    lines.push('');
    lines.push('reasons');
    for (const reason of report.reasons) lines.push(`  ${reason}`);
  }

  if (report.fallbacks.length > 0) {
    lines.push('');
    lines.push('fallbacks — run the full suite');
    for (const entry of report.fallbacks) {
      lines.push(`  ${entry.rung}${entry.scope ? ` [${entry.scope}]` : ''}: ${entry.reason}`);
    }
    lines.push(
      report.fullSuite.length > 0
        ? `  run the full suite for ${report.fullSuite.join(', ')} — the selection above is not narrower than this`
        : '  run the full suite — the selection above is not narrower than this',
    );
  }

  if (report.exit === EXIT.nothing) {
    lines.push('');
    lines.push('nothing affected — no route in the universe reaches a changed file');
  }
  return lines.join('\n');
}

/**
 * The one line `dotnet test` takes unchanged — `dotnet test --filter "<this>"`. Empty is
 * the whole-suite sentinel: `--filter` omitted is exactly how a caller asks for the whole
 * suite, and every fallback prints its reason on the error stream rather than inventing a
 * token the runner would have to be taught.
 */
export function dotnetArgs(report) {
  return report && report.dotnetFilter && !report.dotnetFilter.fallback
    ? report.dotnetFilter.expression
    : '';
}

/**
 * The one-line file list a Playwright runner accepts unchanged: every selected spec of
 * every Playwright suite, plus the changed specs of that suite, sorted and de-duplicated.
 */
export function playwrightArgs(report, { repo = null, repos = [] } = {}) {
  const playwrightRepos = new Set(
    (repos || []).filter((entry) => entry.kind === 'playwright').map((entry) => entry.id),
  );
  const wanted = (name) => (repo ? name === repo : playwrightRepos.size === 0 || playwrightRepos.has(name));
  const names = new Set();
  for (const row of report.specs) if (wanted(row.repo)) names.add(row.spec);
  for (const entry of report.changedSpecs) if (wanted(entry.repo)) names.add(entry.spec);
  return [...names].sort().join(' ');
}
