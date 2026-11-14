# widget-ledger

An invented ledger suite whose case ids come from same-file values: a map with six template
keys read in two nested loops, literal and ternary keys, a block-local `const`, an array
element and loop rows destructured by member and by position. `refusals.spec.ts` holds the arguments the bounded reader
must not resolve: an absent key, a parameter, a call result, the environment, `let` and `var`
bindings, an imported map and loop array, a loop product past the instance limit, and one
absent key among present ones.

`ledger.config.json` names both forms of the case-id call. `case-id-maps.test.js` runs the
corpus through the CLI, one `Case id maps AC-n:` test for each acceptance rule.
