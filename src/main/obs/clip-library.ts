/**
 * src/main/obs/clip-library.ts
 * ============================
 *
 * Moves a clip that OBS just wrote into the user's poe-tool clips folder, renames it
 * to something sortable and human-readable, and (optionally) drops a metadata
 * sidecar next to it.
 *
 * NO `electron` IMPORT. The library directory arrives as a constructor argument -
 * `src/main/index.ts` is the only thing allowed to know that it came from
 * `app.getPath('videos')`. That is what makes this class testable against a real
 * temp directory under vitest.
 *
 *
 * THE FIVE THINGS THAT ACTUALLY GO WRONG HERE
 * -------------------------------------------
 * 1. REMOTE OBS. `settings.obs.host` may point at a second PC. OBS then reports a
 *    path on THAT machine's filesystem, which this process cannot see. Renaming it
 *    would either fail confusingly or - worse, if the path happens to resolve
 *    locally - move the wrong file. So we refuse, and say why. See `isRemoteObs`.
 *
 * 2. SEPARATE VOLUMES. The common streaming rig records to a fast NVMe and keeps the
 *    library on a bulk drive. `rename()` across volumes fails with `EXDEV`, so there
 *    is a streamed copy + verify + unlink fallback. The source is NEVER unlinked
 *    until the destination's size has been confirmed to match.
 *
 * 3. WINDOWS FILE LOCKS. OBS can hold the handle for a moment after it reports the
 *    replay was saved; antivirus and the Windows indexer also grab freshly written
 *    media files. That surfaces as `EBUSY`/`EPERM`/`EACCES`, and it is transient -
 *    hence the backoff retry. `sleep` is injectable so tests do not burn 2.5s.
 *
 * 4. COLLISIONS. Two deaths inside the same second in the same zone produce the same
 *    basename. The second one gets `-2`, and so on.
 *
 * 5. FAILURE IS NOT AN EXCEPTION. `moveClip` NEVER rejects and NEVER deletes a clip
 *    it could not place. Every failure path returns a `ClipRecord` with
 *    `moved: false`, `finalPath: null` and a human-readable `note`, leaving the file
 *    where OBS put it. `ClipRecord.finalPath === null` means "still at
 *    `originalPath`" - it never means "no clip".
 */

import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { pipeline } from 'node:stream/promises'

import type { CurrentZone, DeathCause } from '../../shared/events'
import type { ClipRecord } from '../../shared/ipc'
import { applyCollisionSuffix, buildClipBasename, extensionFromPath } from './clip-namer'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Delays between move attempts, in ms. Length + 1 is the attempt count, so this is
 * 5 attempts spread over 2.5s total - long enough to outlast an OBS handle or an
 * antivirus scan, short enough that a genuinely stuck file reports quickly.
 */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [150, 350, 750, 1250]

/**
 * Error codes worth retrying. All three mean "someone else has the file open right
 * now" on Windows; none of them mean the operation is invalid.
 *
 * Deliberately NOT including `ENOENT` (the file is gone - retrying cannot help) or
 * `EXDEV` (handled by the copy fallback, not by waiting).
 */
export const RETRYABLE_CODES: readonly string[] = ['EBUSY', 'EPERM', 'EACCES']

/**
 * Upper bound on the `-2`, `-3`, ... collision search before falling back to an
 * epoch-millisecond suffix. Purely a guard against an unbounded loop if `exists`
 * ever lies; 999 same-second clips in one zone is not a real scenario.
 */
const MAX_COLLISION_INDEX = 999

// ---------------------------------------------------------------------------
// Injected seams
// ---------------------------------------------------------------------------

/** Injected so tests can assert on backoff timing without actually waiting. */
export type SleepFn = (ms: number) => Promise<void>

const defaultSleep: SleepFn = (ms) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * The filesystem surface this class needs, as a swappable object.
 *
 * This exists so a test can replace exactly ONE operation - `rename` throwing
 * `EXDEV`, say - while every other call still hits the real disk in a real temp
 * directory. Mocking `node:fs/promises` wholesale would prove far less: the point of
 * the `EXDEV` test is that the copy really happens and the source really disappears.
 *
 * All members are plain function properties (never `this`-dependent methods) so
 * `{ ...nodeClipLibraryFs, rename: ... }` is a valid override.
 */
