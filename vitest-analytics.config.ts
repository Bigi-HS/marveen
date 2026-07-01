import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

const WT = '/home/domin/marveen-wt/analytics-oauth'

export default defineConfig({
  root: WT,
  test: {
    root: WT,
    include: [
      `${WT}/src/__tests__/analytics-scopes.test.ts`,
      `${WT}/src/__tests__/analytics-tokens.test.ts`,
      `${WT}/src/__tests__/analytics-youtube.test.ts`,
      `${WT}/src/__tests__/analytics-twitch.test.ts`,
      `${WT}/src/__tests__/analytics-index.test.ts`,
    ],
  },
})
