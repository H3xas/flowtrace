/**
 * dotnet filter — turn a changed set into the `dotnet test --filter` expression that runs
 * only the C# test classes referencing it.
 *
 * `affected` answers "which specs must run" route-first: it walks forward from a changed
 * backend file to the routes it reaches and the Playwright specs holding evidence for
 * those routes' seeds. A shared serializer, a validation attribute or a value object that
 * never surfaces through a controller action reaches no route, so that answer is "nothing"
 * — while the xUnit suite that does exercise it still runs whole. The edges needed here
 * are different in kind: test-class-to-referenced-type, with no route in between.
 *
 * `dotnet test`'s own selector is an expression over `FullyQualifiedName`, not a file
 * list, so the output shape is an expression: `FullyQualifiedName~A|FullyQualifiedName~B`,
 * one term per matched class. `~` is "contains", so the bare class name selects that class
 * in whatever namespace declares it — a name two namespaces share selects both, which
 * over-selects rather than under-selects, the only direction a run list may err in.
 *
 * Two sources answer "does this test class reference the changed type", and the union of
 * the two is taken because either one alone under-selects:
 *
 *   - the index (`scout refs <Type>`, inbound), which sees constructor-injected and
 *     member-level references a name scan cannot — and whose per-kind row cap silently
 *     drops rows, so it can never be the floor;
 *   - a file scan over the test projects for the changed type's own name and the `I`-form
 *     of it, which has no cap and no index to be stale — the recall floor.
 *
 * Every widening is the same printed rung `affected` already uses: a braked interface, a
 * changed file outside every project of the solution, no test project at all, or a
 * selection above the share cap all print the reason and emit no filter, which is exactly
 * how a caller asks `dotnet test` to run the whole suite.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

/** Above this share of the suite's classes a filter has stopped paying for itself. */
export const DEFAULT_DOTNET_MAX_SHARE = 0.3;

/** Shorter than this a type name matches half the system by accident. */
export const TOKEN_MIN_LENGTH = 4;

/**
 * A project whose name ends in a test suffix is a test project; one that merely contains
 * the word (a shared `*.Testing` helper library, a `*.Tests.Postman` collection) is not.
 */
export const TEST_PROJECT_PATTERN = /\.(?:Tests?|UnitTests?|IntegrationTests?)(?:\.(?:Unit|Integration))?$/i;

/**
 * Inbound kinds strong enough to select a test class on their own: a shared base type, a
 * shared field or return type, a member call, constructor injection, an implemented
 * interface or an overridden method all mean the referencing class is compiled against
 * the changed type's shape, so a change there can break it silently. A plain `imports`
 * edge (a `using`, a namespace import) means only that the file's namespace overlaps —
 * one file can import a namespace with a hundred types and touch none of them — so it
 * is visible in `counts` for diagnostics but never turns into a selection on its own.
 */
const REACH_KINDS = new Set([
  'inherits',
  'uses-type',
  'uses-member',
  'ctor-di',
  'implements',
  'overrides',
]);

