# kite-club

An invented kite club: a small ASP.NET Core backend, a React web client with its Cypress
suite, an Ionic app and a Playwright suite. Every name is invented.
`selftest/route-chains.test.js` copies this directory, runs `extract` over the copy and then
runs `chains`, and `span --from-component` beside it, against it.

The route under test is `POST clubs/v1/join/{id}` (`ClubsController.Join`). Three callers
reach it: the thunk `joinClub` in `web/src/actions/clubs.ts`, the function `legacyJoin` in
`web/src/api/legacy.ts` and `ClubService.join` in the Ionic app. The Cypress spec intercepts
the route and the Playwright spec posts to it, and neither is a caller.

## What each shape is for

| Shape | Source | The chain `chains` prints |
|---|---|---|
| A class component bound by `connect(…, { joinClub })`, whose `onClick` handler calls the bound prop | `ClubFeed.handleJoin` | Page `clubs/:clubId/*`, a render `App -> ClubFeed`, the event entry, the dispatch, the `props_bind`, the effect and the request. |
| Components passed as element props of one route | `<Shell main={<ClubFeed />} side={<ClubSidebar />} />` in `web/src/app.tsx` | Their page is the route whose line range holds the render. |
| A component that binds the bound prop straight to `onClick`, rendered twice by `ClubFeed` and once through `Panel` | `JoinButton` | One chain with 3 render variants, through the `ClubFeed -> JoinButton` render on the lower line. |
| A function component that calls the bound prop in its body, with no event | `ClubSidebar` | A `no-entry` gap, and the chain still ends at `clubs/:clubId/*`. |
| A page that dispatches the thunk in a `useEffect` | `JoinPage` | The `join` route by its element, with the `useEffect` entry. Two chains: the call of the thunk and its dispatch. |
| A name two files declare, rendered through a barrel that settles neither | `web/src/cards/Badge.tsx`, `web/src/legacy/Badge.tsx` | The legacy one calls the thunk in its body: a `no-entry` gap, then `component-ambiguous` with both files and no hop above it. Two chains, call and dispatch. |
| A component that calls the thunk in its body and that nothing renders | `OrphanNotice` | `no-entry`, then `no-page`. Two chains, call and dispatch. |
| A function that posts to the route and that nothing calls | `legacyJoin` | `no-caller`. |
| An Ionic page whose `(click)` handler dispatches an action that an NgRx effect answers | `ClubAboutPage.onJoin`, `ClubEffects.joinClub$` | The page, the event entry, the dispatch, the effect, the call of `ClubService.join` and the request. |
| A component the page template renders, whose handler calls the service | `JoinChipComponent` | Page `ClubAboutPage`, one render to `app-join-chip`, its event entry, the call and the request. |
| An Ionic page that calls the service in a lifecycle hook | `ClubInvitePage.ionViewDidEnter` | The page and its `ionViewDidEnter` entry. |
| A route no caller reaches | `DELETE clubs/v1/{id}` | `0 chains`, exit 0. |
| One route key that two controllers serve | `GET clubs/v1/health` | The key is ambiguous: exit 2. |

## Variants the test builds

The test rewrites one thing in a disposable copy for a shape this directory does not hold:

- `web/src/app.tsx` with two `<Route>` elements on one line, each passing `ClubFeed` as an
  element prop: the `ClubFeed` chain ends at `page-ambiguous`.
- `web/src/join/JoinPage.tsx` with `useEffect(runJoin, [])`, where two modules declare
  `runJoin`: the chain prints `entry-unresolved` and still ends at the `join` route.
- The extracted `gateway_call` of the thunk with `resolved: false`: the chains through it
  print `template-not-resolved` and still climb to their pages.

## Expected counts

The default run of `chains "POST clubs/v1/join/{id}" --json`:

```json
{ "callers": 3, "chains": 13, "complete": 7, "withGap": 6 }
```
