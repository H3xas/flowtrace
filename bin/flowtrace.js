#!/usr/bin/env node
/**
 * flowtrace command line: extract | join | render | trace | routes-of | span | surface | skeleton |
 * cover | affected | scaffold | cases | readiness | all.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join as joinPath, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../lib/config.js';
import {
  externalLocations, fact, factsHeader, loadFactsProvider, mergeFacts, producerSummary, staleFactsWarnings, validateFacts,
} from '../lib/facts.js';

import * as affectedModule from '../lib/affected.js';
import * as assertionSurfaceModule from '../lib/assertion-surface.js';
import * as casesModule from '../lib/cases.js';
import * as componentSpanModule from '../lib/component-span.js';
import * as coverModule from '../lib/cover.js';
import * as joinModule from '../lib/join.js';
import * as packetsModule from '../lib/packets.js';
import * as readinessModule from '../lib/readiness.js';
import * as renderModule from '../lib/render.js';
import * as renderComponentSpanHtmlModule from '../lib/render-component-span-html.js';
import * as renderCoverModule from '../lib/render-cover.js';
import * as renderGraphModule from '../lib/render-graph.js';
import * as renderHtmlModule from '../lib/render-html.js';
import * as renderSpanHtmlModule from '../lib/render-span-html.js';
import * as renderTreeModule from '../lib/render-tree.js';
import * as renderTreeHtmlModule from '../lib/render-tree-html.js';
import * as routesOfModule from '../lib/routes-of.js';
import * as runtimeCoverModule from '../lib/runtime-cover.js';
import * as scaffoldModule from '../lib/scaffold.js';
import * as scoutModule from '../lib/scout.js';
import * as skeletonModule from '../lib/skeleton.js';
import * as spanModule from '../lib/span.js';
import * as traceModule from '../lib/trace.js';

import * as backendExtractor from '../lib/extract/backend.js';
import * as mobileExtractor from '../lib/extract/mobile.js';
import * as playwrightExtractor from '../lib/extract/playwright.js';
import * as pwTitlesModule from '../lib/extract/pw-titles.js';
import * as webExtractor from '../lib/extract/web.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMMANDS = new Set([
  'extract', 'join', 'render', 'trace', 'routes-of', 'span', 'surface', 'skeleton', 'cover',
  'affected', 'scaffold', 'cases', 'readiness', 'all',
]);
const AREAS_DIR = joinPath(PACKAGE_ROOT, 'areas');
const USAGE = [
  'usage: flowtrace <command> [options]',
  '',
  'commands:',
  '  extract   read every configured repository and write out/facts/<repo>.json',
  '  join      join the fact sets into out/flow.json',
  '  render    write out/report.md and one out/flows/<route>.md per called route',
  '  trace     walk one start to its sinks and print the tree',
  '  routes-of list every entry route whose complete walk passes through one point',
  '  span      write one outcome-first HTML page for one entry route, for a QA reader',
  '  surface   derive where the state one entry route changes can be read back',
  '  skeleton  emit one spec skeleton from a derived assertion surface',
  '  cover     seed-level coverage of one area, from the existing test evidence',
  '  affected  turn a diff into the specs that must run',
  '  scaffold  write a starting spec per route for the seeds no test reaches',
  '  cases     write a human-readable case sheet per route for the seeds no test reaches',
  '  readiness render an area inventory\'s readiness sheet from the existing facts',
  '  all       extract, then join, then render',
  '',
  'options:',
  '  --repo <id>      scope extraction or point/start resolution to one repository',
  '  --config <path>  use this configuration file instead of ./flowtrace.config.json',
  '  -h, --help       show this message',
  '',
  'extract [--repo <id>]',
  '  Reads every configured repository, or the one named, and writes out/facts/<repo>.json.',
  '  A playwright repository configured "titles": true also runs its own installed',
  '  Playwright in list mode and appends one pw_title fact per test declaration the',
  '  listing resolved, so a parameterised title renders as the titles it produces rather',
  '  than as its expression. When that collector cannot run, extraction still succeeds:',
  '  the reason goes to stderr and into the fact set\'s header, and no pw_title fact is',
  '  written.',
  '  A repository configured with a factsProvider also reads that provider\'s fact',
  '  document — a file, or the stdout of a command — validates every fact against the',
  '  schema, stamps each one provenance: { producer, version }, and merges it with the',
  '  extraction under the configured merge mode; the header records both producers and',
  '  how they compared. An invalid record refuses the whole run and names the record.',
  '',
  'routes-of <point> [--symbol | --literal] [--repo <id>] [--max-nodes N] [--json]',
  '  Resolves <point> as repository-relative file:line, then exact method symbol, then',
  '  an exact allowlisted literal. --symbol and --literal force one mode and never fall',
  '  back. --repo scopes point resolution only; originating routes remain cross-repository.',
  '  A resolved point with no routes exits 0. Unresolved or ambiguous input exits 2 and',
  '  returns no route set. An incomplete forward walk exits 4 and returns no partial set.',
  '  JSON output is deterministic and carries schemaVersion 1; neither renderer claims',
  '  that route-level test evidence proves execution of the resolved point.',
  '',
  'trace <start> [--depth N] [--max-nodes N] [--seeds] [--graph] [--json] [--expand]',
  '            [--expand-infra] [--no-fold] [--mermaid] [--html <file>] [--unscoped]',
  '            [--from-handler <selector>] [--cover-overlay] [--specs <list|file>]',
  'trace --area <file>',
  '  <start> is a mobile class or selector, a route key ("POST orders/v1/checkout"),',
  '  a backend Class.Method, a backend class, a web component name, or a web page path',
  '  ("/catalog/collections/:collectionId" — the mount prefix is inferred from the library\'s own',
  '  navigate() literals, so such a start prints tagged "inferred mount"). Facts are read',
  '  from out/facts, never re-extracted. A page, component or service start prints a route',
  '  inventory; --expand walks every route in full. --expand-infra prints the shared-dependency and',
  '  code-index hops the tree collapses to one line; folding (below) still applies on top',
  '  of whatever --expand-infra leaves shown. --area reads a newline list of route keys',
  '  and emits one JSON array, one entry per key. A hop located at a line where an',
  '  externally supplied fact is stated prints [provider]; --json and --graph nodes carry',
  '  provider: true for the same hops.',
  '',
  '  --from-handler <selector> restricts a mobile walk to the subtree rooted at one',
  '  `template_handler` hop, matched by its display form ("(click) onLike()"), the',
  '  compact "click:onLike", or the bare method name "onLike". Several handlers matching',
  '  the selector, or none, is exit 2 — the first case lists what matched, the second',
  '  lists every handler the walk found. Seeds, folding, --graph, --mermaid and --html all',
  '  run on the narrowed walk unchanged; the default walk is untouched without the flag.',
  '',
  '  Folding: the first time a node (same repo, file, line, kind and ref) appears, it',
  '  prints in full; every later appearance is one line, "↑ <label> (see above, ×N)", with no',
  '  children of its own, preventing a shared dependency (a repository, a shared service)',
  '  from printing its whole subtree once per caller. On by default; --no-fold prints every',
  '  occurrence in full. The trailer names the reduction,',
  '  "folded 40 → 25 nodes", when folding actually removed something.',
  '',
  '  --graph forces the code-index hop everywhere the walk would otherwise leave a',
  '  reference unresolved. Used alone, it prints one JSON object `{ nodes, edges }`',
  '  instead of the tree — every node',
  '  carries a stable `id`, a folded node is `{ id, ref }` pointing at its first',
  '  occurrence instead of repeating its subtree, and every edge is `{ from, to, via }`.',
  '  Pass --json together with --graph to keep the full `flowtrace trace --json` shape',
  '  (which also gains folded `{ id, ref }` node stubs) with the code-index hop forced;',
  '  --json wins when both are given.',
  '',
  '  --mermaid prints a `flowchart LR` built from the same folded graph --graph prints as',
  '  JSON: one shaped node per kind (route stadium, db sink cylinder, bus message hexagon,',
  '  branch diamond, component/handler rounded, everything else a rectangle), grouped into',
  '  one subgraph per repository the walk crosses, edges labelled by `via`. Capped at 120',
  '  nodes; past the cap a trailing `%%` comment names how many were cut and points at',
  '  --max-nodes, which bounds the walk itself rather than this render cap. --html <file>',
  '  writes a self-contained HTML page instead: the terminal tree, line for line, produced by',
  '  the same renderer the terminal uses, with a per-line evidence badge beside it — `direct`',
  '  where a verifying test asserts the status a branch answers, an inherited route tier',
  '  everywhere else, nothing where no test names the route. No mermaid, no SVG layout,',
  '  nothing fetched. Both may be combined with --seeds; neither may be combined with --json.',
  '',
  '  --cover-overlay colours every route node by the evidence tier the same index `cover`',
  '  reads already holds for that route: `asserted` (an executing test names the route and',
  '  that test carries an assertion fact), `stubbed-only` (an executing test names it, no',
  '  assertion fact recorded) or `none`. Requires --mermaid or --html; without the flag every',
  '  route node draws neutral instead of tiered. On --mermaid a legend subgraph keys the',
  '  three colours and `%%` comments state what the colouring does not claim; on --html a',
  '  legend block, a summary strip and two notes do the same, and an unoverlaid page says so',
  '  rather than drawing a tier it did not evaluate. Either way: the tier is about the route',
  '  node alone, a skipped test is not evidence, and Cypress evidence can never reach',
  '  `asserted` because the fact schema records no Cypress assertion fact.',
  '  --specs <list|file> narrows the evidence to the named specs first (comma-separated, or a',
  '  file of them one per line; a bare file name or a trailing path segment matches), so a',
  '  node recolours to what that selection alone proves. Without --cover-overlay the',
  '  --mermaid drawing remains neutral, and the',
  '  --html tree text stays byte-identical to the terminal tree either way.',
  '',
  'span "<route key>" [--out <file>] [--specs <list|file>] [--verdict-facts <file>]',
  '  Writes one self-contained HTML page for one entry route, read outcome-first for a',
  '  tester rather than line-first for an engineer. Four sections: a span map (who calls',
  '  the route, the endpoint and the services and stores that own it, its success outcomes,',
  '  one row per fault outcome read through exception_map so a caught fault reads as the',
  '  status it really answers, the messages it publishes and the consumers, processors and',
  '  observable side effects past them — every file:line behind a per-row expander); a test',
  '  ledger tagging each outcome tested, inherited-only or untested, ordered untested fault',
  '  contracts first, then untested branches, then inherited-only, then tested, and inside a',
  '  tier by the route\'s own seed order; an assertion surface grouping, per state the',
  '  route changes, the safe-verb endpoints that read that state back; and an honesty',
  '  strip stating what a static read cannot know. The ledger reconciles with cover: every',
  '  seed cover lists appears exactly once and the three counts sum to that route\'s seed',
  '  count. A tested row names the test',
  '  by its resolved title, and by the case ids case_id facts resolve for',
  '  it when a case-id annotation, a configured call or a same-file table row carries',
  '  one — never by an id the tool invented.',
  '  --out defaults to <out>/span/<route-slug>.html; --specs narrows the evidence exactly as',
  '  it does for trace --cover-overlay. Nothing is fetched and no timestamp is written, so',
  '  two runs over the same facts produce byte-identical pages.',
  '',
  '  --verdict-facts <file> reads cached surface_verdict facts and annotates each',
  '  observation point the assertion-surface section names outright: confirmed shows the',
  '  field, refused shows the note it was refused for, and a point with no cached verdict',
  '  reads "judgment pending" rather than looking unconsidered. The honesty strip gains the',
  '  confirmed/refused/pending counts. Without the flag the page has no verdict annotations',
  '  or verdict counts.',
  '',
  'span --from-component <name> [--file <path-substring>] [--out <file>] [--specs <list|file>]',
  '            [--repo <id>]',
  '  Web kind only. Resolves a web component, page or service name through the',
  '  existing chain — component → handler or method body → action_dispatch → action_def →',
  '  effect_handler → gateway_call → route — and writes one page: a header naming the',
  '  component, the number of routes it resolves to and the number of arms that do not,',
  '  above one of this verb\'s own span sections per resolved route (a fan-out — one action',
  '  answered by two effects, or one effect calling two endpoints — stays two arms; two',
  '  arms landing on the same route still write one section). An arm is unresolved for one',
  '  of four reasons, each printed rather than dropped: its verb template matches no route',
  '  fact (no-route-match); its gateway_call carries resolved: false (the extractor never',
  '  pinned the template, so a matchRoute guess is not trusted even when one lands);',
  '  it dispatches an action no effect_handler answers (no-effect); or the walk\'s own',
  '  depth or node budget ran out before the arm could be explored (walk-limit).',
  '  A mobile-kind name is refused with its reason and writes no page — this verb',
  '  resolves the web chain only. --out defaults to',
  '  <out>/span/component-<slug>.html; --repo scopes which component the name resolves to,',
  '  never the routes behind it.',
  '',
  '  A name declared in more than one file is ambiguous: with no --file, the',
  '  command exits non-zero and lists every candidate\'s declaring file so the reader can',
  '  pick one; --file <path-substring> narrows to the declaration whose file path contains',
  '  the substring, and still errors, listing what --file matched, if that leaves anything',
  '  other than exactly one.',
  '',
  'surface "<route key>" [--json] [--hops N] [--out <file>]',
  '  Derives the assertion surface of one entry route: the stores it writes — the',
  '  synchronous leg and the processor consequences past every message it publishes — and,',
  '  for each of them, the safe-verb endpoints that read that same state back, so a test',
  '  knows where an outcome can be observed. The reverse walk resolves a receiver through',
  '  ctor_field for the declared type and di_binding for the implementation behind an',
  '  interface, and every hop it prints is one fact with a file:line to open.',
  '',
  '  A broken chain is a row, never a guess: no write reached, no call site reading the',
  '  state, no route inside --hops (default 3), or nothing but state-changing routes reading',
  '  it each print as a gap naming what stopped them. No DTO is named — the facts carry no',
  '  return type, so the hops between store and controller are the service methods the state',
  '  travels through. A surface names an endpoint reading the same state; whether one of its',
  '  response fields reflects this particular write is a judgment, not a walk, and stays',
  '  outside the tool. --json emits { route, states, surfaces, gaps, counts, limits } with',
  '  the assertion_surface facts beside it; --out writes that fact set to a file. Nothing is',
  '  fetched and no timestamp is written, so two runs over the same facts agree byte for byte.',
  '',
  'skeleton "<route key>" [--observe <template>] [--helpers <file>] [--verdict-facts <file>]',
  '            [--drafts <dir>] [--out <file>] [--json] [--hops N] [--stub]',
  '  Emits one spec skeleton from the assertion surface of one entry route: one test per',
  '  written state, calling the route and reading that state back through an endpoint the',
  '  surface itself derived. An asynchronous leg polls the read-back, a synchronous one reads',
  '  it once, and every block prints the chain that reached its endpoint, so an assertion is',
  '  re-walked rather than trusted. --observe keeps only the states one derived endpoint can',
  '  observe; it selects among derived endpoints and never adds one.',
  '',
  '  One written state read back through one endpoint is one contract, however many legs',
  '  reach it: two surface rows agreeing on both emit one test rather than the same assertion',
  '  twice. Nothing is dropped — a merged block names every leg it covers with that leg\'s own',
  '  write site and chain, polls when any leg is asynchronous, and leaves its field claim',
  '  unfilled when its legs\' cached verdicts disagree. Legs reaching different endpoints, and',
  '  gaps, keep their own blocks.',
  '',
  '  --drafts <dir> reads the Gherkin drafts `cases --gherkin-draft --out <dir>` wrote and',
  '  titles each block after the drafted acceptance criterion whose own `Then` clause names',
  '  that write — a `db <store>.<method>` sink line for a synchronous leg, a `⇝ <message>`',
  '  publish for an asynchronous one, both from the same walk the surface itself read. The',
  '  block then prints each drafted scenario\'s `#key` and its `When` trigger. A write no',
  '  drafted `Then` names keeps its surface-derived title rather than borrowing the nearest',
  '  scenario, and a route with no draft in the directory at all says so in a TODO at the',
  '  top of the spec.',
  '',
  '  Nothing is invented. A state whose surface is a gap is parked with test.fixme naming',
  '  the gap and its evidence; a route on which nothing resolved is refused outright, and',
  '  --stub writes the gap-only stub instead. --helpers <file> maps "VERB template" to the',
  '  suite client that already sends it ({ module, className, method, args, imports,',
  '  consts }); a request no map names becomes a TODO carrying the pw_request spec:line',
  '  where an existing helper already sends it, never a guessed helper name. Which response',
  '  field reflects a write is a judgment, not a walk: --verdict-facts <file> reads cached',
  '  surface_verdict facts, each carrying the file:line of the projection path it was read',
  '  from, and a state without one asserts that its endpoint answers and marks the field',
  '  claim unfilled. Case ids are never invented — every block carries the case-id placeholder.',
  '  --out writes the spec, --json emits the plan; nothing is fetched and no timestamp is',
  '  written, so two runs over the same surface agree byte for byte.',
  '',
  'cover --area <file|name> [--json] [--md <out>] [--packets <dir>] [--verdicts <dir>]',
  '            [--runtime <file>]',
  '  <name> resolves to areas/<name>.txt. Prints the seed coverage matrix for the area',
  '  and the gap list; --json emits the whole report, --md writes the markdown page.',
  '  --packets <dir> writes one reader packet per route with candidate tests;',
  '  --verdicts <dir> reads reader verdicts back and upgrades seed levels before',
  '  rendering. A "playwright"-kind repo whose .pw.ts specs use page.route stubs adds',
  '  totals.parity and a per-route cypress/',
  '  playwright column, carried by --json unchanged.',
  '',
  '  --runtime <file> joins per-spec runtime line hits against the branch spans facts',
  '  already carry: a cobertura or lcov artifact, or a JSON manifest naming one report',
  '  per spec (and optionally per test). A hit strictly inside a branch names the arm a',
  '  matching status never can, so an outcome-symmetric guard — both arms answering the',
  '  same code — reaches level disposition with verdictSource "runtime-coverage". A hit',
  '  line is not an assertion: it proves the arm ran in that window, nothing more.',
  '  Without the flag nothing is read and the report is the byte-identical static one.',
  '',
  'affected [--diff <range>] [--staged] [--area <file|name>] [--all-routes] [--repo <id>]',
  '            [--json] [--playwright-args] [--dotnet-filter] [--max-share F] [--hops N]',
  '            [--member-scoped] [--nx]',
  '  Intersects a diff with the forward route walk and prints the specs holding evidence',
  '  for the affected routes, ranked by the strongest seed each one covers. --diff takes',
  '  anything "git diff" takes, --staged reads the index, and with neither the working',
  '  tree is read. The universe is the area named by --area, or every route the facts',
  '  declare with --all-routes; one of the two is required, because the denominator is',
  '  the argument. --repo <id> limits the printed run list to one suite.',
  '  --playwright-args collapses it to one line a Playwright runner accepts unchanged;',
  '  --json emits { changed, universe, routes, seeds, specs, uncovered, reasons,',
  '  fallbacks, widened }. Affected routes holding no evidence at all are printed as',
  '  "uncovered-change" — the signal no coverage report gives at the moment of the diff.',
  '',
  '  --dotnet-filter prints the one expression `dotnet test --filter` takes instead of a',
  '  spec list: the C# test classes whose files reference a changed (or widened) type,',
  '  as "FullyQualifiedName~A|FullyQualifiedName~B", deduplicated and sorted. The index',
  '  answers first (`scout refs`, inbound, constructor-injected and member-level hits',
  '  included) and a scan of the test projects for the type name and its I-form is the',
  '  recall floor under it. Empty output is the whole-suite sentinel — `--filter` omitted',
  '  is how `dotnet test` is asked to run everything — printed with its reason on stderr',
  '  when an interface was braked, a changed file sits under no project of the solution,',
  '  or the selection is above --max-share (0.3 of the suite\'s classes by default here).',
  '  --json carries the same answer as dotnetFilter: { classes, expression, fallback,',
  '  reason, source, suite, share, notes }.',
  '',
  '  --hops N widens the changed set before the route walk: for every changed source file,',
  '  `scout impact <file> --hops N` is unioned in, so a caller reached only through the',
  '  interface it depends on (never the changed file\'s own name) still counts. Off by',
  '  default — bare `affected` is unchanged. Widened files are printed as "+N files via',
  '  impact (hops N)" and carried in --json as `widened: [{from, to, via}]`.',
  '',
  '  --member-scoped tightens that widening onto the member-level receiver-scoped call',
  '  facts: a widened file is kept only when one of its own bodies calls, through a',
  '  constructor-injected field, a member the changed file declares — the same reading the',
  '  walk itself uses, instead of the whole-class hop. Requires --hops. Dropped files are',
  '  printed as "-K not member-scoped" with a reason line naming what was dropped and why,',
  '  and carried in --json as `widenDropped: [{from, to, via, reason}]`. A changed file the',
  '  facts declare no member for is widened whole rather than narrowed on absent evidence.',
  '',
  '  --nx unions the web monorepo\'s own answer in (web repositories only). The Nx',
  '  workspace root is found by walking up from the configured web repo until an nx.json',
  '  is; `nx show projects --affected --base <ref> --json` is asked, with <ref> read off',
  '  the same --diff/--staged/working-tree resolution the flowtrace-side diff used, so the',
  '  two never disagree about what changed; and each affected project\'s own project.json',
  '  test/e2e target names the specs it owns. Those specs are unioned in, tagged',
  '  `via: "nx"` against the route walk\'s `via: "route"`, and the union never subtracts in',
  '  either direction. No nx.json is a no-op; a missing nx binary, a failing command or a',
  '  malformed reply print "nx-unavailable" and leave the route-only list standing, with',
  '  the exit code unchanged — never a silent zero, never a hard failure. --json carries',
  '  `nx: { workspace, ref, projects, added, reason }`.',
  '',
  '  Every widening is a printed rung, never a silent one, and exits 4: stale facts',
  '  (a fact set behind its repository HEAD — nothing is selected at all), a repository',
  '  with no facts, a harness change with no production source to walk, a config-only',
  '  diff, a changed controller declaring no route, and a selection above --max-share',
  '  (default 0.5) of a suite. Exit 0 a list was produced, 3 nothing was affected,',
  '  2 usage, 1 refusal.',
  '',
  'scaffold --area <file|name> [--seed KEY ...] [--max-level L] [--out DIR] [--dry-run]',
  '            [--include-unreachable]',
  '  Writes one spec file per route, one test block per seed at or below --max-level',
  '  (none | skipped | route | path; default skipped, i.e. none and skipped), in the',
  '  conventions of the "scaffold" key of the configuration file. --seed KEY restricts',
  '  the run to named seed keys and repeats. --out defaults to <out>/scaffold and is',
  '  refused inside any configured repository. --dry-run prints the index and the first',
  '  spec instead of writing. A seed no black-box caller can force — every value its',
  '  deciding branch reads came from the JWT or an injected dependency — is dropped and',
  '  listed in an "Unreachable from a black-box caller" footer instead;',
  '  --include-unreachable emits it anyway.',
  '',
  'cases --area <file|name> [--seed KEY ...] [--max-level L] [--out DIR] [--dry-run]',
  '          [--include-unreachable] [--gherkin-draft]',
  '  Writes one plain-English case sheet per route, one block per seed at or below',
  '  --max-level (none | skipped | route | path; default skipped, i.e. none and skipped),',
  '  for a person to read, judge and paste into a case-management tool by hand — no API',
  '  is called. Each block states a title, the preconditions in plain words with the',
  '  branch taken or not-taken made explicit, the steps, the expected result, the',
  '  evidence a test already gives it today, and the seed\'s stable `#key`; a `fault` seed',
  '  is left for a person to decide rather than asserted. --seed KEY restricts the run to',
  '  named seed keys and repeats. --out defaults to <out>/cases and is refused inside any',
  '  configured repository. --dry-run prints the index and the first sheet instead of',
  '  writing. Unreachable seeds are dropped and footered exactly as `scaffold` drops them;',
  '  --include-unreachable emits them anyway.',
  '',
  '  --gherkin-draft writes a second, Gherkin-shaped file per route alongside (never replacing)',
  '  the plain sheet, to `<out>/cases/<route-slug>.gherkin-draft.md`: one `## Scenario:` block',
  '  per seed, from the same trace/cover evidence — `Given` the route\'s identity plus the',
  '  acting role, every feature-toggle and branch precondition and a wildcard segment\'s',
  '  existing id (coverage evidence is not a precondition — a stub a spec already exercises',
  '  is stated below the clauses, never fabricated as a disposition), `When` the request',
  '  action alone, `Then` the same status/sinks (or fault decide-instead-of-assert line)',
  '  `--max-level`\'s Expected already states. Unlike the plain sheet, `--gherkin-draft` is not',
  '  gap-filtered by `--max-level` — every route gets one file, one block per seed (a route',
  '  with no seed left after `--seed`/reachability filtering gets a single bare-identity',
  '  block instead of none). The seed\'s stable `#key` rides as a `<!-- -->` comment, never',
  '  a case-tool field, and the case id line is always pending — this writes a second',
  '  markdown shape of the same evidence, never a test-management API call.',
  '',
  'readiness --areas <file> [--md <out>] [--json] [--repo <id>]',
  '  Turns an external area inventory into a per-area readiness sheet, entirely from',
  '  facts already on disk — no new walk beyond the ones `trace`/`cover` already do.',
  '  --areas names a file of `area,glob` rows (blank lines and `#` comments dropped; the',
  '  equivalent two-column markdown table row also reads), one row per glob a `component`',
  '  fact\'s file can match — flowtrace ships no default, since no machine-readable file in',
  '  an external discovery repository is assumed to exist. Per area: components matched,',
  '  distinct backend routes reached, sinks by class (db write/read, publish, worker,',
  '  signalr, a non-signalr push, infra-only), seeds by reachability, the components with',
  '  no backend reach at all (pure UI) and the components whose every non-happy-path seed',
  '  is unreachable (JWT/body-gated). Cypress/Playwright coverage per route prints "n/a"',
  '  when the repositories carry no such facts at all. Prints the join rate and the unmatched',
  '  component list. --json emits the whole report; --md writes the markdown page.',
].join('\n');

class UsageError extends Error {}

function version() {
  try {
    const manifest = JSON.parse(readFileSync(joinPath(PACKAGE_ROOT, 'package.json'), 'utf8'));
    return manifest.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function display(target) {
  const relativePath = relative(process.cwd(), target);
  return relativePath && !relativePath.startsWith('..') ? relativePath : target;
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

/** Non-fatal, off the stdout stream a downstream `--json` parses. */
function warn(message) {
  process.stderr.write(`${message}\n`);
}

