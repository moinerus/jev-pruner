import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readSessionMode, sessionAllowance } from './session-mode.js';
import { createScopedJevTicket } from './scoped-ticket.js';

type PreToolUseInput = {
  hook_event_name?: unknown;
  tool_name?: unknown;
  session_id?: unknown;
  tool_input?: unknown;
};

const SIMPLE_BUILD = /^(?:(?:npm|pnpm|yarn|bun) (?:test|run (?:build|test|lint|typecheck|check)(?::[\w-]+)?|install|ci)|(?:cargo|go) (?:build|test|check)|node --test(?: [A-Za-z0-9_./-]+)?|(?:pytest|vitest|jest|make|ninja))$/;

function quote(value: string, platform: string): string {
  return platform === 'win32'
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", "'\\''")}'`;
}

export async function processPreToolUse(input: PreToolUseInput, options: {
  home?: string;
  platform?: string;
  nodePath?: string;
  runPath?: string;
  ticketRoot?: string;
  ticketBaseUrl?: string;
  ticketFetch?: typeof globalThis.fetch;
} = {}): Promise<{ hookSpecificOutput: {
  hookEventName: 'PreToolUse'; permissionDecision: 'allow';
  updatedInput: Record<string, unknown>;
} } | undefined> {
  if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Bash' ||
      typeof input.session_id !== 'string' || !input.tool_input ||
      typeof input.tool_input !== 'object') return undefined;
  const toolInput = input.tool_input as Record<string, unknown>;
  const commandKey = typeof toolInput.command === 'string' ? 'command' : 'cmd';
  const command = toolInput[commandKey];
  if (typeof command !== 'string' || command.length > 128 || !SIMPLE_BUILD.test(command)) return undefined;
  const home = options.home ?? homedir();
  const mode = await readSessionMode(input.session_id, home);
  if (!mode || sessionAllowance(mode).availableRequests < 1) return undefined;
  let ticketPath: string;
  try { ticketPath = await createScopedJevTicket(input.session_id, {
    ticketRoot: options.ticketRoot, baseUrl: options.ticketBaseUrl, fetch: options.ticketFetch,
  }); }
  catch { return undefined; }
  const platform = options.platform ?? process.platform;
  const parts = [options.nodePath ?? process.execPath,
    options.runPath ?? fileURLToPath(new URL('./run.js', import.meta.url)),
    '--auto-session', input.session_id, '--ticket-file', ticketPath,
    '--', ...command.split(' ')];
  const rewritten = `${platform === 'win32' ? '& ' : ''}${parts.map(part => quote(part, platform)).join(' ')}`;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow',
    updatedInput: { ...toolInput, command: rewritten, [commandKey]: rewritten } } };
}
