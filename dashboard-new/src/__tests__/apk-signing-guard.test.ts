import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// vitest cwd == dashboard-new root
const GRADLE = resolve(process.cwd(), 'src-tauri/gen/android/app/build.gradle.kts')
const ROOT_GITIGNORE = resolve(process.cwd(), '..', '.gitignore')

function read(p: string): string {
  return readFileSync(p, 'utf-8')
}

describe('APK release signing guard (Chad #968 follow-up)', () => {
  const gradle = read(GRADLE)

  it('reads all four signing env vars', () => {
    expect(gradle).toContain('ANDROID_KEYSTORE_PATH')
    expect(gradle).toContain('ANDROID_KEYSTORE_PASS')
    expect(gradle).toContain('ANDROID_KEY_ALIAS')
    expect(gradle).toContain('ANDROID_KEY_PASS')
  })

  it('fails closed when keystore path is set but a credential is missing', () => {
    // If ANDROID_KEYSTORE_PATH is present the build must not silently proceed
    // with null passwords/alias -- it must throw a clear error naming the gap.
    expect(gradle).toContain('GradleException')
    // the error must reference the missing credentials, not just the path
    expect(gradle).toMatch(/missing/i)
  })
})

describe('APK build artifacts are gitignored (Chad #968 follow-up)', () => {
  it('root .gitignore ignores the out/ build-output dir', () => {
    const ignore = read(ROOT_GITIGNORE)
    const ignoresOut = ignore
      .split('\n')
      .map((l) => l.trim())
      .some((l) => l === 'out/' || l === '/out/' || l === 'out' || l === '/out')
    expect(ignoresOut).toBe(true)
  })
})