function writeJson(target, value) {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

function parseArgs(argv) {
  const options = {
    command: undefined,
    start: undefined,
    repo: undefined,
    config: undefined,
    help: false,
    depth: undefined,
    maxNodes: undefined,
    seeds: false,
    graph: false,
    json: false,
    mermaid: false,
    html: undefined,
    expand: false,
    expandInfra: false,
    unscoped: false,
    fromHandler: undefined,
    fold: true,
    area: undefined,
    areas: undefined,
    md: undefined,
    packets: undefined,
    verdicts: undefined,
    runtime: undefined,
    seedKeys: [],
    maxLevel: undefined,
    out: undefined,
    dryRun: false,
    includeUnreachable: false,
    gherkinDraft: false,
    diff: undefined,
    staged: false,
    allRoutes: false,
    playwrightArgs: false,
    dotnetFilter: false,
    maxShare: undefined,
    hops: undefined,
    memberScoped: false,
    nx: false,
    coverOverlay: false,
    specs: undefined,
    baseline: undefined,
    writeBaseline: false,
    fromComponent: undefined,
    file: undefined,
    observe: undefined,
    helpers: undefined,
    verdictFacts: undefined,
    drafts: undefined,
    stub: false,
    maxSpecs: undefined,
    maxLines: undefined,
    symbol: false,
    literal: false,
  };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '-h' || argument === '--help') {
      options.help = true;
    } else if (argument === '--seeds') {
      options.seeds = true;
    } else if (argument === '--expand') {
      options.expand = true;
    } else if (argument === '--expand-infra') {
      options.expandInfra = true;
    } else if (argument === '--unscoped') {
      options.unscoped = true;
    } else if (argument === '--no-fold') {
      options.fold = false;
    } else if (argument === '--dry-run') {
      options.dryRun = true;
    } else if (argument === '--include-unreachable') {
      options.includeUnreachable = true;
    } else if (argument === '--gherkin-draft') {
      options.gherkinDraft = true;
    } else if (argument === '--staged') {
      options.staged = true;
    } else if (argument === '--all-routes') {
      options.allRoutes = true;
    } else if (argument === '--playwright-args') {
      options.playwrightArgs = true;
    } else if (argument === '--dotnet-filter') {
      options.dotnetFilter = true;
    } else if (argument === '--member-scoped') {
      options.memberScoped = true;
    } else if (argument === '--nx') {
      options.nx = true;
    } else if (argument === '--max-specs' || argument.startsWith('--max-specs=')) {
      const value = argument.startsWith('--max-specs=') ? argument.slice('--max-specs='.length) : argv[++index];
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new UsageError('--max-specs requires a positive whole number');
      }
      options.maxSpecs = parsed;
    } else if (argument === '--max-lines' || argument.startsWith('--max-lines=')) {
      const value = argument.startsWith('--max-lines=') ? argument.slice('--max-lines='.length) : argv[++index];
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new UsageError('--max-lines requires a positive whole number');
      }
      options.maxLines = parsed;
    } else if (argument === '--cover-overlay') {
      options.coverOverlay = true;
    } else if (argument === '--write-baseline') {
      options.writeBaseline = true;
    } else if (argument === '--stub') {
      options.stub = true;
    } else if (argument === '--observe' || argument.startsWith('--observe=')) {
      const value = argument.startsWith('--observe=') ? argument.slice('--observe='.length) : argv[++index];
      if (value === undefined || value.startsWith('-')) throw new UsageError('--observe requires an endpoint template');
      options.observe = value;
    } else if (argument === '--helpers' || argument.startsWith('--helpers=')) {
      const value = argument.startsWith('--helpers=') ? argument.slice('--helpers='.length) : argv[++index];
      if (value === undefined || value.startsWith('-')) throw new UsageError('--helpers requires a file');
      options.helpers = value;
    } else if (argument === '--drafts' || argument.startsWith('--drafts=')) {
      const value = argument.startsWith('--drafts=') ? argument.slice('--drafts='.length) : argv[++index];
      if (value === undefined || value.startsWith('-')) throw new UsageError('--drafts requires a directory');
      options.drafts = value;
    } else if (argument === '--verdict-facts' || argument.startsWith('--verdict-facts=')) {
      const value = argument.startsWith('--verdict-facts=')
        ? argument.slice('--verdict-facts='.length)
        : argv[++index];
      if (value === undefined || value.startsWith('-')) throw new UsageError('--verdict-facts requires a file');
      options.verdictFacts = value;
    } else if (argument === '--baseline' || argument.startsWith('--baseline=')) {
      const value = argument.startsWith('--baseline=') ? argument.slice('--baseline='.length) : argv[++index];
      if (value === undefined || value.startsWith('-')) throw new UsageError('--baseline requires a file');
      options.baseline = value;
    } else if (argument === '--specs' || argument.startsWith('--specs=')) {
      const value = argument.startsWith('--specs=') ? argument.slice('--specs='.length) : argv[++index];
      if (value === undefined || value.startsWith('-')) throw new UsageError('--specs requires a spec list or file');
      options.specs = value;
    } else if (argument === '--diff' || argument.startsWith('--diff=')) {
      const value = argument.startsWith('--diff=') ? argument.slice('--diff='.length) : argv[++index];
      if (value === undefined || value.startsWith('-')) throw new UsageError('--diff requires a range');
      options.diff = value;
    } else if (argument === '--max-share' || argument.startsWith('--max-share=')) {
      const value = argument.startsWith('--max-share=') ? argument.slice('--max-share='.length) : argv[++index];
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
        throw new UsageError('--max-share requires a fraction above 0 and at most 1');
      }
      options.maxShare = parsed;
    } else if (argument === '--hops' || argument.startsWith('--hops=')) {
      const value = argument.startsWith('--hops=') ? argument.slice('--hops='.length) : argv[++index];
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new UsageError('--hops requires a positive whole number');
      }
      options.hops = parsed;
    } else if (argument === '--graph') {
      options.graph = true;
    } else if (argument === '--json') {
      options.json = true;
    } else if (argument === '--symbol') {
      options.symbol = true;
    } else if (argument === '--literal') {
      options.literal = true;
    } else if (argument === '--mermaid') {
      options.mermaid = true;
    } else if (argument === '--html' || argument.startsWith('--html=')) {
      const value = argument.startsWith('--html=') ? argument.slice('--html='.length) : argv[++index];
      if (value === undefined || value.startsWith('-')) throw new UsageError('--html requires a file');
      options.html = value;
    } else if (argument === '--from-handler' || argument.startsWith('--from-handler=')) {
      const value = argument.startsWith('--from-handler=') ? argument.slice('--from-handler='.length) : argv[++index];
      if (value === undefined || value.startsWith('-')) throw new UsageError('--from-handler requires a selector');
      options.fromHandler = value;
    } else if (argument === '--from-component' || argument.startsWith('--from-component=')) {
      const value = argument.startsWith('--from-component=') ? argument.slice('--from-component='.length) : argv[++index];
      if (value === undefined || value.startsWith('-')) throw new UsageError('--from-component requires a component name');
      options.fromComponent = value;
    } else if (argument === '--file' || argument.startsWith('--file=')) {
      const value = argument.startsWith('--file=') ? argument.slice('--file='.length) : argv[++index];
      if (value === undefined || value.startsWith('-')) throw new UsageError('--file requires a path substring');
      options.file = value;
    } else if (argument === '--max-nodes' || argument.startsWith('--max-nodes=')) {
      const value = argument.startsWith('--max-nodes=') ? argument.slice('--max-nodes='.length) : argv[++index];
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new UsageError('--max-nodes requires a positive whole number');
      }
      options.maxNodes = parsed;
    } else if (argument === '--depth' || argument.startsWith('--depth=')) {
      const value = argument.startsWith('--depth=') ? argument.slice('--depth='.length) : argv[++index];
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new UsageError('--depth requires a positive whole number');
      }
      options.depth = parsed;
    } else if (argument === '--area' || argument.startsWith('--area=')) {
      const value = argument.startsWith('--area=') ? argument.slice('--area='.length) : argv[++index];
      if (value === undefined || value.startsWith('-')) throw new UsageError('--area requires a file');
      options.area = value;
    } else if (argument === '--areas' || argument.startsWith('--areas=')) {
      const value = argument.startsWith('--areas=') ? argument.slice('--areas='.length) : argv[++index];
      if (value === undefined || value.startsWith('-')) throw new UsageError('--areas requires a file');
      options.areas = value;
    } else if (argument === '--md' || argument.startsWith('--md=')) {
      const value = argument.startsWith('--md=') ? argument.slice('--md='.length) : argv[++index];
      if (value === undefined || value.startsWith('-')) throw new UsageError('--md requires a file');
      options.md = value;
    } else if (argument === '--packets' || argument.startsWith('--packets=')) {
      const value = argument.startsWith('--packets=') ? argument.slice('--packets='.length) : argv[++index];
      if (value === undefined || value.startsWith('-')) throw new UsageError('--packets requires a directory');
      options.packets = value;
    } else if (argument === '--seed' || argument.startsWith('--seed=')) {
      const value = argument.startsWith('--seed=') ? argument.slice('--seed='.length) : argv[++index];
      if (value === undefined || value.startsWith('-')) throw new UsageError('--seed requires a seed key');
      options.seedKeys.push(value);
    } else if (argument === '--max-level' || argument.startsWith('--max-level=')) {
      const value = argument.startsWith('--max-level=') ? argument.slice('--max-level='.length) : argv[++index];
      if (value === undefined || value.startsWith('-')) throw new UsageError('--max-level requires a level');
      options.maxLevel = value;
    } else if (argument === '--out' || argument.startsWith('--out=')) {
      const value = argument.startsWith('--out=') ? argument.slice('--out='.length) : argv[++index];
      if (value === undefined || value.startsWith('-')) throw new UsageError('--out requires a path');
      options.out = value;
    } else if (argument === '--verdicts' || argument.startsWith('--verdicts=')) {
      const value = argument.startsWith('--verdicts=') ? argument.slice('--verdicts='.length) : argv[++index];
      if (value === undefined || value.startsWith('-')) throw new UsageError('--verdicts requires a directory');
      options.verdicts = value;
    } else if (argument === '--runtime' || argument.startsWith('--runtime=')) {
      const value = argument.startsWith('--runtime=') ? argument.slice('--runtime='.length) : argv[++index];
      if (value === undefined || value.startsWith('-')) {
        throw new UsageError('--runtime requires a coverage artifact or manifest');
      }
      options.runtime = value;
    } else if (argument === '--repo' || argument === '--config') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new UsageError(`${argument} requires a value`);
      }
      index += 1;
      if (argument === '--repo') options.repo = value;
      else options.config = value;
    } else if (argument.startsWith('--repo=')) {
      options.repo = argument.slice('--repo='.length);
    } else if (argument.startsWith('--config=')) {
      options.config = argument.slice('--config='.length);
    } else if (argument.startsWith('-')) {
      throw new UsageError(`unknown option "${argument}"`);
    } else {
      positional.push(argument);
    }
  }
  options.command = positional[0];
  if (
    options.command === 'trace' ||
    options.command === 'routes-of' ||
    options.command === 'span' ||
    options.command === 'surface' ||
    options.command === 'skeleton'
  ) {
    if (positional.length > 2) throw new UsageError(`unexpected argument "${positional[2]}"`);
    options.start = positional[1];
  } else if (positional.length > 1) {
    throw new UsageError(`unexpected argument "${positional[1]}"`);
  }
  return options;
}

