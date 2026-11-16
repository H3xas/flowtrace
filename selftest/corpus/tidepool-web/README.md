# tidepool-web

An invented React app for the client condition reader. Each component holds the forms
one part of the reader reads:

- `deck/Deck` has each JSX display form, the two early returns, parameter destructuring
  with a renamed and a nested key, and a `.map` that passes a field of each item to `Pier`.
- `deck/Pier` is rendered by three parents: `Deck` binds `childFlag`, `Jetty` sets it as
  a string attribute and `Wharf` as a bare attribute.
- `deck/Skiff` is rendered only with a `{...rest}` spread.
- `quay/Jetty` reads a `const` alias of `props.a.b` and returns `c && (<X/>)`.
- `quay/Quay` destructures `props` in its body, with a nested and a renamed key.
- `quay/Mooring` is a class component that reads `this.props.x` and `this.state.x`.
- `quay/Shoal` holds a store selector, a nested callback, a name declared twice and a
  `||` render.
- `quay/Calm` is a complete region that reads no field.
