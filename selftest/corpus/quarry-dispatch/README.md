# quarry-dispatch

An invented dispatch service used by the partial-result contract tests. It is not a
sample application. Each file exists so one result-status case has facts behind it:

- `DispatchController.Plan` reaches a wide survey chain before it writes through
  `DispatchLedger.Record`, so a small node budget stops the depth-first walk before the
  write and the level schedule still enters it.
- `DispatchController.Check` states eight independent validations, so its seed list
  passes the seed cap.
- `DispatchController.Route` calls through `IDispatchGate`, which two classes implement,
  so the walk states an inferred edge.
- `DispatchController.Survey` walks a collection of `ISurveyChannel` with seventeen
  implementations, so the interface fan-out cap drops one.
- `DispatchController.Quiet` calls nothing, so its walk asks the code index and reports
  it unavailable when none is configured.
- `DispatchBoard` calls a gateway whose template the web extractor cannot resolve, so
  the join cannot match a route.

Names, repositories and data are invented for this suite.
