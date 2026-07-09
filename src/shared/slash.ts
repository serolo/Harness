// FROZEN CONTRACT (src/shared/** is append-only — README §5.2).
//
// Slash commands: named prompt templates the user triggers by typing `/name` in the
// composer (spec §5.4). The catalogue comes from `settings.agent.prompts` and is
// exposed over `slash:list` (@shared/ipc). Both the main handler (which builds the
// list) and the renderer composer (which parses input + expands the template) import
// the pure helpers here so the parse/expand rules live in exactly one place.

/** One slash command the composer can offer + expand. */
export interface SlashCommand {
  /** The token typed after `/` (e.g. `review`). Unique within the catalogue. */
  name: string;
  /** The prompt template expanded into the composer when the command is chosen. */
  template: string;
  /** Optional one-line description for the autocomplete menu. */
  description?: string;
}

/** A parsed slash input: the command `name` and any trailing free-text `args`. */
export interface ParsedSlash {
  name: string;
  args: string;
}

/** Command names are a leading letter/digit then word chars or hyphens. */
const SLASH_RE = /^\/([A-Za-z0-9][\w-]*)(?:\s+([\s\S]*))?$/;

/**
 * Parse composer input as a slash command. Returns `{ name, args }` when the input
 * is exactly `/name` optionally followed by whitespace + free text, else `null`
 * (plain prose, a bare `/`, or `/ ` with a leading space are all not commands).
 * Pure + allocation-light so the composer can call it on every keystroke.
 */
export function parseSlash(input: string): ParsedSlash | null {
  const match = SLASH_RE.exec(input);
  if (match === null) return null;
  return { name: match[1]!, args: (match[2] ?? '').trim() };
}

/**
 * Expand a chosen command's template with the user's trailing text. If the template
 * contains the `$ARGS` placeholder, the args are substituted there; otherwise the
 * args (when present) are appended after a blank line. With no args, the template is
 * returned unchanged (placeholder stripped).
 */
export function expandSlashTemplate(template: string, args: string): string {
  if (template.includes('$ARGS')) {
    return template.replaceAll('$ARGS', args);
  }
  return args === '' ? template : `${template}\n\n${args}`;
}

/**
 * Rank + filter a catalogue against a partial command name for the autocomplete menu.
 * A hand-rolled subsequence match (no new dep): keeps commands whose name contains
 * `query`'s characters in order, prefix matches first, then by name length. An empty
 * query returns the whole catalogue in its original order.
 */
export function matchSlashCommands(
  query: string,
  commands: readonly SlashCommand[],
): SlashCommand[] {
  const q = query.toLowerCase();
  if (q === '') return [...commands];
  const scored: { cmd: SlashCommand; score: number }[] = [];
  for (const cmd of commands) {
    const name = cmd.name.toLowerCase();
    if (name.startsWith(q)) {
      scored.push({ cmd, score: 0 });
    } else if (isSubsequence(q, name)) {
      scored.push({ cmd, score: 1 });
    }
  }
  scored.sort(
    (a, b) => a.score - b.score || a.cmd.name.length - b.cmd.name.length,
  );
  return scored.map((s) => s.cmd);
}

/** True if every char of `needle` appears in `haystack` in order. */
function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return i === needle.length;
}
