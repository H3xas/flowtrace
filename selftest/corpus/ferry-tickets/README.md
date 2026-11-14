# ferry-tickets

An invented ferry booking system: two backend repositories (`api`, `ops`) and one web
client (`web`). It holds the attribute and route-argument shapes the C# reader must read:

- attributes over several lines between a verb attribute and its action, at class and
  method level (`SailingsController`, `CheckInEndpoint`, `Harbor/Board.cshtml.cs`);
- attribute lines that end with a `//` or `/* */` comment (`SailingsController.Upload`,
  `ManifestsController.UploadFile`);
- route arguments that are constant expressions (`ApiRoutes`): concatenation, a verbatim
  literal, interpolation, `nameof` and a nested class;
- three controllers that differ only by a constant prefix (`UpperDeckController.cs`, `LowerDeckController.cs`, `CarDeckController.cs`);
- route arguments that have no single value (`FaresController`): an unknown name, a cycle,
  one name in two namespaces, a method call, and a constant that only the `ops`
  repository declares, and a page whose class route names an unknown constant
  (`Harbor/Lost.cshtml.cs`).

`Passengers/` holds the call shapes: calls inside expression-bodied methods, inside object
and collection initializers, and chain links whose receiver type is known from a parameter,
a typed local, `new T()`, an awaited `Task<T>` or the return type of the previous link. Two
receivers have no single target: `thing`, whose type nothing states, and `port`, which
reaches `Moor` through two interfaces.

`Gates/` and `GatesController.cs` hold the decisions an expression makes: conditional
operators (one nested in another), `??` choices beside a `?? throw` and a `??=`, lambdas passed
to `Where`, `Any` and `All` beside a method group, and the nullable marks and `?.` that are no
decision. `GatesController.Status` compares with a named value, the text a statement-level
decision would read dispositions from.

`Boarding/` and `BoardingController.cs` hold a service result that each action tests with an
`if` whose body returns on success. In `Approve`, `Pass` and `Stub` the next statement is the
refusal the sentinel falls through to. The other actions put a statement between the two, give
the `if` a longer body, return a shape no status rule reads, or use an `else`.

`DecksController.cs` holds one-line branches whose condition names a status word other than
the one its own `return` or `throw` answers, beside a multi-line branch.

`Checkin/` holds a pipeline whose steps throw two calls below the step. The `api` table in
`ferry.config.json` maps some of those types, `GateFaultFilter` maps one globally, and
`CheckinController.Caught` catches one in the action. `PierDownException` maps to a 5xx,
`ManifestException` maps nowhere, and only the `ops` table names `TicketLostException`.
