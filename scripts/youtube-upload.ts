#!/usr/bin/env tsx
// YouTube auto-upload CLI (card da367d95). Input = a finished video file + its
// metadata; output = an uploaded YouTube video (its id + watch URL on stdout).
// Mirrors the Claudia Google MCP own-OAuth pattern: a refresh token stored 0600
// under a channel dir mints a short-lived access token for the upload.
//
//   tsx scripts/youtube-upload.ts \
//     --video out/episode12.mp4 \
//     --metadata out/episode12.json            # {title, description, tags, categoryId, privacyStatus}
//   # or with inline flags (override the metadata file):
//   tsx scripts/youtube-upload.ts --video clip.mp4 --title "Clip" --privacy unlisted
//
// SAFE DEFAULT: privacyStatus = private. A video is NEVER published public unless
// you explicitly pass --privacy public (or set it in the metadata file).
//
// The bootstrap (one-time, Dominik at the browser) is scripts/youtube-oauth-authorize.ts.
import { readFile } from 'node:fs/promises'
import { resolve, basename } from 'node:path'
import { loadGoogleCreds, refreshAccessToken } from '../src/mcp/google-oauth.js'
import {
  uploadVideo,
  videoContentType,
  type VideoMetadata,
  type PrivacyStatus,
} from '../src/mcp/youtube-upload.js'

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined
}

const VIDEO = arg('--video')
const CHANNEL_DIR = resolve(arg('--channel-dir') ?? 'agents/big-ben/.claude/channels/youtube')
const META_FILE = arg('--metadata')

// Assemble the metadata: start from the optional --metadata JSON file, then let
// inline flags override individual fields. buildVideoResource (inside uploadVideo)
// validates the result, so we keep this purely about merging.
async function resolveMetadata(): Promise<VideoMetadata> {
  let base: Partial<VideoMetadata> = {}
  if (META_FILE) {
    const parsed = JSON.parse(await readFile(resolve(META_FILE), 'utf-8')) as Record<string, unknown>
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('--metadata file must contain a JSON object')
    }
    base = parsed as Partial<VideoMetadata>
  }
  const title = arg('--title') ?? base.title
  const description = arg('--description') ?? base.description
  const categoryId = arg('--category') ?? base.categoryId
  const privacyFlag = arg('--privacy') as PrivacyStatus | undefined
  const tagsFlag = arg('--tags')
  const tags = tagsFlag
    ? tagsFlag.split(',').map((t) => t.trim()).filter(Boolean)
    : base.tags
  return {
    title: title as string,
    description,
    tags,
    categoryId,
    privacyStatus: privacyFlag ?? base.privacyStatus,
  }
}

async function main(): Promise<void> {
  if (!VIDEO) {
    throw new Error('usage: youtube-upload.ts --video <path> [--metadata <json>] [--title ...] [--privacy private|unlisted|public]')
  }
  const videoPath = resolve(VIDEO)
  const meta = await resolveMetadata()
  const bytes = new Uint8Array(await readFile(videoPath))
  const contentType = arg('--content-type') ?? videoContentType(videoPath)

  const creds = await loadGoogleCreds(CHANNEL_DIR)
  const access = await refreshAccessToken(creds, Date.now())

  console.error(
    `[youtube-upload] uploading ${basename(videoPath)} (${bytes.length} bytes, ${contentType}), ` +
      `privacy=${meta.privacyStatus ?? 'private'} ...`,
  )
  const videoId = await uploadVideo(access.token, meta, { bytes, contentType })

  // stdout = the result (id + URL), so callers can capture it; logs go to stderr.
  console.log(videoId)
  console.log(`https://youtu.be/${videoId}`)
  console.error(`[youtube-upload] done: https://youtu.be/${videoId}`)
}

main().catch((err) => {
  console.error('[youtube-upload] failed:', err?.message ?? err)
  process.exit(1)
})
