// useTerminal — bridges one xterm.js instance to a main-process PTY over the FROZEN
// IPC contract. Mirrors `useChat`'s stream discipline: subscribe to `pty:open`, capture
// the allocated `ptyId` from the leading `started` frame, feed `data` frames into the
// terminal, and abort the stream on unmount / workspace change so no listener (or shell)
// leaks. All main access funnels through `@renderer/ipc` — never `window.api` (README §10).
//
// The xterm CSS is imported here so it ships with the terminal module graph (electron-vite
// bundles it); this module is intentionally NOT imported by `RunPanel`, so the run-panel
// test never pulls xterm/webgl into jsdom.

import { useEffect } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { invoke, subscribeStream } from '@renderer/ipc';

/** Dark theme matching the app shell. Literal values (not `var()`) — xterm paints via
 *  canvas/WebGL, not the DOM, so it can't read CSS custom properties. Mirrors
 *  `tokens/colors.css`: `--surface-well` (terminal well), `--fg-1` (foreground),
 *  `--accent` (cursor). */
const TERMINAL_THEME = {
  background: '#07090d',
  foreground: '#e6e9ef',
  cursor: '#5b8cff',
} as const;

/**
 * Mount an interactive terminal into `containerRef` for one workspace tab. Keystrokes and
 * pastes are forwarded to the PTY (`pty:write`); container resizes refit the viewport and
 * resize the PTY (`pty:resize`). Everything is torn down on unmount / workspace change:
 * the stream is aborted, the xterm instance + addons disposed, and the PTY closed.
 *
 * `tabId` is part of the effect key so a new tab always gets a fresh shell; it is otherwise
 * unused (the main-side `ptyId` is the real handle, captured from the stream).
 */
export function useTerminal(
  workspaceId: string,
  tabId: string,
  containerRef: React.RefObject<HTMLDivElement | null>,
): void {
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const controller = new AbortController();
    let disposed = false;
    // The main-side handle, filled in by the leading `started` frame. Until then,
    // writes/resizes are dropped (there is nothing to address yet).
    let ptyId: string | null = null;

    const term = new Terminal({
      fontSize: 13,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      cursorBlink: true,
      theme: { ...TERMINAL_THEME },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    // WebGL is a perf optimization; if the context can't be created (headless/jsdom,
    // driver issues) fall back to xterm's default renderer rather than failing the mount.
    try {
      term.loadAddon(new WebglAddon());
    } catch {
      /* no WebGL — default renderer is fine */
    }

    /** Fit only when the element has real dimensions (avoids throwing while hidden). */
    const safeFit = (): void => {
      if (el.clientWidth > 0 && el.clientHeight > 0) {
        try {
          fit.fit();
        } catch {
          /* transient layout — next resize will retry */
        }
      }
    };
    safeFit();

    // Keystrokes + bracketed paste flow through onData → the PTY.
    const dataSub = term.onData((data) => {
      if (ptyId) void invoke('pty:write', { ptyId, data }).catch(() => {});
    });
    // A fit changes cols/rows → propagate to the PTY so the child sees the new size.
    const resizeSub = term.onResize(({ cols, rows }) => {
      if (ptyId)
        void invoke('pty:resize', { ptyId, cols, rows }).catch(() => {});
    });

    // Refit on container resize (pane grow/shrink, tab show, big-terminal toggle).
    const observer = new ResizeObserver(() => safeFit());
    observer.observe(el);

    // Copy/paste: Cmd/Ctrl+C copies the selection (only when there IS one, so Ctrl+C
    // still sends SIGINT otherwise); Cmd/Ctrl+V pastes the clipboard into the shell.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === 'c' && term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection());
        return false;
      }
      if (mod && e.key === 'v') {
        void navigator.clipboard.readText().then((text) => {
          if (ptyId && text) void invoke('pty:write', { ptyId, data: text });
        });
        return false;
      }
      return true;
    });

    void subscribeStream(
      'pty:open',
      { workspaceId, cols: term.cols, rows: term.rows },
      (chunk) => {
        if (chunk.kind === 'started') {
          ptyId = chunk.ptyId;
          return;
        }
        term.write(chunk.data);
      },
      { signal: controller.signal },
    ).catch(() => {
      // Stream ended in error, or the shell exited. Surface it in the pane (unless we're
      // tearing down, in which case the terminal is already gone).
      if (!disposed) term.write('\r\n\x1b[31m[process exited]\x1b[0m\r\n');
    });

    return () => {
      disposed = true;
      controller.abort();
      observer.disconnect();
      dataSub.dispose();
      resizeSub.dispose();
      term.dispose();
      // Best-effort: also tell main to kill the shell (abort tears down the stream, but
      // `pty:close` is the explicit deregister so a leaked PTY can't survive the window).
      if (ptyId) void invoke('pty:close', { ptyId }).catch(() => {});
    };
  }, [workspaceId, tabId, containerRef]);
}
