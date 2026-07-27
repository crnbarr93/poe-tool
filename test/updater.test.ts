/**
 * test/updater.test.ts
 * ====================
 *
 * The auto-updater's WIRING - the half `test/update-state.test.ts` deliberately leaves
 * alone. That file drives the pure reducer with no mocks at all; this one drives
 * `src/main/updater.ts` itself, which means both `electron` and `electron-updater` are
 * mocked module-wide.
 *
 * WHAT IS WORTH MOCKING A LIBRARY FOR
 * -----------------------------------
 * Nothing here asserts that electron-updater downloads anything - that would only prove
 * the mock behaves like the mock. What it asserts is the set of promises `AppUpdater`
 * makes to the REST OF THE APP, each of which is a claim about how it treats a hostile
 * library:
 *
 *   RULE 1  an unpackaged build never even ACCESSES the `autoUpdater` export;
 *   RULE 2  no failure of any kind escapes as a throw or an unhandled rejection;
 *   RULE 2  the `'error'` listener is registered before anything else;
 *           `dispose()` removes every listener it put on the singleton.
 *
 * THE MOCK MIRRORS THE ONE STRUCTURAL DETAIL THAT MATTERS: `autoUpdater` is a LAZY
 * GETTER which constructs a platform updater on first property access, and that
 * construction can throw (electron-updater's `AppUpdater` constructor rejects an app
 * version that is not valid semver - `"0.2"` packages fine and detonates on the user's
 * machine). So the mock exports a getter too, counts accesses, and can be told to throw
 * on the Nth one. A plain object would have made both of those untestable.
 *
 * The singleton itself is a hand-rolled emitter rather than node's: `vi.hoisted` runs
 * before the import section, so `EventEmitter` is not in scope there, and a hand-rolled
 * one lets a test read the listener registry directly - which is exactly what "every
 * `on` has a matching `off`" needs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { UpdateState } from '../src/shared/ipc'

// ---------------------------------------------------------------------------
// The mocked modules
// ---------------------------------------------------------------------------

const { harness } = vi.hoisted(() => {
  /** Channel -> listeners, in registration order, duplicates preserved. */
  const listeners = new Map<string, Array<(...args: never[]) => void>>()

  /** Channels in the order they were FIRST subscribed. `'error'` must be index 0. */
  const registrationOrder: string[] = []

  const control = {
    /** Backs `app.isPackaged`. */
    packaged: true,
    /** How many times the `autoUpdater` getter has been read. */
    accesses: 0,
    /**
     * 1-based access index that should throw instead of returning the singleton, or
     * null for "never throw". Models construction-on-first-access failing.
     */
    throwOnAccess: null as number | null,
    /** What `checkForUpdates()` does. Replaced per test. */
    checkForUpdates: (): Promise<unknown> => Promise.resolve(null)
  }

  const singleton = {
    on(channel: string, listener: (...args: never[]) => void): void {
      const existing = listeners.get(channel)
      if (existing === undefined) {
        listeners.set(channel, [listener])
        registrationOrder.push(channel)
      } else {
        existing.push(listener)
      }
    },
    off(channel: string, listener: (...args: never[]) => void): void {
      const existing = listeners.get(channel)
      if (existing === undefined) return
      const at = existing.indexOf(listener)
      if (at >= 0) existing.splice(at, 1)
      if (existing.length === 0) listeners.delete(channel)
    },
    /** Delivers to a COPY, so a listener that detaches itself cannot skip a sibling. */
    emit(channel: string, ...args: never[]): void {
      const existing = listeners.get(channel)
      if (existing === undefined) return
      for (const listener of [...existing]) listener(...args)
    },
    checkForUpdates(): Promise<unknown> {
      return control.checkForUpdates()
    }
  }

  return {
    harness: {
      control,
      listeners,
      registrationOrder,
      singleton,
      reset(): void {
        listeners.clear()
        registrationOrder.length = 0
        control.packaged = true
        control.accesses = 0
        control.throwOnAccess = null
        control.checkForUpdates = (): Promise<unknown> => Promise.resolve(null)
      },
      /** Total live listeners across every channel. Zero after a correct `dispose()`. */
      listenerCount(): number {
        let total = 0
        for (const list of listeners.values()) total += list.length
        return total
      }
    }
  }
})

vi.mock('electron', () => ({
  app: {
    get isPackaged(): boolean {
      return harness.control.packaged
    }
  }
}))

vi.mock('electron-updater', () => ({
  // A GETTER, exactly like the real export - see this file's header.
  get autoUpdater(): unknown {
    harness.control.accesses += 1
    if (harness.control.throwOnAccess === harness.control.accesses) {
      throw new Error('App version is not a valid semver version: "0.2"')
    }
    return harness.singleton
  }
}))

