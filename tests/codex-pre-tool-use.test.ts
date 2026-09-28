import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { JevDurableRequestAllowance } from '../src/codex/durable-request-allowance.js';
import { processPreToolUse } from '../src/codex/pre-tool-use.js';
import { setSessionMode } from '../src/codex/session-mode.js';

const homes: string[] = [];
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'jev-pre-'));
  homes.push(home);
  const callerDirectory = join(home, '.codex', 'codex-router');
  await mkdir(callerDirectory, { recursive: true });
  await writeFile(join(callerDirectory, 'caller-secret'), 'a'.repeat(48));
  const mode = { kind: 'key-capped-requests' as const,
    ledgerPath: join(home, 'requests.json'), maxRequests: 1000 };
  await JevDurableRequestAllowance.initialise(mode.ledgerPath, mode.maxRequests, 41);
  const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash',
    session_id: 'session-a', tool_input: { command: 'npm test' } };
  return { home, mode, input };
}
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });

it('rewrites only enabled, recognised simple commands and keeps the shared allowance', async () => {
  const { home, mode, input } = await fixture();
  expect(await processPreToolUse(input, { home, platform: 'win32', nodePath: 'C:\\node.exe',
    runPath: 'C:\\Jev Pruner\\run.js' })).toBeUndefined();
  await setSessionMode('session-a', mode, home);
  const decision = await processPreToolUse({ ...input,
    tool_input: { command: 'npm test', workdir: 'C:\\repo', yield_time_ms: 10000 } },
    { home, platform: 'win32',
    nodePath: 'C:\\node.exe', runPath: 'C:\\Jev Pruner\\run.js',
    ticketRoot: join(home, 'tickets') });
  expect(decision?.hookSpecificOutput.permissionDecision).toBe('allow');
  expect(decision?.hookSpecificOutput.updatedInput.command).toContain(
    "& 'C:\\node.exe' 'C:\\Jev Pruner\\run.js' '--auto-session' 'session-a' '--ticket-file'");
  expect(decision?.hookSpecificOutput.updatedInput.command).toContain("'--' 'npm' 'test'");
  expect(decision?.hookSpecificOutput.updatedInput.workdir).toBe('C:\\repo');
  expect(decision?.hookSpecificOutput.updatedInput.yield_time_ms).toBe(10000);
  const nodeTest = await processPreToolUse({ ...input,
    tool_input: { command: 'node --test test.test.mjs' } }, { home, platform: 'win32',
    nodePath: 'C:\\node.exe', runPath: 'C:\\Jev Pruner\\run.js',
    ticketRoot: join(home, 'tickets') });
  expect(nodeTest?.hookSpecificOutput.updatedInput.command).toContain("'node' '--test' 'test.test.mjs'");
  expect(new JevDurableRequestAllowance(mode.ledgerPath, 1000).attemptedRequests).toBe(41);
  expect(await processPreToolUse({ ...input, session_id: 'session-b' }, { home })).toBeUndefined();
});

it('leaves compound, risky, unrelated and malformed commands alone', async () => {
  const { home, mode, input } = await fixture();
  await setSessionMode('session-a', mode, home);
  for (const command of ['npm test; echo done', 'npm test | tee out.txt', 'npm test $HOME',
    'npm test -- --watch', 'rg foo src', 'git diff', 'npm run deploy', 'npm test\nwhoami']) {
    expect(await processPreToolUse({ ...input, tool_input: { command } }, { home })).toBeUndefined();
  }
  expect(await processPreToolUse({ ...input, tool_name: 'apply_patch' }, { home })).toBeUndefined();
});