/**
 * One extractor module per repository kind. Statically imported, never resolved from
 * disk at run time: a single-file build has no `lib/` beside the executable.
 */
const EXTRACTORS = {
  backend: backendExtractor,
  contracts: backendExtractor,
  mobile: mobileExtractor,
  playwright: playwrightExtractor,
  web: webExtractor,
};

function loadExtractor(repo) {
  const module = EXTRACTORS[repo.kind];
  if (!module || typeof module.extract !== 'function') {
    throw new Error(
      `no extractor for kind "${repo.kind}" (repo "${repo.id}"): expected one of ${Object.keys(EXTRACTORS).join(', ')}`,
    );
  }
  return module.extract;
}

function sanitiseKey(key) {
  return String(key)
    .toLowerCase()
    .replace(/\*/g, 'star')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'route';
}

async function runExtract(config, repoFilter) {
  const repos = repoFilter ? config.repos.filter((repo) => repo.id === repoFilter) : config.repos;
  if (repos.length === 0) {
    throw new Error(`no repo with id "${repoFilter}" in ${display(config.file)}`);
  }
  const factsDir = joinPath(config.out, 'facts');
  mkdirSync(factsDir, { recursive: true });
  for (const repo of repos) {
    const extract = loadExtractor(repo);
    let facts = await extract(repo.root, {
      exclude: repo.exclude,
      featureRoots: repo.featureRoots,
      cypress: repo.cypress,
      srcSubpath: repo.srcSubpath,
      cypressSubpath: repo.cypressSubpath,
      caseIdCalls: config.caseId ? config.caseId.calls : [],
      workerPatterns: config.workerPatterns,
    });
    let count;
    try {
      count = validateFacts(facts);
    } catch (error) {
      throw new Error(`repo "${repo.id}": ${error.message}`);
    }
    // Title enrichment is opt-in per playwright repository and never fatal: a collector
    // that cannot run leaves the facts as they are, says why on stderr, and records the
    // reason in the header so a `raw` title can be explained later.
    let titles = null;
    let titleNote = '';
    if (repo.titles) {
      const collected = pwTitlesModule.collectTitles(repo.root, { preloadDir: config.out });
      if (collected.status === 'ok') {
        const extra = pwTitlesModule.titleFacts(facts, collected.titlesByLine);
        facts.push(...extra);
        titles = { status: 'ok', facts: extra.length };
        titleNote = `, ${plural(extra.length, 'title')}`;
      } else {
        warn(`flowtrace: titles ${repo.id}: ${collected.reason}`);
        titles = { status: 'failed', reason: collected.reason };
        titleNote = ', titles unavailable';
      }
    }
    // An external provider is opt-in per repository and, unlike the title collector,
    // fatal when it fails: a fact set silently missing what was configured would be a
    // number nobody could point at a fact for. Every fact it supplies is stamped with its
    // provenance; the extractor's own carry none, which is how a reader tells them apart.
    let provider = null;
    let countNote = plural(count, 'fact');
    if (repo.factsProvider) {
      let loaded;
      try {
        loaded = loadFactsProvider(repo, repo.factsProvider);
      } catch (error) {
        throw new Error(`repo "${repo.id}": ${error.message}`);
      }
      const { merge } = repo.factsProvider;
      const merged = mergeFacts(facts, loaded.facts, { mode: merge, producer: loaded.producer, version: loaded.version });
      facts = merged.facts;
      provider = {
        producer: loaded.producer,
        version: loaded.version,
        source: loaded.source,
        merge,
        supplied: merged.supplied,
        kept: merged.kept,
        replaced: merged.replaced,
        comparison: merged.comparison,
      };
      countNote =
        merge === 'regex-only-with-diff'
          ? `${plural(facts.length, 'fact')} (${loaded.producer} compared, ${merge})`
          : `${plural(facts.length, 'fact')} (${count - merged.replaced} extracted, ${merged.kept} from ${loaded.producer}, ${merge})`;
    }
    const target = joinPath(factsDir, `${repo.id}.json`);
    writeJson(
      target,
      factsHeader({
        repo: repo.id, kind: repo.kind, root: repo.root, generatedFrom: `flowtrace ${version()}`, facts, titles, provider,
      }),
    );
    log(`extract ${repo.id} (${repo.kind}): ${countNote}${titleNote} -> ${display(target)}`);
  }
}

