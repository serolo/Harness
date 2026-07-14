/** @type {import('tailwindcss').Config} */
// Content globs already cover every file this task touches (src/renderer/**/*.{ts,tsx} +
// index.html), so no glob change was needed.
//
// Every entry below maps a Tailwind utility name onto a CSS custom property defined in
// `src/renderer/styles/tokens/*.css` (imported once from `index.css`, ahead of the Tailwind
// directives). This is the Harness design system import: components keep authoring with
// `className` — e.g. `bg-surface-panel`, `text-fg-2`, `border-border-1`, `rounded-3`,
// `shadow-2`, `duration-fast` — and the actual values live in one CSS layer that also powers
// light/dark (`[data-theme="light"]`) without touching component code. Keep new tokens here
// in sync with the `tokens/*.css` source of truth by hand (same discipline `theme.ts` used).
export default {
  content: ['./src/renderer/index.html', './src/renderer/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Base ramp
        'bg-0': 'var(--bg-0)',
        'bg-1': 'var(--bg-1)',
        'bg-2': 'var(--bg-2)',
        'bg-3': 'var(--bg-3)',
        'bg-4': 'var(--bg-4)',
        'border-1': 'var(--border-1)',
        'border-2': 'var(--border-2)',
        'fg-1': 'var(--fg-1)',
        'fg-2': 'var(--fg-2)',
        'fg-3': 'var(--fg-3)',
        'fg-disabled': 'var(--fg-disabled)',

        // Accent
        accent: {
          DEFAULT: 'var(--accent)',
          hover: 'var(--accent-hover)',
          active: 'var(--accent-active)',
          fg: 'var(--accent-fg)',
          muted: 'var(--accent-muted)',
          border: 'var(--accent-border)',
        },

        // Workspace / check status
        status: {
          idle: 'var(--status-idle)',
          working: 'var(--status-working)',
          attention: 'var(--status-attention)',
          running: 'var(--status-running)',
          archived: 'var(--status-archived)',
        },

        // Semantic
        ok: { DEFAULT: 'var(--ok)', muted: 'var(--ok-muted)' },
        warn: { DEFAULT: 'var(--warn)', muted: 'var(--warn-muted)' },
        danger: {
          DEFAULT: 'var(--danger)',
          hover: 'var(--danger-hover)',
          muted: 'var(--danger-muted)',
        },
        info: { DEFAULT: 'var(--info)', muted: 'var(--info-muted)' },

        // Diff
        diff: {
          'add-bg': 'var(--diff-add-bg)',
          'add-accent': 'var(--diff-add-accent)',
          'del-bg': 'var(--diff-del-bg)',
          'del-accent': 'var(--diff-del-accent)',
          'hunk-bg': 'var(--diff-hunk-bg)',
        },

        // Semantic aliases
        'surface-app': 'var(--surface-app)',
        'surface-panel': 'var(--surface-panel)',
        'surface-card': 'var(--surface-card)',
        'surface-well': 'var(--surface-well)',
        'surface-overlay': 'var(--surface-overlay)',
        scrim: 'var(--scrim)',
        link: { DEFAULT: 'var(--link)', hover: 'var(--link-hover)' },
        'focus-ring': 'var(--focus-ring)',
        'selection-bg': 'var(--selection-bg)',
        'chat-user': 'var(--chat-user-bg)',
      },
      fontFamily: {
        ui: 'var(--font-ui)',
        display: 'var(--font-display)',
        mono: 'var(--font-mono)',
      },
      fontSize: {
        '2xs': ['var(--text-2xs)', { lineHeight: 'var(--leading-tight)' }],
        xs: ['var(--text-xs)', { lineHeight: 'var(--leading-tight)' }],
        sm: ['var(--text-sm)', { lineHeight: 'var(--leading-normal)' }],
        base: ['var(--text-base)', { lineHeight: 'var(--leading-normal)' }],
        md: ['var(--text-md)', { lineHeight: 'var(--leading-normal)' }],
        lg: ['var(--text-lg)', { lineHeight: 'var(--leading-tight)' }],
        xl: ['var(--text-xl)', { lineHeight: 'var(--leading-tight)' }],
        '2xl': ['var(--text-2xl)', { lineHeight: 'var(--leading-tight)' }],
      },
      letterSpacing: {
        caps: 'var(--tracking-caps)',
      },
      borderRadius: {
        1: 'var(--radius-1)',
        2: 'var(--radius-2)',
        3: 'var(--radius-3)',
        4: 'var(--radius-4)',
        5: 'var(--radius-5)',
      },
      boxShadow: {
        1: 'var(--shadow-1)',
        2: 'var(--shadow-2)',
        3: 'var(--shadow-3)',
        4: 'var(--shadow-4)',
      },
      transitionDuration: {
        fast: 'var(--duration-fast)',
        base: 'var(--duration-base)',
        slow: 'var(--duration-slow)',
      },
      transitionTimingFunction: {
        out: 'var(--ease-out)',
        'in-out': 'var(--ease-in-out)',
      },
      width: {
        sidebar: 'var(--sidebar-width)',
        context: 'var(--context-width)',
      },
      height: {
        titlebar: 'var(--titlebar-height)',
        control: 'var(--control-height)',
        'control-lg': 'var(--control-height-lg)',
      },
    },
  },
  plugins: [],
};
