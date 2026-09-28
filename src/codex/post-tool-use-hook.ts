import { processPostToolUse } from './post-tool-use.js';

try {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 10 * 1024 * 1024) throw new Error('Hook input too large');
    chunks.push(Buffer.from(chunk));
  }
  const decision = await processPostToolUse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  if (decision) process.stdout.write(JSON.stringify(decision) + '\n');
} catch {
  // Hook failures leave the original tool result in place.
}
