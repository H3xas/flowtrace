# Calibration set

Seven golden entries built from this worked example's own packets (`flowtrace cover --area checkout --packets <dir>`).
Each entry is one `<id>.packet.json`, one `<id>.verdict.json` stating the reference verdict and what the merge must
produce for it, and one `<id>.md` note explaining the reading. `reference/` holds the reference verdicts alone, in the
shape a reader writes, so the set can be checked against itself:

```
flowtrace calibrate --golden calibration --verdicts calibration/reference
```

To calibrate a reader, hand it the seven packets, collect its `<id>.verdict.json` files in one directory, and run the
same command with that directory. Exit 0 means every packet came out as the notes say it should.
