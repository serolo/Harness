# Harness telemetry privacy

Harness stores repositories, chat history, diffs, commands, and terminal output locally. Product
analytics and crash reporting are optional and independently disabled by default.

## Anonymous product analytics

When enabled, Harness sends a closed set of feature events to PostHog together with the app version,
operating system, architecture, a per-launch session id, and an anonymous installation id. The id is
created only after opt-in and deleted on opt-out. Events contain only allowlisted enum, boolean, count,
outcome, and duration properties.

Harness does not send repository or workspace identifiers, names, paths, remotes, branch names,
filenames, prompts, chat content, diffs, terminal output, commands, environment variables, tokens, or
account details.

## Crash and error reports

When enabled, Harness uses Sentry's Electron SDK for sanitized JavaScript errors and native crash
diagnostics. Reports do not carry an account or analytics identifier. Requests, user data, extras,
contexts, local paths, code context, secrets, and non-allowlisted breadcrumbs are removed before an
error is transmitted. Native crash dumps can contain diagnostic process data; enabling native crash
reporting after startup takes effect on the next app launch.

Both choices are available during onboarding and under Settings → Privacy. Opting out disables the
corresponding client; usage-event queues and the anonymous installation id are discarded.