export interface ClipLibraryFs {
  readonly mkdirRecursive: (dir: string) => Promise<void>
  readonly rename: (source: string, destination: string) => Promise<void>
  /** Streamed copy - NOT `copyFile`. Clips are hundreds of MB; we will not buffer one. */
  readonly copyStreamed: (source: string, destination: string) => Promise<void>
  readonly sizeOf: (target: string) => Promise<number>
  readonly unlink: (target: string) => Promise<void>
  readonly exists: (target: string) => Promise<boolean>
  readonly writeTextFile: (target: string, contents: string) => Promise<void>
}

/** The real implementation, backed by `node:fs`. */
export const nodeClipLibraryFs: ClipLibraryFs = {
  mkdirRecursive: async (dir) => {
    await mkdir(dir, { recursive: true })
  },
  rename: async (source, destination) => {
    await rename(source, destination)
  },
  copyStreamed: async (source, destination) => {
    // `pipeline` closes both streams and propagates errors from either end, which
    // hand-rolled `.pipe()` does not.
    await pipeline(createReadStream(source), createWriteStream(destination))
  },
  sizeOf: async (target) => (await stat(target)).size,
  unlink: async (target) => {
    await unlink(target)
  },
  exists: async (target) => {
    try {
      await stat(target)
      return true
    } catch (error) {
      const code = errorCode(error)
      if (code === 'ENOENT' || code === 'ENOTDIR') return false
      throw error
    }
  },
  writeTextFile: async (target, contents) => {
    await writeFile(target, contents, 'utf8')
  }
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

/**
 * Node's `error.code` when there is one.
 *
 * Written against `unknown` rather than casting to `NodeJS.ErrnoException`: a catch
 * block can receive literally anything, including a rejected non-Error.
 */
function errorCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error
    return typeof code === 'string' ? code : null
  }
  return null
}

/** A message safe to put in a `ClipRecord.note` and render in the UI. Never throws. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = errorCode(error)
    return code === null ? error.message : `${code}: ${error.message}`
  }
  if (typeof error === 'string') return error
  return 'unknown error'
}

function isRetryable(error: unknown): boolean {
  const code = errorCode(error)
  return code !== null && RETRYABLE_CODES.includes(code)
}

/** Joins two optional notes into one sentence-ish string. */
function joinNotes(first: string | null, second: string | null): string | null {
  if (first === null) return second
  if (second === null) return first
  return `${first} ${second}`
}

// ---------------------------------------------------------------------------
// Public option/result shapes
// ---------------------------------------------------------------------------

/** Constructor extras. All optional; the defaults are the production behaviour. */
export interface ClipLibraryOptions {
  /** Swap the filesystem for a test double. Defaults to {@link nodeClipLibraryFs}. */
  readonly fs?: ClipLibraryFs
  /** Swap the backoff sleep. Defaults to a real `setTimeout`. */
  readonly sleep?: SleepFn
  /** Backoff schedule; attempt count is `length + 1`. Defaults to {@link DEFAULT_RETRY_DELAYS_MS}. */
  readonly retryDelaysMs?: readonly number[]
}

/** Everything {@link ClipLibrary.moveClip} needs about one saved replay. */
export interface MoveClipOptions {
  /** Absolute path OBS wrote the clip to. */
  readonly sourcePath: string
  /** Capture time; drives the filename stamp and `ClipRecord.savedAt`. */
  readonly when: Date
  /** Zone snapshot at capture time. Every field may be null - see `CurrentZone`. */
  readonly zone: CurrentZone
  /** Configured character name, `""` when unconfigured. Recorded, not put in the filename. */
  readonly characterName: string
  /**
   * Which kind of death produced this clip. Copied onto `ClipRecord.cause`; like
   * {@link characterName} it is recorded, never used in the filename.
   *
   * In practice always `'slain'`: the replay clipper drops a `'suicide'` (PoE's
   * `/kill`) at admission, so one never reaches a move. This library does not enforce
   * that - it files whatever it is handed - so do not read a record's `cause` as proof
   * of what the clipper's policy was at the time.
   */
  readonly cause: DeathCause
  /**
   * True when OBS is running on another machine, i.e. `sourcePath` is not this
   * machine's filesystem. Suppresses the move entirely.
   */
  readonly isRemoteObs: boolean
  /** Write a `<finalPath>.json` metadata sidecar alongside the clip. */
  readonly writeSidecar: boolean
}

/**
 * Contents of the `<clip>.json` sidecar.
 *
 * Note `seed` is here but NOT on `ClipRecord`: the IPC record is what the UI renders,
 * whereas the sidecar is the durable record for later tooling, and `seed === 1`
 * (non-procedural area, i.e. town/hideout) is exactly the sort of thing a "why did I
 * clip in town" script wants. This is also why {@link MoveClipOptions} takes the whole
 * `CurrentZone` rather than the three fields `ClipRecord` exposes.
 */