function loadFactSets(config) {
  const factsDir = joinPath(config.out, 'facts');
  const files = existsSync(factsDir)
    ? readdirSync(factsDir).filter((name) => name.endsWith('.json')).sort()
    : [];
  if (files.length === 0) {
    throw new Error(`no fact files in ${display(factsDir)} — run "flowtrace extract" first`);
  }
  return files.map((name) => {
    const target = joinPath(factsDir, name);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(target, 'utf8'));
    } catch (error) {
      throw new Error(`${display(target)}: not valid JSON (${error.message})`);
    }
    return {
      repo: parsed.repo ?? basename(name, '.json'),
      kind: parsed.kind,
      facts: Array.isArray(parsed.facts) ? parsed.facts : [],
      headSha: parsed.headSha,
      dirty: parsed.dirty,
      dirtyDigest: parsed.dirtyDigest,
      generatedAt: parsed.generatedAt,
      fileCount: parsed.fileCount,
      generatedFrom: parsed.generatedFrom,
      provider: parsed.provider,
    };
  });
}

/**
 * Mark every hop of a finished walk that sits at a `repo:file:line` where some fact set
 * carries an externally supplied fact, so the tree, `--json` and `--graph` can say so.
 * The walk itself is untouched: this is a statement about the fact file's contents at
 * that location, which is exactly what a reader can go and check.
 */
