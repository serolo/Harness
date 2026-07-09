/** @type {import('tailwindcss').Config} */
// Content globs already cover every file Task 8 (app shell) creates
// (src/renderer/**/*.{ts,tsx} + index.html), so no glob change was needed.
// Task 8 extends the theme with the named tokens from src/renderer/app/theme.ts so
// they are available as Tailwind utilities (e.g. `bg-app`, `text-ok`) alongside the
// default palette the shell also uses. Keep these in sync with theme.ts by hand at
// this small size; Phase 6 can unify via CSS variables.
export default {
  content: ['./src/renderer/index.html', './src/renderer/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        app: '#0b0e14',
        surface: '#11151f',
        ok: '#3fb950',
        pending: '#d29922',
      },
    },
  },
  plugins: [],
};
