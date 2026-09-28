import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { JevQuestions, JevState } from '../src/jev.js';
import { estimateTokens } from '../src/jev.js';
import { classifyOutput } from '../src/output.js';
import { looksSecret } from '../src/secrets.js';
import { JevDurableCampaignAllowance } from '../src/codex/durable-campaign-allowance.js';
import { processPostToolUse } from '../src/codex/post-tool-use.js';
import { observeSession, readSessionMode, setSessionMode } from '../src/codex/session-mode.js';
import { sessionReport } from '../src/codex/session-report.js';

const homes: string[] = [];
const log = `${'cache hit '.repeat(4)}\n`.repeat(1600) + 'Tests: 20 passed\n';
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'jev-hook-'));
  homes.push(home);
  const mode = { ledgerPath: join(home, 'campaign.json'), maxRequests: 1000,
    maxReservedMicroUsd: 900_000, perRequestCeilingMicroUsd: 900 };
  await JevDurableCampaignAllowance.initialise(mode.ledgerPath, mode.maxRequests,
    mode.maxReservedMicroUsd, mode.perRequestCeilingMicroUsd);
  const input = { hook_event_name: 'PostToolUse', tool_name: 'Bash', session_id: 'session-a',
    cwd: home, tool_input: { command: 'npm test' },
    tool_response: { output: log, exit_code: 0 } };
  const states: JevState[] = [];
  const ask = vi.fn(async (state: JevState, questions: JevQuestions) => {
    states.push(state);
    return { answers: Object.fromEntries(Object.keys(questions).map(id => [id, { noul: 0 }])) };
  });
  return { home, mode, input, states, ask };
}
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });

it('prunes only the enabled session with focused requests and a recoverable original', async () => {
  const { home, mode, input, states, ask } = await fixture();
  const options = { home, asker: { ask } };
  expect(estimateTokens(log)).toBeGreaterThan(10_000);
  expect(classifyOutput('npm test', log)).toBe('build');
  expect(looksSecret('npm test', log)).toBe(false);
  expect(await processPostToolUse(input, options)).toBeUndefined();
  expect(ask).not.toHaveBeenCalled();
  await setSessionMode('session-a', mode, home);
  expect(await readSessionMode('session-a', home)).toEqual(mode);
  expect(new JevDurableCampaignAllowance(mode.ledgerPath, 1000, 900_000, 900).availableRequests).toBe(1000);
  const decision = await processPostToolUse(input, options);
  expect(ask).toHaveBeenCalled();
  expect(decision?.continue).toBe(false);
  expect(decision?.stopReason).toContain('trimmed');
  expect(decision?.stopReason).toContain('full output:');
  expect(decision?.stopReason).not.toContain(log);
  expect(states.length).toBeGreaterThan(0);
  for (const state of states) {
    expect(state.history).toEqual([]);
    expect(state.task).toBe('Keep build and test failures, warnings, final status, counts, and artifact paths.');
    expect(state).not.toHaveProperty('command');
  }
  const archive = decision!.stopReason.match(/full output: (.*?) \(Read or grep/)?.[1];
  expect(archive).toBeTruthy();
  expect(await readFile(archive!, 'utf8')).toBe(log);
  const metrics = await readFile(join(home, '.cache', 'jev-pruner', 'codex', 'metrics', 'session-a.jsonl'), 'utf8');
  expect(metrics).not.toContain('cache hit');
  expect(metrics).not.toContain('npm test');
  expect(JSON.parse(metrics).beforeChars).toBe(log.length);
  expect(await processPostToolUse({ ...input, session_id: 'session-b' }, options)).toBeUndefined();
});

it('preserves failed, short, structured and secret-looking results', async () => {
  const { home, mode, input, ask } = await fixture();
  await setSessionMode('session-a', mode, home);
  const options = { home, asker: { ask } };
  for (const [index, changed] of [
    { tool_response: { output: log, exit_code: 1 } },
    { tool_response: { output: 'Tests: 20 passed', exit_code: 0 } },
    { tool_response: { output: JSON.stringify({ result: log }), exit_code: 0 } },
    { tool_response: { output: `OPENAI_API_KEY=sk-${'x'.repeat(30)}\n${log}`, exit_code: 0 } },
    { tool_input: { command: 'rg cache src' } },
  ].entries()) {
    const decision = await processPostToolUse({ ...input, ...changed }, options);
    expect(decision === undefined, `case ${index}`).toBe(true);
  }
  expect(ask).not.toHaveBeenCalled();
});

it('preserves the original when archiving fails', async () => {
  const { home, mode, input, ask } = await fixture();
  await setSessionMode('session-a', mode, home);
  const archives = join(home, '.cache', 'jev-pruner', 'codex', 'archives');
  await mkdir(archives, { recursive: true });
  await writeFile(join(archives, 'session-a'), 'not a directory');
  expect(await processPostToolUse(input, { home, asker: { ask } })).toBeUndefined();
  expect(ask).not.toHaveBeenCalled();
});

it('records an unpruned baseline without a Jev call or output text', async () => {
  const { home, input, ask } = await fixture();
  await observeSession('session-a', home);
  expect(await processPostToolUse(input, { home, asker: { ask } })).toBeUndefined();
  expect(ask).not.toHaveBeenCalled();
  const report = await sessionReport('session-a', home);
  expect(report).toContain('1 eligible build results; 0 Jev calls');
  expect(report).toContain('Estimates are not measured Codex context usage');
  expect(report).not.toContain('cache hit');
});
