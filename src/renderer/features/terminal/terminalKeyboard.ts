export type TerminalKeyboardAction = 'copy-selection' | 'delegate-to-xterm';

/**
 * xterm owns paste handling through its hidden textarea and emits the pasted value once
 * through `onData`. Only selection-copy needs custom handling so Ctrl+C can continue to
 * mean SIGINT when the terminal has no selection.
 */
export function terminalKeyboardAction(
  event: Pick<KeyboardEvent, 'type' | 'key' | 'metaKey' | 'ctrlKey'>,
  hasSelection: boolean,
): TerminalKeyboardAction {
  const modifier = event.metaKey || event.ctrlKey;
  return event.type === 'keydown' &&
    modifier &&
    event.key.toLowerCase() === 'c' &&
    hasSelection
    ? 'copy-selection'
    : 'delegate-to-xterm';
}