export interface ClipSidecar {
  /** Epoch ms, mirroring `ClipRecord.savedAt`. */
  readonly savedAt: number
  /** Same instant in ISO-8601, purely so the file is readable without tooling. */
  readonly savedAtIso: string | null
  readonly zoneName: string | null
  readonly areaId: string | null
  readonly areaLevel: number | null
  /** `1` means a non-procedural area (town/hideout). */
  readonly seed: number | null
  readonly characterName: string
  /** Where OBS originally wrote the file, before we moved it. */
  readonly originalPath: string
  /** Where the clip lives now. The sidecar itself is this path plus `.json`. */
  readonly finalPath: string
}

/** The `ClipRecord` fields that are known before the move is even attempted. */
type ClipRecordCore = Omit<ClipRecord, 'moved' | 'finalPath' | 'note'>

/** Internal result of the relocate step. `note` on success carries any warning. */
type RelocateOutcome =
  | { readonly ok: true; readonly note: string | null }
  | { readonly ok: false; readonly note: string }

// ---------------------------------------------------------------------------
// ClipLibrary
// ---------------------------------------------------------------------------

/**
 * Owns one clips directory.
 *
 * ```ts
 * const library = new ClipLibrary(settings.clips.libraryDir)
 * const record = await library.moveClip({ ... })
 * if (!record.moved) console.warn(record.note)  // the clip is still at record.originalPath
 * ```
 */
export class ClipLibrary {
  readonly #libraryDir: string
  readonly #fs: ClipLibraryFs
  readonly #sleep: SleepFn
  readonly #retryDelaysMs: readonly number[]

  /**
   * @param libraryDir Directory clips are moved into. Passed in (never read from
   * electron) so this class is usable under plain node and vitest. An empty/blank
   * value is treated as "not configured yet" - see `ClipSettings.libraryDir` - and
   * makes every move fail loudly rather than dumping clips in the process CWD.
   */
  constructor(libraryDir: string, options: ClipLibraryOptions = {}) {
    this.#libraryDir = libraryDir
    this.#fs = options.fs ?? nodeClipLibraryFs
    this.#sleep = options.sleep ?? defaultSleep
    this.#retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
  }

  /** The directory this instance manages. */
  get libraryDir(): string {
    return this.#libraryDir
  }

  /** Total move attempts before giving up: one initial try plus one per backoff delay. */
  get maxAttempts(): number {
    return this.#retryDelaysMs.length + 1
  }

