/**
 * src/renderer/src/format.ts
 * ==========================
 *
 * Pure display helpers for the config UI. No React, no IPC, no `window` access -
 * just value -> string.
 *
 * WHY EVERY ONE OF THESE IS DEFENSIVE
 * -----------------------------------
 * Everything rendered here arrived over IPC from the main process. The types say a
 * `Date` is a `Date` and a number is finite, and the structured clone algorithm does
 * preserve `Date` instances - but the renderer is the one surface where a bad value
 * turns into a WHITE SCREEN rather than a logged warning. A `TypeError` thrown while
 * formatting a timestamp unmounts the whole React tree, and the user loses the config
 * UI for a cosmetic problem. So these functions are total: they degrade to a
 * placeholder string instead of throwing.
 */

/** Rendered in place of a timestamp we could not make sense of. */
const UNKNOWN_TIME = '--:--:--'

/**
 * Formats a wall-clock `Date` as a 24-hour local time, e.g. `19:26:31`.
 *
 * Client.txt writes local time in 24-hour form, so matching that makes it trivial to
 * eyeball a UI row against the raw log line it came from.
 */
export function formatClock(value: Date): string {
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value))
  if (!Number.isFinite(ms)) return UNKNOWN_TIME
  return new Date(ms).toLocaleTimeString(undefined, { hour12: false })
}

/** Formats a `Date.now()`-style epoch millisecond value as a 24-hour local time. */
export function formatEpochClock(ms: number): string {
  if (!Number.isFinite(ms)) return UNKNOWN_TIME
  return new Date(ms).toLocaleTimeString(undefined, { hour12: false })
}

/** Formats an epoch millisecond value as date + time, for rows that can be days old. */
export function formatEpochDateTime(ms: number): string {
  if (!Number.isFinite(ms)) return UNKNOWN_TIME
  const date = new Date(ms)
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString(undefined, { hour12: false })}`
}

/** `1234567` -> `1.2 MB`. Used for the tail offset, which reaches tens of megabytes. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '?'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}

/** Thousands separators for line counts. */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '?'
  return Math.round(value).toLocaleString()
}

/**
 * Last path segment, splitting on BOTH separators.
 *
 * The paths on screen are produced on Windows (`D:\Videos\clip.mkv`) but this code may
 * be running in a dev browser on macOS, so `path.basename` semantics cannot be assumed
 * even if the renderer were allowed to import `node:path` - which it is not.
 */
export function fileNameOf(fullPath: string): string {
  const segments = fullPath.split(/[\\/]/)
  const last = segments[segments.length - 1]
  return last === undefined || last === '' ? fullPath : last
}

/**
 * Turns an unknown thrown/rejected value into something safe to render.
 *
 * A rejected `ipcRenderer.invoke` surfaces as an `Error` whose message is prefixed
 * with `Error invoking remote method '<channel>':` - ugly, but far more useful than
 * "something went wrong", so it is passed through rather than swallowed.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  const text = String(error)
  return text === '' ? 'Unknown error' : text
}
