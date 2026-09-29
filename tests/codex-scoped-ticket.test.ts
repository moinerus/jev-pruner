import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createScopedJevTicket, validScopedTicketFile } from '../src/codex/scoped-ticket.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function issuedTicket(sessionId: string, now = 1_800_000_000_000): string {
  const body = Buffer.from(JSON.stringify({ v: 1, scope: 'jev-decisions-v1', sessionId,
    nonce: 'AAAAAAAAAAAAAAAAAAAAAA', issuedAt: now, expiresAt: now + 3_600_000,
    maxCalls: 19 })).toString('base64url');
  return `${body}.${'A'.repeat(43)}`;
}

it('stores only a bounded Router-issued Jev ticket for one session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-ticket-'));
  roots.push(root);
  const path = await createScopedJevTicket('session-a', { ticketRoot: join(root, 'tickets'),
    now: () => 1_800_000_000_000,
    fetch: async (_input, init) => {
      expect(init?.method).toBe('POST');
      expect(init?.headers).toEqual({ 'content-type': 'application/json',
        'x-jev-pruner': 'ticket-v1' });
      expect(JSON.parse(String(init?.body))).toEqual({ sessionId: 'session-a' });
      return new Response(JSON.stringify({ ticket: issuedTicket('session-a') }), { status: 200 });
    } });
  const token = (await readFile(path, 'utf8')).trim();
  const [body, signature] = token.split('.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  expect(payload).toEqual({ v: 1, scope: 'jev-decisions-v1', sessionId: 'session-a',
    nonce: 'AAAAAAAAAAAAAAAAAAAAAA', issuedAt: 1_800_000_000_000,
    expiresAt: 1_800_003_600_000, maxCalls: 19 });
  expect(signature).toBe('A'.repeat(43));
});

it('rejects failed issuance and a ticket for another session before writing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-ticket-'));
  roots.push(root);
  await expect(createScopedJevTicket('session-a', { ticketRoot: join(root, 'tickets'),
    fetch: async () => new Response('{}', { status: 403 }) })).rejects.toThrow();
  await expect(createScopedJevTicket('session-a', { ticketRoot: join(root, 'tickets'),
    now: () => 1_800_000_000_000,
    fetch: async () => new Response(JSON.stringify({ ticket: issuedTicket('session-b') }),
      { status: 200 }) })).rejects.toThrow();
  await expect(createScopedJevTicket('../other', {
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