function markProviderHops(result, factSets) {
  const locations = externalLocations(factSets);
  if (locations.size === 0 || !result || !result.root) return;
  const seen = new Set();
  const visit = (node) => {
    if (!node || seen.has(node)) return;
    seen.add(node);
    if (node.file && locations.has(`${node.repo}|${node.file}|${node.line}`)) node.provider = true;
    for (const child of node.children || []) visit(child);
  };
  visit(result.root);
  for (const node of result.nodes || []) visit(node);
}

/** One `warn()` per repo `staleFactsWarnings` finds stale — stderr only, always silent on fresh or legacy facts. */
function warnStaleFacts(factSets, repos) {
  for (const message of staleFactsWarnings(factSets, repos)) warn(message);
}

async function runJoin(config) {
  const factSets = loadFactSets(config);
  const { join } = joinModule;
  const flow = join(factSets, { aliases: config.aliases });
  const target = joinPath(config.out, 'flow.json');
  writeJson(target, flow);
  const edges = Array.isArray(flow?.edges) ? flow.edges.length : 0;
  log(`join ${plural(factSets.length, 'fact set')}: ${plural(edges, 'edge')} -> ${display(target)}`);
}

function loadFlow(config) {
  const target = joinPath(config.out, 'flow.json');
  if (!existsSync(target)) {
    throw new Error(`no flow at ${display(target)} — run "flowtrace join" first`);
  }
  return JSON.parse(readFileSync(target, 'utf8'));
}

async function runRender(config) {
  const flow = loadFlow(config);
  const { renderReport, renderMermaid } = renderModule;

  const generated = `flowtrace ${version()} · ${new Date().toISOString()}`;
  const reportTarget = joinPath(config.out, 'report.md');
  // The fact sets are read again here, not taken from the flow: who wrote each fact is
  // stated in the fact file, and the report counts from that rather than from a summary.
  const producers = producerSummary(loadFactSets(config));
  writeFileSync(reportTarget, `${renderReport(flow, { generated, producers })}\n`);

  const flowsDir = joinPath(config.out, 'flows');
  mkdirSync(flowsDir, { recursive: true });
  const routeKeys = [...new Set(flow.edges.filter((edge) => edge.kind === 'calls').map((edge) => edge.key))];
  for (const key of routeKeys) {
    const body = [`# ${key}`, '', '```mermaid', renderMermaid(flow, { endpoint: key }), '```', ''].join('\n');
    writeFileSync(joinPath(flowsDir, `${sanitiseKey(key)}.md`), body);
  }
  log(
    `render ${plural(routeKeys.length, 'flow')} -> ${display(flowsDir)}, report -> ${display(reportTarget)}`,
  );
}

function traceNodeFields(node) {
  const record = {
    repo: node.repo,
    kind: node.kind,
    ref: node.ref,
    file: node.file ?? null,
    line: node.line ?? null,
    via: node.via,
    hops: node.hops,
  };
  for (const field of [
    'sink',
    'unresolved',
    'cycle',
    'leaf',
    'graph',
    'dropped',
    'caller',
    'branchKind',
    'primary',
    'collapsed',
    'responseKind',
    'access',
    'accessGuess',
    'accessUnknown',
    'infra',
    'text',
    'class',
    'method',
    'workType',
    'bindings',
    'match',
    'fqn',
    'fqns',
    'queue',
    'contract',
    'derivedName',
    'crossRepo',
    'homeRepo',
    'selfCall',
    'attach',
    'event',
    'endLine',
    'methods',
    'methodDepth',
    'provider',
  ]) {
    if (node[field] !== undefined) record[field] = node[field];
  }
  return record;
}

function traceNode(node) {
  return { id: node.id, ...traceNodeFields(node) };
}

const INVENTORY_KINDS = new Set(['page', 'component', 'service']);

/**
 * `nodes`/`edges` are the folded graph: the first occurrence of a node in
 * full, every later occurrence a `{ id, ref }` stub with its subtree left out. `fold:
 * false` (`--no-fold`) returns the graph exactly as the walk produced it, one full
 * record per node, matching the unfolded shape byte for byte.
 */
function traceResult(result, options, foldedGraph) {
  const graph = foldedGraph(result, { fold: options.fold !== false, nodeFields: traceNodeFields });
  return {
    root: traceNode(result.root),
    nodes: graph.nodes,
    edges: graph.edges,
    sinks: result.sinks.map(traceNode),
    branches: result.branches.map(traceNode),
    seeds: result.seeds,
    seedsTruncated: result.seedsTruncated,
    stats: result.stats,
  };
}

async function runTrace(config, options) {
  if ((options.html || options.mermaid) && options.json) {
    process.stderr.write('flowtrace: --html and --mermaid cannot combine with --json\n');
    return 2;
  }
  if (options.coverOverlay && !options.mermaid && !options.html) {
    process.stderr.write('flowtrace: --cover-overlay requires --mermaid or --html\n');
    return 2;
  }
  if (options.specs !== undefined && !options.coverOverlay) {
    process.stderr.write('flowtrace: --specs requires --cover-overlay\n');
    return 2;
  }
  const factSets = loadFactSets(config);
  warnStaleFacts(factSets, config.repos);
  const { trace, resolveStart } = traceModule;
  const { renderTree, colorEnabled, foldedGraph } = renderTreeModule;
  const { createScout } = scoutModule;
  const scout = createScout({
    bin: config.scout ? config.scout.bin : undefined,
    outDir: config.out,
    repos: config.repos,
  });
  const shared = {
    depth: options.depth,
    maxNodes: options.maxNodes,
    graph: options.graph,
    repo: options.repo,
    unscoped: options.unscoped,
    aliases: config.aliases,
    sinks: config.sinks,
    consumerEntryMethods: config.workerPatterns.consumerEntryMethods,
    repos: config.repos,
    outbound: scout.outbound,
  };

  if (options.area) {
    const keys = readFileSync(options.area, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    const results = keys.map((key) => {
      const walked = trace(factSets, key, { ...shared, seeds: true });
      if (walked.candidates) return { key, error: 'ambiguous start', candidates: walked.candidates };
      if (walked.error) return { key, error: walked.error };
      markProviderHops(walked, factSets);
      return { key, ...traceResult(walked, options, foldedGraph) };
    });
    log(JSON.stringify(results, null, 2));
    return 0;
  }

  const resolved = resolveStart(factSets, options.start, { repo: options.repo, strictComponentNames: true });
  if (resolved.candidates) {
    process.stderr.write(`flowtrace: "${options.start}" matches ${resolved.candidates.length} starts:\n`);
    for (const candidate of resolved.candidates) process.stderr.write(`  ${candidate}\n`);
    return 2;
  }
  if (resolved.error) {
    process.stderr.write(`flowtrace: ${resolved.error}\n`);
    return 2;
  }
  const inventory = !options.expand && INVENTORY_KINDS.has(resolved.node.kind);
  const result = trace(factSets, options.start, {
    ...shared,
    index: resolved.index,
    startNode: resolved.node,
    seeds: options.seeds,
    inventory,
    fromHandler: options.fromHandler,
  });
  markProviderHops(result, factSets);
  if (result.fromHandlerCandidates) {
    process.stderr.write(`flowtrace: "${options.fromHandler}" matches ${result.fromHandlerCandidates.length} handlers:\n`);
    for (const candidate of result.fromHandlerCandidates) process.stderr.write(`  ${candidate}\n`);
    return 2;
  }
  if (result.fromHandlerError) {
    process.stderr.write(`flowtrace: ${result.fromHandlerError}\n`);
    if (result.fromHandlerAvailable && result.fromHandlerAvailable.length > 0) {
      process.stderr.write('available handlers:\n');
      for (const handler of result.fromHandlerAvailable) process.stderr.write(`  ${handler}\n`);
    } else {
      process.stderr.write('no template handlers found in this walk\n');
    }
    return 2;
  }
  if (options.json) {
    log(JSON.stringify(traceResult(result, options, foldedGraph), null, 2));
    return 0;
  }
  if (options.html || options.mermaid) {
    const { buildCoverOverlay } = renderGraphModule;
    let coverOverlay = null;
    if (options.coverOverlay) {
      const specsText =
        options.specs === undefined
          ? ''
          : existsSync(options.specs)
            ? readFileSync(options.specs, 'utf8')
            : options.specs;
      coverOverlay = buildCoverOverlay(factSets, { specs: specsText, aliases: config.aliases });
      for (const token of coverOverlay.unmatchedSpecs) {
        process.stderr.write(`flowtrace: --specs "${token}" matches no spec in the facts\n`);
      }
    }
    if (options.mermaid) {
      const { renderMermaid } = renderGraphModule;
      const graph = foldedGraph(result, { fold: options.fold !== false, nodeFields: traceNodeFields });
      log(renderMermaid(graph, { coverOverlay }));
    }
    if (options.html) {
      const { renderTreeHtml } = renderTreeHtmlModule;
      const target = resolve(options.html);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(
        target,
        renderTreeHtml(result, {
          title: `flowtrace: ${options.start}`,
          factSets,
          coverOverlay,
          expandInfra: options.expandInfra,
          fold: options.fold !== false,
        }),
      );
      log(`html -> ${display(target)}`);
    }
    return 0;
  }
  if (options.graph) {
    const graph = foldedGraph(result, { fold: options.fold !== false, nodeFields: traceNodeFields });
    const edges = graph.edges.map((edge) => ({ from: edge.from, to: edge.to, via: edge.via }));
    log(JSON.stringify({ nodes: graph.nodes, edges }, null, 2));
    return 0;
  }
  log(
    renderTree(result, {
      color: colorEnabled(),
      seeds: options.seeds,
      expandInfra: options.expandInfra,
      fold: options.fold !== false,
    }),
  );
  return 0;
}

async function runRoutesOf(config, options) {
  const factSets = loadFactSets(config);
  warnStaleFacts(factSets, config.repos);
  const mode = options.symbol ? 'symbol' : options.literal ? 'literal' : undefined;
  const report = routesOfModule.routesOf(factSets, options.start, {
    mode,
    repo: options.repo,
    maxNodes: options.maxNodes,
    aliases: config.aliases,
    sinks: config.sinks,
    consumerEntryMethods: config.workerPatterns.consumerEntryMethods,
    repos: config.repos,
  });
  const exitCode =
    report.verdict === 'incomplete'
      ? 4
      : report.verdict === 'unresolved' || report.verdict === 'ambiguous'
        ? 2
        : 0;
  if (options.json) {
    log(JSON.stringify(report, null, 2));
  } else {
    const output = routesOfModule.renderRoutesOf(report);
    if (exitCode === 0) log(output);
    else process.stderr.write(`flowtrace: ${output}\n`);
  }
  return exitCode;
}

/**
 * One route, one page. `span` reads the same facts every other verb reads and writes a
 * file — there is no terminal form to compose `--graph`, `--json` or `--seeds` onto, which
 * is why it is a verb rather than a flag on `trace`.
 */
async function runSpan(config, options) {
  const factSets = loadFactSets(config);
  warnStaleFacts(factSets, config.repos);
  if (options.fromComponent) {
    return runComponentSpan(config, options, factSets);
  }
  const { span } = spanModule;
  const { renderSpanHtml } = renderSpanHtmlModule;
  const { createScout } = scoutModule;
  const scout = createScout({
    bin: config.scout ? config.scout.bin : undefined,
    outDir: config.out,
    repos: config.repos,
  });
  let verdicts;
  if (options.verdictFacts) {
    const { readVerdictFacts, verdictIndex } = skeletonModule;
    const cached = readVerdictFacts(resolve(options.verdictFacts));
    validateFacts(cached.facts);
    verdicts = verdictIndex([...factSets, cached]);
  }
  const specsText =
    options.specs === undefined ? '' : existsSync(options.specs) ? readFileSync(options.specs, 'utf8') : options.specs;
  const model = span(factSets, options.start, {
    aliases: config.aliases,
    specs: specsText,
    verdicts,
    traceOptions: {
      depth: options.depth,
      maxNodes: options.maxNodes,
      repo: options.repo,
      aliases: config.aliases,
      sinks: config.sinks,
      consumerEntryMethods: config.workerPatterns.consumerEntryMethods,
      repos: config.repos,
      outbound: scout.outbound,
    },
  });
  if (model.error) {
    process.stderr.write(`flowtrace: "${options.start}" ${model.error}\n`);
    for (const candidate of model.candidates || []) process.stderr.write(`  ${candidate}\n`);
    return 2;
  }
  for (const token of model.limits.unmatchedSpecs) {
    process.stderr.write(`flowtrace: --specs "${token}" matches no spec in the facts\n`);
  }
  const target = resolve(options.out || joinPath(config.out, 'span', `${model.slug}.html`));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, renderSpanHtml(model, { title: `flowtrace span: ${options.start}` }));
  const counts = model.ledger.counts;
  log(
    `span ${options.start}: ${plural(counts.total, 'outcome')} — ${counts.tested} tested, ` +
      `${counts['inherited-only']} inherited-only, ${counts.untested} untested ` +
      `(reconciles with cover: ${model.reconcile.ledgerRows}/${model.reconcile.coverSeeds} seeds) -> ${display(target)}`,
  );
  return 0;
}

