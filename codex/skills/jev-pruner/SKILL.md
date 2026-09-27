---
name: jev-pruner
description: Use Jev to prune lengthy output from non-interactive build, test, install, and search commands in Codex.
---

Resolve the plugin root as three directories above this skill's directory.
The installed plugin must already have `dist/codex/run.js` built.

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
Set `JEV_PRUNER_TRANSPORT=codex-router` for the local Router transport. It reads
the host-owned caller capability at runtime; do not copy a provider key into
the plugin. Missing transport access, failed commands, archive
failures, and scoring failures return the original stdout.
Never claim pruning occurred without seeing an omission marker.

Read or search the archive path in the final footer whenever omitted output is
needed. Retained text is verbatim; Jev does not generate a summary.
