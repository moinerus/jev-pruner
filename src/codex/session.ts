import { JevDurableCampaignAllowance } from './durable-campaign-allowance.js';
import { disableSessionMode, isSessionObserving, observeSession, readSessionMode, setSessionMode } from './session-mode.js';
import { sessionReport } from './session-report.js';

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
    const allowance = new JevDurableCampaignAllowance(mode.ledgerPath, mode.maxRequests,
      mode.maxReservedMicroUsd, mode.perRequestCeilingMicroUsd);
    return `Jev pruning on for this session. Calls used: ${allowance.attemptedRequests}. Calls available: ${allowance.availableRequests}.`;
  }
  if (action === 'observe' && args.length === 1) {
    await observeSession(sessionId, home);
    return 'Jev baseline observation on for this session. Paid pruning off.';
  }
  if (action === 'report' && args.length === 1) return sessionReport(sessionId, home);
  if (action === 'enable' && args.length === 5) {
    const mode = { ledgerPath: args[1]!, maxRequests: Number(args[2]),
      maxReservedMicroUsd: Number(args[3]), perRequestCeilingMicroUsd: Number(args[4]) };
    await setSessionMode(sessionId, mode, home);
    return 'Jev pruning on for this session.';
  }
  throw new Error('Usage: session.js enable <existing-ledger.json> <max-requests> <max-reserved-micro-usd> <per-request-ceiling-micro-usd> | observe | disable | status | report');
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  sessionCommand(process.argv.slice(2)).then(message => process.stdout.write(`${message}\n`))
    .catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'Session command failed'}\n`); process.exitCode = 2; });
}