// Imported AFTER the mocks are declared; `vi.mock` is hoisted, so this still sees them.
import { AppUpdater } from '../src/main/updater'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** One call to the `onError` / `onInfo` hooks. */
interface HookCall {
  readonly value: unknown
  readonly context: string
}

interface Built {
  readonly updater: AppUpdater
  readonly errors: HookCall[]
  readonly infos: HookCall[]
  readonly states: UpdateState[]
}

/** Every updater built in the current test, disposed by the shared `afterEach`. */
const live: AppUpdater[] = []

function build(): Built {
  const errors: HookCall[] = []
  const infos: HookCall[] = []
  const states: UpdateState[] = []

  const updater = new AppUpdater({
    onError: (value, context) => {
      errors.push({ value, context })
    },
    onInfo: (value, context) => {
      infos.push({ value, context })
    }
  })
  live.push(updater)
  updater.on('state', (state) => {
    states.push(state)
  })

  return { updater, errors, infos, states }
}

/** Contexts of every `onError` call, for terse assertions. */
function contexts(calls: readonly HookCall[]): string[] {
  return calls.map((call) => call.context)
}

/**
 * Lets node run its unhandled-rejection detection, which fires on a macrotask AFTER the
 * microtask queue drains. Two turns, because the promise under test is itself chained.
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Unhandled rejections seen during a test. MUST stay empty - see RULE 2. */
let unhandled: unknown[] = []

function onUnhandled(reason: unknown): void {
  unhandled.push(reason)
}

beforeEach(() => {
  harness.reset()
  unhandled = []
  process.on('unhandledRejection', onUnhandled)
})

afterEach(() => {
  process.off('unhandledRejection', onUnhandled)
  for (const updater of live.splice(0)) updater.dispose()
})

// ---------------------------------------------------------------------------
// RULE 1: nothing at all when the build is not packaged
// ---------------------------------------------------------------------------

describe('AppUpdater, unpackaged', () => {
  it('never touches the autoUpdater export', async () => {
    harness.control.packaged = false

    const { updater, infos } = build()
    await updater.checkOnLaunch()

    // The whole point of RULE 1: not "it skipped the check" but "it never even read the
    // export", because reading it constructs a platform updater.
    expect(harness.control.accesses).toBe(0)
    expect(harness.listenerCount()).toBe(0)
    expect(updater.enabled).toBe(false)
    expect(updater.state).toEqual({ state: 'disabled-in-dev' })
    // Narrated through onInfo, NOT onError - a dev build is not a defect.
    expect(contexts(infos)).toEqual(['disabled-in-dev'])
  })
})

// ---------------------------------------------------------------------------
// RULE 2: wiring
// ---------------------------------------------------------------------------

describe('AppUpdater, packaged', () => {
  it("subscribes 'error' before anything else and before any assignment", () => {
    const { updater } = build()

    expect(updater.enabled).toBe(true)
    expect(harness.registrationOrder[0]).toBe('error')
    // The first read of the export - the one that would construct the real updater -
    // is the `on('error')` call itself, so the singleton never exists without a handler.
    expect(harness.control.accesses).toBeGreaterThan(0)
    expect(updater.state).toEqual({ state: 'idle' })
  })

  it('removes every listener it attached on dispose', () => {
    const { updater } = build()
    expect(harness.listenerCount()).toBeGreaterThan(0)

    updater.dispose()
    expect(harness.listenerCount()).toBe(0)

    // Idempotent, and a second call must not throw.
    expect(() => {
      updater.dispose()
    }).not.toThrow()
  })

  it("turns an emitted 'error' into an error state instead of rethrowing", () => {
    const { updater, errors, states } = build()

    harness.singleton.emit('error', new Error('getaddrinfo ENOTFOUND github.com') as never)

    expect(updater.state).toEqual({
      state: 'error',
      message: 'getaddrinfo ENOTFOUND github.com'
    })
    expect(states).toHaveLength(1)
    expect(contexts(errors)).toEqual(['updater-event'])
  })
})

// ---------------------------------------------------------------------------
// RULE 2: the check and the download it starts
// ---------------------------------------------------------------------------

