import type { Breadcrumb, ErrorEvent } from '@sentry/electron/main';

import { sanitizeSensitiveText } from '../security/sanitize-error';

export type TelemetryEvent =
  | 'app launched'
  | 'onboarding completed'
  | 'project added'
  | 'workspace created'
  | 'workspace archived'
  | 'workspace restored'
  | 'turn started'
  | 'turn completed'
  | 'terminal started'
  | 'diff opened'
  | 'checks completed'
  | 'pull request opened';

export type TelemetryProperties = Readonly<
  Record<string, string | number | boolean | undefined>
>;

const EVENT_PROPERTIES: Record<TelemetryEvent, readonly string[]> = {
  'app launched': [],
  'onboarding completed': ['github_connected', 'harness_ready'],
  'project added': [],
  'workspace created': ['harness'],
  'workspace archived': [],
  'workspace restored': [],
  'turn started': ['harness', 'mode'],
  'turn completed': ['harness', 'mode', 'outcome', 'duration_ms'],
  'terminal started': [],
  'diff opened': ['file_count'],
  'checks completed': ['status'],
  'pull request opened': ['draft'],
};

export function allowlistedProperties(
  event: TelemetryEvent,
  properties: TelemetryProperties,
): Record<string, string | number | boolean> {
  const allowed = new Set(EVENT_PROPERTIES[event]);
  const output: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!allowed.has(key) || value === undefined) continue;
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      output[key] = value;
    }
  }
  return output;
}

/** Keep only diagnostic stack data and non-identifying runtime tags. */
export function scrubSentryEvent(event: ErrorEvent): ErrorEvent {
  const next: ErrorEvent = {
    type: event.type,
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: event.platform,
    level: event.level,
    logger: event.logger,
    release: event.release,
    environment: event.environment,
    exception: event.exception
      ? {
          values: event.exception.values?.map((value) => ({
            ...value,
            value:
              typeof value.value === 'string'
                ? sanitizeSensitiveText(value.value, 1_024)
                : value.value,
            stacktrace: value.stacktrace
              ? {
                  ...value.stacktrace,
                  frames: value.stacktrace.frames?.map((frame) => ({
                    ...frame,
                    filename:
                      typeof frame.filename === 'string'
                        ? sanitizeSensitiveText(frame.filename, 512)
                        : frame.filename,
                    abs_path: undefined,
                    vars: undefined,
                    context_line: undefined,
                    pre_context: undefined,
                    post_context: undefined,
                  })),
                }
              : undefined,
          })),
        }
      : undefined,
    message:
      typeof event.message === 'string'
        ? sanitizeSensitiveText(event.message, 512)
        : event.message,
    tags: pickTags(event.tags),
  };
  return next;
}

function pickTags(
  tags: ErrorEvent['tags'],
): Record<string, string | number | boolean> | undefined {
  if (!tags) return undefined;
  const output: Record<string, string | number | boolean> = {};
  for (const key of [
    'app_version',
    'os',
    'arch',
    'process_type',
    'error_category',
  ]) {
    const value = tags[key];
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      output[key] = value;
    }
  }
  return Object.keys(output).length === 0 ? undefined : output;
}

export function filterSentryBreadcrumb(
  breadcrumb: Breadcrumb,
): Breadcrumb | null {
  if (breadcrumb.category !== 'telemetry.lifecycle') return null;
  return {
    category: breadcrumb.category,
    level: breadcrumb.level,
    timestamp: breadcrumb.timestamp,
    message:
      typeof breadcrumb.message === 'string'
        ? sanitizeSensitiveText(breadcrumb.message, 128)
        : undefined,
  };
}
