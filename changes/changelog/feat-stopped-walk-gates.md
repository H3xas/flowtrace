### The walk

- A walk that stops at the edge of the configured repositories now reads `external-boundary`.
  This is a zero-hit code index lookup for a class that no fact of any repository declares.
  The stop is listed, but the walk stays `complete` and no gate fails on it. A zero-hit for a
  class that a fact declares stays `unresolved-target`.
- The result identity now holds each code index answer that the walk read, including the
  answers that gate walks read. If no index answered, it holds the reason. The same
  facts with different index answers give different identities.
- `span --from-component <c> --entry <e>` records the selected entry as `status.scope.entry`.
  The evidence counts and the identity then belong to that entry only.
- A route summary in a `trace` tree, its `--html` page and its `--json` node carry the mark of
  the walk of that route as `summaryWalk`. The outer walk does not take the stops of the route
  walk. `--view source-flow` carries no such mark.

### Gates

- `check`, `scope`, `surface`, `skeleton`, `cover --packets`, `readiness`, `affected` and
  `join --against` mark each item that a stopped walk produced, as
  `walk <traversal> (<reason> <n>, ...)` in text and as a `walk` key in `--json`. A run with
  no stopped walk prints no mark and no key. A stderr notice gives the count of walks that
  did not complete.
- If a walk did not complete or the facts are not fresh, `--require-complete` on these eight
  verbs exits 4 after the normal output. Each stderr line names the item and its stops. A
  usage error stays exit 2 and comes first. Exit 4 then comes before every other exit code.
- A stopped walk no longer backs a negative claim. `scope` prints `server-gate: unknown`, and
  `readiness` prints `unknown` for each empty sink of a stopped route. An Unreachable-only
  component whose route walk stopped moves to its own line.
- If a walk stopped, `readiness` adds a "Stopped walks" column per area and for the estate.
- `affected` selects each route whose walk stopped and reached no changed file, also with no
  code index. The route carries the reason `incomplete-walk`, the report carries the
  `incomplete-walk` rung, and the run exits 4. With `--dotnet-filter`, the rung is one stderr
  line and a report entry, and the dotnet filter keeps its own exit.
- A `check` baseline records the walk boundary of each route. A changed boundary fails the
  compare with exit 4 before a regression. A baseline with no boundary is refused once with a
  request to write it again. `--write-baseline --require-complete` writes no baseline over a
  stopped walk.
- `join --against` compares the walk boundary of the snapshot with the current one, and skips
  a route whose boundary moved. An empty item in `--fail-on` is a usage error.
- `check`, `scope` and `join --against` take `--depth` and `--max-nodes`.
- A packet from a stopped walk carries `walk` as its last key. The packet hash does not
  change.
- If the walk stopped, `surface` prints the walk status after its first line. `--json`
  carries `status`. `skeleton` writes one parked `test.fixme` block for each place the walk
  stopped, after the plan blocks.
