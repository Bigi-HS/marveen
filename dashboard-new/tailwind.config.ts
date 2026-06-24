import type { Config } from 'tailwindcss'

// AC-T3: the palette (store/dashboard-palette-noa.md) is exposed as Tailwind colour
// keys so components write `className="bg-bg-deep text-primary"`, never inline hex.
// Every value resolves to a CSS custom property defined in styles/tokens.css -- the
// single source of the literal hex. This config holds NO hex (keeps the DoD hex-grep
// on src/ clean and makes tokens.css the one place a colour value lives).
const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        'bg-deep': 'var(--bg-deep)',
        'bg-surface': 'var(--bg-surface)',
        'bg-elevated': 'var(--bg-elevated)',
        border: 'var(--border)',
        primary: {
          DEFAULT: 'var(--primary)',
          hover: 'var(--primary-hover)',
          press: 'var(--primary-press)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          glow: 'var(--accent-glow)',
        },
        neutral: 'var(--neutral)',
        text: {
          DEFAULT: 'var(--text)',
          muted: 'var(--text-muted)',
        },
        status: {
          planned: 'var(--status-planned)',
          'in-progress': 'var(--status-in-progress)',
          waiting: 'var(--status-waiting)',
          done: 'var(--status-done)',
        },
      },
      boxShadow: {
        glow: '0 0 12px 0 var(--accent-glow)',
      },
    },
  },
  plugins: [],
}

export default config
