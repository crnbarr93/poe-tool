/**
 * src/main/obs/clip-namer.ts
 * ==========================
 *
 * Filename construction for saved replay-buffer clips.
 *
 * EVERY EXPORT IN THIS FILE IS PURE. No imports at all (not even `node:path`), no
 * I/O, no `Date.now()`, no randomness. Given the same arguments these functions
 * always return the same string, which is what makes `clip-library.ts` - the part
 * that does touch the disk - testable by asserting on names rather than on mocks.
 *
 * WHY THE NAMING RULES ARE THE WAY THEY ARE
 * -----------------------------------------
 * The app targets Windows, and Windows path segments are a minefield:
 *  - `< > : " / \ | ? *` are hard-rejected by the filesystem. `:` matters most here
 *    because the obvious clip name is a wall-clock time, and `19:26:31` would fail.
 *    That is why the time separator is `-`.
 *  - A segment may not END in a dot or a space. Explorer and most APIs silently
 *    refuse to create `foo.` or `foo `, and a name that round-trips through a
 *    trailing-space trim can collide with a name that did not.
 *  - Control characters (0x00-0x1F, 0x7F) are rejected outright.
 * Zone names come straight out of Client.txt, so they are effectively untrusted
 * input as far as the filesystem is concerned.
 *
 * The `YYYY-MM-DD_HH-mm-ss` prefix is deliberate: lexicographic sort == chronological
 * sort, so a plain directory listing is already in capture order without any tooling.
 *
 * TIMEZONE: the stamp is built from LOCAL-time getters, matching Client.txt (which
 * logs local time with no UTC offset) and matching what the user saw on their clock
 * when they died. Do not switch these to the UTC getters.
 *
 * WINDOWS RESERVED DEVICE NAMES (`CON`, `PRN`, `NUL`, `COM1`...) are NOT special-cased.
 * They cannot occur: {@link buildClipBasename} always prefixes the date stamp, so the
 * stem always starts with a digit.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum length of the sanitised portion of a name (the zone label).
 *
 * Windows' per-segment limit is 255, so this is not about the filesystem - it is
 * about keeping names readable, and about leaving headroom under the legacy 260-char
 * full-path limit for users whose library lives somewhere deep.
 */
export const MAX_FILENAME_SEGMENT_LENGTH = 60

/** Substituted when the zone name is unknown, empty, or sanitises away to nothing. */
export const UNKNOWN_ZONE_LABEL = 'unknown-zone'

