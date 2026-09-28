import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { JevCampaignExhaustedError, type JevScoringAllowance } from '../campaign-allowance.js';
import type { JevAsker, JevQuestions, JevResponse, JevState } from '../jev.js';

type Ledger = {
  schemaVersion: 1;
  kind: 'provider-key-capped-requests';
  maxRequests: number;
  attemptedRequests: number;
  stopped: boolean;
};

/** Counts dispatches across sessions. The provider key must enforce the separate dollar cap. */
export class JevDurableRequestAllowance implements JevScoringAllowance {
  static async initialise(path: string, maxRequests: number, attemptedRequests: number): Promise<JevDurableRequestAllowance> {
    const allowance = new JevDurableRequestAllowance(path, maxRequests);
    if (!Number.isSafeInteger(attemptedRequests) || attemptedRequests < 0 || attemptedRequests > maxRequests) {
      throw new Error('Invalid earlier Jev request count');
    }
    const ledger: Ledger = { schemaVersion: 1, kind: 'provider-key-capped-requests',
      maxRequests, attemptedRequests, stopped: false };
    await mkdir(dirname(path), { recursive: true });
    const guard = await open(`${path}.lock`, 'wx', 0o600);
    let dirty = false;
    let complete = false;
    try {
      if (existsSync(path) || existsSync(`${path}.journal`)) throw new Error('Jev request ledger already exists');
      dirty = true;
      const journal = await open(`${path}.journal`, 'wx', 0o600);
      try { await journal.writeFile(JSON.stringify(ledger) + '\n'); await journal.sync(); }
      finally { await journal.close(); }
      const handle = await open(path, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(ledger) + '\n'); await handle.sync(); }
      finally { await handle.close(); }
      complete = true;
    } finally {
      await guard.close();
      if (!dirty || complete) await unlink(`${path}.lock`);
    }
    return allowance;
  }

  constructor(readonly path: string, readonly maxRequests: number) {
    if (!isAbsolute(path) || !path.endsWith('.json') || !Number.isSafeInteger(maxRequests) || maxRequests < 1) {
      throw new Error('Invalid Jev request allowance');
    }
  }

  private read(): Ledger {
    let ledger: Ledger;
    let last: Ledger;
    try {
      ledger = JSON.parse(readFileSync(this.path, 'utf8')) as Ledger;
      const lines = readFileSync(`${this.path}.journal`, 'utf8').trimEnd().split('\n');
      last = JSON.parse(lines.at(-1) ?? '') as Ledger;
    } catch { throw new Error('Missing or invalid Jev request ledger'); }
    if (!ledger || typeof ledger !== 'object' ||
        Object.keys(ledger).sort().join(',') !== 'attemptedRequests,kind,maxRequests,schemaVersion,stopped' ||
        ledger.schemaVersion !== 1 || ledger.kind !== 'provider-key-capped-requests' ||
        ledger.maxRequests !== this.maxRequests || !Number.isSafeInteger(ledger.attemptedRequests) ||
        ledger.attemptedRequests < 0 || ledger.attemptedRequests > ledger.maxRequests ||
        typeof ledger.stopped !== 'boolean' || JSON.stringify(ledger) !== JSON.stringify(last)) {
      throw new Error('Invalid Jev request ledger');
    }
    return ledger;
  }

  private async write(ledger: Ledger): Promise<void> {
    const journal = await open(`${this.path}.journal`, 'r+');
    try {
      const end = (await journal.stat()).size;
      const record = Buffer.from(JSON.stringify(ledger) + '\n');
      let written = 0;
      while (written < record.length) {
        const result = await journal.write(record, written, record.length - written, end + written);
        if (result.bytesWritten < 1) throw new Error('Jev request journal write failed');
        written += result.bytesWritten;
      }
      await journal.sync();
    } finally { await journal.close(); }
    const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(ledger) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    try { await rename(temp, this.path); }
    catch (error) { await unlink(temp).catch(() => {}); throw error; }
  }

  get attemptedRequests(): number { return this.read().attemptedRequests; }
  get availableRequests(): number {
    if (existsSync(`${this.path}.lock`)) return 0;
    try {
      const ledger = this.read();
      return ledger.stopped ? 0 : ledger.maxRequests - ledger.attemptedRequests;
    } catch { return 0; }
  }

  async ask(asker: JevAsker, state: JevState, questions: JevQuestions): Promise<JevResponse> {
    let lock;
    try { lock = await open(`${this.path}.lock`, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new JevCampaignExhaustedError();
      throw error;
    }
    let release = true;
    try {
      const ledger = this.read();
      if (ledger.stopped || ledger.attemptedRequests >= ledger.maxRequests) throw new JevCampaignExhaustedError();
      ledger.attemptedRequests += 1;
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
      if (release) await unlink(`${this.path}.lock`);
    }
  }
}
