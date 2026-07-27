/**
 * test/clip-library.test.ts
 * =========================
 *
 * Integration-flavoured tests for the clip mover, against REAL temp directories.
 *
 * The filesystem seam (`ClipLibraryFs`) is only ever partially overridden:
 * `{ ...nodeClipLibraryFs, rename: failTwiceThenSucceed }` keeps the streamed copy,
 * the size verification and the unlink hitting real files, so an assertion like
 * "the source is gone and the destination has the same bytes" actually means
 * something. Fully mocking `node:fs` would only prove that the mock was called.
 *
 * `sleep` is injected everywhere so the 2.5s backoff costs nothing, while still
 * letting us assert the exact schedule that WOULD have been used.
 */

import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { CurrentZone } from '../src/shared/events'
import {
  ClipLibrary,
  DEFAULT_RETRY_DELAYS_MS,
  nodeClipLibraryFs,
  type ClipLibraryFs,
  type ClipSidecar,
  type SleepFn
} from '../src/main/obs/clip-library'

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

/** Local-time constructor keeps the expected filename timezone-independent. */
const WHEN = new Date(2026, 6, 26, 19, 26, 31)
const EXPECTED_NAME = '2026-07-26_19-26-31_Karui-Shores.mkv'

const KARUI_SHORES: CurrentZone = {
  displayName: 'Karui Shores',
  areaId: '2_11_endgame_town',
  areaLevel: 69,
  seed: 1,
  enteredAt: 1_700_000_000_000
}

const UNKNOWN_ZONE: CurrentZone = {
  displayName: null,
  areaId: null,
  areaLevel: null,
  seed: null,
  enteredAt: 1_700_000_000_000
}

const CLIP_BYTES = 'pretend this is 300MB of matroska'

interface CodedError extends Error {
  code?: string
}

function codedError(code: string): CodedError {
  const error: CodedError = new Error(`simulated ${code}`)
  error.code = code
  return error
}

interface SleepRecorder {
  readonly delays: number[]
  readonly sleep: SleepFn
}

function recordSleeps(): SleepRecorder {
  const delays: number[] = []
  return {
    delays,
    sleep: async (ms) => {
      delays.push(ms)
    }
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

let root = ''
let obsDir = ''
let libraryDir = ''

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'poe-tool-cliplib-'))
  obsDir = path.join(root, 'obs-recordings')
  // Deliberately TWO levels deep and never created: moveClip must mkdir recursively.
  libraryDir = path.join(root, 'library', 'poe-tool-clips')
  await nodeClipLibraryFs.mkdirRecursive(obsDir)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Creates a fake OBS recording and returns its path. */
async function writeSource(name = 'Replay 2026-07-26 19-26-31.mkv', body = CLIP_BYTES): Promise<string> {
  const sourcePath = path.join(obsDir, name)
  await writeFile(sourcePath, body, 'utf8')
  return sourcePath
}

