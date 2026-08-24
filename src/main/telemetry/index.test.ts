import { describe, expect, it } from 'vitest';

import {
  allowlistedProperties,
  filterSentryBreadcrumb,
  scrubSentryEvent,
} from './policy';

describe('telemetry privacy boundary', () => {
  it('drops properties not explicitly allowed for an event', () => {
    expect(
      allowlistedProperties('turn completed', {
        harness: 'codex',
        mode: 'default',
        outcome: 'completed',
        duration_ms: 123,
        prompt: 'private prompt',
        repo_path: '/Users/person/secret',
      }),
    ).toEqual({
      harness: 'codex',
      mode: 'default',
      outcome: 'completed',
      duration_ms: 123,
    });
  });

  it('removes Sentry request, user, extras, contexts, and unsafe breadcrumbs', () => {
    const scrubbed = scrubSentryEvent({
      type: undefined,
      event_id: 'event-id',
      message: 'failed at /Users/person/private/repo token=secret',
      request: { url: 'https://example.test/private' },
      user: { email: 'person@example.test' },
      extra: { prompt: 'secret prompt' },
      contexts: { repo: { path: '/Users/person/private/repo' } },
      breadcrumbs: [{ category: 'ipc', message: 'prompt text' }],
      tags: {
        app_version: '1.2.3',
        os: 'darwin',
        workspace_id: 'private-id',
      },
    });

    expect(scrubbed.message).toBe('failed at [private path] token=[redacted]');
    expect(scrubbed.request).toBeUndefined();
    expect(scrubbed.user).toBeUndefined();
    expect(scrubbed.extra).toBeUndefined();
    expect(scrubbed.contexts).toBeUndefined();
    expect(scrubbed.breadcrumbs).toBeUndefined();
    expect(scrubbed.tags).toEqual({ app_version: '1.2.3', os: 'darwin' });
    expect(filterSentryBreadcrumb({ category: 'ipc' })).toBeNull();
  });
});
