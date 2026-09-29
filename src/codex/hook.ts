import { saveContext } from './context.js';
import { processPreToolUse } from './pre-tool-use.js';

try {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw new Error('Hook input too large');
    chunks.push(Buffer.from(chunk));
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  try { await saveContext(input); } catch { /* Context is optional for this hook. */ }
  const decision = await processPreToolUse(input);
  process.stdout.write(JSON.stringify(decision ?? {}) + '\n');
} catch {
  // A context failure must not prevent Codex from executing the command.
  process.stdout.write('{}\n');
}
