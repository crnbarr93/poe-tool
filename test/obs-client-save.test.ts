/**
 * test/obs-client-save.test.ts
 * ============================
 *
 * `ObsClient.saveReplayBuffer()` is the one place in the app where a REQUEST and the
 * EVENT that answers it are not linked by anything: obs-websocket v5 answers
 * `SaveReplayBuffer` with `undefined` and reports the filename later, on a
 * `ReplayBufferSaved` event that carries no request id. Whatever this method decides
 * is "my clip" gets renamed and moved into the user's library, so a wrong decision
 * moves someone else's file.
 *
 * Driven through the `createSocket` seam with a hand-written fake socket - no mocking
 * library, per the project constraints - because the interesting cases (a straggling
 * event from an abandoned save, an event repeating a path we already returned) cannot
 * be staged against a real OBS at all.
 *
 * Timeouts are set in tens of milliseconds rather than faked, because the code under
 * test races `withTimeout` against event delivery and fake timers would hide exactly
 * the ordering this file is about.
 */

import { describe, expect, it } from 'vitest'

import type { OBSRequestTypes, OBSResponseTypes } from 'obs-websocket-js'

import { ObsClient, type ObsSocket, type ObsSocketEventMap } from '../src/main/obs/obs-client'

// ---------------------------------------------------------------------------
// Fake socket
// ---------------------------------------------------------------------------

type SavedListener = (payload: ObsSocketEventMap['ReplayBufferSaved']) => void

/** Minimal, deterministic stand-in for `OBSWebSocket`. */
class FakeSocket implements ObsSocket {
  readonly requests: string[] = []
  readonly #saved = new Set<SavedListener>()

  /** Extra delay before `SaveReplayBuffer` resolves, i.e. a busy OBS. */
  saveAckDelayMs = 0
  /** Non-null makes `SaveReplayBuffer` reject the way obs-websocket does. */
  saveError: unknown = null

  async connect(): Promise<unknown> {
    return undefined
  }

  async disconnect(): Promise<void> {
    // Nothing to close.
  }

  async call<Type extends keyof OBSRequestTypes>(requestType: Type): Promise<OBSResponseTypes[Type]> {
    const name = String(requestType)
    this.requests.push(name)

    if (name === 'SaveReplayBuffer') {
      if (this.saveAckDelayMs > 0) await sleep(this.saveAckDelayMs)
      if (this.saveError !== null) throw this.saveError
      return undefined as unknown as OBSResponseTypes[Type]
    }
    if (name === 'GetVersion') {
      return { obsVersion: '31.0.0', obsWebSocketVersion: '5.5.0' } as unknown as OBSResponseTypes[Type]
    }
    if (name === 'GetReplayBufferStatus') {
      return { outputActive: true } as unknown as OBSResponseTypes[Type]
    }
    return undefined as unknown as OBSResponseTypes[Type]
  }

  on(event: keyof ObsSocketEventMap, listener: (payload: never) => void): unknown {
    if (event === 'ReplayBufferSaved') this.#saved.add(listener as SavedListener)
    return this
  }

  off(event: keyof ObsSocketEventMap, listener: (payload: never) => void): unknown {
    if (event === 'ReplayBufferSaved') this.#saved.delete(listener as SavedListener)
    return this
  }

  removeAllListeners(): unknown {
    this.#saved.clear()
    return this
  }

  /** How many `ReplayBufferSaved` handlers are attached right now. */
  get savedListenerCount(): number {
    return this.#saved.size
  }

