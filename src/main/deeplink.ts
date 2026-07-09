// Deep-link resolver (Phase 6, Task E1 / spec §5.8).
//
// Parses an incoming `harness://…` URL into a `DeepLinkTarget` the renderer's nav
// store can act on. The app currently emits `harness://workspace/<id>` (notification
// click-through, `notifications.ts`); this also accepts an optional trailing pane
// (`/diff` | `/pr`) so a link can deep-link straight to a workspace pane.
//
// Parsing is deliberately hand-rolled (not `new URL`) so the accepted grammar is
// explicit and total: anything that isn't a recognised route returns `null` rather
// than throwing or guessing. Untrusted input (an OS-delivered URL) — reject, don't
// interpolate.

import type { DeepLinkTarget } from '@shared/ipc';

/** The registered protocol scheme (mirrors `DEEP_LINK_SCHEME` in index.ts). */
const SCHEME_PREFIX = 'harness://';

/** The panes a deep link may target within a workspace. */
const PANES = new Set(['diff', 'pr']);

/**
 * Resolve an `harness://workspace/<id>[/diff|/pr]` URL into a nav target, or `null`
 * for anything unroutable (wrong scheme/host, missing id, unknown pane, extra path
 * segments). Query strings and fragments are ignored.
 */
export function resolveDeepLink(url: string): DeepLinkTarget | null {
  if (!url.startsWith(SCHEME_PREFIX)) return null;

  // Everything after the scheme, minus any query/fragment.
  const path = url.slice(SCHEME_PREFIX.length).split(/[?#]/)[0] ?? '';
  const segments = path.split('/').filter((s) => s !== '');

  // Grammar: workspace / <id> [ / pane ]  — 2 or 3 segments, host must be `workspace`.
  if (segments[0] !== 'workspace') return null;
  if (segments.length < 2 || segments.length > 3) return null;

  const workspaceId = decodeSegment(segments[1]!);
  if (workspaceId === null || workspaceId === '') return null;

  if (segments.length === 2) return { workspaceId };

  const pane = segments[2]!;
  if (!PANES.has(pane)) return null;
  return { workspaceId, pane: pane as DeepLinkTarget['pane'] };
}

/** Decode one percent-encoded segment, returning null on malformed encoding. */
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}
