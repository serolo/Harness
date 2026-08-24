# Telemetry privacy contract

- Product analytics and crash reporting are independent, explicit, app-global opt-ins. The durable
  record is `privacy.json` under Electron `userData`; never move consent into project/TOML settings.
- No telemetry client may be initialized or make a network request while its consent is false.
  Missing, malformed, or unknown-version state fails closed.
- Renderer IPC exposes only consent read/update. Event names and properties stay closed and typed in
  main; never add a renderer-controlled event name or free-form property bag.
- Never send repository/workspace identifiers, names, paths, remotes, branches, files, prompts, chat,
  diffs, terminal output, commands, environment variables, tokens, account data, or raw error text.
- Every product event property must be added to `policy.ts`'s per-event allowlist with a test. Sentry
  events pass through the scrubber; default breadcrumbs are rejected because IPC can contain secrets.
- Withdrawing usage consent disables PostHog and clears its queue before shutdown. Withdrawing crash
  consent closes Sentry and disables native uploads. Enabling native crashes after startup takes effect
  on the next launch because the Electron SDK must initialize before `app.ready`.
