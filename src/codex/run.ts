import { spawn } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import { pruneCodexOutput } from './prune.js';
import { createCodexRouterAsker, createScopedCodexRouterAsker } from './router-asker.js';
import { campaignFromEnvironment } from './campaign.js';
import { processPostToolUse } from './post-tool-use.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validScopedTicketFile } from './scoped-ticket.js';

const args = process.argv.slice(2);
const requireCampaign = args[0] === '--require-campaign';
const autoSession = args[0] === '--auto-session' ? args[1] : undefined;
const hasTicketFlag = Boolean(autoSession && args[2] === '--ticket-file');
const ticketFile = hasTicketFlag &&
  validScopedTicketFile(autoSession ?? '', args[3]) ? args[3] : undefined;
const campaignArgs = requireCampaign ? args.slice(1) : autoSession
  ? args.slice(hasTicketFlag ? 4 : 2) : args;
const hasGoalFlag = requireCampaign && campaignArgs[0] === '--goal';
const goal = hasGoalFlag && campaignArgs[1] !== '--' ? campaignArgs[1] : undefined;
const commandArgs = hasGoalFlag ? campaignArgs.slice(goal === undefined ? 1 : 2) : campaignArgs;
if (commandArgs[0] !== '--' || commandArgs.length < 2) {
  process.stderr.write('Usage: node run.js [--require-campaign --goal "short task goal" | --auto-session <id> --ticket-file <path>] -- <executable> [arguments...]\n');
  process.exitCode = 2;
} else {
  const [command, ...parameters] = commandArgs.slice(1);
  const child = spawn(command, parameters, { stdio: ['inherit', 'pipe', 'inherit'] });
  const buffers: Buffer[] = [];
  const limit = 8 * 1024 * 1024;
  let bytes = 0;
  let streaming = false;
  let spawnFailed = false;
  let receivedSignal: NodeJS.Signals | undefined;
  const controller = new AbortController();
  const forward = (signal: NodeJS.Signals) => {
    receivedSignal = signal;
    controller.abort();
    child.kill(signal);
  };
  const forwardInt = () => forward('SIGINT');
  const forwardTerm = () => forward('SIGTERM');
  process.on('SIGINT', forwardInt);
  process.on('SIGTERM', forwardTerm);
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (!streaming && bytes > limit) {
      streaming = true;
      for (const buffer of buffers) process.stdout.write(buffer);
      buffers.length = 0;
    }
    if (streaming) {
      if (!process.stdout.write(chunk)) child.stdout.pause();
    } else buffers.push(chunk);
  });
  process.stdout.on('drain', () => child.stdout.resume());
  child.on('error', () => {
    spawnFailed = true;
    process.stderr.write('jev-pruner: unable to start command\n');
    process.exitCode = 127;
  });
  child.on('close', async (code, signal) => {
    if (!streaming) {
      const output = Buffer.concat(buffers);
      const campaign = campaignFromEnvironment(process.env, requireCampaign);
      let displayed: Buffer = output;
      if (code === 0 && !signal && autoSession && ticketFile &&
          output.equals(Buffer.from(output.toString('utf8')))) {
        try {
          const decision = await processPostToolUse({
            hook_event_name: 'PostToolUse', tool_name: 'Bash', session_id: autoSession,
            cwd: process.cwd(), tool_input: { command: [command, ...parameters].join(' ') },
            tool_response: { output: output.toString('utf8'), exit_code: 0 },
          }, { runtimeRoot: join(tmpdir(), 'jev-pruner', 'codex'),
            asker: createScopedCodexRouterAsker({ ticketFile,
              baseUrl: process.env.JEV_PRUNER_CODEX_ROUTER_BASE_URL,
              signal: controller.signal }) });
          if (decision) displayed = Buffer.from(decision.stopReason);
        } catch { /* The original output remains available. */ }
      } else if (code === 0 && !signal && !autoSession) {
        displayed = await pruneCodexOutput(output, [command, ...parameters].join(' '), {
          cwd: process.cwd(),
          sessionId: process.env.CODEX_THREAD_ID,
          goal,
          apiKey: process.env.TYPESAFE_API_KEY,
          asker: process.env.JEV_PRUNER_TRANSPORT === 'codex-router'
            ? createCodexRouterAsker({
              baseUrl: process.env.JEV_PRUNER_CODEX_ROUTER_BASE_URL,
              signal: controller.signal,
            })
            : undefined,
          campaignRequired: campaign.required,
          campaignAllowance: campaign.allowance,
          signal: controller.signal,
        });
      }
      await new Promise<void>(resolve => process.stdout.write(displayed, () => resolve()));
    }
    if (ticketFile) await unlink(ticketFile).catch(() => {});
    await new Promise<void>(resolve => process.stdout.write('', () => resolve()));
    process.removeListener('SIGINT', forwardInt);
    process.removeListener('SIGTERM', forwardTerm);
    const termination = receivedSignal ?? signal;
    if (termination) process.kill(process.pid, termination);
    else process.exitCode = spawnFailed ? 127 : code ?? 127;
  });
}