/** The standard move options; override per test. */
function moveOptions(sourcePath: string): {
  sourcePath: string
  when: Date
  zone: CurrentZone
  characterName: string
  isRemoteObs: boolean
  writeSidecar: boolean
} {
  return {
    sourcePath,
    when: WHEN,
    zone: KARUI_SHORES,
    characterName: 'FyascoWorbinTime',
    isRemoteObs: false,
    writeSidecar: false
  }
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('ClipLibrary.moveClip - successful move', () => {
  it('creates the library directory recursively and moves the clip into it', async () => {
    const sourcePath = await writeSource()
    const recorder = recordSleeps()
    const library = new ClipLibrary(libraryDir, { sleep: recorder.sleep })

    const record = await library.moveClip(moveOptions(sourcePath))

    expect(record.moved).toBe(true)
    expect(record.finalPath).toBe(path.join(libraryDir, EXPECTED_NAME))
    expect(record.note).toBeNull()
    expect(recorder.delays).toEqual([])

    // The bytes really moved: source gone, destination intact.
    expect(await exists(sourcePath)).toBe(false)
    expect(await readFile(path.join(libraryDir, EXPECTED_NAME), 'utf8')).toBe(CLIP_BYTES)
  })

  it('carries the game context through onto the record', async () => {
    const sourcePath = await writeSource()
    const library = new ClipLibrary(libraryDir, { sleep: recordSleeps().sleep })

    const record = await library.moveClip(moveOptions(sourcePath))

    expect(record.savedAt).toBe(WHEN.getTime())
    expect(record.originalPath).toBe(sourcePath)
    expect(record.zoneName).toBe('Karui Shores')
    expect(record.areaId).toBe('2_11_endgame_town')
    expect(record.areaLevel).toBe(69)
    expect(record.characterName).toBe('FyascoWorbinTime')
  })

  it('falls back to unknown-zone when the zone is not known', async () => {
    const sourcePath = await writeSource()
    const library = new ClipLibrary(libraryDir, { sleep: recordSleeps().sleep })

    const record = await library.moveClip({ ...moveOptions(sourcePath), zone: UNKNOWN_ZONE })

    expect(record.moved).toBe(true)
    expect(path.basename(record.finalPath ?? '')).toBe('2026-07-26_19-26-31_unknown-zone.mkv')
    expect(record.zoneName).toBeNull()
  })

  it('preserves whatever extension OBS used', async () => {
    const sourcePath = await writeSource('Replay.mp4')
    const library = new ClipLibrary(libraryDir, { sleep: recordSleeps().sleep })

    const record = await library.moveClip(moveOptions(sourcePath))

    expect(path.basename(record.finalPath ?? '')).toBe('2026-07-26_19-26-31_Karui-Shores.mp4')
  })
})

// ---------------------------------------------------------------------------
// Collisions
// ---------------------------------------------------------------------------

describe('ClipLibrary.moveClip - collisions', () => {
  it('suffixes -2, -3 when the target basename is already taken', async () => {
    const library = new ClipLibrary(libraryDir, { sleep: recordSleeps().sleep })
    const finalNames: string[] = []

    // Same second, same zone, three different OBS files - the natural burst case.
    for (const sourceName of ['a.mkv', 'b.mkv', 'c.mkv']) {
      const sourcePath = await writeSource(sourceName, `bytes-of-${sourceName}`)
      const record = await library.moveClip(moveOptions(sourcePath))
      expect(record.moved).toBe(true)
      finalNames.push(path.basename(record.finalPath ?? ''))
    }

    expect(finalNames).toEqual([
      '2026-07-26_19-26-31_Karui-Shores.mkv',
      '2026-07-26_19-26-31_Karui-Shores-2.mkv',
      '2026-07-26_19-26-31_Karui-Shores-3.mkv'
    ])

    // Nothing was overwritten: all three payloads survive.
    expect(await readFile(path.join(libraryDir, finalNames[0] ?? ''), 'utf8')).toBe('bytes-of-a.mkv')
    expect(await readFile(path.join(libraryDir, finalNames[1] ?? ''), 'utf8')).toBe('bytes-of-b.mkv')
    expect(await readFile(path.join(libraryDir, finalNames[2] ?? ''), 'utf8')).toBe('bytes-of-c.mkv')
  })

  it('suffixes around a pre-existing unrelated file with the same name', async () => {
    await nodeClipLibraryFs.mkdirRecursive(libraryDir)
    await writeFile(path.join(libraryDir, EXPECTED_NAME), 'someone-elses-file', 'utf8')

    const sourcePath = await writeSource()
    const library = new ClipLibrary(libraryDir, { sleep: recordSleeps().sleep })
    const record = await library.moveClip(moveOptions(sourcePath))

    expect(path.basename(record.finalPath ?? '')).toBe('2026-07-26_19-26-31_Karui-Shores-2.mkv')
    expect(await readFile(path.join(libraryDir, EXPECTED_NAME), 'utf8')).toBe('someone-elses-file')
  })
})

// ---------------------------------------------------------------------------
// Sidecar
// ---------------------------------------------------------------------------

describe('ClipLibrary.moveClip - sidecar', () => {
  it('writes <finalPath>.json with the full capture context', async () => {
    const sourcePath = await writeSource()
    const library = new ClipLibrary(libraryDir, { sleep: recordSleeps().sleep })

    const record = await library.moveClip({ ...moveOptions(sourcePath), writeSidecar: true })

    expect(record.moved).toBe(true)
    const sidecarPath = `${record.finalPath ?? ''}.json`
    const parsed: ClipSidecar = JSON.parse(await readFile(sidecarPath, 'utf8')) as ClipSidecar

    expect(parsed.savedAt).toBe(WHEN.getTime())
    expect(parsed.savedAtIso).toBe(WHEN.toISOString())
    expect(parsed.zoneName).toBe('Karui Shores')
    expect(parsed.areaId).toBe('2_11_endgame_town')
    expect(parsed.areaLevel).toBe(69)
    // seed lives on the sidecar but NOT on ClipRecord - 1 means a non-procedural area.
    expect(parsed.seed).toBe(1)
    expect(parsed.characterName).toBe('FyascoWorbinTime')
    expect(parsed.originalPath).toBe(sourcePath)
    expect(parsed.finalPath).toBe(record.finalPath)
  })

  it('writes nulls rather than omitting fields when the zone is unknown', async () => {
    const sourcePath = await writeSource()
    const library = new ClipLibrary(libraryDir, { sleep: recordSleeps().sleep })

    const record = await library.moveClip({
      ...moveOptions(sourcePath),
      zone: UNKNOWN_ZONE,
      characterName: '',
      writeSidecar: true
    })

    const parsed: ClipSidecar = JSON.parse(
      await readFile(`${record.finalPath ?? ''}.json`, 'utf8')
    ) as ClipSidecar
    expect(parsed.zoneName).toBeNull()
    expect(parsed.areaId).toBeNull()
    expect(parsed.areaLevel).toBeNull()
    expect(parsed.seed).toBeNull()
    expect(parsed.characterName).toBe('')
  })

  it('writes no sidecar when writeSidecar is false', async () => {
    const sourcePath = await writeSource()
    const library = new ClipLibrary(libraryDir, { sleep: recordSleeps().sleep })

    const record = await library.moveClip(moveOptions(sourcePath))

    expect(await exists(`${record.finalPath ?? ''}.json`)).toBe(false)
    expect(await readdir(libraryDir)).toEqual([EXPECTED_NAME])
  })

  it('still reports the move as successful when the sidecar cannot be written', async () => {
    const sourcePath = await writeSource()
    const fs: ClipLibraryFs = {
      ...nodeClipLibraryFs,
      writeTextFile: async () => {
        throw codedError('EACCES')
      }
    }
    const library = new ClipLibrary(libraryDir, { fs, sleep: recordSleeps().sleep })

    const record = await library.moveClip({ ...moveOptions(sourcePath), writeSidecar: true })

    expect(record.moved).toBe(true)
    expect(record.finalPath).not.toBeNull()
    expect(record.note).toContain('sidecar')
    expect(await exists(sourcePath)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Remote OBS
// ---------------------------------------------------------------------------

describe('ClipLibrary.moveClip - remote OBS', () => {
  it('refuses to move and explains why, without touching the filesystem', async () => {
    const sourcePath = await writeSource()
    const remotePath = 'D:\\OBS\\Replay 2026-07-26 19-26-31.mkv'
    const library = new ClipLibrary(libraryDir, { sleep: recordSleeps().sleep })

    const record = await library.moveClip({
      ...moveOptions(remotePath),
      isRemoteObs: true
    })

    expect(record.moved).toBe(false)
    expect(record.finalPath).toBeNull()
    // Never a silent no-op: the note must say why and where the file is.
    expect(record.note).not.toBeNull()
    expect(record.note).toContain('another machine')
    expect(record.note).toContain(remotePath)
    expect(record.originalPath).toBe(remotePath)

    // Not even the library directory is created on this path.
    expect(await exists(libraryDir)).toBe(false)
    // A same-named local file is left completely alone.
    expect(await exists(sourcePath)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Unconfigured library dir
// ---------------------------------------------------------------------------

describe('ClipLibrary.moveClip - unconfigured library directory', () => {
  it('refuses rather than dumping clips in the process CWD', async () => {
    const sourcePath = await writeSource()
    const library = new ClipLibrary('   ', { sleep: recordSleeps().sleep })

    const record = await library.moveClip(moveOptions(sourcePath))

    expect(record.moved).toBe(false)
    expect(record.finalPath).toBeNull()
    expect(record.note).toContain('No clips library directory is configured')
    expect(await exists(sourcePath)).toBe(true)
    expect(await readFile(sourcePath, 'utf8')).toBe(CLIP_BYTES)
  })
})

// ---------------------------------------------------------------------------
// EXDEV / cross-volume fallback
// ---------------------------------------------------------------------------

describe('ClipLibrary.moveClip - EXDEV cross-volume fallback', () => {
  it('falls back to a streamed copy + unlink and leaves no source behind', async () => {
    const sourcePath = await writeSource()
    let renameCalls = 0
    let copyCalls = 0
    const unlinked: string[] = []

    const fs: ClipLibraryFs = {
      ...nodeClipLibraryFs,
      rename: async () => {
        renameCalls++
        // The exact failure a fast NVMe recording dir + bulk-drive library produces.
        throw codedError('EXDEV')
      },
      copyStreamed: async (source, destination) => {
        copyCalls++
        await nodeClipLibraryFs.copyStreamed(source, destination)
      },
      unlink: async (target) => {
        unlinked.push(target)
        await nodeClipLibraryFs.unlink(target)
      }
    }
    const recorder = recordSleeps()
    const library = new ClipLibrary(libraryDir, { fs, sleep: recorder.sleep })

    const record = await library.moveClip(moveOptions(sourcePath))

    expect(record.moved).toBe(true)
    expect(record.finalPath).toBe(path.join(libraryDir, EXPECTED_NAME))
    expect(record.note).toBeNull()

    // EXDEV is not a transient condition: no retry, no backoff, straight to copy.
    expect(renameCalls).toBe(1)
    expect(recorder.delays).toEqual([])
    expect(copyCalls).toBe(1)
    expect(unlinked).toEqual([sourcePath])

    expect(await exists(sourcePath)).toBe(false)
    expect(await readFile(path.join(libraryDir, EXPECTED_NAME), 'utf8')).toBe(CLIP_BYTES)
  })

  it('never unlinks the source when the copy does not verify', async () => {
    const sourcePath = await writeSource()
    const unlinked: string[] = []

    const fs: ClipLibraryFs = {
      ...nodeClipLibraryFs,
      rename: async () => {
        throw codedError('EXDEV')
      },
      // Simulates a copy cut short (full disk, yanked drive) that did not throw.
      copyStreamed: async (_source, destination) => {
        await writeFile(destination, CLIP_BYTES.slice(0, 5), 'utf8')
      },
      unlink: async (target) => {
        unlinked.push(target)
        await nodeClipLibraryFs.unlink(target)
      }
    }
    const library = new ClipLibrary(libraryDir, { fs, sleep: recordSleeps().sleep })

    const record = await library.moveClip(moveOptions(sourcePath))

    expect(record.moved).toBe(false)
    expect(record.finalPath).toBeNull()
    expect(record.note).toContain('did not verify')

    // THE point of this test: the user's clip still exists, in full.
    expect(await exists(sourcePath)).toBe(true)
    expect(await readFile(sourcePath, 'utf8')).toBe(CLIP_BYTES)
    // Only the half-written destination was removed.
    expect(unlinked).toEqual([path.join(libraryDir, EXPECTED_NAME)])
    expect(await readdir(libraryDir)).toEqual([])
  })

  it('leaves nothing behind in the library when the copy itself throws', async () => {
    // REGRESSION: only the size-mismatch branch discarded the partial destination.
    // A copy that REJECTS part-way (ENOSPC as the disk fills, EFBIG writing a >4GB
    // clip to FAT32, a yanked drive) left a truncated file in the library under the
    // FINAL clip name - indistinguishable from a real clip in a directory listing,
    // and it burned the collision namespace so a genuine retry of the same
    // second/zone landed on `-2`.
    const sourcePath = await writeSource()
    const unlinked: string[] = []

    const fs: ClipLibraryFs = {
      ...nodeClipLibraryFs,
      rename: async () => {
        throw codedError('EXDEV')
      },
      copyStreamed: async (_source, destination) => {
        // Some bytes land, then the write fails.
        await writeFile(destination, CLIP_BYTES.slice(0, 8), 'utf8')
        throw codedError('ENOSPC')
      },
      unlink: async (target) => {
        unlinked.push(target)
        await nodeClipLibraryFs.unlink(target)
      }
    }
    const library = new ClipLibrary(libraryDir, { fs, sleep: recordSleeps().sleep })

    const record = await library.moveClip(moveOptions(sourcePath))

    expect(record.moved).toBe(false)
    expect(record.finalPath).toBeNull()
    expect(record.note).toContain('ENOSPC')

    // The user's clip is untouched...
    expect(await exists(sourcePath)).toBe(true)
    expect(await readFile(sourcePath, 'utf8')).toBe(CLIP_BYTES)
    // ...and no truncated impostor is sitting in the library.
    expect(await readdir(libraryDir)).toEqual([])
    expect(unlinked).toEqual([path.join(libraryDir, EXPECTED_NAME)])
  })

  it('reports success with a warning when only the source unlink fails', async () => {
    const sourcePath = await writeSource()
    const fs: ClipLibraryFs = {
      ...nodeClipLibraryFs,
      rename: async () => {
        throw codedError('EXDEV')
      },
      unlink: async () => {
        throw codedError('EPERM')
      }
    }
    const recorder = recordSleeps()
    const library = new ClipLibrary(libraryDir, { fs, sleep: recorder.sleep })

    const record = await library.moveClip(moveOptions(sourcePath))

    // The clip IS in the library, so claiming moved:false would send the user to a
    // path we may still delete later.
    expect(record.moved).toBe(true)
    expect(record.finalPath).toBe(path.join(libraryDir, EXPECTED_NAME))
    expect(record.note).toContain('could not be')
    expect(record.note).toContain(sourcePath)
    // The unlink is itself retried before we give up on it.
    expect(recorder.delays).toEqual([...DEFAULT_RETRY_DELAYS_MS])
    expect(await readFile(path.join(libraryDir, EXPECTED_NAME), 'utf8')).toBe(CLIP_BYTES)
  })
})

// ---------------------------------------------------------------------------
// Windows file locks
// ---------------------------------------------------------------------------

describe('ClipLibrary.moveClip - locked file retries', () => {
  it('retries EBUSY with backoff and succeeds once the lock clears', async () => {
    const sourcePath = await writeSource()
    let renameCalls = 0
    const fs: ClipLibraryFs = {
      ...nodeClipLibraryFs,
      rename: async (source, destination) => {
        renameCalls++
        // OBS holds the handle for the first two attempts, then lets go.
        if (renameCalls <= 2) throw codedError('EBUSY')
        await nodeClipLibraryFs.rename(source, destination)
      }
    }
    const recorder = recordSleeps()
    const library = new ClipLibrary(libraryDir, { fs, sleep: recorder.sleep })

    const record = await library.moveClip(moveOptions(sourcePath))

    expect(record.moved).toBe(true)
    expect(record.finalPath).toBe(path.join(libraryDir, EXPECTED_NAME))
    expect(renameCalls).toBe(3)
    expect(recorder.delays).toEqual([DEFAULT_RETRY_DELAYS_MS[0], DEFAULT_RETRY_DELAYS_MS[1]])
    expect(await exists(sourcePath)).toBe(false)
  })

  it.each(['EBUSY', 'EPERM', 'EACCES'])(
    'treats %s as a transient lock',
    async (code) => {
      const sourcePath = await writeSource()
      let renameCalls = 0
      const fs: ClipLibraryFs = {
        ...nodeClipLibraryFs,
        rename: async (source, destination) => {
          renameCalls++
          if (renameCalls === 1) throw codedError(code)
          await nodeClipLibraryFs.rename(source, destination)
        }
      }
      const library = new ClipLibrary(libraryDir, { fs, sleep: recordSleeps().sleep })

      const record = await library.moveClip(moveOptions(sourcePath))

      expect(record.moved).toBe(true)
      expect(renameCalls).toBe(2)
    }
  )

  it('gives up after 5 attempts over ~2.5s and leaves the source intact', async () => {
    const sourcePath = await writeSource()
    let renameCalls = 0
    const fs: ClipLibraryFs = {
      ...nodeClipLibraryFs,
      rename: async () => {
        renameCalls++
        throw codedError('EBUSY')
      }
    }
    const recorder = recordSleeps()
    const library = new ClipLibrary(libraryDir, { fs, sleep: recorder.sleep })

    const record = await library.moveClip(moveOptions(sourcePath))

    expect(record.moved).toBe(false)
    expect(record.finalPath).toBeNull()
    expect(record.note).toContain('EBUSY')
    expect(record.note).toContain('untouched')
    expect(record.note).toContain(sourcePath)

    expect(library.maxAttempts).toBe(5)
    expect(renameCalls).toBe(5)
    expect(recorder.delays).toEqual([...DEFAULT_RETRY_DELAYS_MS])
    expect(recorder.delays.reduce((sum, ms) => sum + ms, 0)).toBe(2500)

    // The whole contract of the failure path: the clip is still where OBS put it,
    // byte for byte, and nothing partial was left in the library.
    expect(await exists(sourcePath)).toBe(true)
    expect(await readFile(sourcePath, 'utf8')).toBe(CLIP_BYTES)
    expect(await readdir(libraryDir)).toEqual([])
  })

  it('does not retry an error that waiting cannot fix', async () => {
    // No source file at all -> ENOENT. Burning 2.5s to report that would be pure latency.
    const sourcePath = path.join(obsDir, 'never-existed.mkv')
    let renameCalls = 0
    const fs: ClipLibraryFs = {
      ...nodeClipLibraryFs,
      rename: async (source, destination) => {
        renameCalls++
        await nodeClipLibraryFs.rename(source, destination)
      }
    }
    const recorder = recordSleeps()
    const library = new ClipLibrary(libraryDir, { fs, sleep: recorder.sleep })

    const record = await library.moveClip(moveOptions(sourcePath))

    expect(record.moved).toBe(false)
    expect(record.finalPath).toBeNull()
    expect(record.note).toContain('ENOENT')
    expect(renameCalls).toBe(1)
    expect(recorder.delays).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Directory creation failures
// ---------------------------------------------------------------------------

describe('ClipLibrary.moveClip - library directory failures', () => {
  it('reports a failure instead of throwing when the library dir cannot be created', async () => {
    // A regular file where a directory component is expected -> ENOTDIR/EEXIST.
    const blocker = path.join(root, 'blocker')
    await writeFile(blocker, 'not a directory', 'utf8')

    const sourcePath = await writeSource()
    const library = new ClipLibrary(path.join(blocker, 'clips'), { sleep: recordSleeps().sleep })

    const record = await library.moveClip(moveOptions(sourcePath))

    expect(record.moved).toBe(false)
    expect(record.finalPath).toBeNull()
    expect(record.note).toContain('Could not create the clips library directory')
    expect(await exists(sourcePath)).toBe(true)
  })

  it('never rejects, even when the filesystem seam misbehaves entirely', async () => {
    const sourcePath = await writeSource()
    const fs: ClipLibraryFs = {
      ...nodeClipLibraryFs,
      exists: async () => {
        throw new Error('boom')
      }
    }
    const library = new ClipLibrary(libraryDir, { fs, sleep: recordSleeps().sleep })

    const record = await library.moveClip(moveOptions(sourcePath))

    expect(record.moved).toBe(false)
    expect(record.finalPath).toBeNull()
    expect(record.note).toContain('boom')
    expect(await exists(sourcePath)).toBe(true)
  })
})