describe('AppUpdater.checkOnLaunch', () => {
  it('never rejects when the check rejects, and reports it once', async () => {
    harness.control.checkForUpdates = (): Promise<unknown> =>
      Promise.reject(new Error('HttpError: 403'))

    const { updater, errors } = build()
    await expect(updater.checkOnLaunch()).resolves.toBeUndefined()
    await settle()

    expect(contexts(errors)).toEqual(['check'])
    expect(unhandled).toEqual([])
  })

  /**
   * THE REGRESSION THIS FILE EXISTS FOR.
   *
   * With `autoDownload = true`, a successful check hands back `downloadPromise` - the
   * download electron-updater has ALREADY started - and attaches nothing to it in the
   * auto path. Discarding the result therefore leaves a live promise that becomes an
   * unhandled rejection the moment the network, GitHub or the disk lets go part way
   * through, which is an every-week occurrence rather than an exotic one.
   */
  it('catches the auto-download promise the check hands back', async () => {
    const download = Promise.reject(new Error('net::ERR_INTERNET_DISCONNECTED'))
    harness.control.checkForUpdates = (): Promise<unknown> =>
      Promise.resolve({
        isUpdateAvailable: true,
        updateInfo: { version: '0.2.0' },
        versionInfo: { version: '0.2.0' },
        downloadPromise: download
      })

    const { updater, errors } = build()

    // Resolves when the CHECK settles - it must not wait for the download.
    await expect(updater.checkOnLaunch()).resolves.toBeUndefined()
    await settle()

    expect(contexts(errors)).toEqual(['download'])
    expect(unhandled).toEqual([])
  })

  it('is quiet when there is no update and therefore no download promise', async () => {
    harness.control.checkForUpdates = (): Promise<unknown> =>
      Promise.resolve({
        isUpdateAvailable: false,
        updateInfo: { version: '0.1.0' },
        versionInfo: { version: '0.1.0' },
        downloadPromise: null
      })

    const { updater, errors } = build()
    await updater.checkOnLaunch()
    await settle()

    expect(errors).toEqual([])
    expect(unhandled).toEqual([])
  })

  it('is quiet when the download succeeds', async () => {
    harness.control.checkForUpdates = (): Promise<unknown> =>
      Promise.resolve({
        isUpdateAvailable: true,
        updateInfo: { version: '0.2.0' },
        versionInfo: { version: '0.2.0' },
        downloadPromise: Promise.resolve(['C:\\Users\\x\\poe-tool Setup 0.2.0.exe'])
      })

    const { updater, errors } = build()
    await updater.checkOnLaunch()
    await settle()

    expect(errors).toEqual([])
    expect(unhandled).toEqual([])
  })

  it('does nothing at all after dispose', async () => {
    const { updater } = build()
    updater.dispose()

    const before = harness.control.accesses
    await updater.checkOnLaunch()

    expect(harness.control.accesses).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// RULE 2: a throw out of the constructor
// ---------------------------------------------------------------------------

describe('AppUpdater, when electron-updater cannot even be constructed', () => {
  /**
   * THE SECOND REGRESSION THIS FILE EXISTS FOR.
   *
   * `new AppUpdater()` runs inside `createServices()` in `src/main/index.ts`, whose
   * catch abandons the whole bootstrap: no window, no log tailing, no clipping, and a
   * process still holding the single-instance lock so relaunching does nothing either.
   * A shipped `"version": "0.2"` is enough to trigger it, and electron-builder will not
   * stop that version from being packaged. The updater must never be able to do that.
   */
  it('does not throw out of the constructor when the first access throws', () => {
    harness.control.throwOnAccess = 1

    // Called directly, NOT through `expect(...).not.toThrow()`: if the constructor ever
    // throws again, this line fails the test with the real error and the real stack,
    // which is the thing a future reader needs to see.
    const { updater, errors } = build()

    expect(updater.state).toEqual({
      state: 'error',
      message: 'App version is not a valid semver version: "0.2"'
    })
    expect(contexts(errors)).toContain('attach')
    expect(harness.listenerCount()).toBe(0)
  })

  it('cleans up the listeners it managed to attach before the throw', () => {
    // Access 1 registers the 'error' listener; access 2 is the first property
    // assignment, so the instance is half-attached when it blows up.
    harness.control.throwOnAccess = 2

    const { updater, errors } = build()

    expect(updater.state.state).toBe('error')
    expect(contexts(errors)).toContain('attach')
    // Half-attached must still mean fully detached.
    expect(harness.listenerCount()).toBe(0)
  })

  it('runs no network check afterwards', async () => {
    harness.control.throwOnAccess = 1
    let checked = 0
    harness.control.checkForUpdates = (): Promise<unknown> => {
      checked += 1
      return Promise.resolve(null)
    }

    const { updater } = build()
    await expect(updater.checkOnLaunch()).resolves.toBeUndefined()

    expect(checked).toBe(0)
    expect(unhandled).toEqual([])
  })

  it('stays disposable and keeps reporting its state', () => {
    harness.control.throwOnAccess = 1
    const { updater } = build()

    expect(() => {
      updater.dispose()
    }).not.toThrow()
    // `update:state` is an invoke channel: whatever the UI asks after this must still be
    // a renderable state, not a throw.
    expect(updater.state.state).toBe('error')
  })
})
