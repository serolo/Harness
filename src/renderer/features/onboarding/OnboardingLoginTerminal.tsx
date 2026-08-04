import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import {
  CheckCircle2,
  LoaderCircle,
  TerminalSquare,
  XCircle,
} from 'lucide-react';
import '@xterm/xterm/css/xterm.css';

import type { OnboardingLoginProvider } from '@shared/ipc';
import { invoke, subscribeStream } from '@renderer/ipc';

const PROVIDER_LABELS: Record<OnboardingLoginProvider, string> = {
  github: 'GitHub',
  claude: 'Claude Code',
  codex: 'Codex',
};

export function OnboardingLoginTerminal({
  provider,
  method,
  force,
  onFinished,
  onClose,
  onError,
}: {
  provider: OnboardingLoginProvider;
  method?: 'cli' | 'api_key';
  force?: boolean;
  onFinished: (authenticated: boolean) => void;
  onClose: () => void;
  onError: (message: string) => void;
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const callbacksRef = useRef({ onFinished, onError });
  const [status, setStatus] = useState<'running' | 'success' | 'failed'>(
    'running',
  );

  callbacksRef.current = { onFinished, onError };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const controller = new AbortController();
    let disposed = false;
    let ptyId: string | null = null;
    const terminal = new Terminal({
      fontSize: 13,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      cursorBlink: true,
      theme: {
        background: '#100d0d',
        foreground: '#f3f0eb',
        cursor: '#d3a7ff',
        selectionBackground: 'rgba(211, 167, 255, 0.25)',
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);

    const safeFit = (): void => {
      if (container.clientWidth === 0 || container.clientHeight === 0) return;
      try {
        fit.fit();
      } catch {
        // A later resize retries after transient layout changes.
      }
    };
    safeFit();
    terminal.focus();

    const dataSubscription = terminal.onData((data) => {
      if (ptyId !== null) {
        void invoke('pty:write', { ptyId, data }).catch(() => {});
      }
    });
    const resizeSubscription = terminal.onResize(({ cols, rows }) => {
      if (ptyId !== null) {
        void invoke('pty:resize', { ptyId, cols, rows }).catch(() => {});
      }
    });
    const observer = new ResizeObserver(safeFit);
    observer.observe(container);

    void subscribeStream(
      'onboarding:login',
      {
        provider,
        method,
        ...(force !== undefined ? { force } : {}),
        cols: terminal.cols,
        rows: terminal.rows,
      },
      (chunk) => {
        if (chunk.kind === 'started') {
          ptyId = chunk.ptyId;
          terminal.writeln(`\x1b[2m$ ${chunk.command}\x1b[0m`);
          return;
        }
        if (chunk.kind === 'data') {
          terminal.write(chunk.data);
          return;
        }
        if (chunk.kind === 'progress') {
          terminal.writeln(`\x1b[2m${chunk.message}\x1b[0m`);
          return;
        }
        const nextStatus = chunk.authenticated ? 'success' : 'failed';
        setStatus(nextStatus);
        terminal.writeln(
          chunk.authenticated
            ? '\r\n\x1b[32mAuthentication confirmed.\x1b[0m'
            : '\r\n\x1b[31mAuthentication was not completed. Try again.\x1b[0m',
        );
        callbacksRef.current.onFinished(chunk.authenticated);
      },
      { signal: controller.signal },
    ).catch((error: unknown) => {
      if (
        disposed ||
        (error instanceof DOMException && error.name === 'AbortError')
      ) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      setStatus('failed');
      terminal.writeln(`\r\n\x1b[31m${message}\x1b[0m`);
      callbacksRef.current.onError(message);
    });

    return () => {
      disposed = true;
      controller.abort();
      observer.disconnect();
      dataSubscription.dispose();
      resizeSubscription.dispose();
      terminal.dispose();
      if (ptyId !== null) {
        void invoke('pty:close', { ptyId }).catch(() => {});
      }
    };
  }, [force, method, provider]);

  const StatusIcon =
    status === 'running'
      ? LoaderCircle
      : status === 'success'
        ? CheckCircle2
        : XCircle;

  return (
    <section
      className="mt-4 max-w-[1180px] overflow-hidden rounded border border-border-1 bg-[#100d0d] shadow-2xl"
      data-testid="onboarding-login-terminal"
      aria-live="polite"
    >
      <header className="flex h-11 items-center gap-2 border-b border-white/10 px-4 text-xs text-[#b9b2ad]">
        <TerminalSquare className="h-4 w-4" aria-hidden />
        <span className="font-medium text-[#f3f0eb]">
          {status === 'running' ? 'Signing in to' : 'Finished'}{' '}
          {PROVIDER_LABELS[provider]}
        </span>
        <span className="flex-1" />
        <StatusIcon
          className={`h-4 w-4 ${
            status === 'running'
              ? 'animate-spin text-accent'
              : status === 'success'
                ? 'text-ok'
                : 'text-danger'
          }`}
          aria-hidden
        />
        <button
          type="button"
          className="ml-2 rounded px-2 py-1 font-medium text-[#b9b2ad] hover:bg-white/10 hover:text-white"
          onClick={onClose}
        >
          {status === 'running' ? 'Close' : 'Done'}
        </button>
      </header>
      <div ref={containerRef} className="h-72 p-3" />
    </section>
  );
}
