import { JevDurableRequestAllowance } from './durable-request-allowance.js';
import { disableSessionMode, isSessionObserving, observeSession, readSessionMode, sessionAllowance, setSessionMode } from './session-mode.js';
import { sessionReport } from './session-report.js';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

export async function sessionCommand(args: string[], env: NodeJS.ProcessEnv = process.env,
  home?: string): Promise<string> {
  const sessionId = env.CODEX_THREAD_ID;
  if (!sessionId) throw new Error('CODEX_THREAD_ID is required');
  const action = args[0];
  if (action === 'disable' && args.length === 1) {
    await disableSessionMode(sessionId, home);
    return 'Jev pruning off for this session.';
  }
  if (action === 'status' && args.length === 1) {
    const mode = await readSessionMode(sessionId, home);
    if (!mode) return await isSessionObserving(sessionId, home)
      ? 'Jev baseline observation on for this session. Paid pruning off.'
      : 'Jev pruning off for this session.';
    const allowance = sessionAllowance(mode);
    return `Jev pruning on for this session. Calls used: ${allowance.attemptedRequests}. Calls available: ${allowance.availableRequests}.`;
  }
  if (action === 'observe' && args.length === 1) {
    await observeSession(sessionId, home);
    return 'Jev baseline observation on for this session. Paid pruning off.';
  }
  if (action === 'report' && args.length === 1) return sessionReport(sessionId, home,
    join(tmpdir(), 'jev-pruner', 'codex'));
  if (action === 'initialise-key-cap' && args.length === 4) {
    const allowance = await JevDurableRequestAllowance.initialise(args[1]!, Number(args[2]), Number(args[3]));
    return `Jev request ledger created. Calls available: ${allowance.availableRequests}. Provider key dollar cap must be enforced separately.`;
  }
  if (action === 'enable-key-cap' && args.length === 3) {
    await setSessionMode(sessionId, { kind: 'key-capped-requests',
      ledgerPath: args[1]!, maxRequests: Number(args[2]) }, home);
    return 'Jev pruning on for this session. Provider key dollar cap is external.';
  }
  if (action === 'enable' && args.length === 5) {
    const mode = { ledgerPath: args[1]!, maxRequests: Number(args[2]),
      maxReservedMicroUsd: Number(args[3]), perRequestCeilingMicroUsd: Number(args[4]) };
    await setSessionMode(sessionId, mode, home);
    return 'Jev pruning on for this session.';
  }
  throw new Error('Usage: session.js initialise-key-cap <ledger.json> <max-requests> <earlier-requests> | enable-key-cap <existing-ledger.json> <max-requests> | enable <existing-ledger.json> <max-requests> <max-reserved-micro-usd> <per-request-ceiling-micro-usd> | observe | disable | status | report');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  sessionCommand(process.argv.slice(2)).then(message => process.stdout.write(`${message}\n`))
    .catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'Session command failed'}\n`); process.exitCode = 2; });
}
