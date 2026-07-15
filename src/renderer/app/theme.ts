// Renderer theme tokens.
//
// These are plain TS mirrors of the CSS custom properties in
// `src/renderer/styles/tokens/colors.css` (the design-system source of truth), for the
// few call sites that need a literal color value in JS rather than a Tailwind class or
// `var()` — e.g. `useTerminal.ts`'s xterm theme, which paints via canvas/WebGL and can't
// read CSS variables. Tailwind utility classes (mapped in `tailwind.config.js`) remain
// the primary styling mechanism; keep these values in sync with `tokens/colors.css` by
// hand at this small size.

import type { AppearanceTheme } from '@shared/settings';

/** Named color tokens for the dark shell chrome (mirrors `tokens/colors.css` `:root`). */
export const darkColors = {
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

/** Named color tokens for the light shell chrome (mirrors `tokens/colors.css` `[data-theme='light']`). */
export const lightColors = {
  /** App background (outermost). */
  bg: '#f5f6f8',
  /** Slightly raised surface — sidebar rail, panels. */
  surface: '#ffffff',
  /** Panel border / divider hairline. */
  border: '#e4e7ed',
  /** Primary text. */
  text: '#1b202b',
  /** Muted / secondary text. */
  textMuted: '#5d6575',
  /** Accent (interactive) color. */
  accent: '#3d6ee8',
  /** IPC-health OK / status "running". */
  ok: '#1f9d4d',
  /** IPC-health error / status "attention". */
  error: '#d63a44',
  /** IPC-health pending / status "working". */
  pending: '#b57d17',
} as const;

export const colors = darkColors;

type ColorTokens = Record<keyof typeof darkColors, string>;

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
  colors: ColorTokens;
  spacing: typeof spacing;
  appearance: AppearanceTheme;
}

export const themes: Record<AppearanceTheme, Theme> = {
  dark: { colors: darkColors, spacing, appearance: 'dark' },
  light: { colors: lightColors, spacing, appearance: 'light' },
};

/** The default theme. */
export const theme: Theme = themes.dark;
