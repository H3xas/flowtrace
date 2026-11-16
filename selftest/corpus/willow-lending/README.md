# willow-lending

An invented lending API. `LoanService` takes three types from packages that no file of the
corpus declares: the interface `Fernway.Ledger.ILedgerClient` and the classes
`Fernway.Notices.NoticeSender` and `Fernway.Audit.AuditTrail`. `SettlementBook` is a class
of the corpus.

- `POST lending/v1/loans/{loanId}/settle` calls `NoticeSender.Send` and `SettlementBook.Close`.
  A code index that holds no `NoticeSender` makes the first call the edge of the configured
  repositories, and the walk stays complete.
- `GET lending/v1/loans/{loanId}` calls `NoticeSender.Send`, `AuditTrail.Record` and
  `ILedgerClient.Fetch`. The interface has no implementation in the corpus, so the walk
  also stops at an unresolved target.

`willow.config.json` marks the backend as indexed (`scout: true`). The tests name a stand-in
index binary with `FLOWTRACE_SCOUT_BIN`.
