### Extraction

- A `web` repository reads `.js` and `.jsx` sources as it reads `.ts` and `.tsx`. Test,
  spec, story and Cypress files give no facts.
- A default export and a curried wrapper such as `connect(a, b)(C)` name the component `C`.
  A `<Route>` element that names an imported component marks the component of that module
  as the page, and a render lands on the component that its import names.
- A method of a module-level object literal is a `method_span` whose `class` is the const
  name.
- A bare call in such a method to a module-level function of the same file gives a
  `method_call` with `field: "this"` and `calledClass`, the class of that function span.
  `trace`, `chains` and `surface` resolve it to that span in the same file.
- A `gateway_call` reads a call on the default import from `axios`, on an `axios.create`
  instance or field, or on a constructor parameter typed `AxiosInstance`. `service` names
  the receiver. The new `repos[].httpClients` key lists more receiver names. A bad value or
  the key on a repository that is not `web` stops with exit 2.
- A gateway URL built from a literal const, or returned by a helper function of the same
  file, reads as its literal text and joins the route it names.
- A fact set extracted again has a new facts digest, so the status identity of a walk over
  it and the identities of a `join` snapshot or edge export change with it.

### Trace

- `trace <name>` and `trace <Owner>.<name>` start at a web module-level function when no
  page, component, service, route, method or class matches. Two such functions give the
  ambiguous answer.
