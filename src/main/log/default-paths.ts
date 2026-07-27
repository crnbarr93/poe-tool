/**
 * src/main/log/default-paths.ts
 * =============================
 *
 * Best-effort autodetection of `Client.txt` on Windows.
 *
 * NO ELECTRON. Only `node:path` and `node:fs/promises`, so this runs under vitest and
 * under the `tail:debug` CLI.
 *
 *
 * WHY EVERY PATH IS BUILT FROM AN ENVIRONMENT VARIABLE
 * ----------------------------------------------------
 * Hardcoding `C:\Program Files (x86)\...` is wrong often enough to matter: Windows
 * can be installed on a drive other than C:, and `%ProgramFiles(x86)%` is localised
 * on some non-English installs. Reading the environment costs nothing and is correct
 * by construction. A machine that does not define these variables (i.e. anything that
 * is not Windows - macOS during development, for instance) simply yields no
 * candidates, which is the honest answer.
 *
 *
 * WHY {@link win32}
 * -----------------
 * These are Windows paths regardless of the OS this code is running on. Plain
 * `path.join` on a dev macOS box would emit forward slashes and produce a string that
 * looks right, tests fine, and is subtly wrong the moment it reaches a real Windows
 * filesystem. `win32.join` is unconditional and makes the macOS test suite assert the
 * exact strings Windows will see.
 *
 *
 * WHAT THIS CANNOT FIND - AND WHY MANUAL CONFIGURATION IS THE REAL ANSWER
 * -----------------------------------------------------------------------
 * Steam supports multiple library folders on arbitrary drives (`D:\SteamLibrary`,
 * an external disk, a second SSD). A very common real-world install therefore lives
 * at a path NOTHING in this file can predict. Finding those properly means parsing
 * `steamapps\libraryfolders.vdf` - a bespoke Valve text format with no parser in this
 * project's frozen dependency set, and one that changes shape between Steam client
 * versions.
 *
 * So this module is explicitly a CONVENIENCE, not a guarantee. The contract with the
 * UI is:
 *   - `log:autodetect` returns zero or more paths that definitely exist,
 *   - the user picks one, or browses to their own,
 *   - `settings.log.path` is the source of truth and always wins.
 * Returning an empty array is a normal, expected outcome - never an error state.
 */

import { stat } from 'node:fs/promises'
import { win32 } from 'node:path'

// ---------------------------------------------------------------------------
// Environment variables
// ---------------------------------------------------------------------------

/** 32-bit program directory, e.g. `C:\Program Files (x86)`. Where Steam and the GGG installer land. */
const ENV_PROGRAM_FILES_X86 = 'ProgramFiles(x86)'
/**
 * Program directory matching the CURRENT PROCESS's bitness. In a 64-bit process
 * (which Electron is) that is `C:\Program Files`; in a 32-bit process on 64-bit
 * Windows, WOW64 rewrites it to `C:\Program Files (x86)`.
 */
const ENV_PROGRAM_FILES = 'ProgramFiles'
/**
 * The true 64-bit program directory, immune to the WOW64 rewrite above. Defined only
 * on 64-bit Windows. Listed alongside `ProgramFiles` purely as a belt-and-braces
 * fallback; on a normal 64-bit Electron build the two resolve to the same string and
 * the duplicate is dropped.
 */
const ENV_PROGRAM_W6432 = 'ProgramW6432'

/**
 * Base directories to try for software that installs 32-bit by default, most likely
 * first. Steam's installer and GGG's standalone installer both target the x86 tree.
 */
const X86_FIRST: readonly string[] = [ENV_PROGRAM_FILES_X86, ENV_PROGRAM_FILES, ENV_PROGRAM_W6432]

/** Base directories to try for software that installs 64-bit by default, most likely first. */
const NATIVE_FIRST: readonly string[] = [ENV_PROGRAM_FILES, ENV_PROGRAM_W6432, ENV_PROGRAM_FILES_X86]

// ---------------------------------------------------------------------------
// Known install layouts
// ---------------------------------------------------------------------------

/** Every distribution puts the log in `<install root>\logs\Client.txt`. */
const LOG_SUBPATH: readonly string[] = ['logs', 'Client.txt']

interface InstallSpec {
  /** Environment variables to expand as the install root, most likely first. */
  readonly baseEnvVars: readonly string[]
  /** Path segments from that root down to the game's install directory. */
  readonly installSegments: readonly string[]
}

/**
 * Known layouts, ordered most likely first. The order matters: it becomes the order
 * the UI offers the candidates in, and the first entry is what a user will accept
 * without reading.
 */
