import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveContext } from '../src/codex/context.js';
import { pruneCodexOutput } from '../src/codex/prune.js';
import { createCodexRouterAsker } from '../src/codex/router-asker.js';
import { estimateTokens } from '../src/jev.js';
import type { JevQuestions, JevState } from '../src/jev.js';
import { trimOutput } from '../src/output.js';
import { CASES } from './fixtures/retention/cases.js';
import type { RetentionCase } from './fixtures/retention/cases.js';

const directories: string[] = [];
const sessionId = 'offline-retention';

async function temporaryDirectory() {
  const path = await mkdtemp(join(tmpdir(), 'jev-retention-'));
  directories.push(path);
  return path;
}

async function codexOptions(testCase: RetentionCase) {
  const cwd = await temporaryDirectory();
  const transcript = join(cwd, 'transcript.jsonl');
  await writeFile(transcript, [
    JSON.stringify({ type: 'session_meta', payload: { id: sessionId } }),
    JSON.stringify({ type: 'response_item', payload: {
      type: 'message', role: 'user', content: [{ type: 'input_text',
        text: `${testCase.task}\n${testCase.earlierContext}` }],
    } }),
  ].join('\n'));
  await saveContext({ hook_event_name: 'PreToolUse', tool_name: 'Bash',
    session_id: sessionId, transcript_path: transcript }, cwd);
  return { cwd, home: cwd, sessionId };
}

// This filter is shared by every case. Unknown content and failed commands return
// the whole output, because a lexical filter cannot establish their relevance.
function fixedFilter(testCase: RetentionCase): string {
  if (testCase.exitStatus !== 0 || /^(cat|git diff)\b/.test(testCase.command)) return testCase.stdout;
  const lines = testCase.stdout.split('\n');
  if (lines.some(line => !/^(progress:|\s+at\s+|WARNING:|ERROR:|FAILED |Tests:|Artifact:|Exit status:|Build completed)/.test(line))) {
    return testCase.stdout;
  }
  const keep = new Set([0, lines.length - 1]);
  lines.forEach((line, index) => {
    if (/^(\s+at\s+|WARNING:|ERROR:|FAILED |Tests:|Artifact:|Exit status:|Build completed)/.test(line)) {
      for (let i = Math.max(0, index - 1); i <= Math.min(lines.length - 1, index + 1); i++) keep.add(i);
    }
  });
  const displayed: string[] = [];
  let hidden = 0;
  lines.forEach((line, index) => {
    if (keep.has(index)) {
      if (hidden) displayed.push(`[${hidden} lines omitted]`);
      hidden = 0;
      displayed.push(line);
    } else hidden++;
  });
  if (hidden) displayed.push(`[${hidden} lines omitted]`);
  return displayed.join('\n');
}

// The oracle uses frozen fixture truth. It tests pruning mechanics, not Jev's
// ability to find the required lines. Every invocation is counted.
function oracle(testCase: RetentionCase) {
  return vi.fn(async (state: JevState, questions: JevQuestions) => {
    const chunks = (state as { chunks?: Array<{ id: string; text: string }> }).chunks ?? [];
    return { answers: Object.fromEntries(Object.keys(questions).map(id => {
      const text = chunks.find(chunk => chunk.id === id)?.text ?? '';
      return [id, { noul: testCase.requiredFacts.some(fact => text.includes(fact)) ? 0.99 : 0.01 }];
    })) };
  });
}

function assess(testCase: RetentionCase, displayed: string, stderr: string, status: number,
  action: string, conclusion = 'investigate') {
  const evidence = displayed + stderr;
  return status === testCase.exitStatus && action === testCase.nextAction &&
    testCase.requiredFacts.every(fact => evidence.includes(fact)) &&
    testCase.forbiddenConclusions.every(forbidden => conclusion !== forbidden);
}

