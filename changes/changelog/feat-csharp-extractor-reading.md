### Extraction

- The C# extractor reads an attribute section by bracket depth, so an attribute over several
  lines, with a collection expression or a trailing comment, keeps its verb attribute.
- A route argument resolves as a constant string expression: a literal, a `const` string
  field, a concatenation or interpolation of constants, or `nameof`. An argument with no
  single value keeps its route fact with `unresolvedArgument`, `extract` warns once with the
  file and line, and the route never matches or joins a request.
- Calls in expression-bodied methods and in object and collection initializers give their
  `method_call` facts. A link of a member-access chain gives one with `receiverType` when its
  receiver type is known and the repository declares exactly one target.
- `?:` conditionals, `??` choices and predicate lambdas are `branch_point` facts of the kinds
  `ternary`, `coalesce` and `predicate`. `decisions` and `cover` list them, and they
  multiply no seed.
- `if (r) return X; return Y;` and its `null` forms give a `sentinel_map` whose status is
  what `Y` answers.
- A pipeline loop that tests a step before it runs it gives `loop_stop.gate`. A flag write
  whose value is a call gives `flag_write.call`.

### The walk

- A one-line guard or error return reads its label and response kind from its own `return`
  or `throw`, never from its condition. A corpus guard that named a forbidden member no
  longer reads `403 Forbidden`.
- A backend repository accepts `exceptionStatuses`, a map from a simple exception type name
  to a status from 400 to 599. An action `catch` wins first, a global exception filter
  second, and the table of the throwing repository last. A deep throw that maps to a `4xx`
  status is its own outcome.
- `span` fault and reject rows and `cover` seeds, in text and `--json`, list the run-time
  conditions that decide them: a toggle, a pipeline step's gate test and a flag stored from
  a call. A seed that such a gate or call decides, with no branch the request drives, reads
  reachability `unknown` and names the condition.
