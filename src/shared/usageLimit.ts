// FROZEN CONTRACT (src/shared/** is append-only for later phases — README §5.2).
//
// Phase 12 — usage-limit message parser. PURE + import-safe from both processes (no
// Node/DOM/electron). Detects the CLI's "usage limit reached" error message and, when
// possible, extracts the reset time so the chat can offer to schedule a resume turn.
//
// CONSERVATIVE BY DESIGN: there is NO fixture of the real CLI limit message in the repo
// (design doc §3.3 / §11 — capture one when first seen in the wild), so this parser
// fails toward "offer without a prefilled time" (`{ resetsAt: null }`) rather than a
// false positive. It returns `null` for anything that is not clearly a usage-limit error
// (e.g. GitHub "rate limit" wording, generic errors, the bare word "usage").

export interface UsageLimitInfo {
  /** Epoch millis of the reset, or null when a limit was detected but the time is unknown. */
  resetsAt: number | null;
}

/** Pipe form: `Claude AI usage limit reached|<epoch>` (seconds or millis). */
const PIPE_EPOCH = /usage limit reached\s*\|\s*(\d{9,13})/i;

/** Textual form: `… usage limit reached … resets at 5pm` / `resets 05:00`. */
const TEXT_RESETS =
  /usage limit reached[\s\S]*?resets\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;

/** Bare detection: the message mentions a usage limit but carries no parseable time. */
const BARE = /usage limit reached/i;

/** Below this an epoch is seconds, not millis (≈ Sat 2001 in ms / year 33658 in s). */
const EPOCH_SECONDS_CUTOFF = 1e12;

/**
 * Parse an agent error `message`. Returns `UsageLimitInfo` when the message is a
 * usage-limit error (with `resetsAt` when a reset time could be extracted, else `null`),
 * or `null` when the message is NOT a usage-limit error at all.
 *
 * @param now Injectable clock (epoch millis) used to resolve a wall-clock "resets at
 *   HH[:MM]" to the next such instant; defaults to `Date.now()`.
 */
export function parseUsageLimitMessage(
  message: string,
  now: number = Date.now(),
): UsageLimitInfo | null {
  if (typeof message !== 'string' || message.length === 0) {
    return null;
  }

  // 1) Primary: an explicit epoch after a pipe. Normalize seconds → millis.
  const pipe = PIPE_EPOCH.exec(message);
  if (pipe) {
    const raw = Number.parseInt(pipe[1], 10);
    if (Number.isFinite(raw) && raw > 0) {
      const resetsAt = raw < EPOCH_SECONDS_CUTOFF ? raw * 1000 : raw;
      return { resetsAt };
    }
  }

  // 2) Secondary: a textual wall-clock time → the NEXT occurrence of it (today/tomorrow).
  const text = TEXT_RESETS.exec(message);
  if (text) {
    const resetsAt = nextWallClock(text[1], text[2], text[3], now);
    return { resetsAt };
  }

  // 3) Fallback: a bare limit message with no parseable time → offer without a time.
  if (BARE.test(message)) {
    return { resetsAt: null };
  }

  // 4) Not a usage-limit error.
  return null;
}

/**
 * Resolve a wall-clock time (local) to the next epoch-millis instant at or after `now`.
 * Returns `null` if the parsed components are out of range (so the offer degrades to "no
 * prefilled time" rather than a bogus timestamp).
 */
function nextWallClock(
  hourStr: string,
  minuteStr: string | undefined,
  meridiem: string | undefined,
  now: number,
): number | null {
  let hour = Number.parseInt(hourStr, 10);
  const minute = minuteStr !== undefined ? Number.parseInt(minuteStr, 10) : 0;
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (minute < 0 || minute > 59) return null;

  const mer = meridiem?.toLowerCase();
  if (mer === 'am' || mer === 'pm') {
    if (hour < 1 || hour > 12) return null;
    if (mer === 'pm' && hour !== 12) hour += 12;
    if (mer === 'am' && hour === 12) hour = 0;
  } else if (hour < 0 || hour > 23) {
    return null;
  }

  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);
  let ms = candidate.getTime();
  if (ms < now) {
    ms += 24 * 60 * 60 * 1000; // already passed today → tomorrow
  }
  return ms;
}
