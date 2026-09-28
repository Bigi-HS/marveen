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
      // Approved v6 design fonts (store/dashboard-design-system.md): Inter for UI,
      // JetBrains Mono for data (ids, timestamps, counts). Self-hosted via @fontsource
      // (src/fonts.css) -- no third-party font CDN.
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
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
        // card 8c823cdc: Boss-spec work-status KOR colors
        work: {
          working: 'var(--work-working)',
          received: 'var(--work-received)',
          error: 'var(--work-error)',
        },
      },
      boxShadow: {
        glow: '0 0 12px 0 var(--accent-glow)',
      },
      animation: {
        // card 8c823cdc: WORKING state blink (purple, reduced-motion: static)
        blink: 'blink 1.2s ease-in-out infinite',
      },
      keyframes: {
        blink: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.15' },
        },
      },
    },
  },
  plugins: [],
}

export default config
