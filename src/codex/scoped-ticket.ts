import { randomUUID } from 'node:crypto';
import { mkdir, open, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { loopbackBaseUrl } from './router-asker.js';

export function validScopedTicketFile(sessionId: string, candidate: unknown): candidate is string {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(sessionId) ||
      typeof candidate !== 'string' || !isAbsolute(candidate)) return false;
  const root = resolve(join(tmpdir(), 'jev-pruner', 'tickets'));
  const actual = resolve(candidate);
  return dirname(actual).toLowerCase() === root.toLowerCase() &&
    new RegExp(`^${sessionId}-[a-f0-9-]{36}\\.ticket$`).test(basename(actual));
}

export async function createScopedJevTicket(sessionId: string, options: {
  ticketRoot?: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
} = {}): Promise<string> {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(sessionId)) throw new Error('Invalid Codex session id');
  const now = (options.now ?? Date.now)();
  if (!Number.isSafeInteger(now)) throw new Error('Invalid Jev ticket clock');
  const baseUrl = loopbackBaseUrl(options.baseUrl ?? 'http://127.0.0.1:4202');
  const response = await (options.fetch ?? globalThis.fetch)(`${baseUrl}/v1/jev-ticket`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-jev-pruner': 'ticket-v1' },
    body: JSON.stringify({ sessionId }),
    signal: AbortSignal.timeout(2_000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error('Router did not issue a Jev ticket');
  const responseBody = await response.text();
  if (responseBody.length > 2_048) throw new Error('Invalid Router Jev ticket');
  const issued = JSON.parse(responseBody) as { ticket?: unknown };
  const token = issued?.ticket;
  if (typeof token !== 'string' || token.length > 1024 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error('Invalid Router Jev ticket');
  }
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8')) as Record<string, unknown>; }
  catch { throw new Error('Invalid Router Jev ticket'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      Object.keys(payload).sort().join(',') !==
        'expiresAt,issuedAt,maxCalls,nonce,scope,sessionId,v' ||
      payload.v !== 1 || payload.scope !== 'jev-decisions-v1' ||
      payload.sessionId !== sessionId || !Number.isSafeInteger(payload.issuedAt) ||
      !/^[A-Za-z0-9_-]{22,44}$/.test(String(payload.nonce)) ||
      !Number.isSafeInteger(payload.expiresAt) || Number(payload.issuedAt) > now + 30_000 ||
      Number(payload.expiresAt) <= now ||
      Number(payload.expiresAt) - Number(payload.issuedAt) > 3_600_000 ||
      payload.maxCalls !== 19) throw new Error('Invalid Router Jev ticket');
  const ticketRoot = options.ticketRoot ?? join(tmpdir(), 'jev-pruner', 'tickets');
  await mkdir(ticketRoot, { recursive: true, mode: 0o700 });
  const path = join(ticketRoot, `${sessionId}-${randomUUID()}.ticket`);
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(`${token}\n`); await handle.sync(); }
  catch (error) { await handle.close(); await unlink(path).catch(() => {}); throw error; }
  await handle.close();
  return path;
}