const SKIP_DIRECTORIES = new Set(['bin', 'obj', 'node_modules', '.git', '.scout', '.vs', '.idea']);
const TEST_ATTRIBUTE = /\[\s*(?:Xunit\.)?(?:Fact|Theory|Test|TestMethod|TestCase)\s*[\](,]/g;
const CLASS_DECLARATION =
  /(?:^|\n)([^\S\n]*)(?:(?:public|internal|private|protected)\s+)?(?:(?:static|sealed|abstract|partial|unsafe)\s+)*class\s+([A-Za-z_]\w*)/g;
const NAMESPACE_DECLARATION = /(?:^|\n)\s*namespace\s+([A-Za-z_][\w.]*)/;

function compare(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Path segments, so `Foo.Common` never counts as a prefix of `Foo.Common.Tests.Unit`. */
function isUnder(path, directory) {
  if (directory === '' || directory === '.') return true;
  return path === directory || path.startsWith(`${directory}/`);
}

function directoryOf(path) {
  const slash = String(path).lastIndexOf('/');
  return slash === -1 ? '' : String(path).slice(0, slash);
}

function walk(root, relativeDir, match, out, depth = 0) {
  if (depth > 12) return out;
  let entries;
  try {
    entries = readdirSync(join(root, relativeDir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const child = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      walk(root, child, match, out, depth + 1);
    } else if (entry.isFile() && match(entry.name)) {
      out.push(child);
    }
  }
  return out;
}

/**
 * Every project of the solution, and the subset of them that holds tests. The whole set is
 * the scope check's denominator — a changed `.cs` file under no project at all is a file
 * no test project compiles against, and the honest answer for it is the whole suite.
 */
export function discoverProjects(root) {
  const projects = walk(root, '', (name) => name.endsWith('.csproj'), []);
  const dirs = [];
  const testDirs = [];
  for (const file of projects.sort()) {
    const slash = file.lastIndexOf('/');
    const dir = slash === -1 ? '' : file.slice(0, slash);
    const name = basename(file, '.csproj');
    dirs.push(dir);
    if (TEST_PROJECT_PATTERN.test(name)) testDirs.push(dir);
  }
  return { projects: dirs, testProjects: testDirs };
}

/**
 * The class each `[Fact]`/`[Theory]` belongs to: the outermost class declaration before it.
 * Outermost is read off the indentation rather than off a brace count, because a brace
 * count over C# without a parser drifts on the first `{` inside a JSON string literal, and
 * test files are full of them. Only declarations at the file's shallowest class
 * indentation are candidates, so a private helper or a nested fixture class declared
 * inside the test class never takes ownership of the test below it — the wrong owner would
 * spend a filter term on a name `dotnet test` matches nothing with.
 *
 * A nested test class is named by its enclosing class, which is the right term anyway:
 * `dotnet test` builds `Outer+Inner` for it, and `~Outer` matches that.
 */
export function testClassesIn(text) {
  const declarations = [];
  CLASS_DECLARATION.lastIndex = 0;
  for (let hit = CLASS_DECLARATION.exec(text); hit; hit = CLASS_DECLARATION.exec(text)) {
    const indent = hit[1].replace(/\t/g, '    ').length;
    declarations.push({ name: hit[2], at: hit.index, indent });
  }
  if (declarations.length === 0) return [];
  const outermost = Math.min(...declarations.map((declaration) => declaration.indent));
  const top = declarations.filter((declaration) => declaration.indent === outermost);
  const names = new Set();
  TEST_ATTRIBUTE.lastIndex = 0;
  for (let hit = TEST_ATTRIBUTE.exec(text); hit; hit = TEST_ATTRIBUTE.exec(text)) {
    let owner = null;
    for (const declaration of top) {
      if (declaration.at < hit.index) owner = declaration;
      else break;
    }
    if (owner) names.add(owner.name);
  }
  return [...names].sort(compare);
}

/**
 * Every test class of every test project, with the file text kept alongside so the
 * reference scan below reads each file once. A file declaring no test attribute is not a
 * test file: it is a fixture, a builder or a shared base class, and it never runs alone.
 */
export function readTestSuite(root, testProjects) {
  const classes = [];
  const texts = new Map();
  const seen = new Set();
  for (const project of testProjects) {
    for (const file of walk(root, project, (name) => name.endsWith('.cs'), [])) {
      if (seen.has(file)) continue;
      seen.add(file);
      let text;
      try {
        text = readFileSync(join(root, file), 'utf8');
      } catch {
        continue;
      }
      const names = testClassesIn(text);
      if (names.length === 0) continue;
      texts.set(file, text);
      const namespaceHit = NAMESPACE_DECLARATION.exec(text);
      for (const name of names) {
        classes.push({
          file,
          project,
          class: name,
          namespace: namespaceHit ? namespaceHit[1] : null,
        });
      }
    }
  }
  classes.sort((a, b) => compare(a.class, b.class) || compare(a.file, b.file));
  return { classes, texts };
}

/**
 * The type names one changed file can be referenced by. C# names a file after the type it
 * declares, so the basename is the type; the `I`-form is added because a test class that
 * only ever sees the changed class through the interface it is injected as never names the
 * class itself — the constructor-injection hop, spelled as a name rather than as an edge.
 */
export function typeTokens(paths, { minLength = TOKEN_MIN_LENGTH } = {}) {
  const tokens = new Set();
  for (const path of paths || []) {
    const value = String(path || '');
    if (!value.toLowerCase().endsWith('.cs')) continue;
    const name = basename(value, '.cs').trim();
    if (!/^[A-Za-z_]\w*$/.test(name) || name.length < minLength) continue;
    tokens.add(name);
    if (/^I[A-Z]/.test(name)) tokens.add(name.slice(1));
    else tokens.add(`I${name}`);
  }
  return [...tokens].sort(compare);
}

/** The recall floor: which test files name one of the tokens as a whole word. */
export function scanReferences({ classes, texts, tokens }) {
  if (!tokens || tokens.length === 0) return new Map();
  const escaped = tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`\\b(?:${escaped.join('|')})\\b`);
  const hits = new Map();
  for (const row of classes) {
    if (hits.has(row.class)) continue;
    const text = texts.get(row.file);
    if (text && pattern.test(text)) hits.set(row.class, row.file);
  }
  return hits;
}

/**
 * What the index adds on top of the scan: an inbound reference whose text never names the
 * type — a member called on the interface the changed class implements, resolved through
 * the same `ctor-di` edge `impact`'s interface hop already walks. `refs` is
 * `lib/scout.js`'s `inbound`; an index that cannot answer simply adds nothing. Only
 * `REACH_KINDS` turn an edge into a hit — see its own comment for why a bare `imports`
 * edge does not.
 */
export function indexReferences({ classes, tokens, refs, root }) {
  const hits = new Map();
  const asked = (tokens || []).length;
  if (typeof refs !== 'function' || asked === 0) return { hits, unavailable: [], asked };
  const byFile = new Map();
  for (const row of classes) {
    const list = byFile.get(row.file) || [];
    list.push(row.class);
    byFile.set(row.file, list);
  }
  const unavailable = [];
  for (const token of tokens) {
    const edges = refs(root, token) || [];
    if (edges.unavailable) {
      unavailable.push({ token, reason: edges.reason || 'unavailable' });
      continue;
    }
    for (const edge of edges) {
      if (!REACH_KINDS.has(edge && edge.kind)) continue;
      const names = byFile.get(edge.file);
      if (!names) continue;
      for (const name of names) if (!hits.has(name)) hits.set(name, edge.file);
    }
  }
  return { hits, unavailable, asked };
}

/** The one expression `dotnet test --filter` takes, deduplicated and in a stable order. */
export function filterExpression(classNames) {
  return [...new Set(classNames || [])]
    .sort(compare)
    .map((name) => `FullyQualifiedName~${name}`)
    .join('|');
}

/**
 * True when the index's own scope covers a directory — read straight off the manifest the
 * indexer writes, never guessed. `null` scoped dirs (no manifest, or a manifest that names
 * none) means the whole repository is in scope.
 */
export function indexCovers(scopedDirs, directory) {
  if (!Array.isArray(scopedDirs) || scopedDirs.length === 0) return true;
  return scopedDirs.some((scoped) => isUnder(directory, String(scoped).replace(/\/+$/, '')));
}

const empty = (reason, fallback, extra = {}) => ({
  classes: [],
  expression: '',
  fallback,
  reason,
  source: 'none',
  suite: 0,
  share: 0,
  notes: [],
  ...extra,
});

/**
 * Build the filter.
 *
 * `changed` is the production changed set, already unioned with whatever `--hops` widened
 * into it — the scope check reads it, because a production file under no project is the
 * case nothing can be said about. `changedCs` is every C# file the diff names whatever its
 * kind, test files included: a changed test class runs because it changed, exactly as
 * `affected` already always runs a changed spec, and a changed test **base** class is a
 * type name like any other — the classes deriving from it must run too. `braked` is
 * `report.braked`: an interface the index's broad-interface brake held back from widening
 * through means the safe answer is "everyone", never a guess.
 */
export function buildDotnetFilter({
  root,
  changed = [],
  changedCs = [],
  braked = [],
  refs = null,
  scopedDirs = null,
  maxShare = DEFAULT_DOTNET_MAX_SHARE,
  suite = null,
} = {}) {
  if (typeof root !== 'string' || root === '' || !existsSync(root)) {
    return empty('no-root: no backend repository to read test projects from', true);
  }
  const { projects, testProjects } = suite ? suite.discovered : discoverProjects(root);
  if (testProjects.length === 0) {
    return empty('no-tests: no test project found in the repository', true);
  }

  const outside = (changed || []).filter(
    (path) => path.toLowerCase().endsWith('.cs') && !projects.some((dir) => isUnder(path, dir)),
  );
  if (outside.length > 0) {
    return empty(
      `out-of-scope: ${outside[0]}${outside.length > 1 ? ` (+${outside.length - 1} more)` : ''} — ` +
        'a changed file under no project of the solution, so which tests compile against it is unknown',
      true,
    );
  }
  if ((braked || []).length > 0) {
    const names = [...new Set(braked.map((entry) => entry.iface))].sort(compare);
    return empty(
      `braked: ${names.slice(0, 3).join(', ')}${names.length > 3 ? `, +${names.length - 3} more` : ''} — ` +
        'the index held these interfaces back from widening, so the safe answer is the whole suite',
      true,
    );
  }

  const { classes, texts } = suite ? suite.read : readTestSuite(root, testProjects);
  const total = new Set(classes.map((row) => row.class)).size;
  if (total === 0) {
    return empty('no-tests: the test projects declare no test class', true);
  }

  const notes = [];
  const gap = testProjects.filter((project) => !indexCovers(scopedDirs, project));
  if (gap.length > 0) {
    notes.push(
      `index-gap: ${gap.length} of ${testProjects.length} test project${testProjects.length === 1 ? '' : 's'} ` +
        `(${gap[0]}${gap.length > 1 ? `, +${gap.length - 1} more` : ''}) sit outside the index's scoped ` +
        'directories — the file scan carries the reference check for them',
    );
  }

  const named = [...new Set([...(changed || []), ...(changedCs || [])])];
  const tokens = typeTokens(named);
  const scanned = scanReferences({ classes, texts, tokens });
  // The index is asked only about files it was built over: a type declared outside its
  // scoped directories resolves to nothing, and paying a process launch to be told so is
  // the one cost this step can drop without dropping an answer. The scan already covers
  // those files, and covers them without a cap.
  const indexable = named.filter((path) => indexCovers(scopedDirs, directoryOf(path)));
  const indexed = indexReferences({ classes, tokens: typeTokens(indexable), refs, root });
  if (indexed.unavailable.length > 0) {
    const reasons = [...new Set(indexed.unavailable.map((entry) => entry.reason))].sort(compare);
    notes.push(
      `index-unavailable: ${indexed.unavailable.length} of ${indexed.asked} type name${indexed.asked === 1 ? '' : 's'} ` +
        `unresolved (${reasons.join('; ')}) — the file scan answered for them`,
    );
  }

  const selected = new Set([...scanned.keys(), ...indexed.hits.keys()]);
  const byFile = new Map();
  for (const row of classes) {
    const list = byFile.get(row.file) || [];
    list.push(row.class);
    byFile.set(row.file, list);
  }
  for (const path of changedCs || []) {
    for (const name of byFile.get(path) || []) selected.add(name);
  }

  const names = [...selected].sort(compare);
  const share = total > 0 ? names.length / total : 0;
  const source = indexed.hits.size > 0 ? 'index+scan' : 'scan';
  if (names.length > 0 && share > maxShare) {
    return empty(
      `max-share: ${names.length} of ${total} test classes (${Math.round(share * 100)} %) above ` +
        `--max-share ${maxShare} — a filter this wide is worse than running the suite, because it is trusted`,
      true,
      { suite: total, share, source, notes },
    );
  }
  return {
    classes: names,
    expression: filterExpression(names),
    fallback: false,
    reason:
      names.length === 0
        ? 'nothing: no test class references a changed type'
        : `${names.length} of ${total} test classes (${Math.round(share * 100)} %) reference a changed type`,
    source,
    suite: total,
    share,
    notes,
  };
}

/**
 * The suite is read once per process: a replay over many commits pays one directory walk
 * and one pass over the test files, not one per commit.
 */
export function loadSuite(root) {
  const discovered = discoverProjects(root);
  return { discovered, read: readTestSuite(root, discovered.testProjects) };
}
