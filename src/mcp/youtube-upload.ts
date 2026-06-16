// YouTube Data API v3 resumable upload (card da367d95).
//
// Mirrors the Claudia Google MCP own-OAuth pattern: a long-lived refresh token
// (written once by scripts/youtube-oauth-authorize.ts, stored 0600 under a
// channel dir, gitignored) mints short-lived access tokens via the shared
// google-oauth.ts helpers. This module is the testable core: a pure resumable
// upload that takes an access token + media bytes and returns the new video id.
//
// Egress: this module talks ONLY to *.googleapis.com (the resumable init URL and
// the session URI Google hands back, which is also under googleapis.com).
//
// Scope: youtube.upload only (insert/upload). It deliberately does NOT request a
// read/manage scope -- the script can publish a video, nothing else.

// Single hardcoded scope; no runtime config can widen it (mirrors SCOPES in
// google-authorize.ts).
export const YOUTUBE_UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload'

// Resumable upload session init endpoint. part=snippet,status: we set the title/
// description/tags/category (snippet) and the privacy (status).
export const YOUTUBE_RESUMABLE_INIT_URL =
  'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status'

export type PrivacyStatus = 'private' | 'unlisted' | 'public'

const PRIVACY_VALUES: readonly PrivacyStatus[] = ['private', 'unlisted', 'public']

export interface VideoMetadata {
  title: string
  description?: string
  tags?: string[]
  // YouTube video category id. '22' = People & Blogs (a safe generic default).
  categoryId?: string
  // SAFE DEFAULT = 'private'. An upload never goes public unless the caller
  // explicitly asks: a bug or a prompt-injected metadata blob cannot publish.
  privacyStatus?: PrivacyStatus
}

export interface MediaSource {
  bytes: Uint8Array
  // e.g. 'video/mp4', 'video/quicktime'
  contentType: string
}

// A fetch shape rich enough for the resumable flow: it must expose the response
// `Location` header (the session URI) and accept a binary body. Node 20's global
// `fetch` satisfies this; tests inject a stub.
export type UploadFetch = (
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    body: string | Uint8Array
  },
) => Promise<{
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  json: () => Promise<unknown>
  text: () => Promise<string>
}>

const realFetch = fetch as unknown as UploadFetch

// Build the videos.insert request body, validating the metadata. Throws on a
// missing title or an invalid privacyStatus so a malformed metadata file fails
// loudly before any network call.
export function buildVideoResource(meta: VideoMetadata): {
  snippet: { title: string; description: string; tags: string[]; categoryId: string }
  status: { privacyStatus: PrivacyStatus }
} {
  const title = (meta.title ?? '').trim()
  if (!title) {
    throw new Error('youtube upload: metadata.title is required and must be non-empty')
  }
  const privacyStatus = meta.privacyStatus ?? 'private'
  if (!PRIVACY_VALUES.includes(privacyStatus)) {
    throw new Error(
      `youtube upload: invalid privacyStatus ${JSON.stringify(privacyStatus)} ` +
        `(expected one of ${PRIVACY_VALUES.join(', ')})`,
    )
  }
  return {
    snippet: {
      title,
      description: meta.description ?? '',
      tags: meta.tags ?? [],
      categoryId: meta.categoryId ?? '22',
    },
    status: { privacyStatus },
  }
}

// Resumable upload: (1) POST the metadata to open a session and read the session
// URI from the Location header, (2) PUT the bytes to that URI. Returns the new
// video id. `now`-free and dependency-injected so it is fully unit-testable.
export async function uploadVideo(
  accessToken: string,
  meta: VideoMetadata,
  media: MediaSource,
  fetchFn: UploadFetch = realFetch,
): Promise<string> {
  if (!accessToken) throw new Error('youtube upload: missing access token')
  const resource = buildVideoResource(meta)
  const length = media.bytes.length

  // 1. Initiate the resumable session.
  const initRes = await fetchFn(YOUTUBE_RESUMABLE_INIT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': media.contentType,
      'X-Upload-Content-Length': String(length),
    },
    body: JSON.stringify(resource),
  })
  if (!initRes.ok) {
    const t = await initRes.text().catch(() => '')
    throw new Error(`youtube upload init failed: ${initRes.status} ${t.slice(0, 200)}`)
  }
  const sessionUri = initRes.headers.get('location') ?? initRes.headers.get('Location')
  if (!sessionUri) {
    throw new Error(
      'youtube upload: no resumable session URI (Location header) in the init response',
    )
  }

  // 2. Upload the media bytes to the session URI.
  const upRes = await fetchFn(sessionUri, {
    method: 'PUT',
    headers: {
      'Content-Type': media.contentType,
      'Content-Length': String(length),
    },
    body: media.bytes,
  })
  if (!upRes.ok) {
    const t = await upRes.text().catch(() => '')
    throw new Error(`youtube upload failed: ${upRes.status} ${t.slice(0, 200)}`)
  }
  const j = (await upRes.json()) as { id?: string }
  if (!j.id) {
    throw new Error('youtube upload: no video id in the response')
  }
  return j.id
}

// Map a video file extension to its MIME type for the upload Content-Type.
// Falls back to a generic video type for unknown extensions.
export function videoContentType(filename: string): string {
  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'))
  switch (ext) {
    case '.mp4':
    case '.m4v':
      return 'video/mp4'
    case '.mov':
      return 'video/quicktime'
    case '.webm':
      return 'video/webm'
    case '.avi':
      return 'video/x-msvideo'
    case '.mkv':
      return 'video/x-matroska'
    case '.flv':
      return 'video/x-flv'
    default:
      return 'application/octet-stream'
  }
}
