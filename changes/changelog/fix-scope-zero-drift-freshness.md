### Scope

- `scope --area` reads a fact snapshot and no longer refuses a stale one. A moved HEAD or a
  changed working tree now warns on stderr, in human and JSON modes. The JSON report gains
  `freshness: { value, sets }`, using the vocabulary `trace` already reports. When the area
  resolves, the exit code is 0. Stale facts no longer exit 4. The route rows describe the
  snapshot, not the source as it stands now.