/**
 * `span --from-component <name>` (web kind only) — one page per component, carrying one
 * `span()` section per route the component's own walk resolves to. `--repo` here scopes
 * which component the name resolves to, never the routes behind it — a web component and
 * the backend route it calls always live in different repositories, so that scoping is
 * never forwarded into the per-route walk. `--file` disambiguates a name declared
 * in more than one file; `model.error` and `model.candidates` already print identically to
 * every other ambiguous-start case below.
 */
async function runComponentSpan(config, options, factSets) {
  const { componentSpan } = componentSpanModule;
  const { renderComponentSpanHtml } = renderComponentSpanHtmlModule;
  const { createScout } = scoutModule;
  const scout = createScout({
    bin: config.scout ? config.scout.bin : undefined,
    outDir: config.out,
    repos: config.repos,
  });
  const specsText =
    options.specs === undefined ? '' : existsSync(options.specs) ? readFileSync(options.specs, 'utf8') : options.specs;
  const model = componentSpan(factSets, options.fromComponent, {
    repo: options.repo,
    file: options.file,
    aliases: config.aliases,
    specs: specsText,
    traceOptions: {
      depth: options.depth,
      maxNodes: options.maxNodes,
      aliases: config.aliases,
      sinks: config.sinks,
      consumerEntryMethods: config.workerPatterns.consumerEntryMethods,
      repos: config.repos,
      outbound: scout.outbound,
    },
  });
  if (model.refused) {
    process.stderr.write(`flowtrace: ${model.refused}\n`);
    return 2;
  }
  if (model.error) {
    process.stderr.write(`flowtrace: "${options.fromComponent}" ${model.error}\n`);
    for (const candidate of model.candidates || []) process.stderr.write(`  ${candidate}\n`);
    return 2;
  }
  const unmatched = new Set();
  for (const entry of model.routes) {
    for (const token of entry.model.limits.unmatchedSpecs) unmatched.add(token);
  }
  for (const token of unmatched) {
    process.stderr.write(`flowtrace: --specs "${token}" matches no spec in the facts\n`);
  }
  const target = resolve(options.out || joinPath(config.out, 'span', `${model.slug}.html`));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, renderComponentSpanHtml(model, { title: `flowtrace span: ${options.fromComponent}` }));
  log(
    `span --from-component ${options.fromComponent}: ${plural(model.header.routesResolved, 'route')} resolved, ` +
      `${plural(model.header.armsUnresolved, 'arm')} unresolved -> ${display(target)}`,
  );
  return 0;
}

/**
 * One route, one answer to "where can this be observed". `surface` walks the route once for
 * the state it changes and then reverse-walks the facts to the endpoints reading that state
 * back; it writes no page, so it prints its answer and, with `--out`, the facts behind it.
 */
async function runSurface(config, options) {
  const factSets = loadFactSets(config);
  warnStaleFacts(factSets, config.repos);
  const { trace } = traceModule;
  const { assertionSurface, renderSurface, surfaceFacts } = assertionSurfaceModule;
  const { createScout } = scoutModule;
  const scout = createScout({
    bin: config.scout ? config.scout.bin : undefined,
    outDir: config.out,
    repos: config.repos,
  });
  const result = trace(factSets, options.start, {
    depth: options.depth,
    maxNodes: options.maxNodes,
    repo: options.repo,
    aliases: config.aliases,
    sinks: config.sinks,
    consumerEntryMethods: config.workerPatterns.consumerEntryMethods,
    repos: config.repos,
    outbound: scout.outbound,
  });
  if (result.error) {
    process.stderr.write(`flowtrace: "${options.start}" ${result.error}\n`);
    for (const candidate of result.candidates || []) process.stderr.write(`  ${candidate}\n`);
    return 2;
  }
  const model = assertionSurface(factSets, options.start, result, { hops: options.hops, sinks: config.sinks });
  const facts = surfaceFacts(model, fact);
  validateFacts(facts);
  if (options.out) {
    const target = resolve(options.out);
    writeJson(target, factsHeader({
      repo: model.route.repo,
      kind: 'assertion-surface',
      root: null,
      generatedFrom: model.route.key,
      facts,
    }));
    log(`surface ${model.route.key}: ${plural(facts.length, 'fact')} -> ${display(target)}`);
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...model, facts }, null, 2)}\n`);
    return 0;
  }
  if (!options.out) process.stdout.write(renderSurface(model));
  return 0;
}

/**
 * One surface, one spec. `skeleton` derives the route's assertion surface exactly as
 * `surface` does and writes the starting spec for it, so a block's observation point and
 * the surface's own row are one claim rather than two readings. Nothing is emitted for a
 * route on which nothing resolved: the plan is refused and its gaps are printed instead.
 */
async function runSkeleton(config, options) {
  const factSets = loadFactSets(config);
  warnStaleFacts(factSets, config.repos);
  const { trace } = traceModule;
  const { assertionSurface } = assertionSurfaceModule;
  const { readScaffoldConventions } = scaffoldModule;
  const { readDrafts, readHelpers, readVerdictFacts, requestIndex, skeleton, verdictIndex } = skeletonModule;
  const { createScout } = scoutModule;
  const scout = createScout({
    bin: config.scout ? config.scout.bin : undefined,
    outDir: config.out,
    repos: config.repos,
  });
  const result = trace(factSets, options.start, {
    depth: options.depth,
    maxNodes: options.maxNodes,
    repo: options.repo,
    aliases: config.aliases,
    sinks: config.sinks,
    consumerEntryMethods: config.workerPatterns.consumerEntryMethods,
    repos: config.repos,
    outbound: scout.outbound,
  });
  if (result.error) {
    process.stderr.write(`flowtrace: "${options.start}" ${result.error}\n`);
    for (const candidate of result.candidates || []) process.stderr.write(`  ${candidate}\n`);
    return 2;
  }
  const model = assertionSurface(factSets, options.start, result, { hops: options.hops, sinks: config.sinks });
  const sets = [...factSets];
  if (options.verdictFacts) {
    const cached = readVerdictFacts(resolve(options.verdictFacts));
    validateFacts(cached.facts);
    sets.push(cached);
  }
  const draftsDir = options.drafts ? resolve(options.drafts) : null;
  const { plan, spec, placeholders: counted } = skeleton(model, {
    conventions: readScaffoldConventions(config),
    helpers: readHelpers(options.helpers ? resolve(options.helpers) : null),
    verdicts: verdictIndex(sets),
    requests: requestIndex(factSets),
    drafts: readDrafts(draftsDir),
    draftsFrom: draftsDir ? display(draftsDir) : null,
    observe: options.observe,
    stub: options.stub,
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ plan, spec, placeholders: counted ?? null }, null, 2)}\n`);
    return plan.refused && !options.stub ? 3 : 0;
  }
  if (spec === null) {
    process.stderr.write(`flowtrace: ${plan.refusal}\n`);
    for (const block of plan.blocks) {
      process.stderr.write(`  gap ${block.reason}: ${block.state || 'no state'} (${block.file}:${block.line})\n`);
    }
    process.stderr.write('  re-run with --stub to write the gap-only stub instead\n');
    return 3;
  }
  if (options.out) {
    const target = resolve(options.out);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, spec);
    log(
      `skeleton ${plan.route}: ${plan.counts.observed} observed, ${plan.counts.gaps} parked, ` +
        `${counted.caseId} case-id placeholder${counted.caseId === 1 ? '' : 's'}` +
        (plan.counts.deduped > 0 ? `, ${plan.counts.deduped} deduped` : '') +
        (draftsDir ? `, ${plan.counts.drafted} titled from the drafted AC` : '') +
        ` -> ${display(target)}`,
    );
    return 0;
  }
  process.stdout.write(spec);
  return 0;
}

