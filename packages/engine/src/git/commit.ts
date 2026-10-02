// Commits the engine makes (D1 §§7.3, 7.4; SEAM.md §28). A commit's identity
// is fixed with its intent: its tree, parent, message, author, committer and
// dates are frozen then, so an attempt made again after a reconciled absence
// writes the very same object (SEAM.md §45). The author and committer are
// the engine's own, never taken from the environment (D1 §7.1; D1-07).
//
// What a role supplies (its summary) and what a plan names (a stage goal)
// are text in the message and nothing else: control characters are dropped,
// and the summary is indented so that nothing in it can be read as a
// trailer or as the end of the message. The trailers are the engine's, each
// exactly once, in the message's last paragraph.

const IDENTITY = 'Surety Engine <engine@surety.invalid>';

const clean = (text: string): string => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ');

export function oneLine(text: string, max = 72): string {
  const line = clean(text).replace(/[\t\n]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export interface CommitMessage {
  title: string;
  body?: string;
  trailers: [string, string][];
}

export function messageText(m: CommitMessage): string {
  const parts = [oneLine(m.title) || 'surety commit'];
  if (m.body !== undefined && m.body.trim() !== '') {
    const lines = clean(m.body)
      .split('\n')
      .map((line) => (line.trim() === '' ? '' : `    ${line.replace(/\t/g, '    ')}`));
    parts.push(lines.join('\n').replace(/\n{3,}/g, '\n\n'));
  }
  if (m.trailers.length > 0) parts.push(m.trailers.map(([k, v]) => `${k}: ${oneLine(v, 200)}`).join('\n'));
  return `${parts.join('\n\n')}\n`;
}

// The raw commit object, as `git hash-object -t commit` takes it.
export function commitContent(args: { tree: string; parent: string; message: string; at: string }): string {
  const epoch = Math.floor(Date.parse(args.at) / 1000);
  return `tree ${args.tree}\nparent ${args.parent}\nauthor ${IDENTITY} ${epoch} +0000\ncommitter ${IDENTITY} ${epoch} +0000\n\n${args.message}`;
}
