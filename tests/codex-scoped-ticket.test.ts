import { createHmac } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createScopedJevTicket, validScopedTicketFile } from '../src/codex/scoped-ticket.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('writes only a signed, expiring Jev ticket for one session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-ticket-'));
  roots.push(root);
  const home = join(root, 'home');
  const callerDirectory = join(home, '.codex', 'codex-router');
  await mkdir(callerDirectory, { recursive: true });
  const secret = 'a'.repeat(48);
  await writeFile(join(callerDirectory, 'caller-secret'), secret);
  const path = await createScopedJevTicket('session-a', { home, ticketRoot: join(root, 'tickets'),
    now: () => 1_800_000_000_000, nonce: () => Buffer.alloc(16) });
  const token = (await readFile(path, 'utf8')).trim();
  const [body, signature] = token.split('.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  expect(payload).toEqual({ v: 1, scope: 'jev-decisions-v1', sessionId: 'session-a',
    nonce: 'AAAAAAAAAAAAAAAAAAAAAA', issuedAt: 1_800_000_000_000,
    expiresAt: 1_800_003_600_000, maxCalls: 19 });
  expect(signature).toBe(createHmac('sha256', secret).update(body).digest('base64url'));
  expect(token).not.toContain(secret);
});

it('rejects absent or malformed caller authority before creating a ticket', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-ticket-'));
  roots.push(root);
  const home = join(root, 'home');
  await expect(createScopedJevTicket('session-a', { home,
    ticketRoot: join(root, 'tickets') })).rejects.toThrow();
  await expect(createScopedJevTicket('../other', { home,
    ticketRoot: join(root, 'tickets') })).rejects.toThrow('Invalid Codex session id');
});

it('accepts only a session ticket under the designated temporary directory', () => {
  const ticket = join(tmpdir(), 'jev-pruner', 'tickets',
    'session-a-12345678-1234-1234-1234-123456789abc.ticket');
  expect(validScopedTicketFile('session-a', ticket)).toBe(true);
  expect(validScopedTicketFile('session-b', ticket)).toBe(false);
  expect(validScopedTicketFile('session-a', join(tmpdir(), 'elsewhere',
    'session-a-12345678-1234-1234-1234-123456789abc.ticket'))).toBe(false);
  expect(validScopedTicketFile('session-a', 'relative.ticket')).toBe(false);
});
