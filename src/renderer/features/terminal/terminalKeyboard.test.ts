import { describe, expect, it } from 'vitest';
import { terminalKeyboardAction } from './terminalKeyboard';

function key(
  value: string,
  overrides: Partial<KeyboardEvent> = {},
): Pick<KeyboardEvent, 'type' | 'key' | 'metaKey' | 'ctrlKey'> {
  return {
    type: 'keydown',
    key: value,
    metaKey: false,
    ctrlKey: false,
    ...overrides,
  };
}

describe('terminalKeyboardAction', () => {
  it('delegates keyboard paste to xterm so the value is emitted only once', () => {
    expect(
      terminalKeyboardAction(key('v', { metaKey: true }), false),
    ).toBe('delegate-to-xterm');
    expect(
      terminalKeyboardAction(key('v', { ctrlKey: true }), false),
    ).toBe('delegate-to-xterm');
  });

  it('copies a selection but delegates Ctrl+C without one for SIGINT', () => {
    expect(
      terminalKeyboardAction(key('c', { metaKey: true }), true),
    ).toBe('copy-selection');
    expect(
      terminalKeyboardAction(key('c', { ctrlKey: true }), false),
    ).toBe('delegate-to-xterm');
  });
});
