import type { JevAsker, JevQuestions, JevResponse, JevState } from './jev.js';

export class JevCampaignExhaustedError extends Error {
  constructor() { super('Jev campaign allowance exhausted'); }
}

/** Shared reservation for a campaign whose route has an enforced per-call cost ceiling. */
export class JevCampaignAllowance {
  private attempted = 0;
  private reserved = 0;
  private stopped = false;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    readonly maxRequests: number,
    readonly maxReservedMicroUsd: number,
    readonly perRequestCeilingMicroUsd: number,
  ) {
    if (![maxRequests, maxReservedMicroUsd, perRequestCeilingMicroUsd].every(
      value => Number.isSafeInteger(value) && value > 0,
    )) throw new Error('Invalid Jev campaign allowance');
  }

  get attemptedRequests(): number { return this.attempted; }
  get reservedMicroUsd(): number { return this.reserved; }
  get availableRequests(): number {
    return this.stopped ? 0 : Math.min(
      this.maxRequests - this.attempted,
      Math.floor((this.maxReservedMicroUsd - this.reserved) / this.perRequestCeilingMicroUsd),
    );
  }

  async ask(asker: JevAsker, state: JevState, questions: JevQuestions): Promise<JevResponse> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      if (this.availableRequests < 1) throw new JevCampaignExhaustedError();
      this.attempted += 1;
      this.reserved += this.perRequestCeilingMicroUsd;
      try {
        return await asker.ask(state, questions);
      } catch (error) {
        if (!(error instanceof Error && error.message.includes('max_tokens_exceeded'))) this.stopped = true;
        throw error;
      }
    } finally {
      release();
    }
  }
}
