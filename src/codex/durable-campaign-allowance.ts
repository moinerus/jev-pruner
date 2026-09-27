import type { JevAsker, JevQuestions, JevResponse, JevState } from '../jev.js';
import { JevCampaignAllowance, JevCampaignExhaustedError } from '../campaign-allowance.js';
import type { JevScoringAllowance } from '../campaign-allowance.js';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute } from 'node:path';

type Ledger = {
  schemaVersion: 1;
  maxRequests: number;
  maxReservedMicroUsd: number;
  perRequestCeilingMicroUsd: number;
  attemptedRequests: number;
  reservedMicroUsd: number;
  stopped: boolean;
};

/** A lock left by a crashed process keeps the campaign closed until reconciled. */
export class JevDurableCampaignAllowance implements JevScoringAllowance {
  private readonly initial: Ledger;

  static async initialise(
    ledgerPath: string,
    maxRequests: number,
    maxReservedMicroUsd: number,
    perRequestCeilingMicroUsd: number,
  ): Promise<JevDurableCampaignAllowance> {
    const allowance = new JevDurableCampaignAllowance(
      ledgerPath, maxRequests, maxReservedMicroUsd, perRequestCeilingMicroUsd,
    );
    await mkdir(dirname(ledgerPath), { recursive: true });
    const journal = await open(`${ledgerPath}.journal`, 'wx', 0o600);
    try { await journal.writeFile(JSON.stringify(allowance.initial) + '\n'); await journal.sync(); }
    finally { await journal.close(); }
    const handle = await open(ledgerPath, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(allowance.initial) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    return allowance;
  }

  constructor(
    readonly ledgerPath: string,
    maxRequests: number,
    maxReservedMicroUsd: number,
    perRequestCeilingMicroUsd: number,
  ) {
    if (!isAbsolute(ledgerPath) || !ledgerPath.endsWith('.json')) {
      throw new Error('Jev campaign ledger needs an absolute JSON path');
    }
    new JevCampaignAllowance(maxRequests, maxReservedMicroUsd, perRequestCeilingMicroUsd);
    this.initial = { schemaVersion: 1, maxRequests, maxReservedMicroUsd,
      perRequestCeilingMicroUsd, attemptedRequests: 0, reservedMicroUsd: 0, stopped: false };
  }

  private read(): Ledger {
    let ledger: Ledger;
    try { ledger = JSON.parse(readFileSync(this.ledgerPath, 'utf8')) as Ledger; }
    catch { throw new Error('Missing or invalid Jev campaign ledger'); }
    let journalLast: Ledger;
    try {
      const lines = readFileSync(`${this.ledgerPath}.journal`, 'utf8').trimEnd().split('\n');
      journalLast = JSON.parse(lines.at(-1) ?? '') as Ledger;
    } catch { throw new Error('Missing or invalid Jev campaign journal'); }
    const keys = Object.keys(this.initial);
    if (!ledger || typeof ledger !== 'object' || Object.keys(ledger).length !== keys.length ||
        keys.some(key => !Object.hasOwn(ledger, key)) ||
        ledger.schemaVersion !== 1 || ledger.maxRequests !== this.initial.maxRequests ||
        ledger.maxReservedMicroUsd !== this.initial.maxReservedMicroUsd ||
        ledger.perRequestCeilingMicroUsd !== this.initial.perRequestCeilingMicroUsd ||
        !Number.isSafeInteger(ledger.attemptedRequests) || ledger.attemptedRequests < 0 ||
        ledger.attemptedRequests > ledger.maxRequests ||
        ledger.reservedMicroUsd !== ledger.attemptedRequests * ledger.perRequestCeilingMicroUsd ||
        ledger.reservedMicroUsd > ledger.maxReservedMicroUsd || typeof ledger.stopped !== 'boolean' ||
        JSON.stringify(journalLast) !== JSON.stringify(ledger)) {
      throw new Error('Invalid Jev campaign ledger');
    }
    return ledger;
  }

  private async write(ledger: Ledger): Promise<void> {
    const journal = await open(`${this.ledgerPath}.journal`, 'r+');
    try {
      const end = (await journal.stat()).size;
      const record = Buffer.from(JSON.stringify(ledger) + '\n');
      let written = 0;
      while (written < record.length) {
        const result = await journal.write(record, written, record.length - written, end + written);
        if (result.bytesWritten < 1) throw new Error('Jev campaign journal write failed');
        written += result.bytesWritten;
      }
      await journal.sync();
    } finally { await journal.close(); }
    const temp = `${this.ledgerPath}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(ledger) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    try { await rename(temp, this.ledgerPath); }
    catch (error) { await unlink(temp).catch(() => {}); throw error; }
  }

  get attemptedRequests(): number { return this.read().attemptedRequests; }
  get reservedMicroUsd(): number { return this.read().reservedMicroUsd; }
  get availableRequests(): number {
    if (existsSync(`${this.ledgerPath}.lock`)) return 0;
    try {
      const ledger = this.read();
      return ledger.stopped ? 0 : Math.min(ledger.maxRequests - ledger.attemptedRequests,
        Math.floor((ledger.maxReservedMicroUsd - ledger.reservedMicroUsd) / ledger.perRequestCeilingMicroUsd));
    } catch { return 0; }
  }

  async ask(asker: JevAsker, state: JevState, questions: JevQuestions): Promise<JevResponse> {
    await mkdir(dirname(this.ledgerPath), { recursive: true });
    let lock;
    try { lock = await open(`${this.ledgerPath}.lock`, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new JevCampaignExhaustedError();
      throw error;
    }
    let release = true;
    try {
      const ledger = this.read();
      if (ledger.stopped || ledger.attemptedRequests >= ledger.maxRequests ||
          ledger.reservedMicroUsd + ledger.perRequestCeilingMicroUsd > ledger.maxReservedMicroUsd) {
        throw new JevCampaignExhaustedError();
      }
      ledger.attemptedRequests += 1;
      ledger.reservedMicroUsd += ledger.perRequestCeilingMicroUsd;
      await this.write(ledger);
      try { return await asker.ask(state, questions); }
      catch (error) {
        if (!(error instanceof Error && error.message.includes('max_tokens_exceeded'))) {
          ledger.stopped = true;
          try { await this.write(ledger); }
          catch { release = false; }
        }
        throw error;
      }
    } finally {
      await lock.close();
      if (release) await unlink(`${this.ledgerPath}.lock`);
    }
  }
}
