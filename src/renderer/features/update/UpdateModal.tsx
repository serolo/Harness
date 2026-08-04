import type { UpdateStatus } from '@shared/ipc';
import { Button, Dialog } from '@renderer/components/ui';

export interface UpdateModalProps {
  status: UpdateStatus;
  open: boolean;
  installing?: boolean;
  onClose: () => void;
  onRetry: () => void;
  onInstall: () => void;
}

function statusMessage(status: UpdateStatus, installing: boolean): string {
  if (installing) return 'Restarting Harness to install the update…';
  switch (status.state) {
    case 'idle':
    case 'checking':
      return 'Checking for updates…';
    case 'available':
      return 'An update is available and will download automatically.';
    case 'downloading':
      return 'Downloading the update…';
    case 'downloaded':
      return 'The update is ready. Restart Harness when convenient to install it.';
    case 'not-available':
      return 'Harness is up to date.';
    case 'unsupported':
      return (
        status.message ?? 'Automatic updates are unavailable in this build.'
      );
    case 'error':
      return status.message ?? 'Unable to check for updates.';
  }
}

/** Accessible, consent-driven application-update dialog. */
export function UpdateModal({
  status,
  open,
  installing = false,
  onClose,
  onRetry,
  onInstall,
}: UpdateModalProps): React.JSX.Element | null {
  if (!open) return null;

  const progress =
    status.state === 'downloading' && Number.isFinite(status.percent)
      ? Math.min(100, Math.max(0, status.percent ?? 0))
      : undefined;
  const retryable = status.state === 'error';
  const downloaded = status.state === 'downloaded';

  return (
    <Dialog
      title="Harness update"
      onClose={installing ? () => {} : onClose}
      data-testid="update-modal"
      footer={
        <>
          {retryable ? (
            <Button onClick={onRetry} disabled={installing}>
              Try again
            </Button>
          ) : null}
          <Button onClick={onClose} disabled={installing}>
            {downloaded ? 'Later' : 'Close'}
          </Button>
          {downloaded ? (
            <Button variant="primary" onClick={onInstall} disabled={installing}>
              {installing ? 'Restarting…' : 'Restart and update'}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="space-y-3 text-sm text-fg-2">
        <p role={status.state === 'error' ? 'alert' : 'status'}>
          {statusMessage(status, installing)}
        </p>
        {status.currentVersion || status.version ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            {status.currentVersion ? (
              <>
                <dt className="text-fg-3">Current version</dt>
                <dd className="text-fg-1">{status.currentVersion}</dd>
              </>
            ) : null}
            {status.version ? (
              <>
                <dt className="text-fg-3">Available version</dt>
                <dd className="text-fg-1">{status.version}</dd>
              </>
            ) : null}
          </dl>
        ) : null}
        {progress !== undefined ? (
          <div className="space-y-1">
            <div className="flex justify-between text-xs text-fg-3">
              <span>Download progress</span>
              <span>{Math.round(progress)}%</span>
            </div>
            <progress
              className="h-2 w-full accent-accent"
              max={100}
              value={progress}
              aria-label="Update download progress"
            />
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