/** Used when `when` is an Invalid Date. Sorts first, and is obviously wrong to a human. */
const INVALID_STAMP = '0000-00-00_00-00-00'

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/** The nine characters Windows forbids anywhere in a path segment. */
const WINDOWS_ILLEGAL = /[<>:"/\\|?*]/g

/**
 * Control characters that are NOT whitespace, i.e. 0x00-0x08, 0x0E-0x1F and 0x7F.
 *
 * The gaps (0x09-0x0D) are tab/LF/VT/FF/CR. Those ARE matched by `\s` and so are
 * handled by {@link WHITESPACE_RUN} below, which turns them into a dash rather than
 * deleting them - `"Foo\tBar"` should become `Foo-Bar`, not `FooBar`.
 */
const NON_WHITESPACE_CONTROL = /[\u0000-\u0008\u000E-\u001F\u007F]/g

/** Any run of whitespace becomes exactly one dash. */
const WHITESPACE_RUN = /\s+/g

/** Collapses the dash pile-ups that the previous step can produce (`"a - b"`). */
const DASH_RUN = /-{2,}/g

/**
 * Leading/trailing dots, dashes and whitespace.
 *
 * Trailing dots and spaces are the Windows hard requirement; dashes are included
 * because truncating at {@link MAX_FILENAME_SEGMENT_LENGTH} routinely lands on one,
 * and `Foo-Bar-.mkv` reads like a bug.
 */
const EDGE_JUNK = /^[.\-\s]+|[.\-\s]+$/g

// ---------------------------------------------------------------------------
// Sanitisation
// ---------------------------------------------------------------------------

/** Strips leading/trailing dots, dashes and whitespace. */
function trimEdges(value: string): string {
  return value.replace(EDGE_JUNK, '')
}

/**
 * Makes an arbitrary string safe to use as one component of a Windows filename.
 *
 * In order:
 *  1. delete the nine Windows-illegal characters,
 *  2. delete non-whitespace control characters,
 *  3. collapse each whitespace run to a single dash,
 *  4. collapse dash runs,
 *  5. trim dots/dashes/whitespace off both ends,
 *  6. cap at {@link MAX_FILENAME_SEGMENT_LENGTH} and re-trim, so truncation can never
 *     reintroduce a trailing dot or dash.
 *
 * TOTAL: never throws, and MAY return `""` (e.g. for `":::"`). Callers must supply
 * their own fallback - see {@link UNKNOWN_ZONE_LABEL}.
 */
export function sanitizeForFilename(s: string): string {
  const cleaned = s
    .replace(WINDOWS_ILLEGAL, '')
    .replace(NON_WHITESPACE_CONTROL, '')
    .replace(WHITESPACE_RUN, '-')
    .replace(DASH_RUN, '-')

  const trimmed = trimEdges(cleaned)
  if (trimmed.length <= MAX_FILENAME_SEGMENT_LENGTH) return trimmed
  return trimEdges(trimmed.slice(0, MAX_FILENAME_SEGMENT_LENGTH))
}

// ---------------------------------------------------------------------------
// Extension extraction
// ---------------------------------------------------------------------------

/**
 * The extension of `filePath`, INCLUDING the leading dot, or `""` if it has none.
 *
 * Hand-rolled rather than `path.extname` on purpose: OBS reports a WINDOWS path
 * (`C:\Users\me\Videos\Replay 2026-07-26 19-26-31.mkv`), but the tests - and any
 * dev run - happen on macOS where `path` is the POSIX flavour and would not treat
 * `\` as a separator. This recognises both separators on every platform.
 *
 * A leading dot does not count as an extension (`.gitignore` -> `""`), matching
 * `path.extname`.
 */
export function extensionFromPath(filePath: string): string {
  const lastSeparator = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  const name = filePath.slice(lastSeparator + 1)
  const lastDot = name.lastIndexOf('.')
  return lastDot > 0 ? name.slice(lastDot) : ''
}

// ---------------------------------------------------------------------------
// Basename construction
// ---------------------------------------------------------------------------

/** Arguments to {@link buildClipBasename}. */
export interface ClipBasenameOptions {
  /** Capture time. Rendered in LOCAL time - see the timezone note in the file header. */
  readonly when: Date
  /** Zone display name (`CurrentZone.displayName`). Null/blank -> {@link UNKNOWN_ZONE_LABEL}. */
  readonly zoneName: string | null
  /**
   * Extension to keep, with or without a leading dot (`".mkv"` and `"mkv"` are
   * equivalent). Preserved from whatever OBS actually wrote, because the container
   * is an OBS setting we do not control - `""` produces a name with no extension.
   */
  readonly extension: string
}

function pad(value: number, width: number): string {
  return String(Math.abs(value)).padStart(width, '0')
}

/** `YYYY-MM-DD_HH-mm-ss` in local time, or {@link INVALID_STAMP} for an Invalid Date. */
function formatStamp(when: Date): string {
  if (Number.isNaN(when.getTime())) return INVALID_STAMP
  const date = `${pad(when.getFullYear(), 4)}-${pad(when.getMonth() + 1, 2)}-${pad(when.getDate(), 2)}`
  const time = `${pad(when.getHours(), 2)}-${pad(when.getMinutes(), 2)}-${pad(when.getSeconds(), 2)}`
  return `${date}_${time}`
}

/** Normalises an extension to `".ext"`, or `""` when there is nothing usable left. */
function normalizeExtension(extension: string): string {
  // sanitizeForFilename already strips leading dots (they are "edge junk"), so
  // ".mkv" and "mkv" converge on "mkv" here.
  const bare = sanitizeForFilename(extension)
  return bare === '' ? '' : `.${bare}`
}

/**
 * Builds the filename for one clip, e.g. `2026-07-26_19-26-31_Karui-Shores.mkv`.
 *
 * The result is always a SINGLE path segment: it contains no separator, no
 * Windows-illegal character, and no trailing dot or space. Join it onto the library
 * directory with `path.join`; never concatenate.
 *
 * TOTAL: never throws, for any input including an Invalid Date.
 */
export function buildClipBasename(opts: ClipBasenameOptions): string {
  const stamp = formatStamp(opts.when)
  const sanitizedZone = sanitizeForFilename(opts.zoneName ?? '')
  const zone = sanitizedZone === '' ? UNKNOWN_ZONE_LABEL : sanitizedZone
  return `${stamp}_${zone}${normalizeExtension(opts.extension)}`
}

// ---------------------------------------------------------------------------
// Collision suffixing
// ---------------------------------------------------------------------------

/**
 * Inserts a `-N` disambiguator BEFORE the extension: `clip.mkv` + 2 -> `clip-2.mkv`.
 *
 * `index <= 1` returns the name unchanged, so callers can write a plain
 * `for (let i = 1; ...)` loop where the first candidate is the unsuffixed name.
 *
 * The suffix must go before the extension, not after: `clip.mkv-2` would not open in
 * any player and would not be recognised by the OS.
 */
export function applyCollisionSuffix(basename: string, index: number): string {
  if (index <= 1) return basename
  const lastDot = basename.lastIndexOf('.')
  // `lastDot <= 0` covers both "no dot at all" and a leading-dot name, where the dot
  // is part of the stem rather than an extension marker.
  if (lastDot <= 0) return `${basename}-${index}`
  return `${basename.slice(0, lastDot)}-${index}${basename.slice(lastDot)}`
}
