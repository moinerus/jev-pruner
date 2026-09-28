import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export function validScopedTicketFile(sessionId: string, candidate: unknown): candidate is string {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(sessionId) ||
      typeof candidate !== 'string' || !isAbsolute(candidate)) return false;
  const root = resolve(join(tmpdir(), 'jev-pruner', 'tickets'));
  const actual = resolve(candidate);
  return dirname(actual).toLowerCase() === root.toLowerCase() &&
    new RegExp(`^${sessionId}-[a-f0-9-]{36}\\.ticket$`).test(basename(actual));
}

export async function createScopedJevTicket(sessionId: string, options: {
  home?: string;
  ticketRoot?: string;
  now?: () => number;
  nonce?: () => Buffer;
} = {}): Promise<string> {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(sessionId)) throw new Error('Invalid Codex session id');
  const home = options.home ?? homedir();
  const secret = (await readFile(join(home, '.codex', 'codex-router', 'caller-secret'), 'utf8')).trim();
  if (!/^[A-Za-z0-9_-]{32,}$/.test(secret)) throw new Error('Invalid Router caller capability');
  const now = (options.now ?? Date.now)();
  const random = (options.nonce ?? (() => randomBytes(16)))();
  if (!Number.isSafeInteger(now) || !Buffer.isBuffer(random) || random.length !== 16) {
    throw new Error('Invalid Jev ticket clock or nonce');
  }
  const payload = { v: 1, scope: 'jev-decisions-v1', sessionId,
    nonce: random.toString('base64url'), issuedAt: now,
    expiresAt: now + 60 * 60 * 1000, maxCalls: 19 };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  const ticketRoot = options.ticketRoot ?? join(tmpdir(), 'jev-pruner', 'tickets');
  await mkdir(ticketRoot, { recursive: true, mode: 0o700 });
  const path = join(ticketRoot, `${sessionId}-${randomUUID()}.ticket`);
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(`${body}.${signature}\n`); await handle.sync(); }
  catch (error) { await handle.close(); await unlink(path).catch(() => {}); throw error; }
  await handle.close();
  return path;
}