/**
 * `--area` takes a path to a route-key list, or a bare area name that resolves to
 * `areas/<name>.txt` inside the package.
 */
function resolveAreaFile(value) {
  if (existsSync(value)) return { file: value, name: basename(value, '.txt') };
  const named = joinPath(AREAS_DIR, `${value}.txt`);
  if (existsSync(named)) return { file: named, name: value };
  throw new Error(`no area file at ${display(value)} or ${display(named)}`);
}

async function runCover(config, options) {
  const area = resolveAreaFile(options.area);
  const factSets = loadFactSets(config);
  warnStaleFacts(factSets, config.repos);
  const { cover, readAreaKeys } = coverModule;
  const { renderCover, renderCoverMarkdown, colorEnabled } = renderCoverModule;
  const { createScout } = scoutModule;
  const scout = createScout({
    bin: config.scout ? config.scout.bin : undefined,
    outDir: config.out,
    repos: config.repos,
  });
  const keys = readAreaKeys(readFileSync(area.file, 'utf8'));
  const traceOptions = {
    depth: options.depth,
    maxNodes: options.maxNodes,
    graph: options.graph,
    repo: options.repo,
    aliases: config.aliases,
    sinks: config.sinks,
    consumerEntryMethods: config.workerPatterns.consumerEntryMethods,
    repos: config.repos,
    outbound: scout.outbound,
  };
  // The runtime tier is read before the walk so the join runs inside `cover`
  // itself and feeds the one evidence index every consumer already reads, rather than
  // producing a second report beside it.
  let runtime;
  if (options.runtime) {
    const { readRuntimeSnapshots } = runtimeCoverModule;
    runtime = readRuntimeSnapshots(resolve(options.runtime));
    for (const warning of runtime.warnings) warn(`runtime: ${warning}`);
    if (runtime.snapshots.length === 0) throw new Error(`${display(resolve(options.runtime))}: no readable coverage snapshot`);
  }
  const report = cover(factSets, { area: area.name, keys, aliases: config.aliases, traceOptions, runtime });

  if (options.verdicts) {
    const { readVerdicts, mergeVerdicts } = packetsModule;
    const entries = readVerdicts(resolve(options.verdicts));
    const merge = mergeVerdicts(report, entries);
    for (const warning of merge.warnings) warn(`verdicts: ${warning}`);
    warn(
      `verdicts ${plural(merge.files, 'file')} read: ${plural(merge.upgrades, 'upgrade')} applied, ` +
        `${plural(merge.confirmed, 'confirmation')}, rejections ${JSON.stringify(merge.rejections)}`,
    );
  }
  if (options.packets) {
    const { writePackets } = packetsModule;
    const mobileRepo = config.repos.find((repo) => repo.kind === 'mobile');
    const outDir = resolve(options.packets);
    const result = writePackets(factSets, {
      area: area.name,
      keys,
      aliases: config.aliases,
      traceOptions,
      mobileRoot: mobileRepo ? mobileRepo.root : undefined,
      repos: config.repos,
      outDir,
    });
    log(`packets ${area.name}: ${plural(result.written, 'packet')} written, ${plural(result.skipped, 'route')} skipped (no candidates) -> ${display(outDir)}`);
  }

  if (report.runtime) {
    const seeds = report.runtime.seeds;
    warn(
      `runtime ${plural(report.runtime.snapshots.length, 'snapshot')} read: ` +
        `${plural(seeds.proven, 'seed')} proven, ${seeds.contradicted} contradicted, ${seeds.ambiguous} ambiguous, ` +
        `${report.runtime.reachedBranches}/${report.runtime.totalBranches} branch spans reached` +
        (report.runtime.unmatchedFiles.length > 0
          ? `, ${plural(report.runtime.unmatchedFiles.length, 'file')} in no snapshot`
          : ''),
    );
  }

  if (options.md) {
    mkdirSync(dirname(resolve(options.md)), { recursive: true });
    writeFileSync(resolve(options.md), renderCoverMarkdown(report));
  }
  if (options.json) {
    log(JSON.stringify(report, null, 2));
    return 0;
  }
  log(renderCover(report, { color: colorEnabled() }));
  if (options.md) log(`\nmarkdown -> ${display(resolve(options.md))}`);
  return 0;
}

/**
 * `affected` reads its diff from the repository the system lives in — the backend —
 * and attributes every path in it across every configured repository, so a harness
 * nested inside that checkout is recognised as its own repository rather than as backend
 * source.
 */
function diffSourceRepo(config, repoFilter) {
  const backend = config.repos.find((repo) => repo.kind === 'backend');
  if (backend) return backend;
  const named = repoFilter ? config.repos.find((repo) => repo.id === repoFilter) : undefined;
  return named || config.repos[0];
}

async function runAffected(config, options) {
  const factSets = loadFactSets(config);
  const {
    affected,
    allRouteKeys,
    attributeChanges,
    changedPaths,
    dotnetArgs,
    nxBaseRef,
    playwrightArgs,
    renderAffected,
  } = affectedModule;
  const { readAreaKeys } = coverModule;
  const { createScout } = scoutModule;

  const source = diffSourceRepo(config, options.repo);
  if (!source) throw new Error('no repository configured to read a diff from');
  const paths = changedPaths(source.root, { diff: options.diff, staged: options.staged });
  if (paths === null) {
    throw new Error(`cannot read a diff in ${source.id}: not a git repository, or git is unavailable`);
  }
  const changed = attributeChanges(paths, config.repos, { root: source.root });

  const area = options.allRoutes ? null : resolveAreaFile(options.area);
  const keys = area
    ? readAreaKeys(readFileSync(area.file, 'utf8'))
    : allRouteKeys(factSets);

  const scout = createScout({
    bin: config.scout ? config.scout.bin : undefined,
    outDir: config.out,
    repos: config.repos,
  });
  // The filter is read against the backend checkout the diff came from: its
  // projects are the scope, its `.scout` manifest says whether the index covers the test
  // projects or the file scan has to carry them alone.
  const dotnet = options.dotnetFilter
    ? {
        repo: source.id,
        root: source.root,
        refs: scout.inbound,
        scopedDirs: scout.scopedDirs(source.root),
        maxShare: options.maxShare,
      }
    : null;
  // The Nx workspace is the *web* repository's, never the backend's: the backend
  // has no project graph, and asking one that does not exist would answer a question about
  // the wrong repository. `--nx` with no web repository configured is a stated no-op.
  const webRepo = config.repos.find((repo) => repo.kind === 'web') || null;
  const nx = options.nx
    ? {
        repo: webRepo ? webRepo.id : null,
        root: webRepo ? webRepo.root : null,
        ref: nxBaseRef({ diff: options.diff, staged: options.staged }),
      }
    : null;
  const report = affected(factSets, {
    area: area ? area.name : null,
    universeSource: area ? 'area' : 'all-routes',
    keys,
    changed,
    aliases: config.aliases,
    repos: config.repos,
    maxShare: options.maxShare,
    hops: options.hops,
    memberScoped: options.memberScoped,
    impact: scout.impact,
    dotnet,
    nx,
    // `--repo` names the suite to print, never the repository a route is resolved in:
    // scoping the walk to a test repository would resolve no route at all.
    traceOptions: {
      depth: options.depth,
      maxNodes: options.maxNodes,
      aliases: config.aliases,
      sinks: config.sinks,
      consumerEntryMethods: config.workerPatterns.consumerEntryMethods,
      repos: config.repos,
      outbound: scout.outbound,
    },
  });

  if (options.json) {
    log(JSON.stringify(report, null, 2));
    return report.exit;
  }
  if (options.dotnetFilter) {
    const expression = dotnetArgs(report);
    if (expression) log(expression);
    // Only this answer's own rung is printed here: the spec-side rungs are about suites
    // this mode is not selecting, and `report.exit` already reports the dotnet verdict.
    // `--json` still carries every rung, unfiltered.
    if (report.dotnetFilter && report.dotnetFilter.fallback) {
      const rung = report.fallbacks.find((entry) => entry.rung === 'dotnet-filter');
      warn(`flowtrace: dotnet-filter${rung && rung.scope ? ` [${rung.scope}]` : ''}: ${report.dotnetFilter.reason}`);
    }
    return report.exit;
  }
  if (options.playwrightArgs) {
    const line = playwrightArgs(report, { repo: options.repo, repos: config.repos });
    if (line) log(line);
    // The one-line mode still says why a union did not happen: a fallback the caller
    // cannot see is exactly the silent zero the --nx contract refuses.
    if (report.nx && report.nx.reason) warn(`flowtrace: ${report.nx.reason}`);
    for (const entry of report.fallbacks) warn(`flowtrace: ${entry.rung}${entry.scope ? ` [${entry.scope}]` : ''}: ${entry.reason}`);
    return report.exit;
  }
  log(renderAffected(report, { repo: options.repo }));
  return report.exit;
}

/**
 * One walk per route, shared by `cover`, the packets that carry the helper index, and the
 * scaffold itself: the three steps ask the same walker the same question about the same
 * keys, and walking a route three times only costs time.
 */
function memoizedWalker(walk) {
  const memo = new Map();
  return (factSets, key, walkOptions) => {
    if (!memo.has(key)) memo.set(key, walk(factSets, key, walkOptions));
    return memo.get(key);
  };
}

