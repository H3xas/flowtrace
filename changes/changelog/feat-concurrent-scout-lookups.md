### Code index lookups

- The query verbs that read the code index run its lookups as child processes, a bounded
  number at the same time, in passes. The output does not change. `scout.concurrency` in the
  configuration file, or `FLOWTRACE_SCOUT_CONCURRENCY` in the environment, sets the limit, and
  the file value wins. The default is `min(8, os.availableParallelism())`. A limit of 1 runs one
  lookup at a time. A value that is not an integer of at least 1 fails the configuration load.
- `scope` and `cover` build the trace index and the intercept evidence index once for each run,
  not once for each lookup pass.
