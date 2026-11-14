# Fact schema

A fact is one statement an extractor makes about one line of one file. `flowtrace extract`
writes them to `out/facts/<repo>.json`; every later step reads only facts.

## File shape

```json
{
  "repo": "api",
  "kind": "backend",
  "generatedFrom": "flowtrace <version>",
  "generatedAt": "2026-01-01T00:00:00.000Z",
  "headSha": "…",
  "dirty": false,
  "dirtyDigest": "…",
  "fileCount": 9,
  "titles": { "status": "ok", "facts": 12, "refused": 0 },
  "controlEvidence": 1,
  "facts": [ … ]
}
```

The git fields are stamped when the root is a git checkout and git is on `PATH`, and are
what later steps compare against to warn that a fact set has gone stale. `dirtyDigest` is
part of that same stamp: a fingerprint of the working tree's changed paths, present whenever
the other git fields are. `titles` is not a git field: it appears only on a `playwright`
repository configured `"titles": true`, and states what the title collector did (`status`
`ok` or `failed`). `controlEvidence` is not a git field: a `backend` or `web` fact set carries
it, with the version of the control-evidence fields (see `method_call` below). A fact set
without it carries no control evidence, and the source-flow view reports each of its bodies as
unknown order. A non-git checkout extracts perfectly well; it simply carries no
baseline, so nothing warns — that fact set's *identity* inside a `join --snapshot` or
`join --export-edges` document still states a revision witness, as `"headSha": null`, rather
than omitting the field.

