# status-identity

Walk answers as the release branch printed them, kept as text so that a test can compare them
with this checkout. A walk's status identity is a digest of the fact sets the walk read, so a
fact kind or a fact field that an extractor adds moves it. Each file here is the answer of a
start whose identity moves for that reason. The rest of its text is the release's, and
`test-evidence-identity.test.js` holds this checkout to it.

`index.json` lists each file with the group, the corpus, the start and the output it holds.

| Group | Files | What each file is |
|---|---|---|
| `buoy-signals/` | 1 | The `trace --area harbor.area.txt` answer of `corpus/buoy-signals`, as its `expected/trace-area/stdout` pin held it at the release. Each of its three answers holds another identity today. |
| `seed/<corpus>/` | 7 for `demo-shop`, 5 for `kettle-market` | `trace <route> --seeds --json`, as `corpus/seed-goldens/<corpus>.json` held it at the release. |
| `dependency/<corpus>/` | 16 for `demo-shop`, 10 for `kettle-market`, 18 for `lantern-depot` | `trace <start> --json` and `trace <start> --graph`, written by the release command line over the corpus the release extracted. The sha256 of each file, taken as `dependency-goldens.js` takes it, is the digest that the release's `corpus/dependency-goldens.json` held. |

Every file is the whole stdout of its command, so it also holds the identity the release wrote.
The test takes out `status.identity` and nothing else before it compares.

A change that moves a field beside the identity fails the test. Write these files again only
from the release command line, and only when the release answer itself changes.
