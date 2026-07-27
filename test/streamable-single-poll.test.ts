/**
 * test/streamable-single-poll.test.ts
 * ===================================
 *
 * PINS THE CONTRACT `src/main/index.ts`'s `getVideoStatus` ADAPTER IS BUILT ON.
 *
 * WHY THIS FILE EXISTS, given that `test/streamable-client.test.ts` already covers
 * `awaitReady` thoroughly: the adapter that joins `StreamableClient` to `UploadQueue`
 * lives in `src/main/index.ts`, which imports electron and therefore cannot be imported
 * here. So the wiring itself is untestable, and the next best thing is to pin the four
 * behaviours it silently depends on - each of which is an ordinary implementation detail
 * of `awaitReady` from that module's own point of view, and any of which could be
 * "tidied up" without a single existing test going red.
 *
 * THE PROBLEM THE ADAPTER SOLVES. `UploadClient.getVideoStatus` is specified as ONE poll
 * - the queue owns the schedule (`maxStatusPolls`, `statusPollIntervalMs`) and calls it
 * in a loop. `StreamableClient.awaitReady` is itself a polling loop. Nesting the two
 * would multiply into hundreds of requests to a third party per clip, which is how an app
 * earns a rate limit. The adapter collapses the inner loop with `maxWaitMs: 0`, and that
 * one option is load-bearing for everything below.
 *
 * THE FOUR ASSUMPTIONS, and what breaks if one stops holding:
 *
 *  1. `maxWaitMs: 0` issues EXACTLY ONE request. If it ever issued two, every status
 *     check would silently double the request count against Streamable.
 *  2. A video that is still transcoding comes back as a `timeout` error CARRYING THE
 *     SHORTCODE, with the numeric status delivered through `onStatus` on the way past.
 *     The adapter reads that as the ordinary in-progress answer and maps it to the
 *     readiness word `processing`/`uploading`. If the shortcode stopped being carried,
 *     every in-progress poll would be reported to the user as a failed upload.
 *  3. A GENUINE WIRE TIMEOUT carries `shortcode: null`. This is the discriminator the
 *     adapter uses to tell "Streamable is still working" from "we never got an answer" -
 *     the first is data, the second is a transient failure the queue should keep polling
 *     through. Collapse the two and a flaky connection would look like a finished video.
 *  4. `status: 3` surfaces as `processing-failed`, which the adapter intercepts and
 *     reports as the readiness word `error` rather than letting it fall through to the
 *     error mapper - where it would become `bad-response` and tell the user poe-tool
 *     needs an update, when in fact Streamable's transcode failed.
 *
 * OFFLINE, like every other test here: `fetch` is injected, so nothing leaves the
 * machine and no timing is real.
 */

import { describe, expect, it } from 'vitest'

import { StreamableClient, type FetchLike } from '../src/main/upload/streamable-client'

/** A transport that answers every request identically and counts the calls. */
function fetchReturning(status: number, body: string): { fn: FetchLike; calls: string[] } {
  const calls: string[] = []
  const fn: FetchLike = async (url) => {
    calls.push(url)
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (): string | null => null },
      text: async () => body
    }
  }
  return { fn, calls }
}

describe('awaitReady with maxWaitMs: 0 - the single-poll contract', () => {
  it('issues exactly ONE request while the video is still processing, and reports the status', async () => {
    const { fn, calls } = fetchReturning(200, JSON.stringify({ status: 1 }))
    const client = new StreamableClient({ fetch: fn })

    const seen: number[] = []
    const result = await client.awaitReady('abc123', {
      maxWaitMs: 0,
      onStatus: (status) => {
        seen.push(status)
      }
    })

    expect(calls).toHaveLength(1)
    // The status reaches the caller even though the call "failed" - this is how the
    // adapter recovers `processing` vs `uploading`.
    expect(seen).toEqual([1])
    expect(result.ok).toBe(false)
    if (!result.ok && result.error.kind === 'timeout') {
      // ASSUMPTION 2: a shortcode means "still working", not "lost".
      expect(result.error.shortcode).toBe('abc123')
    } else {
      expect.unreachable('expected a timeout carrying the shortcode')
    }
  })

  it('issues ONE request and reports NO status for a 404, which means "not visible yet"', async () => {
    const { fn, calls } = fetchReturning(404, 'not found')
    const client = new StreamableClient({ fetch: fn })

    const seen: number[] = []
    const result = await client.awaitReady('abc123', {
      maxWaitMs: 0,
      onStatus: (status) => {
        seen.push(status)
      }
    })

    expect(calls).toHaveLength(1)
    // No number at all - which is why the adapter's `readinessFromStatus` has to accept
    // `undefined` and answer `uploading` rather than assuming a status was observed.
    expect(seen).toEqual([])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('timeout')
  })

  it('resolves ok on status 2, in one request', async () => {
    const { fn, calls } = fetchReturning(200, JSON.stringify({ status: 2 }))
    const client = new StreamableClient({ fetch: fn })

    const result = await client.awaitReady('abc123', { maxWaitMs: 0 })

    expect(calls).toHaveLength(1)
    expect(result.ok).toBe(true)
  })

  it('reports status 3 as processing-failed, not as an unparseable response', async () => {
    const { fn } = fetchReturning(200, JSON.stringify({ status: 3, message: 'transcode died' }))
    const client = new StreamableClient({ fetch: fn })

    const result = await client.awaitReady('abc123', { maxWaitMs: 0 })

    expect(result.ok).toBe(false)
    // ASSUMPTION 4. Were this to become `unexpected-response`, the adapter would map it
    // to `bad-response` and the user would be told poe-tool needs an update.
    if (!result.ok) expect(result.error.kind).toBe('processing-failed')
  })

  it('a genuine wire timeout carries NO shortcode, so the two timeouts stay tellable apart', async () => {
    const client = new StreamableClient({
      // Never answers; the client's own request timeout is what fires.
      fetch: async (_url, request) => {
        await new Promise<void>((resolve) => {
          request.signal.addEventListener('abort', () => {
            resolve()
          }, { once: true })
        })
        const error = new Error('aborted')
        error.name = 'AbortError'
        throw error
      }
    })

    const result = await client.awaitReady('abc123', { maxWaitMs: 5_000, requestTimeoutMs: 5 })

    expect(result.ok).toBe(false)
    if (!result.ok && result.error.kind === 'timeout') {
      // ASSUMPTION 3: null here is what makes the adapter treat this as a transient
      // failure to keep polling through, rather than as "still processing".
      expect(result.error.shortcode).toBeNull()
    } else {
      expect.unreachable('expected a timeout with no shortcode')
    }
  })
})