A repository configured with a `factsProvider` also carries a `provider` block between the
git fields and `facts`; see [Externally supplied facts](#externally-supplied-facts).

## Every fact

Required on all: `type`, `file` (repository-relative, forward slashes), `line` (1-based).
Each type adds its own required fields; optional fields may be added freely and are carried
through untouched.

One optional field has a fixed meaning on every type: `provenance`, present only on a fact
an external provider supplied, `{ "producer": "…", "version": "…" }`. A fact the bundled
extractor read never carries it. The absence is the mark, and a provider cannot set it
(see below).

### Backend

| type | fields | stated when |
|---|---|---|
| `route` | `controller`, `action`, `verb`, `template` | a controller action declares an HTTP route; a minimal-API registration adds `handler` (`lambda`, or `method` for a method group naming a method the repository declares), and a lambda's `action` is `<registering method>(<VERBS> <template>)` |
| `http_out` | `configKey`, `template` | the service calls out over HTTP to another service |
| `publish` | `message`, `verb` | a message is published to the bus; `message` is `null` and `unresolved` names why when the argument's type could not be read; `verb` is the matched call name lower-cased (`publish`, `send`, `defer`, `submitjob`, `reply`, an `Async` suffix dropped either way) |
| `consume` | `message`, `consumer` | a class consumes a message type |
| `saga` | `saga`, `initiatedBy`, `handles`, `correlation` | a class implements a saga interface (`workerPatterns.sagaInterfaces`, default `IAmInitiatedBy`); `initiatedBy` and `handles` are message-type-name arrays read off the class's own base list, and `correlation` is the property a `ConfigureHowToFindSaga`/`CorrelateBy` lambda names, or `null` when the class states none. The class still emits its own `consume` facts for whichever messages its base list names through a consumer base, so a reader that ignores `saga` sees the walk unchanged |
| `worker_processor` | `workType`, `processor` | a processor is registered against a work type |
| `signalr_push` | `method` | a SignalR hub method is pushed to clients |
| `redis_publish` | `channel` | a broadcast is published to a channel |
| `exchange_name` | `name`, `constant` | an exchange name constant is declared |
| `queue_name` | `message`, `name` | a queue name is derived for a message |
| `message_class` | `name`, `fqn` | a message type is declared |
| `di_binding` | `iface`, `impl` | an interface is registered to an implementation |
| `ctor_field` | `class`, `field`, `paramType` | a class holds a constructor-injected field; with `method`, a parameter the framework injects into that one handler |
| `method_call` | `class`, `method`, `field`, `calledMethod` | a body calls a member on an injected field; optional `receiverType` names the receiver's type when the field is not a constructor field; on a mobile fact, `field` keeps the local type spelling, and optional `source` and `imported` carry the same import provenance as the `injects` fact, with `unresolved: "mobile-declaration-unresolved"` for an unsupported form. A fact set carrying `controlEvidence` also gives every `method_call` a `column` and a `control` (see [Control evidence](#control-evidence)) |
| `method_span` | `class`, `method`, `endLine` | a method body's extent; optional `paramTypes` lists the signature's parameter types as written |
| `branch_point` | `class`, `method`, `kind`, `text`, `endLine` | a body branches; `kind` is `error_return`, `validation`, `toggle`, `guard`, `if` or `switch` |
| `param_source` | `class`, `method`, `param`, `source`, `via` | where a parameter's value comes from — `body`, `query`, `route`, `jwt`, `injected` |
| `exception_map` | `scope`, `class`, `exception`, `status` | an exception type is converted to a status — `scope` is `global` for a registered exception filter, `action` for a `catch` inside one controller action |

| `step_composition` | `class`, `field`, `source`, `steps` | the source names the ordered steps of one pipeline's collection field: `source` is `factory` (registration calls on the instance a DI factory lambda builds and returns), `typeof-list` (a literal `typeof(...)` list resolved through the container) or `enumerable` (an injected `IEnumerable<T>` and its `Add*<T, X>()` registrations); `steps` is `[{ type, file, line }]` in run order, or `null` with a `reason` (`step-expression`, `registration-order`, `no-registration`, `factory-count`) when the list cannot be read |
| `loop_stop` | `class`, `method`, `field`, `form`, `step` | a `foreach` over a collection field calls `step` on each element; `form` is `flag-return` (with `flag`, `negated`, `position` `before` or `after` the call, and `returns`), `flag-break` (with `flag`, `negated` and `after`, the line after the loop that tests the flag), `bool-return` (with `returns`), `none`, or `unresolved` with `reason: "stop-rule"`; `endLine`, `stepLine`, `arg` and `argType` describe the loop and its argument |
| `flag_write` | `class`, `method`, `member`, `value` | a body writes `param.member = value;` for a member that a loop's stop rule reads; `value` is `true`, `false` or `expression`, and `param` names the receiver |
| `sentinel_return` | `class`, `method`, `value` | a body returns `false` or `null`; `ifLine` names the `if` it answers, when it has one |
| `return_flow` | `class`, `method`, `field`, `calledMethod` | a method returns a call's value unchanged, so a sentinel passes through it to its caller |
| `sentinel_map` | `class`, `method`, `field`, `calledMethod`, `sentinel`, `status` | an action answers `status` when the call it names returns `sentinel` (`null` or `false`), read from a `?:` conditional or an `if` on the value; `local` names the variable that holds the value |
| `auth_filter` | `class`, `name`, `stage`, `method`, `exemptions` | a class with a source body implements an authorization or action filter: `stage` is `authorization` or `action`, `method` its entry method, `name` the filter as an attribute names it, and `exemptions` the attribute names its early return tests through `typeof(XAttribute)`; `order` holds a literal `Order` value. An exception filter gives no fact |
| `filter_result` | `class`, `method`, `status` | a filter's entry method assigns `context.Result` a result whose status the status rules read |
| `filter_use` | `filter`, `scope` | a filter applies: `scope` is `global` (an `options.Filters.Add(typeof(X))` registration, with its `position`), or `controller` or `action` for an attribute on that class or method (with `class`, and `method` for an action) |
| `class_base` | `class`, `base` | a class header names a base class that the repository declares; a framework base such as `ControllerBase` gives no fact |

`param_source` is what makes seed reachability answerable: a branch reading only `jwt` or
`injected` values cannot be forced by a black-box caller.

The walk reads the last ten types only at a pipeline loop, a sentinel return or a filter. A
fact set without them gives the same tree and seeds as before, and each pipeline loop then
shows `composition-not-extracted`. From these facts the walk adds reject decisions: a branch
of kind `reject` with the sides `taken` and `not-taken`, whose `rejectForm` is `flag-write`,
`bool-false`, `sentinel`, `filter-result` or `no-grant`. A reject on its `not-taken` side adds
no token to a seed key. In `trace --json` and `trace --seeds --json`, these fields appear
only where they apply:

- A collection node carries `composition`: `{ state: "resolved", source, steps }` or
  `{ state: "unresolved", reason }`. The class node of each resolved step carries `step`, its
  position.
- A reject decision carries `rejectForm`. It also carries `statusVia`, the file and line that
  gave the status, or `statusReason: "status-unmapped"` with a `null` response.
- A seed that a filter decides carries `gate: { filter, scope, stage, shared }`. The value of
  `shared` is `true` for a global filter. A seed with no readable status carries
  `statusReason`.
- `stats.pipelines` gives the resolved count and the unresolved pipelines with their reasons.
  `stats.gates` gives the filters that the route ran.

### Caller side (mobile and web)

| type | fields | stated when |
|---|---|---|
| `component` | `name`, `selector`, `role` | a component is declared; `role` is `page`, `container`, `component`, `hook` or `service`; optional `lazy` is the module a `lazy(() => import(...))` binding loads; `exports` lists each name its module exports it under: on a web component `default` is included, and on a mobile component only named value exports are listed, with `[]` for a declaration the module does not export; a render's `source` binds only a component whose `exports` holds the imported name, and a component without `exports` binds no import |
| `renders` | `from`, `to` | one component's template renders another; optional `source` is the module the rendering file imports `to` from; optional `imported` is the name that module exports it under when it is not `to` itself (`default` for a default import, `A` for `{ A as B }`, the member for a namespace tag `<NS.A>`); on a mobile fact, optional `componentFile` is the declaration file that owns the template, while `file` and `line` stay the template source site |
| `template_handler` | `component`, `event`, `handler`, `kind` | a template or JSX binds an event to a handler; on a mobile fact, optional `componentFile` is the declaration file that owns the template |
| `injects` | `from`, `to` | a class is given another as a dependency; on a mobile fact, optional `source` is the written module specifier, `imported` the named value export, and `unresolved: "mobile-declaration-unresolved"` an import form the reader cannot bind |
| `gateway_call` | `service`, `method`, `verb`, `template`, `resolved` | a service issues an HTTP call; `resolved` is false when the URL could not be made literal; with `controlEvidence`, it also carries `column` and `control` |
| `action_def` | `action` | an action type is declared |
| `action_dispatch` | `class`, `method`, `action` | a body dispatches an action; with `controlEvidence`, it also carries `control` |
| `effect_handler` | `class`, `field`, `actions`, `endLine` | a body handles dispatched actions and issues HTTP |
| `props_bind` | `component`, `prop`, `target` | a `connect` map binds a creator to a prop |
| `component_entry` | `component`, `kind`, `trigger`, `handler`, `guards` | execution reaches a component: a class lifecycle callback, a hook effect, the cleanup an effect returns, or a trigger the extractor cannot read |
| `page_route` | `owner`, `path` | a web `<Route>` element, as written: `owner` is the component declaring it and `path` its own path (`''` for an index or pathless route). `endLine` is the line where the whole element ends, at the `>` of its closing tag or at its `/>`; a `route-object` fact has no `endLine`. Optional: `index`, `layout` (it has child routes), `parentLine`/`parentColumn` (the enclosing `<Route>`), `pathLine`, `element` with `elementLine` (the line of the component tag the element renders, inside any wrappers) and with `elementFile`/`elementName` when the element's import resolves, `lazyLine`/`lazySpecifier` when the element is a lazy binding, `wrappers`, `guards` (`{ kind: "condition", text, branch }` or `{ kind: "wrapper", text }`), `redirect`/`redirectLine` for a `<Navigate>`, and `unsupported` — `path-expression`, `optional-segment`, `element-expression`, `redirect-expression`, `route-expression` or `route-object` — for a form the lookup will not guess through. A `<Route>` held by an `if (…) { … }` block carries that test as a `guards` condition, unevaluated like any other; one built inside a loop, a `switch` or an object literal keeps `route-expression` |
| `page_route` (from a route array) | as above | the same fact for an entry of an array a `.map` renders as `<Route>`: `file`/`line`/`column` stay the rendering `.map`'s `<Route>` site, `endLine` is the line where that opening `<Route>` tag ends, the fact has no `elementLine`, and `entryFile`/`entryLine`/`entryColumn` name the array entry the values came from, with `arrayFile`/`arrayName` naming the iterated constant or the prop it arrived as. An entry's guard carries its own `file`, which is the entry's, not the render site's. `unsupported` adds `route-array-expression` (a computed or concatenated array, or an entry that is not an object literal), `route-array-unresolved` (no readable array behind the iterated name), `route-array-ambiguous` (more than one prop site supplies it), `filter-expression` (a `.filter` predicate that is not one property of the loop binding) and `filter-property` (an entry the filter names by a property it does not state) |
| `page_mount` | `path`, `source` | where a routed tree is mounted: `source` `app-root` (a root render; `component` names what it renders) or `router` (a router element inside `component`), with `path` the router's literal `basename` or `/`; an unreadable basename has `path: ""` and `unsupported: "basename-expression"` and cannot anchor a page; or `inferred`, the prefix the library's own `navigate()` literals agree on, with `evidence` counting them |
| `branch_point` | `class`, `method`, `kind`, `text`, `endLine` | a decision inside a `method_span` body; `kind` is `if`, `else`, `switch`, `case` (one for each `case` or `default` clause), `ternary`, `logical` (the outermost `&&` or `\|\|` chain) or `coalesce` (the outermost `??` chain); `class` and `method` name the innermost `method_span` that holds it |

A caller `branch_point` is read from the masked text of a method body. String, template
literal, regex literal and JSX text content gives no fact, and loops, `try`/`catch`,
optional chaining, logical assignments and conditional types give none either. A `&&` or `||`
chain in the condition of an `if`, a `switch`, a loop or a ternary is part of that decision and
gives no `logical` fact of its own. An arrow or function body starts a new chain, so a callback
in a condition keeps its own fact. `text` is the decision's own source with whitespace
collapsed, at most 120 characters. `endLine` is the line that closes its block, its clause or
its expression.

`trace` reads backend decisions only. The walk and every reader of its index skip the
`branch_point` facts of a web or mobile fact set, so they change no walk, seed or `check`
baseline. `cover --runtime` joins them to line coverage, and `decisions` lists them.

A `component_entry` names one way execution reaches a component, on the site it was
written at. `kind` is `mount`, `update`, `unmount`, `effect`, `cleanup`, `event` or
`unknown`; `trigger` is the name it was written under (`componentDidMount`, `useEffect`,
a hook the extractor does not read); `handler` is the callback or handler it names, and is
`null` when the trigger *is* its own callback. `guards` lists, in source order, the
conditions that gate the calls inside the entry. Optional: `column` is the trigger's
1-based column, which with `line` is the site — two declarations can share a line, and one
line is then not a site; `deps` is an effect's dependency list as written — `[]` when none
was written — `endLine` closes the entry's span, `unresolved` names why the trigger could
not be followed (`custom-hook`, `dynamic-callback`), and `method` is the key the calls
inside the entry attribute to.

An entry states a declaration, never how many times React runs the body and never an
order between two entries. A JSX `on*` binding is an entry too; its identity comes from
the `template_handler` fact that states it, with the event as its trigger. A `use…` call
the extractor does not read is one entry per call site, so two calls of one unread hook
are two sites rather than one name.

Optional on `action_dispatch`: `continuesFile` and `continuesLine` name the gateway call
whose response handler this dispatch is written inside, and `outcome` is `success` or
`failure` for which of that call's handlers it is. The field is stated only where the
source states the relation — a `.then` or `.catch` callback — never inferred from two
statements sharing a body. Optional on `template_handler`: the `column` of the binding.

Mobile declaration identity works from these facts alone. A mobile `injects` or
injected-receiver `method_call` fact can carry `source` and `imported`. The reader follows
them to one declaration in one file and enters that declaration's own class name. A written
`.ts` specifier names that exact file. An extensionless specifier names the same path with
`.ts` added. The reader never searches directory indexes, other extensions, barrels, path
aliases or packages. A declaration proves an import only when its own `exports` lists the
imported name. Without provenance, a declaration in the caller's own file wins, then a
single declaration in the repository. A site the evidence cannot prove states the terminal
`mobile-declaration-unresolved` result, with the sorted candidate files when more than one
declaration is possible. An older fact set that lacks these optional fields remains
readable. It keeps the name-only limits, and a fresh extraction adds the provenance.

### Client display conditions

The mobile and web extractors record the conditions that show or hide a part of a component
template. They also record the values that a parent passes to a child component. Each read of a field in
one of these expressions has a trace. A trace is the list of hops from the read back to the
place that gives the value. The reader holds no list of field names, so each field name is
data.

| type | fields | stated when |
|---|---|---|
| `display_condition` | `component`, `form`, `shows`, `text` | a condition shows or hides a part of the template, and `text` is the condition as written |
| `client_transfer` | `component`, `target`, `name`, `text` | a template passes a value to a child: `target` is the child tag, `name` the bound input or prop, and `text` the value expression |
| `client_assignment` | `component`, `target`, `text` | a trace passes through an assignment: `target` is the assigned name, `text` the assigned value, and `step` the trace step |
| `client_read` | `component`, `path`, `context` | a condition, a transfer or an assignment reads a field: `path` is the read as `a.b.c`, and `context` is `condition`, `transfer` or `assignment` |
| `client_scan` | `component`, `region`, `status` | the reader scans one template region: `region` is `template` (Angular) or `jsx` (React), and `status` is `complete`, `partial` or `failed` |

Each fact also has `column`. If the template is a separate file, a mobile fact has
`componentFile`, as other mobile facts do. That is the file that declares the component.
Two sites on one line give two facts.

The forms of a `display_condition` are these:

- `ngIf`, from `*ngIf`, with `; else`, `then`, `let` and `as` parts. `shows` is `true`.
- `hidden`, from `[hidden]`. `shows` is `false`.
- `and`, from `{c && <X/>}`, and `return-and`, from `return c && (<X/>)`. `shows` is `true`.
- `ternary`, from `{c ? <X/> : <Y/>}`. `shows` is `"both"`, because each branch shows a part.
- `early-return`, from `if (c) return …` before the last `return` of a component.
  `shows` is `false`.

A `client_transfer` has `form`. The template forms are `property` for `[x]`, `two-way` for
`[(x)]`, and `attr`, `class` or `style` for `[attr.x]`, `[class.x]` and `[style.x]`. The JSX
forms are `jsx` for `x={…}` and `spread` for `{...x}`. If one component declares the child tag or the imported name, the fact has
`targetComponent` and `targetFile`. A JSX attribute whose value is an element gives a
transfer with no read.

A `client_read` has `negated` and `traces`. If an odd number of `!` holds the read, `negated`
is `true`. With Angular pipes, it has `pipes`, the pipe names from the read outward. Its
`site` is `{ kind, file, line, column }`, the site that holds the read. A trace is
`{ hops, end }`. Each hop is `{ step, file, line, column, path }`, where `path` is the path
that the step looks up. If the trace reaches a literal value, `end` is
`{ origin: "literal", text }`. If the trace stops, `end` is `{ unresolved: <reason> }`. A stopped trace keeps the hops
before the stop. A read with a stopped trace has `unresolved`, the reason of its first
stopped trace.

The trace steps are these:

| step | the hop goes to |
|---|---|
| `alias` | a `const` or `let` that holds the read |
| `destructure` | a destructuring pattern that names the read |
| `member` | a class member initializer |
| `assignment` | a `this.x = …` assignment in a class body |
| `getter` | the single `return` of a getter |
| `input` | an `@Input()` member |
| `prop` | a prop of a function or class component |
| `transfer` | the parent site that binds the input or prop |
| `iteration` | the list of an `*ngFor` or a `.map` callback, with `[]` added to the path |
| `async` | the value under an `async` pipe |

A trace reason names why a trace stops. The list is closed:

| reason | the trace stops at |
|---|---|
| `dynamic-key` | a key that is not a literal, as in `flags[key]` |
| `store-selector` | a store `select` or a `useSelector` read |
| `call` | the result of a helper or method call |
| `external-root` | an import, a global or an injected service member |
| `unsupported-local` | a `#ref`, `let-x` or `index as i` template local |
| `no-binding` | an input or prop that no parent site binds |
| `spread-props` | a prop that only a `{...x}` spread can give |
| `ambiguous` | a name with two declarations in scope, or a selector that two components declare |
| `cycle` | a member that the trace already passed through |
| `depth-limit` | the hop limit, 16 hops |
| `trace-limit` | the trace limit, 64 traces for one read, and the branches after it give no trace |
| `unsupported-syntax` | an expression outside the grammar, or a hop with no supported source |
| `unsupported-form` | a form that the reader knows and does not read, such as a static attribute at a child tag |

A `client_scan` fact is at line 1 of a separate template file. An inline template has its
fact at its `template:` line, and a JSX region at its component declaration. The fact has
`counts`, the number of conditions, transfers, assignments and reads of the region. The
status is one of these:

- `complete` means that the reader parsed each condition and each transfer site.
- `partial` means that some sites are outside the reader. Each one is an `unsupported` row
  `{ file, line, column, reason, text }`, with the reason `unsupported-syntax` or
  `unsupported-form`. A `[ngSwitch]`, an `@if (…) {` block, and a JSX `{c || <X/>}` are
  `unsupported-form`. An error in the reader gives a row with `internal: true`, and the
  other facts of the file stay.
- `failed` means that the reader cannot read the template. The fact has a `reason`.

| reason | the template |
|---|---|
| `template-url-unresolved` | the `templateUrl` names no readable file |
| `template-url-non-literal` | the `templateUrl` is not a plain string |
| `inline-template-substitution` | the inline `template` is not a plain string, for example a template literal with `${}` |

The five types join the one `facts` array. So a fact set extracted again has a new facts
`digest`, and each identity that hashes the digest changes with it: the `status.identity` of
`trace`, `span` and `chains`, and the `provenance.id` of an edge export. A snapshot taken
before reports drift for that set. The fact count of a set changes with its facts, in the
`extract` line and in the "Fact producers" table of the `render` report. A file whose only
facts are new facts is a file that the extractor read. So `decisions` reads it with blame,
and a member-scoped `affected` widening keeps an edge to it.

### Control evidence

A `backend` or `web` fact set with `controlEvidence: 1` states, on each call fact, where the
call sits in its body. The `source-flow` view reads these fields and falls back to an
unknown-order group when it cannot read them.

`column` is the 1-based column of the same offset the fact's `line` comes from. Two calls on
one line then have two columns.

`control` is an object, or `null` when the extractor could not read the body.

- `path` lists the frames that hold the call, outermost first. Each frame has `kind`, `form`,
  `id` (`<form>@<line>:<column>` of the construct), `line`, `column`, `text` (the construct
  head, at most 120 characters), and the field the form adds:
  - `arm`: an `if`, `switch` case, `?:`, `&&`, `||`, `??`, `?.` or `switch-expression`. The
    `arm` field is `then`, `else`, `default`, `true`, `false`, `right`, `non-null` or
    `case <labels>`.
  - `try`: `part` is `body`, `catch <n>` or `finally`.
  - `loop`: a `for`, `foreach`, `while` or `do` body, which repeats with no stated count.
  - `callback`: a `lambda`, `anonymous-method`, `local-function`, `callback` or
    `async-effect-callback`. `host` names the call that receives it, or is `null`. A web
    function written outside every component and member, such as a method of a module-level
    object, is a `callback` with `host: null`, because it runs whenever something calls it.
  - `continuation`: a web `then` or `catch` handler. `outcome` is `success` or `failure`, and
    `of` is the `{ line, column }` site it answers: the `Promise.all` or
    `Promise.allSettled` its chain starts with, or else the call its chain starts with. Earlier
    `.then` and `.catch` links of the same chain answer the same site.
  - `async-form`: `Promise.race` or `Promise.any`, whose scheduling the source does not state.
- `await` is `true` when the call heads the chain an `await` operand is, and is absent
  otherwise.
- `task` marks a started task: `{ id, local, join }`. `id` is `<line>:<column>`. `local` is
  the variable that holds it, or `null`. `join` is `{ id, form, line, column, tasks, path }` for the
  `await`, `Task.WhenAll`, `Task.WhenAny`, `Promise.all` or `Promise.allSettled` that names
  it, or `null` when nothing joins it. `tasks` lists only the task ids that calls of the same
  file carry. A call that is no fact, such as `Task.Delay`, is left out. A later assignment
  to the local replaces the task it held, unless the assignment sits in an arm, a loop or a
  callback that may not run. A task added to a collection stays in it. A task can start outside a guard and be joined inside
  it. So `path` lists the frames that hold the join itself, in the same form as the call's
  own `path`. The projection places the join inside those frames, not at the body's root.

A call in the condition of an `if` or `switch`, or in the collection of a `foreach`, is
outside that construct. A call in the condition or the step of a `for`, `while` or `do` is
inside the loop.

### Test evidence

| type | fields | stated when |
|---|---|---|
| `pw_test` | `spec`, `test`, `skipped` | a Playwright test is declared — not a `test.skip(condition, reason)` guard written inside a test body, and not a `test` reached through a member access (a regular expression's `.test(...)`, a matcher object's) |
| `pw_request` | `spec`, `test`, `verb`, `template`, `resolved` | a test issues a request |
| `pw_assert` | `spec`, `test`, `kind` | a test asserts something |
| `pw_stub` | `spec`, `test`, `kind` | a test stubs a response; `handler` says what its route handler does |
| `pw_backend` | `spec`, `test`, `skipped`, `backend`, `sites` | one per `pw_test`: whether the test runs on a real backend, on patched responses or on a mocked backend |
| `cypress_test` | `spec`, `test`, `skipped` | a Cypress test is declared |
| `cypress_intercept` | `spec`, `test`, `verb`, `pattern` | a Cypress spec or support file intercepts a URL |
| `case_id` | `spec`, `ids`, `source` | a test names test-management case ids — `source` is `annotation` for a `case-id` annotation push, `literal` for a literal argument of a configured case-id call, `table` for one row of a same-file data table the test iterates |
| `pw_title` | `spec`, `titles` | *(optional)* the titles a collector resolved for one `pw_test` declaration, one per parameter instance; its `line` is that declaration's *source* line |

A `pw_request` can have four optional fields. `via: "helper"` marks a request that the test
makes through a call into a helper function, a helper class method or a client method. That
fact keeps the `file` and `line` of the call in the test body, and it gets one fact for each
request call that the call reaches, in source order. `chain` lists the calls as
`{ file, line, call }` entries. The first entry is the call in the test body, and the last
entry is the request call. `call` is the callee as written, with no white space. `receiver`
is the class whose method holds the request call. A request call in a top-level function
has no `receiver`.

The extractor enters four function or method bodies at most. It does not enter a body that
is already on the chain, or a body that calls `.route(`. If it cannot follow a call, the call
gives one fact with `verb: "ANY"`, `resolved: false`, a placeholder `template`, no `receiver`
and a `reason`. The reason is `ambiguous-receiver` when two or more bodies can answer the call,
and `depth-bound` when the call needs a fifth body. The chain of that fact ends at the call.
A request written in the test body itself, also inside an `expect(...)` argument, has none of
the four fields.

A name in a URL resolves in the file that holds the URL. If that file does not define the
name, a named import resolves to the one value of the files that export the name. Otherwise
the name resolves to its one value in the repository. If two or more values are left, the
template keeps `${name}` and the fact has `resolved: false`.

A `cypress_intercept` written in a support command carries no enclosing test and is exactly
as much proof that a route is exercised as one written inline. There is no Cypress assertion
fact, which is why Cypress evidence can never reach the `path` tier — the schema records no
basis for it.

`pw_backend` is written for every `pw_test`, at the same `file` and `line` and with the same
`spec`, `test` and `skipped`. `backend` is one of four classes:

- `mocked`: a call named in `backend.mockCalls` reaches the test
  ([configuration.md](configuration.md#backend)).
- `patched`: a route handler answers a request (`route.fulfill`, with or without
  `route.fetch` first), a `routeFromHAR(` call replays an archive, or a call named in
  `backend.patchCalls` reaches the test.
- `unknown`: the test reaches a region that the reader cannot read, and no mock or patch
  decides the class. `reason` says which region: `body-by-reference` (a test body or a hook
  passed by name), `named-handler` (a route handler named by a function that its file does
  not declare), `unread-handler` (a handler that calls none of `fulfill`, `fetch`, `continue`,
  `fallback` and `abort` on its route), `ambiguous-helper` (a bare call name whose
  repo-wide functions reach different kinds), or `unread-file` (the reader could not parse the
  spec file).
- `real`: none of the above.

The precedence is `mocked`, then `patched`, then `unknown`, then `real`, and only an `unknown`
fact carries `reason`. A test is read through its own body, the `beforeEach` and `beforeAll`
hooks at file level and of every `test.describe` block that encloses it, and every function
that those regions call. A function of the same file wins over a repo-wide class method or
top-level function of the same name. The walk follows calls to a fixed point, so a cycle
ends it. Comments and string contents are never read as calls.

`sites` lists the calls that decided the class, sorted by line. A site has `line`, `where`
(`test`, `hook` or `helper`) and `kind`, and can have `call`, `via` and `at`:

| `kind` | the deciding call |
|---|---|
| `mock` | a call named in `backend.mockCalls` |
| `patch` | a call named in `backend.patchCalls` |
| `fulfill` | a `.route(` handler that calls `fulfill` |
| `fetch-fulfill` | a `.route(` handler that calls `fetch` and then `fulfill` |
| `har` | a `routeFromHAR(` call |
| `abort` | a `.route(` handler that calls `abort` and not `fulfill` |
| `spy` | a `.route(` handler that calls only `continue` or `fallback` |
| `unresolved` | a region the reader cannot read |

An `abort` or a `spy` site never changes the class: a spy shows that the test makes the
request, and an abort removes a request. `call` is the callee as written. `via` lists the
functions between the test and the deciding call, in call order, with a method written as
`Class.method`. `at` gives the `file` and `line` of the deciding call when another file holds
it. A site `line` is always a line of the spec: the deciding call's own line when the spec
holds it, else the line of the test's call into `via`.

`pw_stub.handler` comes from the same reader: `fulfill`, `fetch-fulfill`, `abort`, `spy` or
`unresolved`. A direct `page.route(` stub takes the kind of its own handler. A stub helper call
takes the kind that every repo-wide helper of that name agrees on, else `unresolved`. The field
adds nothing to the set of `pw_stub` facts, and `cover` reads neither field.

`case_id` resolves only three shapes and refuses the rest: a
`test.info().annotations.push({ type: 'case-id', description: '…' })` whose description is
a string literal, a literal argument of a configured case-id call (`caseId.calls` in the
configuration file — an entry like `tms.id` matches `tms.id(...)` sites; none are
configured out of the box), or a member expression whose object is the loop binding of a
same-file `for (const row of ROWS)` over an array of object literals. A subscript, a
computed value, a template or a cross-file table stays absent rather than being
approximated — the id a tester pastes into a case tool is never invented.

`pw_title` is written by `extract` for a `playwright` repository configured `"titles": true`
(see [configuration.md](configuration.md#playwright-titles)): Playwright's own list mode
evaluates each parameterised title, and one fact per resolved declaration carries the titles
it produced. The listing is joined to the source on `(spec file, declaration ordinal)`, not
on any line the runner reports — those are positions in transformed source — so a fact's
`line` is always the *source* line of the declaration it belongs to, the same line the
`pw_test` fact for that declaration carries. A spec file whose two sides cannot be shown to
line up resolves nothing at all rather than a shifted set. Without the option, when the
collector could not run, or for a refused file, a reader keeps the title *expression* as
written and labels it `raw`; the fact set's header says which of the three happened.

### Derived and judged

| type | fields | stated when |
|---|---|---|
| `assertion_surface` | `route`, `status`, `chain` | `surface --out <file>` records where the state one route writes can be read back; `status` is `resolved` (adds `state`, `observe`) or `gap` (adds `reason`) |
| `surface_verdict` | `route`, `state`, `observe`, `field`, `reflects` | a human or agent read the projection path and recorded whether a response field of `observe` reflects the write; a refusal is `reflects: false`, an unread correlation is absent |

These two are the only facts not produced by an extractor. `assertion_surface` is a
derivation this tool can redo from the same fact sets at any time; `surface_verdict` is a
judgment it cannot make, cached so `skeleton` can quote it instead of guessing.

## Externally supplied facts

A repository configured with a `factsProvider` ([configuration.md](configuration.md#external-fact-provider))
takes facts from a second producer. The provider's document is `{ "producer", "version"?,
"repo"?, "facts" }`, its facts validated by the rules below, and every one that enters the
file is stamped `provenance`. The header records the second producer and how the two
compared, while `generatedFrom` still names the extraction that wrote the file:

```json
{
  "repo": "api",
  "kind": "backend",
  "generatedFrom": "flowtrace <version>",
  "generatedAt": "2026-01-01T00:00:00.000Z",
  "provider": {
    "producer": "syntax-exporter",
    "version": "1.4.0",
    "source": { "file": "/workspace/shop-api-facts.json" },
    "merge": "prefer-external",
    "supplied": 37,
    "kept": 37,
    "replaced": 12,
    "comparison": {
      "ctor_field": { "extracted": 20, "external": 22, "agreed": 9, "disagreed": 3, "externalOnly": 10, "extractedOnly": 8 }
    },
    "digest": "4b1f0c9e2d7a58e3b6c1f90a7d2e4c8b5a3f6e10"
  },
  "facts": [
    { "type": "ctor_field", "file": "Controllers/OrdersController.cs", "line": 14,
      "class": "OrdersController", "field": "_orders", "paramType": "Shop.Orders.IOrderService",
      "provenance": { "producer": "syntax-exporter", "version": "1.4.0" } }
  ]
}
```

`source` is `{ "file" }` or `{ "command": [ … ] }` as configured. `supplied` counts the
facts the provider gave, `kept` how many of them entered the array, `replaced` how many
extracted facts were dropped in their favour. In `comparison`, `extracted` and `external`
count facts per type; `agreed`, `disagreed`, `externalOnly` and `extractedOnly` count
*sites* — one type at one line of one file — that both stated identically, both stated
differently, only the provider stated, only the extractor stated. The comparison is computed
before the merge, because afterwards the losing facts are gone. `digest` is a sha1 over the
provider's facts as it supplied them, before any stamp or merge.

Every field of this block except `source` is part of the fact set's identity in a snapshot and
an edge export. `source` is left out because it is a location on one machine: the same facts
read from another checkout must keep the same identity, and an identity is published.
`digest` stands in for it, and is what still tells two provider documents apart under
`regex-only-with-diff`, where none of the provider's facts enter the array. Extracted facts keep their
order and come first; the provider's follow in the order it gave them.

## Validation

`fact(type, fields)` throws on an unknown type, a missing required field, a `file` that is
not repository-relative with forward slashes, or a `line` that is not a positive integer.
`validateFacts(array)` checks a whole set and reports the first bad entry by index and type.
Both live in `lib/facts.js`; an extractor cannot emit a malformed fact by accident.
`parseProviderDocument(document)` applies the same checks to an external provider's document
and additionally refuses a fact that already carries `provenance`, so the stamp is always
this tool's own statement.

## Reverse-resolution fields

`routes-of` adds no fact types and never scans source. Literal mode searches this complete
allowlist:

| meaning | fact field |
|---|---|
| route template | `route.template`, `gateway_call.template` |
| method-call target | `method_call.calledMethod` |
| publish or consume key | `publish.message`, `consume.message` |
| spec-evidence string | `cypress_test.test`, `pw_test.test` |

Route-template fields use the same route normalizer as `join`; all other fields compare the
whole string exactly. Substrings, regular expressions, fuzzy matches, concrete URLs standing
in for parameterised templates, metadata fields and raw file contents do not resolve.

The forward walker carries the identity and `repo:file:line` of these source facts on the
edges they create. That edge provenance is how reverse membership for a call, publish,
consume or gateway literal is proved. A spec title joins through the existing route-evidence
index instead; it remains route-level evidence and does not claim that the queried point ran.
