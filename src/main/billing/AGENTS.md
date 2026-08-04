# Billing

- Treat remote pricing as untrusted data: extract only allowlisted model IDs, validate
  every numeric rate, and cap response size and request duration.
- Startup pricing refresh is best-effort. A network or parse failure must preserve the
  last-known-good cache; a missing cache must preserve the bundled shared rates.
- Main and renderer must install the same validated snapshot through typed IPC so live
  estimates and persisted completed-turn costs use the same catalogue version.
- Persist the effective pricing version on every completed turn. Never retroactively
  recalculate historical spend when a newer catalogue arrives.
