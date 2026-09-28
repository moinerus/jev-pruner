import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { JevAsker, JevQuestions, JevResponse, JevState } from '../jev.js';
import { parseJevResponse } from '../jev.js';

export const CODEX_ROUTER_JEV_MODEL = 'openrouter-jev-campaign/jev-1.13';

export interface CodexRouterAskerOptions {
  home?: string;
  baseUrl?: string;
  readSecret?: () => Promise<string>;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ScopedCodexRouterAskerOptions extends Omit<CodexRouterAskerOptions, 'home' | 'readSecret'> {
  ticketFile: string;
  readTicket?: () => Promise<string>;
}

function loopbackBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Codex Router URL must be a loopback HTTP URL');
  }
  const hostname = url.hostname.toLowerCase();
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname) ||
    url.username || url.password || url.search || url.hash
  ) {
    throw new Error('Codex Router URL must be a loopback HTTP URL');
  }
  return url.toString().replace(/\/$/, '');
}

/** Creates an asker using the host-owned Codex Router caller capability. */
export function createCodexRouterAsker(options: CodexRouterAskerOptions = {}): JevAsker {
  const readSecret = options.readSecret ?? (() => readFile(
    join(options.home ?? homedir(), '.codex', 'codex-router', 'caller-secret'), 'utf8',
  ));
  return {
    async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
      const baseUrl = loopbackBaseUrl(options.baseUrl ?? 'http://127.0.0.1:4202');
      if (options.signal?.aborted) throw new DOMException('Codex Router request aborted', 'AbortError');
      const secret = (await readSecret()).trim();
      if (options.signal?.aborted) throw new DOMException('Codex Router request aborted', 'AbortError');
      if (!secret) throw new Error('Codex Router caller secret is empty');
      return postDecisions(baseUrl, `/_codex-router/${encodeURIComponent(secret)}/v1/decisions`,
        secret, state, questions, options);
    },
  };
}

export function createScopedCodexRouterAsker(options: ScopedCodexRouterAskerOptions): JevAsker {
  const readTicket = options.readTicket ?? (() => readFile(options.ticketFile, 'utf8'));
  return {
    async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
      const baseUrl = loopbackBaseUrl(options.baseUrl ?? 'http://127.0.0.1:4202');
      if (options.signal?.aborted) throw new DOMException('Codex Router request aborted', 'AbortError');
      const ticket = (await readTicket()).trim();
      if (options.signal?.aborted) throw new DOMException('Codex Router request aborted', 'AbortError');
      if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(ticket) || ticket.length > 1024) {
        throw new Error('Invalid scoped Jev ticket');
      }
      return postDecisions(baseUrl, '/v1/jev-decisions', ticket, state, questions, options);
    },
  };
}

async function postDecisions(baseUrl: string, path: string, credential: string,
  state: JevState, questions: JevQuestions, options: CodexRouterAskerOptions): Promise<JevResponse> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(cancel, options.timeoutMs ?? 30_000);
  try {
    if (options.signal?.aborted) cancel();
    const response = await (options.fetch ?? globalThis.fetch)(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: CODEX_ROUTER_JEV_MODEL, state, questions }),
      signal: controller.signal,
      redirect: 'error',
    });
    return parseJevResponse(response.status, response.ok, await response.text());
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', cancel);
  }
}
