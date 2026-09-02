# Peers

An agent picking tools from a marketplace, an MCP registry or a GitHub search has a dozen it can
install in one command, several reading C# and TypeScript far better than flowtrace's regular
expressions do. These are the ones this benchmark runs against.

**Selection rule, fixed before any tool was looked at:** a licence permitting use on a closed
codebase; installs and answers locally, no hosted account, no API key; a commit inside the last
twelve months; a CLI or MCP surface an agent calls directly; a documented path for at least one of
C#, TypeScript, Angular templates or React. Exact versions live in each run's environment block.

## The roster

| arm | project | licence | install | cross-repo |
|---|---|---|---|---|
| `rg` | BurntSushi/ripgrep — the control arm, the floor | MIT OR Unlicense | package manager | no |
| `joern` | joernio/joern | Apache-2.0 | release archive, JVM | no |
| `astgrep` | ast-grep/ast-grep | MIT | package manager | no |
| `semgrep` | semgrep/semgrep, Community Edition | LGPL-2.1 | `pipx install semgrep` | no |
| `codegraph` | vitali87/code-graph-rag | MIT | `uv tool install` + a graph database | yes |
| `serena` | oraios/serena | MIT | `uv tool install` | partial |
| `repomap` | Aider-AI/aider — its repo map | Apache-2.0 | `pipx install aider-chat` | no |
| `flowtrace` | this repository | MIT | `npm i -g flowtrace-cli` | yes |

**Excluded, with the reason.** *CodeQL CLI* — its Terms permit analysis only of an open-source
codebase without a paid licence; that bar *is* satisfiable on the public corpora here, so it is
un-run rather than unsuitable — and the first roster addition registered for the next public-corpus round. *Sourcegraph* — core
went private, no free self-host tier. *Nx* — its graph's nodes are projects; no code-graph task fits, but its `affected` verb belongs to the test-selection lane below.

## What each one claims, in its own terms

- **`rg`** — a line-oriented recursive search tool. The floor: what an agent reaches for first, and without it every peer would be read only against flowtrace.
- **`joern`** — a code property graph fusing AST, control flow and program dependence, with a C#
  frontend and a JS/TypeScript one. Real interprocedural reachability; built per codebase.
- **`astgrep`** — a syntactic AST matcher over many languages including C#, TypeScript, TSX and
  HTML. Its FAQ disclaims scope, type, control-flow, data-flow and taint analysis: a pattern.
- **`semgrep` (CE)** — the same shape with a rule format and a large public rule corpus. Its own
  docs draw the line: CE "can only analyze interactions within a single function".
- **`codegraph`** — the only peer with a documented multi-repository notion: index each repo, the
  graph is shared. Its query path wants a model to write Cypher; with none in this loop the arm
  runs frozen hand-written Cypher — a handicap against its design, published as one, not repaired.
- **`serena`** — a language-server-backed symbol server, roughly two dozen tools, refactoring verbs
  included. It holds one active project; its documented all-repos-in-a-folder workaround is used
  here, so it attempts the join rather than being written off on a technicality.
- **`repomap`** — a token-budgeted ranked *summary* built from tree-sitter tags over a graph whose
  nodes are files. It ranks files, never call sites, and never resolves anything — and says so.

## Capability matrix

No numbers by design — they live in a results document, with its corpus and host attached. `~` means partial, or documented but conditional.

| | literal search | symbol defs & refs | data flow | route → sink | test evidence | diff → specs | cross-repo join | languages | index step |
|---|---|---|---|---|---|---|---|---|---|
| `rg` | yes | no | no | no | no | no | no | any text | none |
| `joern` | via query | yes | yes | yes | no | no | no | many | build a CPG |
| `astgrep` | yes | no | no | no | no | no | no | many | none |
| `semgrep` | yes | ~ | within one function | no | no | no | no | many | none |
| `codegraph` | over symbol names | yes | no | ~ | no | no | yes | several | index + database |
| `serena` | yes | yes | no | ~ | no | no | ~ | many | language servers |
| `repomap` | no | file-level ranking | no | no | no | no | no | tag-query languages | per invocation |
| `flowtrace` | **no** | ~ | no | yes | yes | yes | yes | this stack only | `extract` + `join` |

## Where peers lead

Kept honest from the run's own findings, stated corpus-independently.

- **flowtrace has no literal-search mode at all.** `trace` takes a route key, a class, a
  `Class.Method`, a component or a page path — never a bare literal, so the input that finds a
  pattern arm its answer finds flowtrace nothing. The `.a` halves are theirs by construction.
- **Every pattern arm's row is directly openable** — path, line and matched text on essentially
  every hit, with no index step at all and answers in the fast lane of any timing table.
- **`joern` computes what flowtrace approximates**: interprocedural reachability and real data
  flow from a C# frontend, where flowtrace walks call names with regexes and cannot do taint.
- **`serena` resolves symbols the way a compiler does**, and offers refactoring verbs; flowtrace has neither a language server nor a single verb that edits code.
- **`codegraph` has a shared graph and a natural-language query path** where flowtrace has a fixed
  verb set; **`repomap`** produces a ranked whole-repo summary inside a token budget, which
  flowtrace has no equivalent of at all.
- **Language breadth is not close.** Several peers cover dozens of languages; flowtrace covers
  ASP.NET Core, Ionic/Angular, React + Redux, Playwright and Cypress, and nothing else.

## The test-selection lane (registered, not yet run)

`affected` — a diff in, a spec list out — has real competitors that the code-graph roster above
does not cover, because none of those peers takes a diff. The tools that do take one form a
separate lane, registered here before any of it runs:

| tool | takes a diff | selection granularity | cross-repo | evidence-aware |
| --- | --- | --- | --- | --- |
| `dotnet-affected` | yes | MSBuild project | no | no |
| Nx `affected` | yes | Nx project / target | no | no |
| VSTest Test Impact Analysis | per prior test run | test method, from runtime coverage | no | runtime, not static |
| flowtrace `affected` | yes | spec file, or a `dotnet test --filter` FQN expression | yes | static test-evidence facts |

The granularity difference is the whole contest: a project-level selector re-runs every test in a
touched project, and a runtime-coverage selector needs an instrumented prior run. flowtrace claims
spec-level selection from static facts alone, plus an `uncovered-change` flag for affected routes
with no evidence at all. That claim is unmeasured against these peers — the honest state of this
lane is a table of documentation claims, and it stays labelled that way until the round runs.

## Gaps we solve

- **Diff to test selection.** No code-graph peer takes a diff, each by its own documentation. The project-granularity selectors that do are a separate, registered lane above — none of them spec-level, cross-repo or evidence-aware.
- **The cross-language join.** An HTTP call from TypeScript into a C# controller is no static
  call-graph edge in any language server or CPG here — nor in the multi-repository graphs.
- **Route to test evidence.** No peer has a notion of a spec as evidence for a route, or of
  evidence tiers, so none can say which distinguishable path through a route a test pins down.
- **Route-rooted outcome enumeration** — branches, seeds and sinks from one route key, with what a static read cannot know printed rather than guessed.
- **Nothing to set up**: no build, no toolchain, no language server, no JVM, no container, no
  database — which is also why extraction is heuristic and why `sink` is where it is weakest.
