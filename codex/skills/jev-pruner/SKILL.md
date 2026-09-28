---
name: jev-pruner
description: Use Jev to prune lengthy output from non-interactive build, test, install, and search commands in Codex.
---

Resolve the plugin root as three directories above this skill's directory.
The installed plugin must already have `dist/codex/run.js` built.

When the user wants automatic pruning for this Codex session, use
`dist/codex/session.js status` first. The default is off. Use `observe` for a
baseline session. Use `enable` only with an existing validated durable campaign
ledger and its exact limits. If the provider key has a verified lifetime dollar
cap, `initialise-key-cap` may create one private request ledger using the
provider's earlier call count. Then use `enable-key-cap` for chosen sessions.
The request ledger does not enforce dollars and must never be reset to regain
calls. Keep paid pruning off until a live command rewrite probe passes.
The `PreToolUse` hook wraps only simple, recognised build and test commands in
enabled sessions. Its wrapper preserves exit status, stderr and the original
stdout when pruning is unsafe or unavailable. The `PostToolUse` hook records
baseline sizes only; it must not spend when Codex ignores a command rewrite.
For automatic desktop pruning, the trusted hook signs a one-hour Jev-only
ticket with Router's host-owned caller capability. The wrapped command reads
that ticket from the user's temporary directory and calls only Router's scoped
Jev Decisions endpoint. If ticket creation fails, the command runs unchanged.
Confirm Router supports the scoped endpoint before a paid live probe.
In managed desktop sessions, use a private request ledger in a directory that
the wrapped command can write. If that ledger disappears, scoring stops.
Run `report` to see local output-size estimates, then compare those with actual
Codex usage and task quality in a similar session. The hook sends no transcript
and records no command or output text in metrics. A live rewritten command
probe is required before paid activation on a new Codex build.

For non-interactive commands that may produce lengthy output, use the native
Codex shell tool to execute:

```sh
node "<plugin-root>/dist/codex/run.js" --require-campaign --goal "Keep test failures and the final result" -- npm test
```

Arguments after `--` are passed directly to the executable, without evaluation
by a second shell. Preserve their quoting. For a compound shell program, pass
the intended shell explicitly, for example `-- bash -c 'command1 && command2'`.
Keep the original workdir, sandbox settings, and approval requirements.
Do not request broader permissions solely to make pruning work.
Always place `--require-campaign` and a one-line `--goal` of at most 240
characters before `--`. Never run this skill without them.
The wrapper preserves original stdout and makes no scoring request until the
campaign ledger and all four `JEV_PRUNER_CAMPAIGN_*` settings are valid. Follow
the README's durable campaign instructions before using paid scoring.

Use the ordinary shell directly for interactive/TTY commands, servers, commands
whose live progress is required, whole-file reads, diffs, structured data, and
commands involving secrets. Do not wrap nested calls that require machine-readable
output. This wrapper buffers stdout until completion (up to 8 MiB), forwards stderr
unchanged, and preserves the exit code. It does not intercept other shell calls.

Only stdout over 10,000 estimated tokens is eligible. In campaign mode, the
wrapper sends the short goal and bounded command-output chunks to Jev. It does
not read or send the Codex transcript. Missing or invalid goals return the
original stdout without a scoring request.
Set `JEV_PRUNER_TRANSPORT=codex-router` for explicit wrapper calls outside the
managed desktop sandbox. That older path reads the host-owned caller capability
at runtime. Automatic desktop calls use the scoped ticket instead. Keep the
provider key with Router. Missing transport access, failed commands, archive
failures, and scoring failures return the original stdout.
Never claim pruning occurred without seeing an omission marker.

Read or search the archive path in the final footer whenever omitted output is
needed. Retained text is verbatim; Jev does not generate a summary.
