/**
 * test/streamable-client.test.ts
 * ==============================
 *
 * `src/main/upload/streamable-client.ts` is the only module in poe-tool that talks to
 * Streamable, and half of what it talks to is UNDOCUMENTED (see that file's header).
 * That makes this suite's job unusually specific: it is not here to prove the happy
 * path works - it is here to prove that THE DAY THE UNOFFICIAL ENDPOINT CHANGES, the
 * app reports a clear error instead of throwing a `TypeError` somewhere in the death
 * path.
 *
 * FULLY OFFLINE AND DETERMINISTIC. `fetch` is injected through the `fetch` seam and
 * file access through `openFile`, so nothing here resolves DNS, opens a socket, or
 * depends on Streamable being up. A test that needed the real endpoint would be a test
 * that silently stops running the first time a CI box has no network - and this suite's
 * whole point is to keep working when Streamable does not.
 *
 * Hand-written fakes, no mocking library, per the project constraints. Poll timings are
 * set in tens of milliseconds with REAL timers rather than faked, matching
 * `test/obs-client-save.test.ts`: the code under test races a deadline against request
 * completion, and fake timers would hide exactly the ordering that matters.
 *
 * THE PASSWORD USED THROUGHOUT IS DISTINCTIVE ON PURPOSE. `SECRET_PASSWORD` is a string
 * that could not occur by accident, so the leak tests at the bottom can search entire
 * serialised results for it.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  STREAMABLE_UPLOAD_URL,
  STREAMABLE_VIDEO_API_BASE,
  StreamableClient,
  buildAuthorizationHeader,
  credentialSecrets,
  nodeOpenFile,
  parseShortcode,
  parseVideoStatus,
  scrubSecrets,
  videoPageUrl,
  type FetchLike,
  type OpenFileFn,
  type StreamableHttpRequest,
  type StreamableHttpResponse,
  type StreamableResult,
  type UploadProgress
} from '../src/main/upload/streamable-client'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EMAIL = 'exile@example.com'
/** Distinctive, contains regex metacharacters, and has a leading space on purpose. */
const SECRET_PASSWORD = ' zz-p4ssw0rd-$never(leak)this-zz'
const SHORTCODE = 'ab12cd'

/** A recorded call to the injected fetch. */
interface RecordedCall {
  readonly url: string
  readonly request: StreamableHttpRequest
}

/** Builds a response the client can read. `headers` keys must be lower-case. */
function httpResponse(
  status: number,
  body: string,
  headers: Readonly<Record<string, string>> = {}
): StreamableHttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => body
  }
}

/** A fetch that answers from a queue, then repeats its last answer forever. */
function queuedFetch(
  responses: readonly StreamableHttpResponse[],
  calls: RecordedCall[]
): FetchLike {
  let index = 0
  return async (url, request) => {
    calls.push({ url, request })
    const chosen = responses[Math.min(index, responses.length - 1)]
    index += 1
    if (chosen === undefined) throw new Error('test fetch has no response to give')
    return chosen
  }
}

/** A fetch that rejects the way undici does when a connection cannot be made. */
function throwingFetch(error: unknown, calls: RecordedCall[]): FetchLike {
  return async (url, request) => {
    calls.push({ url, request })
    throw error
  }
}

/** An `openFile` that yields a fake clip of `sizeBytes`, without touching the disk. */
function fakeOpenFile(sizeBytes: number, fileName = 'death.mkv'): OpenFileFn {
  return async () => ({
    fileName,
    sizeBytes,
    // Contents are irrelevant - nothing here serialises a body - but a real Blob keeps
    // the FormData assertions honest.
    blob: new Blob([new Uint8Array(Math.min(sizeBytes, 16))], { type: 'video/x-matroska' })
  })
}

function uploadArgs(): { filePath: string; email: string; password: string } {
  return { filePath: 'C:\\OBS\\death.mkv', email: EMAIL, password: SECRET_PASSWORD }
}

/** Narrows a result to its error, failing the test if it unexpectedly succeeded. */
function errorOf<T>(result: StreamableResult<T>): { kind: string; message: string } {
  if (result.ok) throw new Error('expected a failure, got a success')
  return { kind: result.error.kind, message: result.error.message }
}