async function runScaffold(config, options) {
  const area = resolveAreaFile(options.area);
  const factSets = loadFactSets(config);
  warnStaleFacts(factSets, config.repos);
  const { cover, readAreaKeys } = coverModule;
  const { buildPackets } = packetsModule;
  const { scaffold, readScaffoldConventions } = scaffoldModule;
  const { trace } = traceModule;
  const { createScout } = scoutModule;
  const scout = createScout({
    bin: config.scout ? config.scout.bin : undefined,
    outDir: config.out,
    repos: config.repos,
  });
  const keys = readAreaKeys(readFileSync(area.file, 'utf8'));
  const traceOptions = {
    depth: options.depth,
    maxNodes: options.maxNodes,
    graph: options.graph,
    repo: options.repo,
    aliases: config.aliases,
    sinks: config.sinks,
    consumerEntryMethods: config.workerPatterns.consumerEntryMethods,
    repos: config.repos,
    outbound: scout.outbound,
  };
  const walker = memoizedWalker(trace);
  const report = cover(factSets, {
    area: area.name,
    keys,
    aliases: config.aliases,
    traceOptions,
    trace: walker,
  });
  const mobileRepo = config.repos.find((repo) => repo.kind === 'mobile');
  const { packets } = buildPackets(factSets, {
    area: area.name,
    keys,
    aliases: config.aliases,
    traceOptions,
    trace: walker,
    mobileRoot: mobileRepo ? mobileRepo.root : undefined,
    repos: config.repos,
  });
  const outDir = resolve(options.out || joinPath(config.out, 'scaffold'));
  const result = scaffold({
    facts: factSets,
    keys,
    cover: report,
    packets,
    filter: { area: area.name, seedKeys: options.seedKeys, maxLevel: options.maxLevel },
    conventions: readScaffoldConventions(config),
    outDir,
    dryRun: options.dryRun === true,
    includeUnreachable: options.includeUnreachable === true,
    repoRoots: config.repos.map((repo) => repo.root),
    trace: walker,
    traceOptions,
  });

  if (options.dryRun) {
    log(result.index);
    if (result.files.length > 0) {
      log(`--- ${result.files[0].file}`);
      log(result.files[0].contents);
    }
    return 0;
  }
  log(
    `scaffold ${area.name}: ${plural(result.counts.routes, 'route')}, ${plural(result.counts.tests, 'test')}, ` +
      `${result.counts.helperReuse} reusing a helper, ${result.counts.processor} worker-shaped -> ${display(outDir)}`,
  );
  return 0;
}

async function runCases(config, options) {
  const area = resolveAreaFile(options.area);
  const factSets = loadFactSets(config);
  warnStaleFacts(factSets, config.repos);
  const { cover, readAreaKeys } = coverModule;
  const { cases } = casesModule;
  const { trace } = traceModule;
  const { createScout } = scoutModule;
  const scout = createScout({
    bin: config.scout ? config.scout.bin : undefined,
    outDir: config.out,
    repos: config.repos,
  });
  const keys = readAreaKeys(readFileSync(area.file, 'utf8'));
  const traceOptions = {
    depth: options.depth,
    maxNodes: options.maxNodes,
    graph: options.graph,
    repo: options.repo,
    aliases: config.aliases,
    sinks: config.sinks,
    consumerEntryMethods: config.workerPatterns.consumerEntryMethods,
    repos: config.repos,
    outbound: scout.outbound,
  };
  const walker = memoizedWalker(trace);
  const report = cover(factSets, {
    area: area.name,
    keys,
    aliases: config.aliases,
    traceOptions,
    trace: walker,
  });
  const outDir = resolve(options.out || joinPath(config.out, 'cases'));
  const result = cases({
    facts: factSets,
    keys,
    cover: report,
    filter: { area: area.name, seedKeys: options.seedKeys, maxLevel: options.maxLevel },
    outDir,
    dryRun: options.dryRun === true,
    includeUnreachable: options.includeUnreachable === true,
    gherkinDraft: options.gherkinDraft === true,
    repoRoots: config.repos.map((repo) => repo.root),
    trace: walker,
    traceOptions,
  });

  if (options.dryRun) {
    log(result.index);
    if (result.files.length > 0) {
      log(`--- ${result.files[0].file}`);
      log(result.files[0].contents);
    }
    if (options.gherkinDraft && result.gherkinFiles.length > 0) {
      log(`--- ${result.gherkinFiles[0].file}`);
      log(result.gherkinFiles[0].contents);
    }
    return 0;
  }
  log(
    `cases ${area.name}: ${plural(result.counts.routes, 'route')}, ${plural(result.counts.cases, 'case')}, ` +
      `${result.counts.faultCases} fault, ${result.counts.uncovered} uncovered -> ${display(outDir)}` +
      (options.gherkinDraft
        ? `; gherkin-draft: ${plural(result.counts.gherkinFiles, 'file')}, ${plural(result.counts.gherkinScenarios, 'scenario')}`
        : ''),
  );
  return 0;
}

async function runReadiness(config, options) {
  const factSets = loadFactSets(config);
  warnStaleFacts(factSets, config.repos);
  const { readiness, readInventory, renderReadinessMarkdown } = readinessModule;
  const { createScout } = scoutModule;
  const scout = createScout({
    bin: config.scout ? config.scout.bin : undefined,
    outDir: config.out,
    repos: config.repos,
  });
  const inventoryPath = resolve(options.areas);
  if (!existsSync(inventoryPath)) {
    throw new Error(`no inventory file at ${display(inventoryPath)}`);
  }
  const rows = readInventory(readFileSync(inventoryPath, 'utf8'));
  if (rows.length === 0) {
    throw new Error(
      `${display(inventoryPath)} named no "area,glob" row — one per line, e.g. "widgets,features/widgets/**"`,
    );
  }
  const traceOptions = {
    depth: options.depth,
    maxNodes: options.maxNodes,
    repo: options.repo,
    aliases: config.aliases,
    sinks: config.sinks,
    consumerEntryMethods: config.workerPatterns.consumerEntryMethods,
    repos: config.repos,
    outbound: scout.outbound,
  };
  const report = readiness(factSets, { rows, aliases: config.aliases, traceOptions });

  if (options.md) {
    mkdirSync(dirname(resolve(options.md)), { recursive: true });
    writeFileSync(resolve(options.md), renderReadinessMarkdown(report));
  }
  if (options.json) {
    log(JSON.stringify(report, null, 2));
    return 0;
  }
  log(renderReadinessMarkdown(report));
  if (options.md) log(`\nmarkdown -> ${display(resolve(options.md))}`);
  return 0;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    return usage(error.message);
  }
  if (options.help) {
    log(USAGE);
    return 0;
  }
  if (!COMMANDS.has(options.command)) {
    return usage(options.command ? `unknown command "${options.command}"` : 'no command given');
  }
  if (options.command === 'trace' && !options.start && !options.area) {
    return usage('trace requires a start, or --area <file>');
  }
  if (options.command === 'routes-of' && !options.start) {
    return usage('routes-of requires a point');
  }
  if (options.symbol && options.literal) {
    return usage('--symbol and --literal are mutually exclusive');
  }
  if ((options.symbol || options.literal) && options.command !== 'routes-of') {
    return usage('--symbol and --literal are routes-of options');
  }
  if (options.command === 'routes-of' && options.graph) {
    return usage('routes-of is fact-only and does not accept --graph');
  }
  if (options.command === 'routes-of' && options.depth) {
    return usage('routes-of is exhaustive and does not accept --depth');
  }
  if (options.command === 'span' && options.start && options.fromComponent) {
    return usage('span accepts a route key or --from-component <name>, not both');
  }
  if (options.command === 'span' && !options.start && !options.fromComponent) {
    return usage(
      'span requires a route key, e.g. span "POST orders/v1/checkout", or --from-component <name>',
    );
  }
  if (options.command === 'span' && options.file && !options.fromComponent) {
    return usage('span --file requires --from-component <name>');
  }
  if (options.command === 'surface' && !options.start) {
    return usage('surface requires a route key, e.g. surface "POST orders/v1/checkout"');
  }
  if (options.command === 'skeleton' && !options.start) {
    return usage('skeleton requires a route key, e.g. skeleton "POST orders/v1/checkout"');
  }
  if (options.command === 'cover' && !options.area) {
    return usage('cover requires --area <file|name>');
  }
  if (options.runtime && options.command !== 'cover') {
    return usage('--runtime is a cover option');
  }
  if (options.command === 'affected' && !options.area && !options.allRoutes) {
    return usage('affected requires --area <file|name> or --all-routes');
  }
  if (options.command === 'affected' && options.memberScoped && !options.hops) {
    return usage('affected --member-scoped requires --hops N — there is no widening to tighten without it');
  }
  if (options.command === 'scaffold' && !options.area) {
    return usage('scaffold requires --area <file|name>');
  }
  if (options.command === 'cases' && !options.area) {
    return usage('cases requires --area <file|name>');
  }
  if (options.command === 'readiness' && !options.areas) {
    return usage('readiness requires --areas <file>');
  }
  let config;
  try {
    config = loadConfig({ configPath: options.config });
  } catch (error) {
    return usage(error.message);
  }
  try {
    if (options.command === 'trace') {
      return await runTrace(config, options);
    }
    if (options.command === 'routes-of') {
      return await runRoutesOf(config, options);
    }
    if (options.command === 'span') {
      return await runSpan(config, options);
    }
    if (options.command === 'surface') {
      return await runSurface(config, options);
    }
    if (options.command === 'skeleton') {
      return await runSkeleton(config, options);
    }
    if (options.command === 'cover') {
      return await runCover(config, options);
    }
    if (options.command === 'affected') {
      return await runAffected(config, options);
    }
    if (options.command === 'scaffold') {
      return await runScaffold(config, options);
    }
    if (options.command === 'cases') {
      return await runCases(config, options);
    }
    if (options.command === 'readiness') {
      return await runReadiness(config, options);
    }
    if (options.command === 'extract' || options.command === 'all') {
      await runExtract(config, options.repo);
    }
    if (options.command === 'join' || options.command === 'all') {
      await runJoin(config);
    }
    if (options.command === 'render' || options.command === 'all') {
      await runRender(config);
    }
  } catch (error) {
    process.stderr.write(`flowtrace: ${error.message}\n`);
    return 1;
  }
  return 0;
}

function usage(reason) {
  process.stderr.write(`flowtrace: ${reason}\n${USAGE}\n`);
  return 2;
}

// `.then()` rather than top-level await: the single-file build wraps this entry as
// CommonJS, where a top-level await is a syntax error.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`flowtrace: ${error && error.message ? error.message : error}\n`);
    process.exitCode = 1;
  },
);