const INSTALL_SPECS: readonly InstallSpec[] = [
  // Steam, Path of Exile 1. The single most common install.
  {
    baseEnvVars: X86_FIRST,
    installSegments: ['Steam', 'steamapps', 'common', 'Path of Exile']
  },
  // Standalone client from the GGG installer, Path of Exile 1.
  {
    baseEnvVars: X86_FIRST,
    installSegments: ['Grinding Gear Games', 'Path of Exile']
  },
  // Epic Games Store, Path of Exile 1. Note the folder has no spaces here, unlike
  // every other distribution - that is Epic's app name, not a typo.
  {
    baseEnvVars: NATIVE_FIRST,
    installSegments: ['Epic Games', 'PathOfExile']
  },

  // -------------------------------------------------------------------------
  // PATH OF EXILE 2 - UNTESTED, SPECULATIVE, BEST-EFFORT
  // -------------------------------------------------------------------------
  // Listed last on purpose. Nobody has verified these against a real PoE2 install,
  // and PoE2's Client.txt format is NOT known to match the PoE1 lines this project's
  // parser is built against. Autodetect surfacing one of these is harmless (it only
  // ever offers a choice), but pointing the watcher at a PoE2 log may simply produce
  // no events. Do not promote these above the PoE1 entries without a verified sample.
  {
    // Steam, Path of Exile 2.
    baseEnvVars: X86_FIRST,
    installSegments: ['Steam', 'steamapps', 'common', 'Path of Exile 2']
  },
  {
    // Standalone GGG client, Path of Exile 2.
    baseEnvVars: X86_FIRST,
    installSegments: ['Grinding Gear Games', 'Path of Exile 2']
  }
]

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reads an environment variable, treating missing, empty and whitespace-only values
 * as absent.
 *
 * The lookup falls back to a case-INSENSITIVE scan because Windows environment
 * variables are case-insensitive and `process.env` on Windows honours that, while a
 * plain object literal built in a test (or a hand-assembled env for a child process)
 * does not. Matching the platform's own semantics here means `PROGRAMFILES(X86)` and
 * `ProgramFiles(x86)` behave identically, as they do in a real `cmd.exe`.
 */
function readEnv(env: NodeJS.ProcessEnv, name: string): string | null {
  const direct = env[name]
  if (typeof direct === 'string' && direct.trim() !== '') return direct

  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() !== wanted) continue
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return null
}

/**
 * Builds every plausible `Client.txt` path for this machine, most likely first.
 *
 * PURE: no filesystem access at all - nothing here has been checked for existence.
 * Use {@link autodetectLogPath} for that. Duplicates are removed case-insensitively,
 * matching how Windows itself compares paths, so a 64-bit process where
 * `%ProgramFiles%` and `%ProgramW6432%` are identical does not produce doubled
 * entries.
 *
 * @param env Usually `process.env`. Injected so tests can simulate a Windows box.
 * @returns Windows-style paths (backslash separated), possibly empty.
 */
export function candidateLogPaths(env: NodeJS.ProcessEnv): string[] {
  const paths: string[] = []
  const seen = new Set<string>()

  for (const spec of INSTALL_SPECS) {
    for (const envVar of spec.baseEnvVars) {
      const base = readEnv(env, envVar)
      if (base === null) continue

      const candidate = win32.join(base, ...spec.installSegments, ...LOG_SUBPATH)
      const key = candidate.toLowerCase()
      if (seen.has(key)) continue

      seen.add(key)
      paths.push(candidate)
    }
  }

  return paths
}

/**
 * Existence predicate injected into {@link autodetectLogPath}.
 *
 * Sync or async, either is accepted - tests overwhelmingly want a plain
 * `(p) => p === expected`, while production wants {@link fileExists}.
 */
export type LogPathExistsFn = (candidate: string) => boolean | Promise<boolean>

/**
 * Production {@link LogPathExistsFn}: true only for a path that exists AND is a
 * regular file.
 *
 * The `isFile()` check is not pedantry - it stops a directory that happens to be
 * named `Client.txt` from being offered as a log file, which the watcher would then
 * fail to tail with an opaque EISDIR.
 */
export const fileExists: LogPathExistsFn = async (candidate: string): Promise<boolean> => {
  try {
    const stats = await stat(candidate)
    return stats.isFile()
  } catch {
    // ENOENT (not installed there), EACCES/EPERM (another user's Program Files),
    // ENOTDIR (a path component is a file). All mean "not a usable candidate".
    return false
  }
}

/**
 * Filters {@link candidateLogPaths} down to the paths that actually exist, preserving
 * the most-likely-first ordering.
 *
 * NEVER REJECTS. An `existsFn` that throws or rejects for one candidate - a
 * permissions error on a locked-down `Program Files`, say - counts as "does not
 * exist" for that candidate only, and the scan continues. Autodetect is a
 * convenience; it must not be able to take down the `log:autodetect` IPC handler.
 *
 * Checks run concurrently: a handful of `stat` calls against a spun-down or network
 * drive can each take hundreds of milliseconds, and this sits behind a button press.
 *
 * @param env Usually `process.env`.
 * @param existsFn Injected so the suite can run on macOS without a Windows filesystem.
 *                 Production callers pass {@link fileExists}.
 * @returns Existing paths, most likely first. Empty means "ask the user to browse".
 */
export async function autodetectLogPath(
  env: NodeJS.ProcessEnv,
  existsFn: LogPathExistsFn
): Promise<string[]> {
  const candidates = candidateLogPaths(env)

  const results = await Promise.all(
    candidates.map(async (candidate): Promise<boolean> => {
      try {
        return (await existsFn(candidate)) === true
      } catch {
        return false
      }
    })
  )

  return candidates.filter((_candidate, index) => results[index] === true)
}