/** Narrows a result to its value, failing the test if it unexpectedly failed. */
function valueOf<T>(result: StreamableResult<T>): T {
  if (!result.ok) throw new Error(`expected a success, got ${result.error.kind}: ${result.error.message}`)
  return result.value
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** The rejection `fetch` produces when its signal fires. */
function abortError(): Error {
  const error = new Error('This operation was aborted')
  error.name = 'AbortError'
  return error
}

// ---------------------------------------------------------------------------
// upload - the happy path and the request we actually send
// ---------------------------------------------------------------------------

describe('StreamableClient.upload - a successful upload', () => {
  it('posts to the unofficial endpoint and returns the parsed shortcode', async () => {
    const calls: RecordedCall[] = []
    const client = new StreamableClient({
      fetch: queuedFetch([httpResponse(200, JSON.stringify({ status: 1, shortcode: SHORTCODE }))], calls),
      openFile: fakeOpenFile(4 * 1024 * 1024)
    })

    const uploaded = valueOf(await client.upload(uploadArgs()))

    expect(uploaded.shortcode).toBe(SHORTCODE)
    expect(uploaded.url).toBe(`https://streamable.com/${SHORTCODE}`)
    expect(uploaded.status).toBe(1)
    expect(uploaded.sizeBytes).toBe(4 * 1024 * 1024)

    expect(calls).toHaveLength(1)
    const call = calls[0]
    if (call === undefined) throw new Error('expected one request')
    expect(call.url).toBe(STREAMABLE_UPLOAD_URL)
    expect(call.url).toBe('https://api.streamable.com/upload')
    expect(call.request.method).toBe('POST')
  })

  it('sends the video under the "file" field, with its real filename', async () => {
    const calls: RecordedCall[] = []
    const client = new StreamableClient({
      fetch: queuedFetch([httpResponse(200, JSON.stringify({ shortcode: SHORTCODE }))], calls),
      openFile: fakeOpenFile(1024, 'Karui Shores 2026-07-27.mkv')
    })

    valueOf(await client.upload(uploadArgs()))

    const body = calls[0]?.request.body
    if (body === undefined || body === null) throw new Error('expected a multipart body')
    const part = body.get('file')
    if (part === null || typeof part === 'string') throw new Error('expected the file part to be a File')
    expect(part.name).toBe('Karui Shores 2026-07-27.mkv')
    // Exactly one field: nothing else may be smuggled into the upload.
    expect([...body.keys()]).toEqual(['file'])
  })

  it('tolerates an upload response that carries no numeric status', async () => {
    // The upload response is the UNDOCUMENTED half. Only `shortcode` is load-bearing;
    // a missing `status` must not be treated as a failure, because the documented
    // endpoint is where status actually comes from.
    const client = new StreamableClient({
      fetch: queuedFetch([httpResponse(200, JSON.stringify({ shortcode: SHORTCODE }))], []),
      openFile: fakeOpenFile(1024)
    })

    expect(valueOf(await client.upload(uploadArgs())).status).toBeNull()
  })

  it('reports progress once, as indeterminate, with the real total size', async () => {
    // Not an oversight: a `fetch` with a FormData body has no per-chunk hook in Node,
    // and `UploadUploading.percent` is `number | null` precisely so the UI can render
    // an indeterminate bar instead of a fabricated percentage.
    const seen: UploadProgress[] = []
    const client = new StreamableClient({
      fetch: queuedFetch([httpResponse(200, JSON.stringify({ shortcode: SHORTCODE }))], []),
      openFile: fakeOpenFile(12_345)
    })

    valueOf(await client.upload({ ...uploadArgs(), onProgress: (p) => seen.push(p) }))

    expect(seen).toEqual([{ totalBytes: 12_345, bytesSent: 0, percent: null }])
  })

  it('survives an onProgress listener that throws', async () => {
    const reported: string[] = []
    const client = new StreamableClient({
      fetch: queuedFetch([httpResponse(200, JSON.stringify({ shortcode: SHORTCODE }))], []),
      openFile: fakeOpenFile(1024),
      onInternalError: (_error, context) => reported.push(context)
    })

    const result = await client.upload({
      ...uploadArgs(),
      onProgress: () => {
        throw new Error('the renderer bridge blew up')
      }
    })

    expect(valueOf(result).shortcode).toBe(SHORTCODE)
    expect(reported).toEqual(['progress-listener'])
  })
})

// ---------------------------------------------------------------------------
// The Authorization header
// ---------------------------------------------------------------------------

describe('HTTP Basic authentication', () => {
  it('builds "Basic base64(email:password)" exactly', () => {
    expect(buildAuthorizationHeader('a@b.com', 'pw')).toBe(
      `Basic ${Buffer.from('a@b.com:pw', 'utf8').toString('base64')}`
    )
    // A password may legitimately contain a colon; only the FIRST one separates the
    // two fields, so it must survive verbatim rather than being escaped or trimmed.
    const decoded = Buffer.from(
      buildAuthorizationHeader('a@b.com', 'pa:ss word ').slice('Basic '.length),
      'base64'
    ).toString('utf8')
    expect(decoded).toBe('a@b.com:pa:ss word ')
  })

  it('sends that header on the upload request', async () => {
    const calls: RecordedCall[] = []
    const client = new StreamableClient({
      fetch: queuedFetch([httpResponse(200, JSON.stringify({ shortcode: SHORTCODE }))], calls),
      openFile: fakeOpenFile(1024)
    })

    valueOf(await client.upload(uploadArgs()))

    const headers = calls[0]?.request.headers
    if (headers === undefined) throw new Error('expected headers')
    expect(headers['Authorization']).toBe(buildAuthorizationHeader(EMAIL, SECRET_PASSWORD))
    expect(Buffer.from(String(headers['Authorization']).slice(6), 'base64').toString('utf8')).toBe(
      `${EMAIL}:${SECRET_PASSWORD}`
    )
  })

  it('trims the email but never the password', async () => {
    const calls: RecordedCall[] = []
    const client = new StreamableClient({
      fetch: queuedFetch([httpResponse(200, JSON.stringify({ shortcode: SHORTCODE }))], calls),
      openFile: fakeOpenFile(1024)
    })

    valueOf(await client.upload({ ...uploadArgs(), email: `  ${EMAIL}  ` }))

    const decoded = Buffer.from(String(calls[0]?.request.headers['Authorization']).slice(6), 'base64').toString(
      'utf8'
    )
    // The leading space in SECRET_PASSWORD is deliberate: a password may legitimately
    // begin with whitespace and altering it would fail auth for no visible reason.
    expect(decoded).toBe(`${EMAIL}:${SECRET_PASSWORD}`)
  })

  it('does not contact Streamable at all when no credentials are configured', async () => {
    const calls: RecordedCall[] = []
    const client = new StreamableClient({
      fetch: queuedFetch([httpResponse(200, '{}')], calls),
      openFile: fakeOpenFile(1024)
    })

    expect(errorOf(await client.upload({ ...uploadArgs(), password: '' })).kind).toBe('auth-failed')
    expect(errorOf(await client.upload({ ...uploadArgs(), email: '   ' })).kind).toBe('auth-failed')
    expect(calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// upload - the failure modes that matter
// ---------------------------------------------------------------------------

describe('StreamableClient.upload - a vendor change must not throw', () => {
  it('returns unexpected-response for an HTML error page instead of throwing', async () => {
    // THE REGRESSION THIS FILE EXISTS FOR. The endpoint is undocumented; the day it
    // changes, or a captive portal / proxy answers instead, the body is HTML. Calling
    // `.json()` on that rejects, and an unhandled rejection on the death path would
    // take the main process with it.
    const client = new StreamableClient({
      fetch: queuedFetch(
        [httpResponse(200, '<!doctype html>\n<html><body>\n  <h1>502 Bad Gateway</h1>\n</body></html>')],
        []
      ),
      openFile: fakeOpenFile(1024)
    })

    const error = errorOf(await client.upload(uploadArgs()))

    expect(error.kind).toBe('unexpected-response')
    expect(error.message).toContain('Unexpected response from Streamable')
    // Names the file to repair, so nobody has to go hunting for where Streamable lives.
    expect(error.message).toContain('src/main/upload/streamable-client.ts')
    // The snippet is single-line: an HTML page's newlines must not land in a UI label.
    expect(error.message).not.toContain('\n')
    expect(error.message).toContain('502 Bad Gateway')
  })

  it('returns unexpected-response when the JSON parses but the shortcode is gone', async () => {
    // The most likely shape of a breaking change: still JSON, still HTTP 200, field
    // renamed. Nothing may quietly proceed with `undefined` as a shortcode.
    const client = new StreamableClient({
      fetch: queuedFetch([httpResponse(200, JSON.stringify({ status: 1, id: SHORTCODE }))], []),
      openFile: fakeOpenFile(1024)
    })

    const error = errorOf(await client.upload(uploadArgs()))

    expect(error.kind).toBe('unexpected-response')
    expect(error.message).toContain('shortcode')
  })

  it('refuses a shortcode that could not be safely put in a URL', async () => {
    // A shortcode is concatenated into two URLs. `../` would turn a status poll into a
    // request for something else entirely.
    const client = new StreamableClient({
      fetch: queuedFetch([httpResponse(200, JSON.stringify({ shortcode: '../videos/someone-else' }))], []),
      openFile: fakeOpenFile(1024)
    })

    expect(errorOf(await client.upload(uploadArgs())).kind).toBe('unexpected-response')
  })

  it('returns unexpected-response for an empty body', async () => {
    const client = new StreamableClient({
      fetch: queuedFetch([httpResponse(200, '')], []),
      openFile: fakeOpenFile(1024)
    })

    expect(errorOf(await client.upload(uploadArgs())).kind).toBe('unexpected-response')
  })
})

describe('StreamableClient.upload - HTTP status mapping', () => {
  it('maps 401 to auth-failed', async () => {
    const client = new StreamableClient({
      fetch: queuedFetch([httpResponse(401, JSON.stringify({ message: 'Unauthorized' }))], []),
      openFile: fakeOpenFile(1024)
    })

    const result = await client.upload(uploadArgs())

    if (result.ok) throw new Error('expected the upload to be refused')
    if (result.error.kind !== 'auth-failed') throw new Error(`got ${result.error.kind}`)
    expect(result.error.message).toContain('401')
    // Says the thing users get wrong: there is no API key to look for.
    expect(result.error.message).toContain('ACCOUNT password')
    // A JSON rejection is what Streamable itself sends, so the wording stays confident -
    // and does NOT send the reader off to repair this file.
    expect(result.error.message).not.toContain('may be a block page')
    expect(result.error.message).not.toContain('streamable-client.ts')
    // The evidence travels with it either way.
    expect(result.error.bodySnippet).toContain('Unauthorized')
    expect(result.error.status).toBe(401)
  })

  it('maps 403 to auth-failed as well', async () => {
    const client = new StreamableClient({
      fetch: queuedFetch([httpResponse(403, 'Forbidden')], []),
      openFile: fakeOpenFile(1024)
    })

    expect(errorOf(await client.upload(uploadArgs())).kind).toBe('auth-failed')
  })

  it('maps 413 to file-too-large', async () => {
    const client = new StreamableClient({
      fetch: queuedFetch([httpResponse(413, 'Request Entity Too Large')], []),
      openFile: fakeOpenFile(300 * 1024 * 1024)
    })

    const result = await client.upload({ ...uploadArgs(), maxBytes: 0 })

    if (result.ok) throw new Error('expected the upload to be refused')
    if (result.error.kind !== 'file-too-large') throw new Error(`got ${result.error.kind}`)
    expect(result.error.sizeBytes).toBe(300 * 1024 * 1024)
    // The server never told us its limit, so we must not invent one.
    expect(result.error.limitBytes).toBeNull()
    expect(result.error.message).toContain('250 MB')
    // 413 is also exactly what an upload proxy says. Keep what it actually sent.
    expect(result.error.bodySnippet).toBe('Request Entity Too Large')
  })

  it('maps 429 to rate-limited and reads Retry-After', async () => {
    const client = new StreamableClient({
      fetch: queuedFetch([httpResponse(429, 'slow down', { 'retry-after': '120' })], []),
      openFile: fakeOpenFile(1024)
    })

    const result = await client.upload(uploadArgs())

    if (result.ok) throw new Error('expected the upload to be refused')
    if (result.error.kind !== 'rate-limited') throw new Error(`got ${result.error.kind}`)
    expect(result.error.retryAfterMs).toBe(120_000)
    expect(result.error.message).toContain('120s')
    expect(result.error.bodySnippet).toBe('slow down')
  })

  it('maps an unrecognised status to unexpected-response, carrying the status', async () => {
    const client = new StreamableClient({
      fetch: queuedFetch([httpResponse(500, JSON.stringify({ message: 'internal error' }))], []),
      openFile: fakeOpenFile(1024)
    })

    const result = await client.upload(uploadArgs())

    if (result.ok) throw new Error('expected the upload to be refused')
    if (result.error.kind !== 'unexpected-response') throw new Error(`got ${result.error.kind}`)
    expect(result.error.status).toBe(500)
    expect(result.error.message).toContain('500')
  })

  /**
   * A 401 or a 403 is the SHAPE A BOT WALL ARRIVES IN, and on an undocumented endpoint
   * that is at least as likely as a wrong password. The status mapping is pinned and stays
   * as it is - but reporting only "Streamable rejected the account email and password",
   * with the body thrown away, sent the user to re-type a credential that works and left
   * them nothing to report to anyone. The client's own header calls making breakage CHEAP
   * AND OBVIOUS its purpose; for these two statuses it used to do the opposite.
   */
  describe('a 401/403 that is not really about the password', () => {
    /** A Cloudflare interstitial, near enough verbatim. */
    const BLOCK_PAGE =
      '<!DOCTYPE html><html><head><title>Access denied</title></head><body>' +
      '<h1>Sorry, you have been blocked</h1>' +
      '<p>You are unable to access streamable.com</p>' +
      '<span>Ray ID: 8a1b2c3d4e5f6789</span></body></html>'

    it('keeps the page as evidence instead of discarding it', async () => {
      const client = new StreamableClient({
        fetch: queuedFetch([httpResponse(403, BLOCK_PAGE)], []),
        openFile: fakeOpenFile(1024)
      })

      const result = await client.upload(uploadArgs())

      if (result.ok) throw new Error('expected the upload to be refused')
      if (result.error.kind !== 'auth-failed') throw new Error(`got ${result.error.kind}`)
      // The one thing that identifies what actually happened, and the one thing a bug
      // report needs. Whitespace-collapsed, like every other snippet in this module.
      expect(result.error.bodySnippet).toContain('Sorry, you have been blocked')
      expect(result.error.bodySnippet).toContain('Ray ID: 8a1b2c3d4e5f6789')
      expect(result.error.bodySnippet).not.toContain('\n')
    })

    it('says it might be a block page rather than asserting the password is wrong', async () => {
      const client = new StreamableClient({
        fetch: queuedFetch([httpResponse(403, BLOCK_PAGE)], []),
        openFile: fakeOpenFile(1024)
      })

      const { message } = errorOf(await client.upload(uploadArgs()))

      expect(message).toContain('403')
      expect(message).toContain('may be a block page')
      // Still names the credential to check - it might genuinely be that - but no longer
      // states it as the diagnosis.
      expect(message).toContain('ACCOUNT password')
      // And it points at the one file to repair, exactly as an unrecognised 4xx does.
      expect(message).toContain('src/main/upload/streamable-client.ts')
      expect(message).toContain('Ray ID')
    })

    it('applies the same reading to a credential check, which is where the button is', async () => {
      const client = new StreamableClient({ fetch: queuedFetch([httpResponse(403, BLOCK_PAGE)], []) })

      const { kind, message } = errorOf(await client.testCredentials(EMAIL, SECRET_PASSWORD))

      expect(kind).toBe('auth-failed')
      expect(message).toContain('may be a block page')
    })

    it('does not cry wolf over an empty body', async () => {
      // No body is not evidence of an interstitial - it is just a terse rejection. The
      // confident wording is right here, and a spurious "poe-tool may need an update"
      // would be its own kind of misdirection.
      const client = new StreamableClient({
        fetch: queuedFetch([httpResponse(401, '')], []),
        openFile: fakeOpenFile(1024)
      })

      const result = await client.upload(uploadArgs())

      if (result.ok) throw new Error('expected the upload to be refused')
      if (result.error.kind !== 'auth-failed') throw new Error(`got ${result.error.kind}`)
      expect(result.error.message).toContain('rejected the account email and password')
      expect(result.error.message).not.toContain('may be a block page')
      expect(result.error.bodySnippet).toBe('')
    })

    it('scrubs the credential out of the snippet, like every other body', async () => {
      // A proxy that echoes the request back is the most likely source of a non-JSON 401
      // in the first place, so this field is the newest place a secret could escape from.
      const token = Buffer.from(`${EMAIL}:${SECRET_PASSWORD}`, 'utf8').toString('base64')
      const client = new StreamableClient({
        fetch: queuedFetch(
          [httpResponse(403, `<html>Blocked request with Authorization: Basic ${token}</html>`)],
          []
        ),
        openFile: fakeOpenFile(1024)
      })

      const result = await client.upload(uploadArgs())

      if (result.ok) throw new Error('expected the upload to be refused')
      if (result.error.kind !== 'auth-failed') throw new Error(`got ${result.error.kind}`)
      expect(result.error.bodySnippet).not.toContain(token)
      expect(result.error.bodySnippet).not.toContain(SECRET_PASSWORD)
      expect(result.error.bodySnippet).toContain('***')
    })
  })

  it('maps a transport failure to network, keeping the underlying cause', async () => {
    const failure = new Error('fetch failed')
    Object.defineProperty(failure, 'cause', { value: new Error('getaddrinfo ENOTFOUND api.streamable.com') })
    const client = new StreamableClient({
      fetch: throwingFetch(failure, []),
      openFile: fakeOpenFile(1024)
    })

    const error = errorOf(await client.upload(uploadArgs()))

    expect(error.kind).toBe('network')
    expect(error.message).toContain('ENOTFOUND')
  })
})

describe('StreamableClient.upload - local checks happen before any request', () => {
  it('refuses an over-sized clip without contacting Streamable', async () => {
    const calls: RecordedCall[] = []
    const client = new StreamableClient({
      fetch: queuedFetch([httpResponse(200, JSON.stringify({ shortcode: SHORTCODE }))], calls),
      openFile: fakeOpenFile(380 * 1024 * 1024)
    })

    const result = await client.upload(uploadArgs())

    if (result.ok) throw new Error('expected the clip to be refused')
    if (result.error.kind !== 'file-too-large') throw new Error(`got ${result.error.kind}`)
    expect(result.error.limitBytes).toBe(250 * 1024 * 1024)
    expect(result.error.message).toContain('380 MB')
    expect(result.error.message).toContain('250 MB')
    // The whole point: nothing was sent, so the user did not wait for a doomed upload.
    expect(calls).toHaveLength(0)
  })

  it('honours maxBytes: 0 as "let Streamable decide"', async () => {
    const calls: RecordedCall[] = []
    const client = new StreamableClient({
      fetch: queuedFetch([httpResponse(200, JSON.stringify({ shortcode: SHORTCODE }))], calls),
      openFile: fakeOpenFile(900 * 1024 * 1024)
    })

    expect(valueOf(await client.upload({ ...uploadArgs(), maxBytes: 0 })).shortcode).toBe(SHORTCODE)
    expect(calls).toHaveLength(1)
  })

  it('reports a missing clip as file-unreadable, not as a network problem', async () => {
    const calls: RecordedCall[] = []
    const client = new StreamableClient({
      fetch: queuedFetch([httpResponse(200, '{}')], calls),
      openFile: async () => {
        throw Object.assign(new Error("ENOENT: no such file or directory, stat 'C:\\OBS\\death.mkv'"), {
          code: 'ENOENT'
        })
      }
    })

    const error = errorOf(await client.upload(uploadArgs()))

    expect(error.kind).toBe('file-unreadable')
    expect(error.message).toContain('C:\\OBS\\death.mkv')
    expect(calls).toHaveLength(0)
  })

  it('reports a zero-byte clip as file-unreadable', async () => {
    const calls: RecordedCall[] = []
    const client = new StreamableClient({
      fetch: queuedFetch([httpResponse(200, '{}')], calls),
      openFile: fakeOpenFile(0)
    })

    expect(errorOf(await client.upload(uploadArgs())).kind).toBe('file-unreadable')
    expect(calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------

describe('StreamableClient - cancellation', () => {
  it('does nothing at all when the signal is already aborted', async () => {
    const calls: RecordedCall[] = []
    const openedFiles: string[] = []
    const client = new StreamableClient({
      fetch: queuedFetch([httpResponse(200, '{}')], calls),
      openFile: async (filePath) => {
        openedFiles.push(filePath)
        return { fileName: 'x.mkv', sizeBytes: 1, blob: new Blob(['x']) }
      }
    })
    const controller = new AbortController()
    controller.abort()

    expect(errorOf(await client.upload({ ...uploadArgs(), signal: controller.signal })).kind).toBe('aborted')
    expect(calls).toHaveLength(0)
    expect(openedFiles).toHaveLength(0)
  })

  it('cancels an upload that is already in flight', async () => {
    // The shutdown path: `before-quit` fires while a 200 MB clip is halfway out.
    const client = new StreamableClient({
      fetch: async (_url, request) =>
        new Promise<StreamableHttpResponse>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(abortError()), { once: true })
        }),
      openFile: fakeOpenFile(1024)
    })
    const controller = new AbortController()

    const pending = client.upload({ ...uploadArgs(), signal: controller.signal })
    await sleep(10)
    controller.abort()

    const error = errorOf(await pending)
    expect(error.kind).toBe('aborted')
    expect(error.message).toContain('cancelled')
  })

  it('tells its own timeout apart from the caller cancelling', async () => {
    // Both arrive as an AbortError on the same signal, and they need different words:
    // "we gave up" is worth investigating, "you quit the app" is not.
    const client = new StreamableClient({
      fetch: async (_url, request) =>
        new Promise<StreamableHttpResponse>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(abortError()), { once: true })
        }),
      openFile: fakeOpenFile(1024)
    })

    const result = await client.upload({ ...uploadArgs(), timeoutMs: 25 })

    if (result.ok) throw new Error('expected the upload to time out')
    if (result.error.kind !== 'timeout') throw new Error(`got ${result.error.kind}`)
    expect(result.error.waitedMs).toBe(25)
    expect(result.error.shortcode).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// awaitReady - the OFFICIAL, documented endpoint
// ---------------------------------------------------------------------------

describe('StreamableClient.awaitReady - polling GET /videos/{shortcode}', () => {
  it('polls the documented endpoint until the status turns ready', async () => {
    const calls: RecordedCall[] = []
    const client = new StreamableClient({
      fetch: queuedFetch(
        [
          httpResponse(200, JSON.stringify({ status: 0 })),
          httpResponse(200, JSON.stringify({ status: 1 })),
          httpResponse(200, JSON.stringify({ status: 2, url: 'streamable.com/ab12cd' }))
        ],
        calls
      )
    })
    const seen: number[] = []

    const ready = valueOf(
      await client.awaitReady(SHORTCODE, {
        email: EMAIL,
        password: SECRET_PASSWORD,
        pollIntervalMs: 5,
        maxWaitMs: 2_000,
        onStatus: (status) => seen.push(status)
      })
    )

    expect(ready.shortcode).toBe(SHORTCODE)
    expect(ready.url).toBe(videoPageUrl(SHORTCODE))
    expect(seen).toEqual([0, 1, 2])
    expect(calls).toHaveLength(3)
    expect(calls[0]?.url).toBe(`${STREAMABLE_VIDEO_API_BASE}/${SHORTCODE}`)
    expect(calls[0]?.url).toBe(`https://api.streamable.com/videos/${SHORTCODE}`)
    expect(calls[0]?.request.method).toBe('GET')
    expect(calls[0]?.request.body).toBeNull()
    // Authenticated, because a freshly uploaded video may be private to the account -
    // an unauthenticated poll would 404 forever.
    expect(calls[0]?.request.headers['Authorization']).toBe(
      buildAuthorizationHeader(EMAIL, SECRET_PASSWORD)
    )
  })

  it('reports status 3 as processing-failed and keeps the link', async () => {
    const client = new StreamableClient({
      fetch: queuedFetch(
        [httpResponse(200, JSON.stringify({ status: 3, message: 'unsupported codec' }))],
        []
      )
    })

    const result = await client.awaitReady(SHORTCODE, { pollIntervalMs: 5, maxWaitMs: 500 })

    if (result.ok) throw new Error('expected processing to have failed')
    if (result.error.kind !== 'processing-failed') throw new Error(`got ${result.error.kind}`)
    expect(result.error.shortcode).toBe(SHORTCODE)
    expect(result.error.message).toContain('unsupported codec')
    // The upload itself worked, and saying so is the difference between "retry the
    // upload" and "go and find your clip".
    expect(result.error.message).toContain(videoPageUrl(SHORTCODE))
  })

  it('gives up with a timeout once the cap is spent, without losing the shortcode', async () => {
    const calls: RecordedCall[] = []
    const client = new StreamableClient({
      fetch: queuedFetch([httpResponse(200, JSON.stringify({ status: 1 }))], calls)
    })

    const startedAt = Date.now()
    const result = await client.awaitReady(SHORTCODE, { pollIntervalMs: 5, maxWaitMs: 60 })
    const elapsed = Date.now() - startedAt

    if (result.ok) throw new Error('expected the poll to time out')
    if (result.error.kind !== 'timeout') throw new Error(`got ${result.error.kind}`)
    // A timeout here does NOT mean the clip was lost - Streamable is still working.
    expect(result.error.shortcode).toBe(SHORTCODE)
    expect(result.error.message).toContain('THE UPLOAD SUCCEEDED')
    // Bounded: the cap is respected rather than merely eventually noticed.
    expect(elapsed).toBeLessThan(2_000)
    expect(calls.length).toBeGreaterThan(1)
  })

  it('treats a 404 as "not visible yet" rather than as a failure', async () => {
    // Streamable does not necessarily expose a video the instant the upload returns.
    // Giving up on the first 404 would report every successful upload as broken.
    const client = new StreamableClient({
      fetch: queuedFetch(
        [
          httpResponse(404, JSON.stringify({ message: 'Not found' })),
          httpResponse(404, JSON.stringify({ message: 'Not found' })),
          httpResponse(200, JSON.stringify({ status: 2 }))
        ],
        []
      )
    })

    const ready = valueOf(await client.awaitReady(SHORTCODE, { pollIntervalMs: 5, maxWaitMs: 2_000 }))

    expect(ready.shortcode).toBe(SHORTCODE)
  })

  it('returns unexpected-response when the documented status field goes missing', async () => {
    const client = new StreamableClient({
      fetch: queuedFetch([httpResponse(200, JSON.stringify({ state: 'ready' }))], [])
    })

    const error = errorOf(await client.awaitReady(SHORTCODE, { pollIntervalMs: 5, maxWaitMs: 500 }))

    expect(error.kind).toBe('unexpected-response')
    expect(error.message).toContain('status')
  })

  it('returns unexpected-response for a status outside the documented 0-3', async () => {
    // Not "probably still processing": it is an API we no longer understand, and
    // waiting for a 2 that will never come would hang the upload UI for five minutes.
    const client = new StreamableClient({
      fetch: queuedFetch([httpResponse(200, JSON.stringify({ status: 7 }))], [])
    })

    expect(errorOf(await client.awaitReady(SHORTCODE, { pollIntervalMs: 5, maxWaitMs: 500 })).kind).toBe(
      'unexpected-response'
    )
  })

  it('maps 401 during polling to auth-failed', async () => {
    const client = new StreamableClient({
      fetch: queuedFetch([httpResponse(401, 'Unauthorized')], [])
    })

    expect(errorOf(await client.awaitReady(SHORTCODE, { pollIntervalMs: 5, maxWaitMs: 500 })).kind).toBe(
      'auth-failed'
    )
  })

  it('sends NO Authorization header when it was given no credentials', async () => {
    // `base64(":")` is not "no credential" - it is a wrong one, and a server is
    // entitled to answer 401 to it. An unauthenticated poll of a public video must
    // stay unauthenticated.
    const calls: RecordedCall[] = []
    const client = new StreamableClient({
      fetch: queuedFetch([httpResponse(200, JSON.stringify({ status: 2 }))], calls)
    })

    valueOf(await client.awaitReady(SHORTCODE, { pollIntervalMs: 5, maxWaitMs: 500 }))

    expect(calls[0]?.request.headers['Authorization']).toBeUndefined()
    expect(calls[0]?.request.headers['Accept']).toBe('application/json')
  })

  it('refuses a shortcode that is not a shortcode, without making a request', async () => {
    const calls: RecordedCall[] = []
    const client = new StreamableClient({ fetch: queuedFetch([httpResponse(200, '{}')], calls) })

    expect(errorOf(await client.awaitReady('../videos/someone-else')).kind).toBe('unexpected-response')
    expect(errorOf(await client.awaitReady('')).kind).toBe('unexpected-response')
    expect(calls).toHaveLength(0)
  })

  it('stops promptly when the caller aborts mid-wait', async () => {
    const client = new StreamableClient({
      fetch: queuedFetch([httpResponse(200, JSON.stringify({ status: 1 }))], [])
    })
    const controller = new AbortController()

    const pending = client.awaitReady(SHORTCODE, {
      pollIntervalMs: 5_000,
      maxWaitMs: 60_000,
      signal: controller.signal
    })
    await sleep(20)
    controller.abort()

    expect(errorOf(await pending).kind).toBe('aborted')
  })
})

// ---------------------------------------------------------------------------
// testCredentials
// ---------------------------------------------------------------------------

describe('StreamableClient.testCredentials - a negative test, honestly implemented', () => {
  it('rejects credentials Streamable answers 401 to', async () => {
    const client = new StreamableClient({ fetch: queuedFetch([httpResponse(401, 'Unauthorized')], []) })

    expect(errorOf(await client.testCredentials(EMAIL, SECRET_PASSWORD)).kind).toBe('auth-failed')
  })

  it('accepts credentials that get past auth, even when the request is then refused', async () => {
    // THIS IS THE EXPECTED SUCCESS SHAPE. There is no documented "verify my login"
    // endpoint, so the check posts to the SAME endpoint with the SAME auth AND NO FILE.
    // A 400 about the missing file means the login got through - which is all we asked.
    const client = new StreamableClient({
      fetch: queuedFetch([httpResponse(400, JSON.stringify({ message: 'No file provided' }))], [])
    })

    expect((await client.testCredentials(EMAIL, SECRET_PASSWORD)).ok).toBe(true)
  })

  it('never sends a video', async () => {
    const calls: RecordedCall[] = []
    const client = new StreamableClient({ fetch: queuedFetch([httpResponse(400, 'no file')], calls) })

    await client.testCredentials(EMAIL, SECRET_PASSWORD)

    const body = calls[0]?.request.body
    if (body === undefined || body === null) throw new Error('expected an (empty) multipart body')
    expect([...body.keys()]).toEqual([])
    expect(calls[0]?.request.headers['Authorization']).toBe(
      buildAuthorizationHeader(EMAIL, SECRET_PASSWORD)
    )
  })

  it('keeps "no internet" distinguishable from "wrong password"', async () => {
    const client = new StreamableClient({ fetch: throwingFetch(new Error('fetch failed'), []) })

    expect(errorOf(await client.testCredentials(EMAIL, SECRET_PASSWORD)).kind).toBe('network')
  })

  it('still reports a rate limit rather than calling it a pass', async () => {
    const client = new StreamableClient({ fetch: queuedFetch([httpResponse(429, 'slow down')], []) })

    expect(errorOf(await client.testCredentials(EMAIL, SECRET_PASSWORD)).kind).toBe('rate-limited')
  })

  it('does not call a 5xx a pass', async () => {
    // "Streamable is having a bad day" says nothing about whether the credentials are
    // right, and a green tick here would send the user away believing something that
    // was never verified.
    const client = new StreamableClient({ fetch: queuedFetch([httpResponse(503, 'maintenance')], []) })

    expect(errorOf(await client.testCredentials(EMAIL, SECRET_PASSWORD)).kind).toBe('unexpected-response')
  })

  it('refuses to test a blank credential without asking Streamable', async () => {
    const calls: RecordedCall[] = []
    const client = new StreamableClient({ fetch: queuedFetch([httpResponse(200, '{}')], calls) })

    expect(errorOf(await client.testCredentials('', SECRET_PASSWORD)).kind).toBe('auth-failed')
    expect(errorOf(await client.testCredentials(EMAIL, '')).kind).toBe('auth-failed')
    expect(calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// THE PASSWORD MUST NOT ESCAPE
// ---------------------------------------------------------------------------

describe('the account password never leaves the module', () => {
  const token = Buffer.from(`${EMAIL}:${SECRET_PASSWORD}`, 'utf8').toString('base64')

  /** Every form the secret could take in an echoed request. */
  const forbidden = [SECRET_PASSWORD, token, `Basic ${token}`]

  function assertClean(label: string, result: StreamableResult<unknown>): void {
    // Serialised whole, so a secret hidden in a `bodySnippet` or a nested field is
    // caught too - not just the top-level `message`.
    const serialised = JSON.stringify(result)
    for (const secret of forbidden) {
      expect(serialised, `${label} leaked a credential`).not.toContain(secret)
    }
    expect(errorOf(result).message.length).toBeGreaterThan(0)
  }

  it('keeps it out of every failure, including bodies that echo the request back', async () => {
    // A proxy, a captive portal or a careless error handler CAN echo a request - the
    // header line, the base64 token, or the decoded password - straight back in its
    // body, and that body ends up in an error message, in an IPC payload, in a public
    // repository's screenshots.
    const echo =
      `<html><body>Rejected request: Authorization: Basic ${token} ` +
      `(decoded ${EMAIL}:${SECRET_PASSWORD})</body></html>`

    const cases: readonly (readonly [string, StreamableResult<unknown>])[] = [
      [
        '401 echoing the header',
        await new StreamableClient({
          fetch: queuedFetch([httpResponse(401, echo)], []),
          openFile: fakeOpenFile(1024)
        }).upload(uploadArgs())
      ],
      [
        '500 echoing the header',
        await new StreamableClient({
          fetch: queuedFetch([httpResponse(500, echo)], []),
          openFile: fakeOpenFile(1024)
        }).upload(uploadArgs())
      ],
      [
        '200 with an unparseable body echoing the header',
        await new StreamableClient({
          fetch: queuedFetch([httpResponse(200, echo)], []),
          openFile: fakeOpenFile(1024)
        }).upload(uploadArgs())
      ],
      [
        'a JSON error message echoing the password',
        await new StreamableClient({
          fetch: queuedFetch([httpResponse(400, JSON.stringify({ message: echo }))], []),
          openFile: fakeOpenFile(1024)
        }).upload(uploadArgs())
      ],
      [
        'a transport error quoting the URL with credentials in it',
        await new StreamableClient({
          fetch: throwingFetch(new Error(`connect ECONNREFUSED (auth ${EMAIL}:${SECRET_PASSWORD})`), []),
          openFile: fakeOpenFile(1024)
        }).upload(uploadArgs())
      ],
      [
        'a filesystem error quoting the password',
        await new StreamableClient({
          fetch: queuedFetch([httpResponse(200, '{}')], []),
          openFile: async () => {
            throw new Error(`EACCES opening clip for ${EMAIL}:${SECRET_PASSWORD}`)
          }
        }).upload(uploadArgs())
      ],
      [
        'a poll that fails',
        await new StreamableClient({ fetch: queuedFetch([httpResponse(500, echo)], []) }).awaitReady(
          SHORTCODE,
          { email: EMAIL, password: SECRET_PASSWORD, pollIntervalMs: 5, maxWaitMs: 200 }
        )
      ],
      [
        'a credential check that fails',
        await new StreamableClient({ fetch: queuedFetch([httpResponse(401, echo)], []) }).testCredentials(
          EMAIL,
          SECRET_PASSWORD
        )
      ]
    ]

    for (const [label, result] of cases) assertClean(label, result)
  })

  it('never throws the password either - no method rejects at all', async () => {
    // A rejection would carry a stack and a message past every scrubbing point, and on
    // the death path it would become an unhandled rejection in the main process.
    const hostile: FetchLike = () => {
      throw new Error(`boom ${SECRET_PASSWORD}`)
    }
    const client = new StreamableClient({ fetch: hostile, openFile: fakeOpenFile(1024) })

    const results = [
      await client.upload(uploadArgs()),
      await client.awaitReady(SHORTCODE, { email: EMAIL, password: SECRET_PASSWORD, maxWaitMs: 50 }),
      await client.testCredentials(EMAIL, SECRET_PASSWORD)
    ]

    for (const result of results) {
      expect(result.ok).toBe(false)
      assertClean('a synchronous throw from fetch', result)
    }
  })

  it('scrubs every form of the credential, including regex metacharacters', () => {
    const secrets = credentialSecrets(EMAIL, SECRET_PASSWORD)
    const text = `a ${SECRET_PASSWORD} b ${token} c Basic ${token} d`

    const scrubbed = scrubSecrets(text, secrets)

    for (const secret of forbidden) expect(scrubbed).not.toContain(secret)
    expect(scrubbed).toContain('***')
    // An empty password must not turn every string into asterisks.
    expect(credentialSecrets(EMAIL, '')).toEqual([])
    expect(scrubSecrets('hello', credentialSecrets(EMAIL, ''))).toBe('hello')
  })
})

// ---------------------------------------------------------------------------
// Pure parsers
// ---------------------------------------------------------------------------

describe('defensive parsing helpers never throw', () => {
  it('parseShortcode narrows instead of casting', () => {
    expect(parseShortcode({ shortcode: 'ab12cd' })).toBe('ab12cd')
    expect(parseShortcode({ shortcode: '  ab12cd  ' })).toBe('ab12cd')
    expect(parseShortcode({ shortcode: 42 })).toBeNull()
    expect(parseShortcode({ shortcode: '' })).toBeNull()
    expect(parseShortcode({ shortcode: 'a/b' })).toBeNull()
    expect(parseShortcode({})).toBeNull()
    expect(parseShortcode(null)).toBeNull()
    expect(parseShortcode(undefined)).toBeNull()
    expect(parseShortcode([1, 2, 3])).toBeNull()
    expect(parseShortcode('a string')).toBeNull()
  })

  it('parseVideoStatus accepts only the four documented values', () => {
    expect(parseVideoStatus({ status: 0 })).toBe(0)
    expect(parseVideoStatus({ status: 2 })).toBe(2)
    expect(parseVideoStatus({ status: 3 })).toBe(3)
    expect(parseVideoStatus({ status: 4 })).toBeNull()
    expect(parseVideoStatus({ status: -1 })).toBeNull()
    expect(parseVideoStatus({ status: 1.5 })).toBeNull()
    // A numeric STRING is not a number: coercing here would be exactly the kind of
    // "helpful" narrowing that hides a changed API.
    expect(parseVideoStatus({ status: '2' })).toBeNull()
    expect(parseVideoStatus({ status: Number.NaN })).toBeNull()
    expect(parseVideoStatus(null)).toBeNull()
    expect(parseVideoStatus(undefined)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The default file seam, against a real file
// ---------------------------------------------------------------------------

describe('nodeOpenFile', () => {
  let dir = ''

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'poe-tool-streamable-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reports the real size and name, and yields readable bytes', async () => {
    // Proves the production seam works on this platform: `fs.openAsBlob` is what keeps
    // a 250 MB clip from being buffered into the main process's heap.
    const filePath = join(dir, 'Karui Shores.mkv')
    await writeFile(filePath, 'not really a video, but it has bytes')

    const source = await nodeOpenFile(filePath)

    expect(source.fileName).toBe('Karui Shores.mkv')
    expect(source.sizeBytes).toBe('not really a video, but it has bytes'.length)
    expect(source.blob.type).toBe('video/x-matroska')
    expect(await source.blob.text()).toBe('not really a video, but it has bytes')
  })

  it('rejects for a path that is not a file, so upload reports file-unreadable', async () => {
    await expect(nodeOpenFile(join(dir, 'nope.mkv'))).rejects.toThrow()
    await expect(nodeOpenFile(dir)).rejects.toThrow()
  })
})
