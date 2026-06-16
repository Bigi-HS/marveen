import { describe, it, expect } from 'vitest'
import {
  uploadVideo,
  buildVideoResource,
  videoContentType,
  assertGoogleUploadUri,
  YOUTUBE_RESUMABLE_INIT_URL,
  YOUTUBE_UPLOAD_SCOPE,
  type UploadFetch,
} from '../mcp/youtube-upload.js'

const SESSION_URI = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=xyz'

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: string | Uint8Array
}

// Build a stub fetch that answers the init POST then the bytes PUT. Records every
// call so the test can assert the exact request shape.
function stubFetch(opts?: {
  initOk?: boolean
  initStatus?: number
  location?: string | null
  upOk?: boolean
  upStatus?: number
  upBody?: unknown
}): { fetchFn: UploadFetch; calls: Call[] } {
  const calls: Call[] = []
  const o = {
    initOk: true,
    initStatus: 200,
    location: SESSION_URI as string | null,
    upOk: true,
    upStatus: 200,
    upBody: { id: 'VID123' } as unknown,
    ...opts,
  }
  const fetchFn: UploadFetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body })
    if (calls.length === 1) {
      return {
        ok: o.initOk,
        status: o.initStatus,
        headers: { get: (n: string) => (n.toLowerCase() === 'location' ? o.location : null) },
        json: async () => ({}),
        text: async () => 'init-error-body',
      }
    }
    return {
      ok: o.upOk,
      status: o.upStatus,
      headers: { get: () => null },
      json: async () => o.upBody,
      text: async () => 'upload-error-body',
    }
  }
  return { fetchFn, calls }
}

const META = { title: 'My Clip', description: 'desc', tags: ['a', 'b'] }
const MEDIA = { bytes: new Uint8Array([1, 2, 3, 4]), contentType: 'video/mp4' }

describe('YOUTUBE_UPLOAD_SCOPE', () => {
  it('is the upload-only scope (not a broader manage/read scope)', () => {
    expect(YOUTUBE_UPLOAD_SCOPE).toBe('https://www.googleapis.com/auth/youtube.upload')
  })
})

describe('buildVideoResource', () => {
  it('defaults privacyStatus to private (never auto-public)', () => {
    expect(buildVideoResource({ title: 'x' }).status.privacyStatus).toBe('private')
  })

  it('defaults categoryId to 22 and empty description/tags', () => {
    const r = buildVideoResource({ title: 'x' })
    expect(r.snippet.categoryId).toBe('22')
    expect(r.snippet.description).toBe('')
    expect(r.snippet.tags).toEqual([])
  })

  it('trims the title and carries metadata through', () => {
    const r = buildVideoResource({ title: '  Hello  ', description: 'd', tags: ['t'], categoryId: '10', privacyStatus: 'unlisted' })
    expect(r.snippet.title).toBe('Hello')
    expect(r.snippet.tags).toEqual(['t'])
    expect(r.snippet.categoryId).toBe('10')
    expect(r.status.privacyStatus).toBe('unlisted')
  })

  it('throws on a missing/empty title', () => {
    expect(() => buildVideoResource({ title: '' })).toThrow(/title is required/)
    expect(() => buildVideoResource({ title: '   ' })).toThrow(/title is required/)
  })

  it('throws on an invalid privacyStatus', () => {
    // @ts-expect-error -- testing a bad runtime value
    expect(() => buildVideoResource({ title: 'x', privacyStatus: 'world' })).toThrow(/invalid privacyStatus/)
  })
})

