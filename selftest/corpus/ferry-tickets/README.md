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
