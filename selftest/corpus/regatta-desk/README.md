# regatta-desk

An invented race office for sailing regattas: a small ASP.NET Core backend, a React and Redux
web client and an Ionic app with NgRx. Every name is invented.
`selftest/web-journeys.test.js` copies this directory, runs `extract` over the copy and then
runs `trace`, `span --from-component` and `chains` against it.

## What each shape is for

| Shape | Source | Read by |
|---|---|---|
| A class component whose `componentDidMount` and `componentDidUpdate` call `connect`-bound creators | `RegattaHeader` | AC-11 |
| A function component that dispatches a thunk in a `useEffect`, and in an inline `onClick` arrow | `ResultsBoard` | AC-2, AC-4, AC-11 |
| A function component that calls a `connect`-bound creator in its body, and a local named arrow that no event links | `CrewRoster` (`onSignUp`) | AC-1, AC-3, AC-8 |
| A class component whose `render` calls a `connect`-bound creator, and a `let action` that the body sets to an arrow later | `SignupPanel` | AC-1, AC-3, AC-8 |
| Inline `onClick` arrows on `this.props` and on `props`, each on one line and over more than one line | `BoatList`, `BoatRow` | AC-2, AC-8 |
| Inline `onClick` arrows that dispatch a creator call, on one line and over more than one line | `MarkBoard` | AC-2, AC-9 |
| A function component that dispatches through `useDispatch` in its body | `WindBox` | AC-1 |
| A component that no route and no render reaches | `DriftNotice` | AC-9 |
| A creator with no `effect_handler` that dispatches other creators, in the function form and the curried arrow form, and one that dispatches such a creator | `refreshDesk`, `refreshResults`, `refreshAll` in `web/src/actions/regattas.ts` | AC-4 |
| A curried arrow creator that sends its own request | `loadWind`, `loadTide` in `web/src/actions/weather.ts` | AC-4 |
| `App`, mounted at `/` by the root render, holds `groups/:groupId/*`. A second `<Routes>` tree that nothing renders holds `groups/:groupId` | `web/src/app.tsx`, `GroupGlance` | AC-6, AC-7 |
| An Ionic page that sends requests from `ngOnInit`, `ionViewWillEnter` (through an NgRx `store.dispatch`) and `ionViewDidEnter`, and a component its template renders | `RaceDayPage`, `ProtestChipComponent` | AC-12 |

## Configurations

- `regatta.config.json` reads the three repositories.
- `regatta-mounted.config.json` also names the mount of `App` in `repos[].mounts`.

## Base captures

`base-facts/web.json` is the web fact set that the extractor of the implementation base
writes for this corpus. `base-capture.json` holds what the base code prints for it: the
`trace --json` nodes without their walk ids, the `span --from-component --json` entries and
the `chains --json` hop sites. `golden.mjs` writes both files. The captures pin the base
code, so a newer one is compared with them and never written into them. Run the base
commit's own CLI over the current inputs:

```
git archive <base commit> lib bin package.json | tar -x -C <empty directory>
node selftest/corpus/regatta-desk/golden.mjs --cli <empty directory>/bin/flowtrace.js
```

A change to the corpus needs this step in the same diff.