  /**
   * Relocates one clip into the library.
   *
   * NEVER REJECTS. Every failure - remote OBS, unconfigured directory, a lock we
   * could not outwait, a cross-volume copy that did not verify - comes back as a
   * `ClipRecord` with `moved: false`, `finalPath: null` and an explanatory `note`,
   * with the original file untouched.
   *
   * A `moved: true` record may still carry a `note`: the clip made it into the
   * library, but something adjacent (deleting the cross-volume original, writing the
   * sidecar) needs the user's attention.
   */
  async moveClip(opts: MoveClipOptions): Promise<ClipRecord> {
    const core = this.#core(opts)

    // 1. Remote OBS: the path belongs to another machine. Refuse explicitly - a
    //    silent no-op would look identical to a successful move in the UI.
    if (opts.isRemoteObs) {
      return {
        ...core,
        moved: false,
        finalPath: null,
        note:
          'OBS is running on another machine, so the clip was saved to that machine\'s ' +
          `disk (${opts.sourcePath}) and cannot be moved from here. Copy it across manually, ` +
          'or point poe-tool at a local OBS.'
      }
    }

    // 2. `""` means "the videos directory has not been resolved yet", NOT the CWD.
    if (this.#libraryDir.trim() === '') {
      return {
        ...core,
        moved: false,
        finalPath: null,
        note: `No clips library directory is configured, so the clip was left at ${opts.sourcePath}.`
      }
    }

    try {
      return await this.#moveLocal(opts, core)
    } catch (error) {
      // Belt and braces: the steps below already convert their own failures into
      // records, so reaching here means something genuinely unexpected. Still not
      // allowed to reject - the caller is an event-bus listener on the tail path.
      return {
        ...core,
        moved: false,
        finalPath: null,
        note: `Clip move failed: ${describeError(error)}. The clip is still at ${opts.sourcePath}.`
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** The half of the record that does not depend on whether the move worked. */
  #core(opts: MoveClipOptions): ClipRecordCore {
    const stamp = opts.when.getTime()
    return {
      // An Invalid Date would poison the sort key, so fall back to "now".
      savedAt: Number.isNaN(stamp) ? Date.now() : stamp,
      originalPath: opts.sourcePath,
      zoneName: opts.zone.displayName,
      areaId: opts.zone.areaId,
      areaLevel: opts.zone.areaLevel,
      characterName: opts.characterName,
      cause: opts.cause
    }
  }

  async #moveLocal(opts: MoveClipOptions, core: ClipRecordCore): Promise<ClipRecord> {
    // mkdir FIRST: on a fresh install the library directory does not exist yet, and
    // both `rename` and the collision probe below would otherwise fail with ENOENT.
    try {
      await this.#fs.mkdirRecursive(this.#libraryDir)
    } catch (error) {
      return {
        ...core,
        moved: false,
        finalPath: null,
        note:
          `Could not create the clips library directory ${this.#libraryDir} ` +
          `(${describeError(error)}). The clip is still at ${opts.sourcePath}.`
      }
    }

    const basename = buildClipBasename({
      when: opts.when,
      zoneName: opts.zone.displayName,
      extension: extensionFromPath(opts.sourcePath)
    })
    const destination = await this.#resolveFreePath(basename)

    const outcome = await this.#relocate(opts.sourcePath, destination)
    if (!outcome.ok) {
      return { ...core, moved: false, finalPath: null, note: outcome.note }
    }

    let note = outcome.note
    if (opts.writeSidecar) {
      note = joinNotes(note, await this.#writeSidecar(destination, opts, core))
    }
    return { ...core, moved: true, finalPath: destination, note }
  }

  /**
   * First unused path for `basename`, suffixing `-2`, `-3`, ... before the extension.
   *
   * There is an unavoidable TOCTOU window between this probe and the rename. It does
   * not matter in practice: this process is the only writer to the library directory,
   * and clips are debounced (`settings.clips.debounceMs`) so two moves never overlap.
   */
  async #resolveFreePath(basename: string): Promise<string> {
    for (let index = 1; index <= MAX_COLLISION_INDEX; index++) {
      const candidate = path.join(this.#libraryDir, applyCollisionSuffix(basename, index))
      if (!(await this.#fs.exists(candidate))) return candidate
    }
    // Pathological fallback - unique by construction, ugly on purpose so it is
    // obvious in a directory listing that something is wrong.
    return path.join(this.#libraryDir, applyCollisionSuffix(basename, Date.now()))
  }

  /** Move with retries, converting a final failure into a note instead of throwing. */
  async #relocate(source: string, destination: string): Promise<RelocateOutcome> {
    try {
      const warning = await this.#withRetry(() => this.#attemptRelocate(source, destination))
      return { ok: true, note: warning }
    } catch (error) {
      // No attempt count in the message: a non-retryable failure gives up after one
      // try, and quoting "after 5 attempts" there would be a lie in a support log.
      return {
        ok: false,
        note:
          `Could not move the clip into ${this.#libraryDir}: ${describeError(error)}. ` +
          `The original file is untouched at ${source}.`
      }
    }
  }

  /**
   * One move attempt. Resolves to a warning string, or null when everything was clean.
   * Throws on failure so {@link #withRetry} can decide whether to try again.
   */
  async #attemptRelocate(source: string, destination: string): Promise<string | null> {
    try {
      await this.#fs.rename(source, destination)
      return null
    } catch (error) {
      // EXDEV = "cross-device link". Not a transient condition and not retryable:
      // rename will NEVER work between these two paths, so switch strategy.
      if (errorCode(error) !== 'EXDEV') throw error
    }
    return await this.#copyThenUnlink(source, destination)
  }

  /**
   * Cross-volume fallback: stream the bytes over, verify, then delete the original.
   *
   * THE ORDER IS THE POINT. The size check happens BEFORE the unlink, so a copy cut
   * short by a full disk or a yanked USB drive can never cost the user their clip -
   * the half-written destination is discarded and the source is left alone.
   *
   * A copy that THROWS part-way (ENOSPC on a filling disk, EFBIG writing a >4GB clip
   * to FAT32, a yanked drive) is the same failure and gets the same cleanup: without
   * it, a truncated file would be left in the library under the final clip name,
   * indistinguishable from a real clip in a directory listing, and it would burn the
   * collision namespace so a genuine retry of the same second/zone landed on `-2`.
   *
   * THE GUARD COVERS THE VERIFICATION TOO, not just the copy. Once bytes have been
   * written to `destination`, EVERY path out of this method that is not "the clip is
   * now in the library" has to remove them - and `sizeOf` is a `stat`, which is
   * exactly the call antivirus and the Windows indexer make fail with EPERM/EBUSY on
   * a file that was written a millisecond ago (see {@link RETRYABLE_CODES}). A throw
   * escaping the verification uncleaned is WORSE than the truncated-copy case it was
   * modelled on: the orphan is FULL SIZE, so it looks like a perfectly good clip in a
   * directory listing while the record says `moved: false` / `finalPath: null` and
   * sends the user back to the OBS path.
   */
  async #copyThenUnlink(source: string, destination: string): Promise<string | null> {
    try {
      await this.#fs.copyStreamed(source, destination)
    } catch (error) {
      await this.#discard(destination)
      throw error
    }

    // Stat both AFTER the copy: comparing against a size sampled beforehand would
    // false-positive on a file OBS is still flushing, and the failure mode we care
    // about (a truncated write) is only visible once the stream has ended.
    let sourceSize: number
    let destinationSize: number
    try {
      sourceSize = await this.#fs.sizeOf(source)
      destinationSize = await this.#fs.sizeOf(destination)
    } catch (error) {
      // Unverifiable is treated as unmoved: the source is still whole, so discarding
      // the copy costs nothing and is the only outcome that leaves the two ends of
      // this operation agreeing with each other.
      await this.#discard(destination)
      throw error
    }

    if (sourceSize !== destinationSize) {
      await this.#discard(destination)
      throw new Error(
        `cross-volume copy did not verify (source ${sourceSize} bytes, copy ${destinationSize} bytes)`
      )
    }

    try {
      await this.#withRetry(() => this.#fs.unlink(source))
      return null
    } catch (error) {
      // The clip IS in the library, so this is a success with a caveat, not a
      // failure. Reporting `moved: false` here would be a lie in the dangerous
      // direction: the UI would send the user back to a path we may yet delete.
      return (
        `The clip was copied into the library, but the original at ${source} could not be ` +
        `deleted (${describeError(error)}); remove it manually.`
      )
    }
  }

  /** Best-effort cleanup of a partial destination. Swallows errors by design. */
  async #discard(target: string): Promise<void> {
    try {
      await this.#fs.unlink(target)
    } catch {
      // Nothing useful to do: we are already on a failure path, and the caller's
      // error is the one worth surfacing.
    }
  }

  /**
   * Runs `action`, retrying only on {@link RETRYABLE_CODES} (Windows file locks),
   * sleeping {@link DEFAULT_RETRY_DELAYS_MS} between attempts.
   *
   * A non-retryable error (ENOENT, ENOSPC, a bad path) is rethrown immediately -
   * waiting 2.5s to report a missing file would be pure latency.
   */
  async #withRetry<T>(action: () => Promise<T>): Promise<T> {
    const attempts = this.maxAttempts
    for (let attempt = 1; ; attempt++) {
      try {
        return await action()
      } catch (error) {
        if (attempt >= attempts || !isRetryable(error)) throw error
        // `?? 0` satisfies noUncheckedIndexedAccess; the index is in range by
        // construction (attempt <= retryDelaysMs.length whenever we get here).
        await this.#sleep(this.#retryDelaysMs[attempt - 1] ?? 0)
      }
    }
  }

  /**
   * Writes `<finalPath>.json`. Returns a note on failure - a missing sidecar must
   * never downgrade a successful move.
   */
  async #writeSidecar(
    finalPath: string,
    opts: MoveClipOptions,
    core: ClipRecordCore
  ): Promise<string | null> {
    const sidecar: ClipSidecar = {
      savedAt: core.savedAt,
      savedAtIso: toIso(core.savedAt),
      zoneName: opts.zone.displayName,
      areaId: opts.zone.areaId,
      areaLevel: opts.zone.areaLevel,
      seed: opts.zone.seed,
      characterName: opts.characterName,
      originalPath: opts.sourcePath,
      finalPath
    }
    const sidecarPath = `${finalPath}.json`
    try {
      await this.#fs.writeTextFile(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`)
      return null
    } catch (error) {
      return `The clip moved, but its sidecar ${sidecarPath} could not be written (${describeError(error)}).`
    }
  }
}

/** `Date#toISOString` throws on an out-of-range instant, so this stays defensive. */
function toIso(epochMs: number): string | null {
  const when = new Date(epochMs)
  if (Number.isNaN(when.getTime())) return null
  return when.toISOString()
}
