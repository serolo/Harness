import { describe, expect, it } from 'vitest';
import { permissionFromToolResult } from './toolResults';

describe('permissionFromToolResult', () => {
  it('ignores ordinary tool output', () => {
    expect(permissionFromToolResult('tests passed')).toBeNull();
    expect(permissionFromToolResult({ output: 'file contents' })).toBeNull();
  });

  it('recognizes Claude permission denials without returning the raw result', () => {
    const result = permissionFromToolResult(
      "Claude requested permissions to read from /Users/me/.claude/plans/example.md, but you haven't granted it yet.",
    );

    expect(result).toEqual({
      title: 'File access requires approval',
      description:
        'The agent needs your approval to read from /Users/me/.claude/plans/example.md.',
    });
    expect(result).not.toHaveProperty('input');
  });

  it('recognizes blocked command results inside content envelopes', () => {
    expect(
      permissionFromToolResult({
        content: [
          {
            type: 'text',
            text: "cat in '/tmp/plan.md' was blocked. Claude Code requires approval before reading it.",
          },
        ],
      }),
    ).toEqual({
      title: 'File access requires approval',
      description:
        "The agent needs your approval before it can run cat in '/tmp/plan.md'.",
    });
  });
});
