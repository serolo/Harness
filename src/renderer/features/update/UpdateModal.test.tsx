import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  onEvent: vi.fn(),
}));

vi.mock('@renderer/ipc', () => ipc);

import type { UpdateStatus } from '@shared/ipc';
import { UpdateModal } from './UpdateModal';
import { useAppUpdate } from './useAppUpdate';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function ControllerHarness(): React.JSX.Element {
  const controller = useAppUpdate();
  return (
    <>
      <button
        type="button"
        data-testid="manual-check"
        onClick={() => void controller.manualCheck()}
      >
        Manual check
      </button>
      <UpdateModal
        status={controller.status}
        open={controller.open}
        installing={controller.installing}
        onClose={controller.close}
        onRetry={() => void controller.manualCheck()}
        onInstall={() => void controller.install()}
      />
    </>
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('UpdateModal', () => {
  it('renders versions and clamps progress at the UI boundary', () => {
    render(
      <UpdateModal
        open
        status={{
          state: 'downloading',
          currentVersion: '1.0.0',
          version: '1.1.0',
          percent: 180,
        }}
        onClose={vi.fn()}
        onRetry={vi.fn()}
        onInstall={vi.fn()}
      />,
    );

    expect(screen.getByText('1.0.0')).toBeInTheDocument();
    expect(screen.getByText('1.1.0')).toBeInTheDocument();
    expect(screen.getByText('100%')).toBeInTheDocument();
    expect(screen.getByLabelText('Update download progress')).toHaveValue(100);
    expect(
      screen.queryByRole('button', { name: 'Restart and update' }),
    ).not.toBeInTheDocument();
  });

  it('offers Later and an idempotent disabled install action only when downloaded', () => {
    const onClose = vi.fn();
    const onInstall = vi.fn();
    const { rerender } = render(
      <UpdateModal
        open
        status={{ state: 'downloaded', version: '1.1.0' }}
        onClose={onClose}
        onRetry={vi.fn()}
        onInstall={onInstall}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restart and update' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onInstall).toHaveBeenCalledTimes(1);

    rerender(
      <UpdateModal
        open
        installing
        status={{ state: 'downloaded', version: '1.1.0' }}
        onClose={onClose}
        onRetry={vi.fn()}
        onInstall={onInstall}
      />,
    );
    expect(screen.getByRole('button', { name: 'Restarting…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Later' })).toBeDisabled();
    expect(screen.getByText(/Restarting Harness/)).toBeInTheDocument();
  });

  it('shows retry for recoverable errors and invokes it', () => {
    const onRetry = vi.fn();
    render(
      <UpdateModal
        open
        status={{ state: 'error', message: 'Feed unavailable' }}
        onClose={vi.fn()}
        onRetry={onRetry}
        onInstall={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Feed unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ state: 'checking' } as UpdateStatus, 'Checking for updates…'],
    [{ state: 'not-available' } as UpdateStatus, 'Harness is up to date.'],
    [
      {
        state: 'unsupported',
        message: 'Use a signed release build.',
      } as UpdateStatus,
      'Use a signed release build.',
    ],
  ])('renders the manual result state %#', (status, message) => {
    render(
      <UpdateModal
        open
        status={status}
        onClose={vi.fn()}
        onRetry={vi.fn()}
        onInstall={vi.fn()}
      />,
    );
    expect(screen.getByText(message)).toBeInTheDocument();
  });
});

describe('useAppUpdate controller', () => {
  it('subscribes before hydration, preserves a newer event, and auto-opens a download only once', async () => {
    const hydration = deferred<UpdateStatus>();
    let listener: ((status: UpdateStatus) => void) | undefined;
    const unsubscribe = vi.fn();
    const order: string[] = [];
    ipc.onEvent.mockImplementation(
      (_event: string, callback: (status: UpdateStatus) => void) => {
        order.push('subscribe');
        listener = callback;
        return unsubscribe;
      },
    );
    ipc.invoke.mockImplementation((channel: string) => {
      order.push(channel);
      return hydration.promise;
    });

    const mounted = render(<ControllerHarness />);
    expect(order.slice(0, 2)).toEqual(['subscribe', 'update:getStatus']);
    expect(screen.queryByTestId('update-modal')).not.toBeInTheDocument();

    act(() => listener?.({ state: 'downloaded', version: '1.1.0' }));
    expect(await screen.findByTestId('update-modal')).toBeInTheDocument();
    expect(screen.getByText('1.1.0')).toBeInTheDocument();

    await act(async () => {
      hydration.resolve({ state: 'not-available' });
      await hydration.promise;
    });
    expect(screen.getByText('1.1.0')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(screen.queryByTestId('update-modal')).not.toBeInTheDocument();
    act(() => listener?.({ state: 'downloaded', version: '1.1.0' }));
    expect(screen.queryByTestId('update-modal')).not.toBeInTheDocument();

    mounted.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('keeps automatic no-update and error transitions silent', async () => {
    let listener: ((status: UpdateStatus) => void) | undefined;
    ipc.onEvent.mockImplementation(
      (_event: string, callback: (status: UpdateStatus) => void) => {
        listener = callback;
        return vi.fn();
      },
    );
    ipc.invoke.mockResolvedValue({ state: 'idle' });
    render(<ControllerHarness />);
    await waitFor(() =>
      expect(ipc.invoke).toHaveBeenCalledWith('update:getStatus', undefined),
    );

    act(() => listener?.({ state: 'not-available' }));
    expect(screen.queryByTestId('update-modal')).not.toBeInTheDocument();
    act(() => listener?.({ state: 'error', message: 'offline' }));
    expect(screen.queryByTestId('update-modal')).not.toBeInTheDocument();
  });

  it('opens immediately for a manual check and supports retry after failure', async () => {
    ipc.onEvent.mockReturnValue(vi.fn());
    let attempts = 0;
    ipc.invoke.mockImplementation((channel: string) => {
      if (channel === 'update:getStatus') {
        return Promise.resolve({ state: 'idle' });
      }
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error('offline'))
        : Promise.resolve({ state: 'not-available' });
    });
    render(<ControllerHarness />);
    await waitFor(() =>
      expect(ipc.invoke).toHaveBeenCalledWith('update:getStatus', undefined),
    );

    fireEvent.click(screen.getByTestId('manual-check'));
    expect(screen.getByTestId('update-modal')).toBeInTheDocument();
    expect(screen.getByText('Checking for updates…')).toBeInTheDocument();
    expect(
      await screen.findByText(
        'Unable to check for updates. Please try again later.',
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByText('Harness is up to date.'),
    ).toBeInTheDocument();
    expect(ipc.invoke).toHaveBeenCalledTimes(3);
  });

  it('allows only one install request while restart is in progress', async () => {
    const install = deferred<void>();
    ipc.onEvent.mockReturnValue(vi.fn());
    ipc.invoke.mockImplementation((channel: string) => {
      if (channel === 'update:getStatus') {
        return Promise.resolve({ state: 'idle' });
      }
      if (channel === 'update:check') {
        return Promise.resolve({ state: 'downloaded', version: '1.1.0' });
      }
      if (channel === 'update:install') return install.promise;
      return Promise.reject(new Error(`Unexpected channel: ${channel}`));
    });
    render(<ControllerHarness />);
    await waitFor(() =>
      expect(ipc.invoke).toHaveBeenCalledWith('update:getStatus', undefined),
    );

    fireEvent.click(screen.getByTestId('manual-check'));
    const restart = await screen.findByRole('button', {
      name: 'Restart and update',
    });
    fireEvent.click(restart);
    fireEvent.click(restart);

    expect(
      ipc.invoke.mock.calls.filter(([c]) => c === 'update:install'),
    ).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Restarting…' })).toBeDisabled();

    await act(async () => {
      install.resolve();
      await install.promise;
    });
  });
});
