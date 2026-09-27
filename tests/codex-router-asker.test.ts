import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { CODEX_ROUTER_JEV_MODEL, createCodexRouterAsker } from '../src/codex/router-asker.js';

async function withEndpoint(
  handle: Parameters<typeof createServer>[0],
  run: (baseUrl: string) => Promise<void>,
) {
  const server = createServer(handle);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

describe('Codex Router Jev asker', () => {
  it('pins the dedicated Jev campaign route', () => {
    expect(CODEX_ROUTER_JEV_MODEL).toBe('openrouter-jev-campaign/jev-1.13');
  });

  it('posts Decisions requests using only the caller capability', async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => new Response(
      JSON.stringify({ answers: { keep: { noul: 0 } } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const asker = createCodexRouterAsker({
      baseUrl: 'http://127.0.0.1:4202',
      readSecret: async () => 'caller/secret',
      fetch,
    });
    const state = { history: ['tool output'] };
    const questions = { keep: { type: 'noul', instructions: 'keep it?' } as const };
    await expect(asker.ask(state, questions)).resolves.toMatchObject({ answers: { keep: { noul: 0 } } });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:4202/_codex-router/caller%2Fsecret/v1/decisions');
    expect(init?.headers).toEqual({ authorization: 'Bearer caller/secret', 'content-type': 'application/json' });
    expect(init?.redirect).toBe('error');
    expect(JSON.parse(String(init?.body))).toEqual({ model: CODEX_ROUTER_JEV_MODEL, state, questions });
  });

  it('fails when the host capability is unavailable or the router rejects the request', async () => {
    const asker = createCodexRouterAsker({ readSecret: async () => { throw new Error('missing'); } });
    await expect(asker.ask('state', {})).rejects.toThrow('missing');
    const rejected = createCodexRouterAsker({
      readSecret: async () => 'caller',
      fetch: vi.fn(async () => new Response('nope', { status: 503 })),
    });
    await expect(rejected.ask('state', {})).rejects.toThrow('Jev request failed (503)');
  });

  it('cancels an in-flight router request when the wrapper is interrupted', async () => {
    const controller = new AbortController();
    const fetch = vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      controller.abort();
    }));
    const asker = createCodexRouterAsker({
      readSecret: async () => 'caller',
      fetch,
      signal: controller.signal,
    });
    await expect(asker.ask('state', {})).rejects.toThrow('aborted');
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('does not read the caller capability after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const readSecret = vi.fn(async () => 'caller');
    const fetch = vi.fn();
    const asker = createCodexRouterAsker({ readSecret, fetch, signal: controller.signal });
    await expect(asker.ask('state', {})).rejects.toThrow('aborted');
    expect(readSecret).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a non-loopback router URL before reading the caller capability', async () => {
    const readSecret = vi.fn(async () => 'caller');
    const fetch = vi.fn();
    const asker = createCodexRouterAsker({
      baseUrl: 'https://router.example.test',
      readSecret,
      fetch,
    });
    await expect(asker.ask('state', {})).rejects.toThrow('loopback');
    expect(readSecret).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses a loopback Decisions endpoint without forwarding a provider credential', async () => {
    const received: Array<{ url: string; headers: Record<string, string | string[] | undefined>; body: unknown }> = [];
    await withEndpoint(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received.push({
        url: request.url ?? '',
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString()),
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ answers: { keep: { noul: 1 } } }));
    }, async baseUrl => {
      const asker = createCodexRouterAsker({ baseUrl, readSecret: async () => 'local-capability' });
      await expect(asker.ask('state', { keep: { type: 'noul', instructions: 'keep?' } }))
        .resolves.toMatchObject({ answers: { keep: { noul: 1 } } });
    });
    expect(received).toHaveLength(1);
    expect(received[0]?.url).toBe('/_codex-router/local-capability/v1/decisions');
    expect(received[0]?.headers.authorization).toBe('Bearer local-capability');
    expect(received[0]?.headers['x-api-key']).toBeUndefined();
    expect(received[0]?.body).toEqual({
      model: CODEX_ROUTER_JEV_MODEL,
      state: 'state',
      questions: { keep: { type: 'noul', instructions: 'keep?' } },
    });
  });

  it('refuses redirects without sending the capability to the redirect target', async () => {
    let redirectedRequests = 0;
    await withEndpoint((request, response) => {
      if (request.url === '/redirect-target') {
        redirectedRequests += 1;
        response.end('unexpected');
        return;
      }
      response.writeHead(302, { location: '/redirect-target' });
      response.end();
    }, async baseUrl => {
      const asker = createCodexRouterAsker({ baseUrl, readSecret: async () => 'local-capability' });
      await expect(asker.ask('state', {})).rejects.toThrow();
    });
    expect(redirectedRequests).toBe(0);
  });

  it('aborts a pending loopback request on timeout', async () => {
    let received = false;
    await withEndpoint(() => { received = true; }, async baseUrl => {
      const asker = createCodexRouterAsker({
        baseUrl,
        readSecret: async () => 'local-capability',
        timeoutMs: 100,
      });
      await expect(asker.ask('state', {})).rejects.toThrow();
    });
    expect(received).toBe(true);
  });

  it('aborts a pending loopback request when its caller is cancelled', async () => {
    const controller = new AbortController();
    let received = false;
    await withEndpoint(() => {
      received = true;
      controller.abort();
    }, async baseUrl => {
      const asker = createCodexRouterAsker({
        baseUrl,
        readSecret: async () => 'local-capability',
        signal: controller.signal,
      });
      await expect(asker.ask('state', {})).rejects.toThrow();
    });
    expect(received).toBe(true);
  });
});
