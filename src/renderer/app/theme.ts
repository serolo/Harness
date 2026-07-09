// Renderer theme tokens (Phase 0 — minimal scaffolding).
//
// These are the design primitives the shell renders against. They are kept as plain
// TS objects (not Tailwind config) so components can read them at runtime for inline
// styles where a utility class doesn't fit, and so `providers.tsx` can publish the
// active theme through React context. Tailwind utility classes remain the primary
// styling mechanism (see index.css); this is the shared source of a few named tokens.
//
// Later phases (esp. Phase 6 "Config, Settings UI, Polish") may promote these into
// CSS variables / a full design system. For now: minimal, real, and typed.

/** Named color tokens for the dark shell chrome. */
export const colors = {
  /** App background (outermost). */
  bg: '#0b0e14',
  /** Slightly raised surface — sidebar rail, panels. */
  surface: '#11151f',
  /** Panel border / divider hairline. */
  border: '#1e2430',
  /** Primary text. */
  text: '#e6e9ef',
  /** Muted / secondary text. */
  textMuted: '#8b93a7',
  /** Accent (interactive) color. */
  accent: '#5b8cff',
  /** IPC-health OK. */
  ok: '#3fb950',
  /** IPC-health error. */
  error: '#f85149',
  /** IPC-health pending. */
  pending: '#d29922',
} as const;

/** Spacing scale (px). Deliberately small — extend in Phase 6. */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;

/** The full theme object published through React context (see providers.tsx). */
export interface Theme {
  colors: typeof colors;
  spacing: typeof spacing;
}

/** The single default theme for Phase 0. */
export const theme: Theme = { colors, spacing };
