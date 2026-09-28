import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { JevAsker } from '../jev.js';
import { estimateTokens } from '../jev.js';
import { classifyOutput, exceedsOutputThreshold } from '../output.js';
import { looksSecret } from '../secrets.js';
import { pruneCodexOutput } from './prune.js';
import { createCodexRouterAsker } from './router-asker.js';
import { isSessionObserving, readSessionMode, sessionAllowance } from './session-mode.js';

type PostToolUseInput = {
  hook_event_name?: unknown;
  tool_name?: unknown;
  session_id?: unknown;
  cwd?: unknown;
  tool_input?: unknown;
  tool_response?: unknown;
};

type BashResult = { output: string; exit_code: number };

function bashResult(value: unknown): BashResult | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const result = value as Record<string, unknown>;
  if (typeof result.output !== 'string' || result.exit_code !== 0 ||
      result.session_id !== undefined || result.isError === true) return undefined;
  return { output: result.output, exit_code: result.exit_code };
}

function commandInput(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  return typeof input.command === 'string' ? input.command :
    typeof input.cmd === 'string' ? input.cmd : undefined;
}

async function recordMetric(sessionId: string, home: string, metric: {
  beforeChars: number; afterChars: number; beforeEstimatedTokens: number;
  afterEstimatedTokens: number; calls: number; latencyMs: number;
}): Promise<void> {
  const metricsDirectory = join(home, '.cache', 'jev-pruner', 'codex', 'metrics');
  try {
    await mkdir(metricsDirectory, { recursive: true, mode: 0o700 });
    await appendFile(join(metricsDirectory, `${sessionId}.jsonl`),
      JSON.stringify({ schemaVersion: 1, category: 'build', ...metric }) + '\n', { mode: 0o600 });
  } catch { /* Metrics never decide whether the original result is preserved. */ }
}

export async function processPostToolUse(input: PostToolUseInput, options: {
  home?: string;
  asker?: JevAsker;
  baseUrl?: string;
  now?: () => number;
} = {}): Promise<{ continue: false; stopReason: string } | undefined> {
  if (input.hook_event_name !== 'PostToolUse' || input.tool_name !== 'Bash' ||
      typeof input.session_id !== 'string' || typeof input.cwd !== 'string') return undefined;
  const command = commandInput(input.tool_input);
  const result = bashResult(input.tool_response);
  if (!command || !result || result.output.length > 8 * 1024 * 1024 ||
      !exceedsOutputThreshold(result.output) || classifyOutput(command, result.output) !== 'build' ||
      looksSecret(command, result.output) || /(?:truncated|output cut off)/i.test(result.output.slice(-500))) return undefined;
  const home = options.home ?? homedir();
  const mode = await readSessionMode(input.session_id, home);
  if (!mode) {
    if (await isSessionObserving(input.session_id, home)) await recordMetric(input.session_id, home, {
      beforeChars: result.output.length, afterChars: result.output.length,
      beforeEstimatedTokens: estimateTokens(result.output),
      afterEstimatedTokens: estimateTokens(result.output), calls: 0, latencyMs: 0,
    });
    return undefined;
  }
  const allowance = sessionAllowance(mode);
  if (allowance.availableRequests < 1) {
    await recordMetric(input.session_id, home, {
      beforeChars: result.output.length, afterChars: result.output.length,
      beforeEstimatedTokens: estimateTokens(result.output),
      afterEstimatedTokens: estimateTokens(result.output), calls: 0, latencyMs: 0,
    });
    return undefined;
  }
  const original = Buffer.from(result.output);
  const started = (options.now ?? Date.now)();
  let calls = 0;
  const transport = options.asker ?? createCodexRouterAsker({ home, baseUrl: options.baseUrl });
  const archiveDirectory = join(home, '.cache', 'jev-pruner', 'codex', 'archives', input.session_id);
  const displayed = await pruneCodexOutput(original, command, {
    cwd: input.cwd,
    archiveDirectory,
    goal: 'Keep build and test failures, warnings, final status, counts, and artifact paths.',
    asker: { async ask(state, questions) { calls += 1; return transport.ask(state, questions); } },
    campaignRequired: true,
    campaignAllowance: allowance,
    maxScoringRequests: 19,
    maxChars: 7_000,
    maxStateTokens: 2_000,
  });
  const replacement = displayed.toString('utf8');
  const replaced = !displayed.equals(original) &&
    /\[fast-jev-output trimmed \d+(?: more)? lines/.test(replacement) &&
    estimateTokens(replacement) <= 2_000;
  const shown = replaced ? replacement : result.output;
  await recordMetric(input.session_id, home, {
    beforeChars: result.output.length,
    afterChars: shown.length,
    beforeEstimatedTokens: estimateTokens(result.output),
    afterEstimatedTokens: estimateTokens(shown),
    calls,
    latencyMs: Math.max(0, (options.now ?? Date.now)() - started),
  });
  return replaced ? { continue: false, stopReason: shown } : undefined;
}
