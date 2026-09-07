# Calibration set

A golden set built from this worked example's own packets: run
`flowtrace cover --area checkout --packets <dir>` here and the four packets it writes are,
byte for byte, the ones under `<id>.packet.json`. Each entry is one packet, one
`<id>.verdict.json` holding the reference verdict and the outcome the merge must produce for
it — the level of every seed, the rejection reasons and their counts, the number of upgrades
and confirmations — and one `<id>.md` note that explains the reading. `reference/` holds the
reference verdicts alone, in the shape a reader writes.

Entries come in two kinds:

- **Readings** (01–04): the verdict is what a careful reader writes for the packet. A reader
  is calibrated against these by reading the packet and writing its own verdict.
- **Refusals** (05–07): the verdict is deliberately defective — a stale hash, the wrong route,
  an uncited upgrade — and the entry pins that the merge refuses it. No reader produces these
  from the packet; copy them from `reference/` into the reader's output directory unchanged.

To check the set against itself, which CI does on every push:

```
flowtrace calibrate --golden calibration --verdicts calibration/reference
```

To calibrate a reader: hand it the seven packets, collect its `<id>.verdict.json` files in one
directory together with the three refusal verdicts from `reference/`, and run the same command
with that directory. Exit 0 means every packet came out as its note says; exit 1 lists each
disagreement by packet, seed, expected level, level produced and the rule the entry quotes.
