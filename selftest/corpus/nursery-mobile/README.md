# nursery-mobile

An invented Ionic app and the small ASP.NET Core backend it calls. Every name is invented.
`selftest/mobile-component-span.test.js` copies this directory, runs `extract` and `join`
over the copy, and then runs `span --from-component` and `trace` against it.

## What each shape is for

The start page is `PlotDetailPage` (`mobile/src/app/features/plots/plot-detail.page.ts`). It
injects `PlotService` and the NgRx `Store`, and its template renders `SeedlingBadgeComponent`.

| Shape | Source | What the span shows |
|---|---|---|
| Three handlers call three methods of one service | `onRefresh`, `onWater`, `onRelabel` | Each entry keeps its own route. |
| A gateway call inside `pipe(mergeMap(...))` on one line | `PlotService.loadSeedlings` | `GET nursery/v1/plots/*/seedlings`, resolved, under `onRefresh`. |
| One handler reaches two methods of the service, one through a `this.` helper | `onTend`, `prepareTend` | Both the `water` and the `label` routes, under `onTend`. |
| A gateway call written over two lines | `PlotService.addNote` | No fact. `onNote` is an entry that reaches no route and has no unresolved arm. |
| A path no route serves | `PlotService.exportPlot` | `no-route-match` under `onExport`. |
| A template built by a method the extractor does not inline | `PlotService.replaceWatchers` | `template-not-resolved` under `onShareWatchers`. The route matcher lands it on `PUT nursery/v1/plots/*/label` by prefix, and the span does not trust that. |
| A dispatched action that an effect answers | `onSync`, `PlotEffects.sync$` | `GET nursery/v1/plots/*/sensors` under `onSync`. |
| A dispatched action that no effect answers | `onPin` | `no-effect` under `onPin`. |
| Lifecycle hooks from the list | `ngOnInit`, `ngOnChanges`, `ngOnDestroy` | One `mount`, one `update` and one `unmount` entry. Only `ngOnInit` reaches the `summary` route. |
| A method named like a hook that is not on the list | `ionViewCanLeave` | No entry. Its `history` request is the one arm without entry. |
| A method no entry calls, which calls a method an entry reaches | `reloadAll` | Nothing extra: the `seedlings` request already belongs to `onRefresh`. |
| An assign binding | `(ionInput)="draft = $event"` | No entry. |
| A rendered child with its own handler, injecting the same service | `SeedlingBadgeComponent.onMark` | A `SeedlingBadgeComponent` entry with the `health` route. The page's own requests to the service still print. |
| Two classes of one name in two folders | `features/archive/` and `features/legacy/` `ArchiveListPage` | Without `--file` the name exits 2 and lists both files. `--file legacy` picks one, with its `ngOnDestroy` entry only. |

## Expected header counts

Each key names one run of `span --from-component <start> --json` with the flags shown. The
test reads this block and compares every `header` with it.

```json
{
  "PlotDetailPage": { "routesResolved": 9, "armsResolved": 11, "armsUnresolved": 3, "entries": 13, "armsWithoutEntry": 1 },
  "PlotDetailPage --depth 2": { "routesResolved": 8, "armsResolved": 8, "armsUnresolved": 16, "entries": 13, "armsWithoutEntry": 10 },
  "PlotDetailPage --entry onTend": { "routesResolved": 2, "armsResolved": 2, "armsUnresolved": 0, "entries": 1, "armsWithoutEntry": 0 },
  "PlotDetailPage --entry ngOnInit": { "routesResolved": 1, "armsResolved": 1, "armsUnresolved": 0, "entries": 1, "armsWithoutEntry": 0 },
  "PlotDetailPage --entry click@6": { "routesResolved": 1, "armsResolved": 1, "armsUnresolved": 0, "entries": 1, "armsWithoutEntry": 0 },
  "PlotDetailPage --entry onExport": { "routesResolved": 0, "armsResolved": 0, "armsUnresolved": 1, "entries": 1, "armsWithoutEntry": 0 },
  "SeedlingBadgeComponent": { "routesResolved": 1, "armsResolved": 1, "armsUnresolved": 0, "entries": 1, "armsWithoutEntry": 0 },
  "PlotService": { "routesResolved": 8, "armsResolved": 8, "armsUnresolved": 2, "entries": 0, "armsWithoutEntry": 10 }
}
```

The `--depth 2` run is the one with `walk-limit` arms. Each entry walk stops at a service
method or at a store action. The constructor walk of the page spends no depth on its `ctor`
hop, so at that depth it still reaches routes the entries do not. Those requests are arms
without entry, which is why that run has ten of them.

## The trace goldens

`trace-plot-detail.golden.json` is `trace PlotDetailPage --json`, and
`trace-plot-detail-from-handler.golden.json` is
`trace PlotDetailPage --from-handler onSync --json`. The capture ran over a copy of this
directory after `extract` and `join`. It used the CLI from before the mobile component span,
and two captures were byte-identical. They prove that the span's entries leave mobile `trace`
output as it was. Change a golden only together with a deliberate change to mobile `trace`.
