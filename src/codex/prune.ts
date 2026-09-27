import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { JevAsker } from '../jev.js';
import type { JevScoringAllowance } from '../campaign-allowance.js';
import { buildJevRequest, parseJevResponse } from '../jev.js';
import { exceedsOutputThreshold, trimOutput } from '../output.js';
import { looksSecret } from '../secrets.js';
import { readTranscript } from './context.js';
import { codexMessages } from './history.js';
import { CODEX_ROUTER_JEV_MODEL } from './router-asker.js';

export async function pruneCodexOutput(
  output: Buffer,
  command: string,
  options: {
    cwd: string;
    sessionId?: string;
    goal?: string;
    apiKey?: string;
    home?: string;
    asker?: JevAsker;
    campaignRequired?: boolean;
    campaignAllowance?: JevScoringAllowance;
    signal?: AbortSignal;
  },
): Promise<Buffer> {
  const apiKey = options.apiKey;
  const text = output.toString('utf8');
  const focusedGoal = options.goal?.trim();
  if (!output.equals(Buffer.from(text)) || !exceedsOutputThreshold(text)
      || (!options.campaignRequired && !options.sessionId) ||
      (options.campaignRequired && (!focusedGoal || focusedGoal.length > 240 ||
        /[\r\n]/.test(focusedGoal) || looksSecret(focusedGoal, focusedGoal))) ||
      (!apiKey && !options.asker) || looksSecret(command, text) ||
      (options.campaignRequired && !options.campaignAllowance)) return output;
  try {
    const messages = options.campaignRequired ? [] : codexMessages(
      await readTranscript(options.sessionId!, options.home), options.sessionId!,
    );
    const goal = focusedGoal ?? messages.filter(message => message.role === 'user' && message.text)
      .slice(-3).map(message => message.text.slice(0, 500)).join('\n');
    const directory = join(options.cwd, '.jev-pruner');
    const path = join(directory, `codex-${randomUUID()}.txt`);
    let archived: Promise<void> | undefined;
    const archive = async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(join(directory, '.gitignore'), '*\n', { mode: 0o600 });
      await writeFile(path, output, { mode: 0o600, flag: 'wx' });
    };
    const result = await trimOutput(
      { command, goal, messages, output: text, fullOutputPath: path,
        focused: options.campaignRequired },
      {
        async ask(state, questions) {
          if (options.signal?.aborted) throw new Error('Command interrupted');
          await (archived ??= archive());
          if (options.asker) return options.asker.ask(state, questions);
          if (!apiKey) throw new Error('Jev API key is unavailable');
          const request = buildJevRequest({ apiKey }, state, questions);
          const controller = new AbortController();
          const cancel = () => controller.abort();
          options.signal?.addEventListener('abort', cancel, { once: true });
          const timeout = setTimeout(cancel, 30_000);
          try {
            if (options.signal?.aborted) cancel();
            const response = await fetch(request.url, {
              method: request.method, headers: request.headers, body: request.body,
              signal: controller.signal,
            });
            return parseJevResponse(response.status, response.ok, await response.text());
          } finally {
            clearTimeout(timeout);
            options.signal?.removeEventListener('abort', cancel);
          }
        },
      },
      {
        campaignAllowance: options.campaignAllowance,
        ...(options.campaignRequired ? {
          maxStateTokens: 3_000,
          maxRequestTokens: 6_000,
          requestModel: CODEX_ROUTER_JEV_MODEL,
        } : {}),
      },
    );
    return result.trimmed && !options.signal?.aborted
      ? Buffer.from(`${result.output}\n\n[fast-jev-output full output: ${path} (Read or grep it if needed)]`)
      : output;
  } catch {
    return output;
  }
}