  /** Delivers a `ReplayBufferSaved` exactly as OBS would. */
  emitSaved(savedReplayPath: string): void {
    for (const listener of [...this.#saved]) listener({ savedReplayPath })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

interface Harness {
  readonly client: ObsClient
  readonly socket: FakeSocket
}

/** A connected client over a fake socket, with short but real timeouts. */
async function connected(overrides: { saveTimeoutMs?: number; requestTimeoutMs?: number } = {}): Promise<Harness> {
  const socket = new FakeSocket()
  const client = new ObsClient({
    createSocket: () => socket,
    connectTimeoutMs: 500,
    requestTimeoutMs: overrides.requestTimeoutMs ?? 200,
    saveTimeoutMs: overrides.saveTimeoutMs ?? 60
  })
  const state = await client.connect({ host: '127.0.0.1', port: 4455, password: '' })
  expect(state.state).toBe('connected')
  expect(client.connected).toBe(true)
  return { client, socket }
}

// ---------------------------------------------------------------------------
// Correlation
// ---------------------------------------------------------------------------

describe('ObsClient.saveReplayBuffer - which ReplayBufferSaved is mine', () => {
  it('resolves with the path OBS reports for the save it requested', async () => {
    const { client, socket } = await connected()

    const pending = client.saveReplayBuffer()
    await sleep(5)
    socket.emitSaved('C:\\OBS\\Replay A.mkv')

    const result = await pending
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected a saved clip')
    expect(result.value.savedReplayPath).toBe('C:\\OBS\\Replay A.mkv')
    // No listener left behind: repeated deaths must not pile up handlers.
    expect(socket.savedListenerCount).toBe(0)
  })

  it('never hands a later save the clip of an earlier, abandoned one', async () => {
    // REGRESSION: the first `ReplayBufferSaved` seen after a save was requested used
    // to be claimed unconditionally. A save that gave up (a busy OBS, a slow flush)
    // left its event ownerless, and the NEXT death's save adopted it - renaming clip
    // A to death B's name, moving it out of the OBS folder, and leaving death B's
    // real clip uncatalogued.
    const { client, socket } = await connected({ saveTimeoutMs: 40 })

    // Save 1: accepted, but OBS reports nothing in time.
    const first = await client.saveReplayBuffer()
    expect(first.ok).toBe(false)
    if (first.ok) throw new Error('expected the first save to time out')
    expect(first.error.kind).toBe('save-timeout')

    // The straggler finally arrives. It belongs to save 1 and must be consumed here,
    // not left lying around for the next caller.
    socket.emitSaved('C:\\OBS\\Replay A.mkv')

    // Save 2, for a completely different death.
    const second = client.saveReplayBuffer()
    await sleep(5)
    // A re-emit of A must be ignored...
    socket.emitSaved('C:\\OBS\\Replay A.mkv')
    await sleep(5)
    // ...and only OBS's report for THIS save may be accepted.
    socket.emitSaved('C:\\OBS\\Replay B.mkv')

    const result = await second
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected the second save to succeed')
    expect(result.value.savedReplayPath).toBe('C:\\OBS\\Replay B.mkv')
  })

  it('ignores a repeat of a path it has already returned', async () => {
    const { client, socket } = await connected({ saveTimeoutMs: 40 })

    const first = client.saveReplayBuffer()
    await sleep(5)
    socket.emitSaved('C:\\OBS\\Replay A.mkv')
    expect((await first).ok).toBe(true)

    // OBS re-emitting the same file is not a second clip - clip filenames are
    // timestamped, so a repeat always means "already dealt with".
    const second = client.saveReplayBuffer()
    await sleep(5)
    socket.emitSaved('C:\\OBS\\Replay A.mkv')

    const result = await second
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected the duplicate path to be refused')
    expect(result.error.kind).toBe('save-timeout')
  })

  it('waits for the file even when OBS is slow to acknowledge the request', async () => {
    // The request round trip used to be capped at the (much shorter) request
    // timeout, so a busy OBS turned a save that WAS going to land into an abandoned
    // one - which is what produces an ownerless event in the first place.
    const { client, socket } = await connected({ requestTimeoutMs: 10, saveTimeoutMs: 200 })
    socket.saveAckDelayMs = 40

    const pending = client.saveReplayBuffer()
    await sleep(60)
    socket.emitSaved('C:\\OBS\\Replay Slow.mkv')

    const result = await pending
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected the slow save to succeed')
    expect(result.value.savedReplayPath).toBe('C:\\OBS\\Replay Slow.mkv')
  })

  it('reports the replay buffer being off without waiting for any event', async () => {
    const { client, socket } = await connected()
    socket.saveError = { code: 501, message: 'output not running' }

    const result = await client.saveReplayBuffer()

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected the save to be refused')
    expect(result.error.kind).toBe('buffer-inactive')
  })

  it('refuses to save at all when there is no live socket', async () => {
    const client = new ObsClient({ createSocket: () => new FakeSocket() })

    const result = await client.saveReplayBuffer()

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected not-connected')
    expect(result.error.kind).toBe('not-connected')
  })
})
