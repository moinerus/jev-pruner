import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { JevDurableCampaignAllowance } from '../src/codex/durable-campaign-allowance.js';
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
