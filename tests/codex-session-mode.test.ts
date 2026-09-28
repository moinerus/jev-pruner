import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { JevDurableCampaignAllowance } from '../src/codex/durable-campaign-allowance.js';
import { JevDurableRequestAllowance } from '../src/codex/durable-request-allowance.js';
import { disableSessionMode, readSessionMode, setSessionMode } from '../src/codex/session-mode.js';
import { sessionCommand } from '../src/codex/session.js';

const homes: string[] = [];
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'jev-session-'));
  homes.push(home);
  const ledgerPath = join(home, 'campaign.json');
  await JevDurableCampaignAllowance.initialise(ledgerPath, 1000, 900_000, 900);
  return { home, mode: { ledgerPath, maxRequests: 1000,
    maxReservedMicroUsd: 900_000, perRequestCeilingMicroUsd: 900 } };
}
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });

it('defaults off and enables only the named Codex session', async () => {
  const { home, mode } = await fixture();
  expect(await readSessionMode('session-a', home)).toBeUndefined();
  await setSessionMode('session-a', mode, home);
  expect(await readSessionMode('session-a', home)).toEqual(mode);
  expect(await readSessionMode('session-b', home)).toBeUndefined();
  await disableSessionMode('session-a', home);
  expect(await readSessionMode('session-a', home)).toBeUndefined();
});

it('requires an existing matching ledger and rejects unsafe session ids', async () => {
  const { home, mode } = await fixture();
  await expect(setSessionMode('bad/../id', mode, home)).rejects.toThrow();
  await expect(setSessionMode('safe', { ...mode, maxRequests: 1001 }, home)).rejects.toThrow();
  await expect(setSessionMode('safe', { ...mode, ledgerPath: join(home, 'missing.json') }, home)).rejects.toThrow();
  expect(await readSessionMode('safe', home)).toBeUndefined();
});

it('reports only counts and never the ledger path', async () => {
  const { home, mode } = await fixture();
  const env = { CODEX_THREAD_ID: 'session-a' };
  expect(await sessionCommand(['status'], env, home)).toContain('off');
  expect(await sessionCommand(['observe'], env, home)).toContain('observation on');
  expect(await sessionCommand(['status'], env, home)).toContain('observation on');
  expect(await sessionCommand(['enable', mode.ledgerPath, '1000', '900000', '900'], env, home)).toContain('on');
  const status = await sessionCommand(['status'], env, home);
  expect(status).toContain('Calls available: 1000');
  expect(status).not.toContain(mode.ledgerPath);
  const saved = await readFile(join(home, '.cache', 'jev-pruner', 'codex', 'session-modes', 'session-a.json'), 'utf8');
  expect(JSON.parse(saved).schemaVersion).toBe(1);
  expect(await sessionCommand(['disable'], env, home)).toContain('off');
  expect(await sessionCommand(['status'], env, home)).toContain('off');
});

it('starts a key-capped request ledger from earlier provider calls and shares it across sessions', async () => {
  const { home } = await fixture();
  const ledgerPath = join(home, 'key-capped.json');
  const first = { CODEX_THREAD_ID: 'session-a' };
  const second = { CODEX_THREAD_ID: 'session-b' };
  expect(await sessionCommand(['initialise-key-cap', ledgerPath, '1000', '31'], first, home)).toContain('969');
  expect(await sessionCommand(['enable-key-cap', ledgerPath, '1000'], first, home)).toContain('on');
  expect(await sessionCommand(['enable-key-cap', ledgerPath, '1000'], second, home)).toContain('on');
  expect(await sessionCommand(['status'], second, home)).toContain('Calls available: 969');
  await expect(sessionCommand(['initialise-key-cap', ledgerPath, '1000', '0'], first, home)).rejects.toThrow();
});

it('counts a dispatch before asking and fails closed if the key-capped ledger is lost', async () => {
  const { home } = await fixture();
  const path = join(home, 'key-capped.json');
  const first = await JevDurableRequestAllowance.initialise(path, 32, 31);
  const second = new JevDurableRequestAllowance(path, 32);
  let calls = 0;
  const asker = { async ask() { calls += 1; return { answers: {} }; } };
  await first.ask(asker, 'state', {});
  expect(second.attemptedRequests).toBe(32);
  expect(second.availableRequests).toBe(0);
  await expect(second.ask(asker, 'state', {})).rejects.toThrow('exhausted');
  expect(calls).toBe(1);
  await rm(path);
  expect(first.availableRequests).toBe(0);
  await expect(first.ask(asker, 'state', {})).rejects.toThrow('ledger');
  expect(calls).toBe(1);
});

it('cannot recreate a missing journal to reopen an existing request ledger', async () => {
  const { home } = await fixture();
  const path = join(home, 'key-capped.json');
  const allowance = await JevDurableRequestAllowance.initialise(path, 32, 31);
  await rm(`${path}.journal`);
  expect(allowance.availableRequests).toBe(0);
  await expect(JevDurableRequestAllowance.initialise(path, 32, 31)).rejects.toThrow();
  expect(allowance.availableRequests).toBe(0);
});
