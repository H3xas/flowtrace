# tidepool-mobile

An invented Angular app for the client condition reader. Each component holds the forms
one part of the reader reads:

- `harbor/harbor-panel` has an external template with each `*ngIf` form and `[hidden]`.
  A field and a method both set one member. The class also has a getter, an `@Input()`
  and an `async` alias. An `*ngFor` passes a field of each item to `tp-buoy`.
- `harbor/buoy` has an inline template. Two parents render it: one binds `childFlag`
  and one sets `spare` as a static attribute. No parent binds `drift`.
- `harbor/calm-note` is a complete region that reads no field.
- `harbor/shore-note` has an external template with no child tag, so the new facts are
  the only facts of that template file.
- `reef/reef-board` holds a dynamic key, a literal key, store selectors, a call and an
  injected service. It also holds an import, template locals, a member loop, a member
  with no source and a nested callback. Last, it holds a selector that two components
  declare, and the forms that the reader knows but does not read.
- `reef/twin-a` and `reef/twin-b` declare the same selector.
- `reef/drift-note`, `reef/eddy-note` and `reef/swell-note` are the three failed regions.
