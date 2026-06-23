// Type declarations for browse.mjs (the runtime deliverable stays plain ESM JS;
// this lets the vitest suite import it under NodeNext + strict). Card 3d14e258.

export type BrowseMode = 'text' | 'screenshot'

export function parseArgs(argv: (string | undefined | null)[]): { url: string; mode: BrowseMode }

export function isBlockedHost(hostname: string): boolean

export function validateTargetUrl(rawUrl: string): URL

export interface BrowseOptions {
  url: string
  mode: BrowseMode
  launch?: () => Promise<unknown>
  outDir?: string
  stamp?: string
}

export function browse(opts: BrowseOptions): Promise<{ text: string; screenshotPath: string | null }>

export interface MainIo {
  launch?: () => Promise<unknown>
  outDir?: string
  stamp?: string
  out?: { write: (s: string) => void }
  err?: { write: (s: string) => void }
}

export function main(argv: string[], io?: MainIo): Promise<number>
