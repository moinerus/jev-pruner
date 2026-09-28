import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface SessionMetric {
  schemaVersion: 1;
  category: 'build';
  beforeChars: number;
  afterChars: number;
  beforeEstimatedTokens: number;
  afterEstimatedTokens: number;
  calls: number;
  latencyMs: number;
}

export async function sessionReport(sessionId: string, home = homedir(), extraRoot?: string): Promise<string> {
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(sessionId)) throw new Error('Invalid Codex session id');
  const roots = [join(home, '.cache', 'jev-pruner', 'codex'), ...(extraRoot ? [extraRoot] : [])];
  const lines: string[] = [];
  for (const root of roots) {
    try {
      lines.push(...(await readFile(join(root, 'metrics', `${sessionId}.jsonl`), 'utf8')).trim().split('\n'));
    } catch { /* A session may have metrics in only one location. */ }
  }
  if (lines.length === 0) return 'No Jev session metrics yet.';
  const totals = { events: 0, beforeChars: 0, afterChars: 0,
    beforeEstimatedTokens: 0, afterEstimatedTokens: 0, calls: 0, latencyMs: 0 };
  for (const line of lines) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    if (record.schemaVersion !== 1 || record.category !== 'build' ||
        !['beforeChars', 'afterChars', 'beforeEstimatedTokens', 'afterEstimatedTokens', 'calls', 'latencyMs']
          .every(key => typeof record[key] === 'number' && Number.isSafeInteger(record[key]) && record[key] >= 0)) continue;
    totals.events += 1;
    for (const key of ['beforeChars', 'afterChars', 'beforeEstimatedTokens', 'afterEstimatedTokens', 'calls', 'latencyMs'] as const) {
      totals[key] += record[key] as number;
    }
  }
  return `${totals.events} eligible build results; ${totals.calls} Jev calls; ` +
    `${totals.beforeChars} original chars; ${totals.afterChars} shown chars; ` +
    `${totals.beforeEstimatedTokens} original estimated tokens; ${totals.afterEstimatedTokens} shown estimated tokens; ` +
    `${totals.latencyMs} ms hook latency. Estimates are not measured Codex context usage.`;
}