async function runWrapper(testCase: RetentionCase) {
  const cwd = await temporaryDirectory();
  const stdoutPath = join(cwd, 'stdout.txt');
  const stderrPath = join(cwd, 'stderr.txt');
  await writeFile(stdoutPath, testCase.stdout);
  await writeFile(stderrPath, testCase.stderr);
  const script = 'const fs=require("node:fs");process.stdout.write(fs.readFileSync(process.argv[1]));process.stderr.write(fs.readFileSync(process.argv[2]));process.exitCode=Number(process.argv[3])';
  const compiled = resolve('dist/codex/run.js');
  const loader = existsSync(compiled) ? [compiled] : ['--import', 'tsx', resolve('src/codex/run.ts')];
  const child = spawn(process.execPath, [...loader, '--',
    process.execPath, '-e', script, stdoutPath, stderrPath, String(testCase.exitStatus)], {
    cwd: resolve('.'), env: { ...process.env, CODEX_THREAD_ID: '', TYPESAFE_API_KEY: '',
      JEV_PRUNER_TRANSPORT: '' },
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  return new Promise<{ stdout: Buffer; stderr: Buffer; status: number | null }>((done, fail) => {
    child.on('error', fail);
    child.on('close', status => done({ stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr), status }));
  });
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('frozen offline retention cases', () => {
  it.each(CASES)('$name: full, fixed filter and oracle Jev retain the next-action facts', async testCase => {
    expect(estimateTokens(testCase.stdout)).toBeGreaterThan(10_000);
    expect(assess(testCase, testCase.stdout, testCase.stderr, testCase.exitStatus,
      testCase.nextAction)).toBe(true);
    const filtered = fixedFilter(testCase);
    expect(assess(testCase, filtered, testCase.stderr, testCase.exitStatus,
      testCase.nextAction)).toBe(true);

    const ask = oracle(testCase);
    let displayed: string;
    if (testCase.exitStatus !== 0) {
      const wrapped = await runWrapper(testCase);
      expect(wrapped.stdout.equals(Buffer.from(testCase.stdout)), wrapped.stderr.toString()).toBe(true);
      expect(wrapped.stderr.equals(Buffer.from(testCase.stderr))).toBe(true);
      expect(wrapped.status).toBe(testCase.exitStatus);
      displayed = wrapped.stdout.toString();
    } else {
      const options = await codexOptions(testCase);
      displayed = (await pruneCodexOutput(Buffer.from(testCase.stdout), testCase.command,
        { ...options, asker: { ask } })).toString();
      const archiveDir = join(options.cwd, '.jev-pruner');
      if (testCase.expected === 'pruned') {
        expect(ask.mock.calls.length).toBeGreaterThan(0);
        expect(ask.mock.calls.length).toBeLessThanOrEqual(41);
        expect(displayed.length).toBeLessThan(testCase.stdout.length);
        const archives = (await readdir(archiveDir)).filter(name => name.endsWith('.txt'));
        expect(archives).toHaveLength(1);
        expect(await readFile(join(archiveDir, archives[0]!))).toEqual(Buffer.from(testCase.stdout));
      } else {
        expect(displayed).toBe(testCase.stdout);
        expect(ask).not.toHaveBeenCalled();
        await expect(readdir(archiveDir)).rejects.toThrow();
      }
    }
    expect(assess(testCase, displayed, testCase.stderr, testCase.exitStatus,
      testCase.nextAction)).toBe(true);
    expect(assess(testCase, displayed.replace(testCase.requiredFacts[0]!, ''),
      testCase.stderr.replace(testCase.requiredFacts[0]!, ''), testCase.exitStatus,
      testCase.nextAction)).toBe(false);
    expect(assess(testCase, displayed, testCase.stderr, 99, testCase.nextAction)).toBe(false);
    expect(assess(testCase, displayed, testCase.stderr, testCase.exitStatus,
      'Skip investigation')).toBe(false);
    expect(assess(testCase, displayed, testCase.stderr, testCase.exitStatus,
      testCase.nextAction, testCase.forbiddenConclusions[0])).toBe(false);
  });
});

describe('strict floor and failure recovery', () => {
  it.each([9_999, 10_000, 10_001])('%i estimated tokens uses the strict eligibility floor', async tokens => {
    const testCase = CASES[0]!;
    const options = await codexOptions(testCase);
    const output = Buffer.from('cache\n'.repeat(tokens));
    expect(estimateTokens(output.toString())).toBe(tokens);
    const ask = oracle(testCase);
    const displayed = await pruneCodexOutput(output, 'npm test', { ...options, asker: { ask } });
    if (tokens <= 10_000) {
      expect(displayed).toEqual(output);
      expect(ask).not.toHaveBeenCalled();
      await expect(readdir(join(options.cwd, '.jev-pruner'))).rejects.toThrow();
    } else {
      expect(ask.mock.calls.length).toBeGreaterThan(0);
      const archives = (await readdir(join(options.cwd, '.jev-pruner'))).filter(name => name.endsWith('.txt'));
      expect(archives).toHaveLength(1);
      expect(await readFile(join(options.cwd, '.jev-pruner', archives[0]!))).toEqual(output);
    }
  });

  it.each(['malformed decision', 'archive failure', 'cancellation', 'timeout'] as const)(
    '%s returns exact output, with request counts and archive state', async mode => {
      const testCase = CASES[0]!;
      const options = await codexOptions(testCase);
      const output = Buffer.from(testCase.stdout);
      const controller = new AbortController();
      let transportCalls = 0;
      const ask = vi.fn(async () => {
        if (mode === 'cancellation') controller.abort();
        return { answers: {} };
      });
      if (mode === 'archive failure') await writeFile(join(options.cwd, '.jev-pruner'), 'occupied');
      let asker = { ask };
      if (mode === 'timeout') {
        const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_done, fail) => {
          transportCalls++;
          init.signal!.addEventListener('abort', () => fail(new DOMException('timed out', 'AbortError')),
            { once: true });
        }));
        asker = createCodexRouterAsker({ readSecret: async () => 'synthetic-local-capability',
          fetch: fetch as typeof globalThis.fetch, timeoutMs: 1 });
      }
      const displayed = await pruneCodexOutput(output, testCase.command,
        { ...options, asker, signal: controller.signal });
      expect(displayed).toEqual(output);
      expect(ask.mock.calls.length).toBe(mode === 'archive failure' || mode === 'timeout' ? 0 : 1);
      expect(transportCalls).toBe(mode === 'timeout' ? 1 : 0);
      if (mode !== 'archive failure') {
        const archives = (await readdir(join(options.cwd, '.jev-pruner'))).filter(name => name.endsWith('.txt'));
        expect(archives).toHaveLength(1);
        expect(await readFile(join(options.cwd, '.jev-pruner', archives[0]!))).toEqual(output);
      }
    },
  );

  it('counts every fake upstream request under partial coverage and refinement', async () => {
    const testCase = CASES[0]!;
    const ask = oracle(testCase);
    const decisions: string[] = [];
    const result = await trimOutput({ command: testCase.command, goal: testCase.task,
      output: testCase.stdout, fullOutputPath: '/synthetic/archive.txt' }, { ask }, {
      maxStateTokens: 1_500, maxScoringRequests: 2, maxChars: 1_000,
      onDecision: decision => decisions.push(decision),
    });
    expect(ask.mock.calls.length).toBe(3);
    expect(decisions.at(-1)).toBe('budget_unfit');
    expect(result.output).toBe(testCase.stdout);
    expect(result.output.includes(testCase.requiredFacts[0]!)).toBe(true);
    expect(result.output.includes(testCase.requiredFacts[1]!)).toBe(true);
  });

  it('counts retry requests after a fake upstream token rejection', async () => {
    const testCase = CASES[0]!;
    const good = oracle(testCase);
    let calls = 0;
    const ask = vi.fn(async (state: JevState, questions: JevQuestions) => {
      calls++;
      if (calls === 1) throw new Error('max_tokens_exceeded');
      return good(state, questions);
    });
    const result = await trimOutput({ command: testCase.command, goal: testCase.task,
      output: testCase.stdout }, { ask }, { maxScoringRequests: 5 });
    expect(ask.mock.calls.length).toBeGreaterThan(1);
    expect(ask.mock.calls.length).toBeLessThanOrEqual(6);
    expect(result.output).toContain(testCase.requiredFacts[0]);
    expect(result.output).toContain(testCase.requiredFacts[1]);
  });

  it('keeps an unscored task value when the request allowance leaves coverage incomplete', async () => {
    const testCase = CASES[4]!;
    const ask = oracle(testCase);
    const result = await trimOutput({ command: testCase.command, goal: testCase.task,
      output: testCase.stdout }, { ask }, { maxStateTokens: 1_500, maxScoringRequests: 0 });
    expect(ask.mock.calls.length).toBe(1);
    expect(result.output).toContain(testCase.requiredFacts[0]);
    expect(result.output).toContain(testCase.requiredFacts[1]);
  });
});
