import { describe, expect, it } from 'vitest';
import { JevCampaignAllowance } from '../src/campaign-allowance.js';
import { trimOutput } from '../src/output.js';
import type { JevAsker, JevQuestions } from '../src/jev.js';

const answer = (questions: JevQuestions) => ({
  answers: Object.fromEntries(Object.keys(questions).map(id => [id, { noul: 0 }])),
});
const input = { command: 'build', goal: 'Check result', output: 'progress item cached\n'.repeat(4_000) };

describe('shared Jev campaign allowance', () => {
  it('reserves the worst case before dispatch and runs only one request at a time', async () => {
    const allowance = new JevCampaignAllowance(3, 200, 100);
    let active = 0;
    let peak = 0;
    let called = 0;
    const asker: JevAsker = {
      async ask(_state, questions) {
        called += 1;
        active += 1;
        peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 1));
        active -= 1;
        return answer(questions);
      },
    };
    const questions: JevQuestions = { one: { type: 'noul', instructions: 'Keep?' } };
    const results = await Promise.allSettled(Array.from({ length: 3 }, () =>
      allowance.ask(asker, 'state', questions)));
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled', 'rejected']);
    expect(called).toBe(2);
    expect(peak).toBe(1);
    expect(allowance.attemptedRequests).toBe(2);
    expect(allowance.reservedMicroUsd).toBe(200);
    expect(allowance.availableRequests).toBe(0);
  });

  it('shares both limits across separate trims and preserves unscored output', async () => {
    const allowance = new JevCampaignAllowance(4, 200, 100);
    let calls = 0;
    const asker: JevAsker = { async ask(_state, questions) { calls += 1; return answer(questions); } };
    await trimOutput(input, asker, { campaignAllowance: allowance, maxScoringRequests: 1 });
    const before = calls;
    const second = await trimOutput(input, asker, { campaignAllowance: allowance, maxScoringRequests: 1 });
    expect(calls).toBe(2);
    expect(before).toBeGreaterThan(0);
    expect(second.output).toBe(input.output);
    expect(allowance.reservedMicroUsd).toBe(200);
  });

  it('preserves output when concurrent trims race for the last slot', async () => {
    const allowance = new JevCampaignAllowance(1, 100, 100);
    let calls = 0;
    const asker: JevAsker = {
      async ask(_state, questions) {
        calls += 1;
        await new Promise(resolve => setTimeout(resolve, 5));
        return answer(questions);
      },
    };
    const [first, second] = await Promise.all([
      trimOutput(input, asker, { campaignAllowance: allowance }),
      trimOutput(input, asker, { campaignAllowance: allowance }),
    ]);
    expect(calls).toBe(1);
    expect(second.output).toBe(input.output);
    expect(first.output.length).toBeGreaterThan(0);
  });

  it('counts a failed size request before a retry and stops after a transport error', async () => {
    const allowance = new JevCampaignAllowance(2, 200, 100);
    let calls = 0;
    await trimOutput(input, {
      async ask(_state, questions) {
        calls += 1;
        if (calls === 1) throw new Error('max_tokens_exceeded');
        return answer(questions);
      },
    }, { campaignAllowance: allowance, maxScoringRequests: 1 });
    expect(calls).toBe(2);
    expect(allowance.reservedMicroUsd).toBe(200);

    const failed = new JevCampaignAllowance(3, 300, 100);
    await expect(trimOutput(input, { async ask() { throw new Error('transport failed'); } },
      { campaignAllowance: failed })).rejects.toThrow('transport failed');
    expect(failed.attemptedRequests).toBe(1);
    expect(failed.reservedMicroUsd).toBe(100);
    expect(failed.availableRequests).toBe(0);
  });

  it('charges refinement requests to the same allowance as initial scoring', async () => {
    const allowance = new JevCampaignAllowance(2, 200, 100);
    const calls: string[] = [];
    const output = Array.from({ length: 600 }, (_, index) =>
      `progress: item ${index} ${'cached '.repeat(16)}`).join('\n');
    await trimOutput({ ...input, output }, {
      async ask(_state, questions) {
        calls.push(Object.keys(questions)[0] ?? '');
        return {
          answers: Object.fromEntries(Object.keys(questions).map(id => [id, { noul: 0.11 }])),
        };
      },
    }, { campaignAllowance: allowance, maxChars: 1_000, compactMarkers: true });
    expect(calls.some(id => id.startsWith('c'))).toBe(true);
    expect(calls.some(id => id.startsWith('g'))).toBe(true);
    expect(calls).toHaveLength(2);
    expect(allowance.reservedMicroUsd).toBe(200);
  });

  it('rejects invalid or unverifiable allowance values', () => {
    expect(() => new JevCampaignAllowance(0, 100, 100)).toThrow();
    expect(() => new JevCampaignAllowance(2, 100, 0)).toThrow();
    expect(() => new JevCampaignAllowance(2, Number.POSITIVE_INFINITY, 100)).toThrow();
  });
});
