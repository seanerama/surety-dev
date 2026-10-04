// The adapters' fixed invocation templates (D2 §§1.2, 4.5, 4.6; build spec
// §5 "Templates"): the text a trust entry records, and the argument array it
// renders to. Every argument is engine-authored fixed text or a path inside
// the sandbox; task content never reaches one (D1 §17 item 3). A change here
// is a template version change, which revokes entries (D2 §7.3). Rendering
// starts nothing: the choke point spawns.

import { createHash } from 'node:crypto';

export interface Template {
  version: string;
  text: string;
  // The environment variable the provider key is delivered in.
  keyVariable: string;
  // The flags by which the backend is asked to keep nothing between runs
  // (D2 §4.3); what it writes despite them is recorded by the canaries.
  persistenceFlags: string[];
  // The provider session id the engine assigns before launch (D2 §1.7),
  // when the template passes one; recorded on the receipt.
  sessionIdOf?: (invocation: string) => string;
  render(args: { model: string; invocation: string }): string[];
}

// The fixed prompt (D2 §1.2): it points at the context package and never
// begins with "-".
export const PROMPT = 'Read /surety/context/prompt.md and do what it asks. Write your result to /surety/out/result.json.';

// The tools a role is given (D2 §4.5, `--tools`): the built-in ones; the
// delegation and scheduling tools are denied by name.
const ROLE_TOOLS = 'Read,Edit,Write,Bash,Glob,Grep';

// Claude Code's `--session-id`, derived from the invocation id (D2 §1.7): a
// UUID in RFC 4122 form, the same for the same invocation.
export function sessionId(invocation: string): string {
  const h = createHash('sha256').update(`surety-session:${invocation}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export const TEMPLATES: Readonly<Record<string, Template>> = {
  // D2 §4.5, Claude Code 2.1.288.
  claude: {
    version: 'claude-one-shot-1',
    text:
      'claude --bare -p --output-format stream-json --verbose --model <m> --tools <role tools> --disallowed-tools Agent Task ScheduleWakeup Workflow ' +
      '--permission-mode bypassPermissions --no-session-persistence --session-id <uuid> <prompt>',
    keyVariable: 'ANTHROPIC_API_KEY',
    persistenceFlags: ['--no-session-persistence'],
    sessionIdOf: sessionId,
    render: ({ model, invocation }) => [
      '--bare',
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      model,
      '--tools',
      ROLE_TOOLS,
      '--disallowed-tools',
      'Agent',
      'Task',
      'ScheduleWakeup',
      'Workflow',
      '--permission-mode',
      'bypassPermissions',
      '--no-session-persistence',
      '--session-id',
      sessionId(invocation),
      PROMPT,
    ],
  },
  // D2 §4.6, Codex CLI 0.159.2: the prompt on standard input.
  codex: {
    version: 'codex-exec-1',
    text:
      'codex exec --json --ephemeral --ignore-user-config --ignore-rules --strict-config --disable multi_agent --dangerously-bypass-approvals-and-sandbox ' +
      '-C /surety/workspace -m <m> -o /surety/out/last-message.txt -',
    keyVariable: 'OPENAI_API_KEY',
    persistenceFlags: ['--ephemeral'],
    render: ({ model }) => [
      'exec',
      '--json',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--strict-config',
      '--disable',
      'multi_agent',
      '--dangerously-bypass-approvals-and-sandbox',
      '-C',
      '/surety/workspace',
      '-m',
      model,
      '-o',
      '/surety/out/last-message.txt',
      '-',
    ],
  },
};

export const keyVariable = (backend: string): string => TEMPLATES[backend]?.keyVariable ?? `${backend.toUpperCase()}_API_KEY`;

// The scripted backend as a qualifiable one, in the engine's test mode only
// (SEAM.md §148): its binary is started with no arguments and reads the
// scripted protocol's request on its standard input; no key; nothing kept.
export const SCRIPTED_TEMPLATE: Template = {
  version: 'scripted-1',
  text: '<binary> (the scripted protocol on standard input)',
  keyVariable: '',
  persistenceFlags: [],
  render: () => [],
};

// The template of a backend this engine has an adapter for, with its
// version as this start has it (the test mode may set another; SEAM.md
// §150). `scripted` only where the caller allows it.
export function templateOf(backend: string, opts: { scripted?: boolean; versions?: Record<string, string> | null } = {}): Template | undefined {
  const t = TEMPLATES[backend] ?? (opts.scripted && backend === 'scripted' ? SCRIPTED_TEMPLATE : undefined);
  if (!t) return undefined;
  const v = opts.versions?.[backend];
  return v === undefined ? t : { ...t, version: v };
}
