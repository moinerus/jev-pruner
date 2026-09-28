import { randomUUID } from 'node:crypto';
import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { JevDurableCampaignAllowance } from './durable-campaign-allowance.js';

export interface SessionMode {
  ledgerPath: string;
  maxRequests: number;
  maxReservedMicroUsd: number;
  perRequestCeilingMicroUsd: number;
}

function sessionPath(sessionId: string, home: string): string {
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(sessionId)) throw new Error('Invalid Codex session id');
  return join(home, '.cache', 'jev-pruner', 'codex', 'session-modes', `${sessionId}.json`);
}

function observationPath(sessionId: string, home: string): string {
  sessionPath(sessionId, home);
  return join(home, '.cache', 'jev-pruner', 'codex', 'observations', `${sessionId}.json`);
}

export async function isSessionObserving(sessionId: string, home = homedir()): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(observationPath(sessionId, home), 'utf8'));
    return value?.schemaVersion === 1 && value?.observe === true && Object.keys(value).length === 2;
  } catch { return false; }
}

export async function observeSession(sessionId: string, home = homedir()): Promise<void> {
  const path = observationPath(sessionId, home);
  await unlink(sessionPath(sessionId, home)).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
  await mkdir(join(home, '.cache', 'jev-pruner', 'codex', 'observations'), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile('{"schemaVersion":1,"observe":true}\n'); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temp, path); }
  catch (error) { await unlink(temp).catch(() => {}); throw error; }
}

export async function readSessionMode(sessionId: string, home = homedir()): Promise<SessionMode | undefined> {
  const path = sessionPath(sessionId, home);
  let value: unknown;
  try { value = JSON.parse(await readFile(path, 'utf8')); }
  catch { return undefined; }
  if (!value || typeof value !== 'object') return undefined;
  const mode = value as Record<string, unknown>;
  if (Object.keys(mode).sort().join(',') !==
      'ledgerPath,maxRequests,maxReservedMicroUsd,perRequestCeilingMicroUsd,schemaVersion' ||
      mode.schemaVersion !== 1 || typeof mode.ledgerPath !== 'string' ||
      typeof mode.maxRequests !== 'number' || typeof mode.maxReservedMicroUsd !== 'number' ||
      typeof mode.perRequestCeilingMicroUsd !== 'number') return undefined;
  try {
    const allowance = new JevDurableCampaignAllowance(mode.ledgerPath,
      mode.maxRequests, mode.maxReservedMicroUsd, mode.perRequestCeilingMicroUsd);
    void allowance.attemptedRequests;
  } catch { return undefined; }
  return { ledgerPath: mode.ledgerPath, maxRequests: mode.maxRequests,
    maxReservedMicroUsd: mode.maxReservedMicroUsd,
    perRequestCeilingMicroUsd: mode.perRequestCeilingMicroUsd };
}

export async function setSessionMode(sessionId: string, mode: SessionMode, home = homedir()): Promise<void> {
  const path = sessionPath(sessionId, home);
  const allowance = new JevDurableCampaignAllowance(mode.ledgerPath, mode.maxRequests,
    mode.maxReservedMicroUsd, mode.perRequestCeilingMicroUsd);
  void allowance.attemptedRequests;
  const directory = join(home, '.cache', 'jev-pruner', 'codex', 'session-modes');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify({ schemaVersion: 1, ...mode }) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temp, path); }
  catch (error) { await unlink(temp).catch(() => {}); throw error; }
  await unlink(observationPath(sessionId, home)).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
}

export async function disableSessionMode(sessionId: string, home = homedir()): Promise<void> {
  for (const path of [sessionPath(sessionId, home), observationPath(sessionId, home)]) {
    await unlink(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
}