describe('uploadVideo', () => {
  it('opens a resumable session with the right URL, auth + upload headers, and JSON body', async () => {
    const { fetchFn, calls } = stubFetch()
    await uploadVideo('AT', META, MEDIA, fetchFn)
    const init = calls[0]
    expect(init.url).toBe(YOUTUBE_RESUMABLE_INIT_URL)
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer AT')
    expect(init.headers['Content-Type']).toContain('application/json')
    expect(init.headers['X-Upload-Content-Type']).toBe('video/mp4')
    expect(init.headers['X-Upload-Content-Length']).toBe('4')
    const parsed = JSON.parse(init.body as string)
    expect(parsed.snippet.title).toBe('My Clip')
    expect(parsed.status.privacyStatus).toBe('private')
  })

  it('PUTs the bytes to the session URI and returns the video id', async () => {
    const { fetchFn, calls } = stubFetch()
    const id = await uploadVideo('AT', META, MEDIA, fetchFn)
    expect(id).toBe('VID123')
    const put = calls[1]
    expect(put.url).toBe(SESSION_URI)
    expect(put.method).toBe('PUT')
    expect(put.headers['Content-Type']).toBe('video/mp4')
    expect(put.headers['Content-Length']).toBe('4')
    expect(put.body).toBe(MEDIA.bytes)
  })

  it('throws when the access token is missing', async () => {
    const { fetchFn } = stubFetch()
    await expect(uploadVideo('', META, MEDIA, fetchFn)).rejects.toThrow(/access token/)
  })

  it('throws when the init response has no Location header', async () => {
    const { fetchFn } = stubFetch({ location: null })
    await expect(uploadVideo('AT', META, MEDIA, fetchFn)).rejects.toThrow(/session URI/)
  })

  it('throws on a non-2xx init response', async () => {
    const { fetchFn } = stubFetch({ initOk: false, initStatus: 403 })
    await expect(uploadVideo('AT', META, MEDIA, fetchFn)).rejects.toThrow(/init failed: 403/)
  })

  it('throws on a non-2xx upload response', async () => {
    const { fetchFn } = stubFetch({ upOk: false, upStatus: 500 })
    await expect(uploadVideo('AT', META, MEDIA, fetchFn)).rejects.toThrow(/upload failed: 500/)
  })

  it('throws when the upload response has no video id', async () => {
    const { fetchFn } = stubFetch({ upBody: {} })
    await expect(uploadVideo('AT', META, MEDIA, fetchFn)).rejects.toThrow(/no video id/)
  })

  it('refuses a non-HTTPS session URI before PUTing bytes', async () => {
    const { fetchFn, calls } = stubFetch({ location: 'http://www.googleapis.com/upload/x' })
    await expect(uploadVideo('AT', META, MEDIA, fetchFn)).rejects.toThrow(/non-Google . non-HTTPS|refusing/)
    expect(calls.length).toBe(1) // never reached the PUT
  })

  it('refuses a session URI on a non-googleapis host before PUTing bytes', async () => {
    const { fetchFn, calls } = stubFetch({ location: 'https://evil.example.com/upload/x' })
    await expect(uploadVideo('AT', META, MEDIA, fetchFn)).rejects.toThrow(/refusing/)
    expect(calls.length).toBe(1)
  })
})

describe('assertGoogleUploadUri', () => {
  it('accepts googleapis.com HTTPS hosts', () => {
    expect(() => assertGoogleUploadUri('https://www.googleapis.com/upload/youtube/v3/videos?upload_id=x')).not.toThrow()
    expect(() => assertGoogleUploadUri('https://googleapis.com/x')).not.toThrow()
  })
  it('rejects http, foreign hosts, and a lookalike suffix', () => {
    expect(() => assertGoogleUploadUri('http://www.googleapis.com/x')).toThrow()
    expect(() => assertGoogleUploadUri('https://evil.com/x')).toThrow()
    expect(() => assertGoogleUploadUri('https://googleapis.com.evil.com/x')).toThrow()
    expect(() => assertGoogleUploadUri('not a url')).toThrow(/malformed/)
  })
})

describe('videoContentType', () => {
  it('maps known extensions', () => {
    expect(videoContentType('a.mp4')).toBe('video/mp4')
    expect(videoContentType('a.MOV')).toBe('video/quicktime')
    expect(videoContentType('clip.webm')).toBe('video/webm')
    expect(videoContentType('x.mkv')).toBe('video/x-matroska')
  })

  it('falls back to octet-stream for unknown extensions', () => {
    expect(videoContentType('a.xyz')).toBe('application/octet-stream')
    expect(videoContentType('noext')).toBe('application/octet-stream')
  })
})
