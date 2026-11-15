### Extraction

- A `mobile` repository reads a class with no `@Component` or `@Injectable` decorator. It
  writes a `component` fact with the new role `class` and its `exports`. It also writes the
  member, call, injection, gateway and dispatch facts of a decorated class. A class with an `extends`
  clause writes `extends`, and for an imported base also `extendsSource` and
  `extendsImported`.
- A mobile static call `<Name>.<member>(…)` on a class that the file declares or imports from
  a relative module writes a `method_call` with `field: <Name>` and `static: true`.
- A mobile `this.<GatewayService field>.<verb>(…)` call with spaces, line breaks, comments or
  type arguments between its tokens writes one `gateway_call` fact at the line of `this`. A
  fact set extracted again can have a new facts digest, so the status identity of a walk over
  it changes with it.

### The walk

- `trace` on a mobile page gives one handler node for each template site that binds the
  handler, each with its own site and subtree.
- A `--from-handler` selector that matches handlers at two or more sites exits 2 and lists
  one candidate for each site, on web and mobile starts. An `@<line>` or `@<line>:<column>`
  suffix selects one site. A malformed suffix exits 2 with
  `--from-handler site must be @<line> or @<line>:<column>`.
- A plain mobile class is a `trace` start in the class tier, beside backend classes. A name
  that both declare exits 2 and lists both, and `--repo` selects one. A static call from a
  mobile method is followed in `trace` and in `span --from-component`. A static call whose
  relative module declares no class of that name gives one `mobile-declaration-unresolved`
  arm.
- `trace <Class>.<method>` on a mobile class name that two files declare, each with that
  method, exits 2 and lists each declaration file.
- `chains` keeps the declaration file of a mobile template entry, so a page that shares its
  name with another page climbs to its own page. A template owner that the facts do not prove
  gives a `component-ambiguous` gap that names the candidate files.

### Component span

- A listed lifecycle hook that a mobile page inherits from a base class in the repository is
  an entry of the page, at the hook of the base class. A base imported from a package gives no
  entry. A relative base that resolves to no one declaration gives one
  `mobile-declaration-unresolved` arm at the `extends` site.
- The walk-limit text names the kind of the node that the budget cut: action, method,
  service, component, page or entry. The JSON `reason` stays `walk-limit`.
- `docs/cli.md` describes the `span --from-component --json` model (schemaVersion 1) as one
  contract for web and mobile.
