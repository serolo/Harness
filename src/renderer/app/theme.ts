// Renderer theme tokens.
//
// These are plain TS mirrors of the CSS custom properties in
// `src/renderer/styles/tokens/colors.css` (the design-system source of truth), for the
// few call sites that need a literal color value in JS rather than a Tailwind class or
// `var()` — e.g. `useTerminal.ts`'s xterm theme, which paints via canvas/WebGL and can't
// read CSS variables. Tailwind utility classes (mapped in `tailwind.config.js`) remain
// the primary styling mechanism; keep these values in sync with `tokens/colors.css` by
// hand at this small size.

/** Named color tokens for the dark shell chrome (mirrors `tokens/colors.css` `:root`). */
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
  /** IPC-health OK / status "running". */
  ok: '#3fb960',
  /** IPC-health error / status "attention". */
  error: '#f0565f',
  /** IPC-health pending / status "working". */
  pending: '#d9a13c',
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
