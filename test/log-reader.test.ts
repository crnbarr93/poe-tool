/**
 * test/log-reader.test.ts
 * =======================
 *
 * Everything here runs against a REAL file in a real temp directory
 * (`fs.mkdtemp` under `os.tmpdir()`, removed in `afterEach`). No fs mocking: the
 * whole point of `LogReader` is its interaction with a file that another process
 * is appending to, truncating and replacing, and a mocked `fs` would happily
 * agree with whatever wrong model of that we wrote.
 *
 * Bytes are written explicitly as `Buffer`s wherever the test is about byte
 * boundaries (UTF-8 splits, CRLF), so the assertions do not depend on how the
 * host encodes string writes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { LogReader } from '../src/main/log/log-reader'

// Real Client.txt lines (ground truth from the user).
const SLAIN =
  '2026/07/26 19:26:31 1018412156 cffb0658 [INFO Client 50396] : FyascoWorbinTime has been slain.'
const ENTERED =
  '2026/07/26 19:28:42 1018543171 cffb0658 [INFO Client 50396] : You have entered Karui Shores.'
const GENERATING =
  '2026/07/26 19:28:41 1018542484 1186a8a3 [DEBUG Client 50396] Generating level 69 area "2_11_endgame_town" with seed 1'

let dir = ''
let logPath = ''

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'poe-tool-log-reader-'))
  logPath = path.join(dir, 'Client.txt')
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

/** Appends raw text/bytes exactly as given - no newline is added for you. */
async function append(data: string | Buffer): Promise<void> {
  await fs.appendFile(logPath, data)
}

/** Replaces the file's contents in place. Keeps the same file (and birth time). */
async function overwrite(data: string | Buffer): Promise<void> {
  await fs.writeFile(logPath, data)
}

/** Byte length of a UTF-8 string, for `bytesRead` assertions. */
function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

describe('LogReader.readDelta', () => {
  it('returns appended lines once and does not re-read them', async () => {
    await append(`${SLAIN}\n${ENTERED}\n`)
    const reader = new LogReader(logPath)

    const first = await reader.readDelta()
    expect(first.status).toBe('ok')
    expect(first.rotated).toBe(false)
    expect(first.lines).toEqual([SLAIN, ENTERED])
    expect(first.bytesRead).toBe(bytes(`${SLAIN}\n${ENTERED}\n`))
    expect(reader.offset).toBe(first.bytesRead)

    // Nothing new: a quiet tick is `ok` with no lines, not an error.
    const second = await reader.readDelta()
    expect(second.status).toBe('ok')
    expect(second.lines).toEqual([])
    expect(second.bytesRead).toBe(0)
    expect(second.rotated).toBe(false)

    await append(`${GENERATING}\n`)
    const third = await reader.readDelta()
    expect(third.lines).toEqual([GENERATING])
    expect(third.bytesRead).toBe(bytes(`${GENERATING}\n`))
    expect(reader.offset).toBe(bytes(`${SLAIN}\n${ENTERED}\n${GENERATING}\n`))
  })

  it('starts at offset 0 so a fresh reader replays the whole file (debug replay mode)', async () => {
    await append(`${SLAIN}\n${ENTERED}\n${GENERATING}\n`)
    const reader = new LogReader(logPath)
    expect(reader.offset).toBe(0)

    const result = await reader.readDelta()
    expect(result.lines).toEqual([SLAIN, ENTERED, GENERATING])
  })

  it('preserves blank lines rather than silently dropping them', async () => {
    await append(`${SLAIN}\n\n${ENTERED}\n`)
    const reader = new LogReader(logPath)

    const result = await reader.readDelta()
    expect(result.lines).toEqual([SLAIN, '', ENTERED])
  })

  it('does not interleave overlapping calls', async () => {
    await append(`${SLAIN}\n${ENTERED}\n${GENERATING}\n`)
    const reader = new LogReader(logPath)

    // Fire both without awaiting the first - a naive setInterval watcher on a
    // slow disk does exactly this. The bytes must be split between them, never
    // duplicated.
    const [a, b] = await Promise.all([reader.readDelta(), reader.readDelta()])
    expect([...a.lines, ...b.lines]).toEqual([SLAIN, ENTERED, GENERATING])
    expect(a.bytesRead + b.bytesRead).toBe(bytes(`${SLAIN}\n${ENTERED}\n${GENERATING}\n`))
  })
})

describe('LogReader.seekToEnd', () => {
  it('skips content that already existed', async () => {
    await append(`${SLAIN}\n${ENTERED}\n`)
    const reader = new LogReader(logPath)

    const seek = await reader.seekToEnd()
    expect(seek.status).toBe('ok')
    expect(seek.lines).toEqual([])
    expect(seek.bytesRead).toBe(0)
    expect(reader.offset).toBe(bytes(`${SLAIN}\n${ENTERED}\n`))

    // The history is gone for good...
    expect((await reader.readDelta()).lines).toEqual([])

    // ...but anything written afterwards still arrives.
    await append(`${GENERATING}\n`)
    expect((await reader.readDelta()).lines).toEqual([GENERATING])
  })

  it('reports file-missing without throwing and leaves the offset at 0', async () => {
    const reader = new LogReader(logPath)

    const seek = await reader.seekToEnd()
    expect(seek.status).toBe('file-missing')
    expect(reader.offset).toBe(0)

    // The game starts later: everything in the new file is genuinely new, so it
    // must all be read even though we "seeked to the end" first.
    await append(`${SLAIN}\n`)
    expect((await reader.readDelta()).lines).toEqual([SLAIN])
  })
})

describe('LogReader.seekToStart', () => {
  it('rewinds so the file is replayed from the beginning', async () => {
    await append(`${SLAIN}\n${ENTERED}\n`)
    const reader = new LogReader(logPath)
    await reader.seekToEnd()
    expect((await reader.readDelta()).lines).toEqual([])

    reader.seekToStart()
    expect(reader.offset).toBe(0)

    const replay = await reader.readDelta()
    expect(replay.lines).toEqual([SLAIN, ENTERED])
    // A rewind we asked for is not a rotation.
    expect(replay.rotated).toBe(false)
  })
})

describe('rotation and truncation', () => {
  it('resets and re-reads when the file is truncated to something shorter', async () => {
    await append(`${SLAIN}\n${ENTERED}\n${GENERATING}\n`)
    const reader = new LogReader(logPath)
    expect((await reader.readDelta()).lines).toHaveLength(3)

    // PoE truncates Client.txt in place when it gets too big. Same file, same
    // birth time, size goes backwards.
    const shorter = `${SLAIN}\n`
    await overwrite(shorter)
    expect(bytes(shorter)).toBeLessThan(reader.offset)

    const rotatedRead = await reader.readDelta()
    expect(rotatedRead.status).toBe('ok')
    expect(rotatedRead.rotated).toBe(true)
    expect(rotatedRead.lines).toEqual([SLAIN])
    expect(rotatedRead.bytesRead).toBe(bytes(shorter))
    expect(reader.offset).toBe(bytes(shorter))

    // The rotation is reported exactly once; the next tick is quiet again.
    const after = await reader.readDelta()
    expect(after.rotated).toBe(false)
    expect(after.lines).toEqual([])
  })

  it('detects a replaced file even when it grew', async () => {
    await overwrite(`${SLAIN}\n`)
    const reader = new LogReader(logPath)
    expect((await reader.readDelta()).lines).toEqual([SLAIN])

    // Delete + recreate = a different file at the same path. The new file is
    // LONGER than our old offset, so the size check cannot see it - the content
    // fingerprint of the bytes we already consumed is what catches this.
    await fs.rm(logPath)
    await new Promise((resolve) => setTimeout(resolve, 25))
    await overwrite(`${ENTERED}\n${GENERATING}\n`)

    const rotatedRead = await reader.readDelta()
    expect(rotatedRead.rotated).toBe(true)
    expect(rotatedRead.backlog).toBe(true)
    expect(rotatedRead.lines).toEqual([ENTERED, GENERATING])
    expect(reader.offset).toBe(bytes(`${ENTERED}\n${GENERATING}\n`))
  })

  it('detects an in-place truncate-and-regrow PAST the old offset', async () => {
    // REGRESSION: same inode (so `birthtimeMs` is unchanged) and a new size that is
    // not smaller (so the size check is blind). The reader used to keep reading from
    // its stale offset, slicing into the MIDDLE of the new file and emitting the
    // byte fragment it found there as if it were a complete line - while everything
    // before that offset was silently skipped and never emitted at all.
    //
    // On Windows this is also how a plain delete+recreate looks: NTFS file tunneling
    // hands a same-named file created within ~15s the ORIGINAL creation timestamp.
    await append(`${SLAIN}\n${SLAIN}\n`)
    const reader = new LogReader(logPath)
    expect((await reader.readDelta()).lines).toHaveLength(2)
    const staleOffset = reader.offset

    // O_TRUNC + write: same file, same birth time, and longer than where we were.
    const replacement = `${ENTERED}\n${ENTERED}\n${ENTERED}\n`
    await overwrite(replacement)
    expect(bytes(replacement)).toBeGreaterThan(staleOffset)

    const rotatedRead = await reader.readDelta()
    expect(rotatedRead.rotated).toBe(true)
    expect(rotatedRead.backlog).toBe(true)
    // Whole lines from the start of the new file - not a fragment carved out of
    // the middle of line 3, and nothing skipped.
    expect(rotatedRead.lines).toEqual([ENTERED, ENTERED, ENTERED])
    expect(reader.offset).toBe(bytes(replacement))
  })

  it('does not report a rotation when the replacement kept the bytes we had read', async () => {
    // The fingerprint answers "are the bytes I already consumed still there?". When
    // they are, continuing from the offset loses nothing and duplicates nothing, so
    // there is no rotation to report however the file got that way.
    await append(`${SLAIN}\n`)
    const reader = new LogReader(logPath)
    expect((await reader.readDelta()).lines).toEqual([SLAIN])

    await overwrite(`${SLAIN}\n${ENTERED}\n`)

    const next = await reader.readDelta()
    expect(next.rotated).toBe(false)
    expect(next.lines).toEqual([ENTERED])
  })

  it('discards a partial line held over from the file that was replaced', async () => {
    await append(`${SLAIN}\n2026/07/26 19:30:00 truncated-half-l`)
    const reader = new LogReader(logPath)
    const first = await reader.readDelta()
    expect(first.lines).toEqual([SLAIN])

    await overwrite(`${ENTERED}\n`)
    const rotatedRead = await reader.readDelta()
    expect(rotatedRead.rotated).toBe(true)
    // The dead file's fragment must NOT be glued onto the new file's first line.
    expect(rotatedRead.lines).toEqual([ENTERED])
  })
})

describe('backlog reporting', () => {
  it('keeps backlog true for EVERY capped chunk of a rotation drain', async () => {
    // REGRESSION: `rotated` is true only on the call that noticed the reset, and a
    // capped first chunk routinely ends mid-line - so that one flagged result can
    // carry ZERO lines while every replayed line arrives later, unflagged. A
    // consumer keyed on `rotated` therefore published pre-existing deaths as live
    // and the replay clipper saved real OBS clips for them.
    await append(`${SLAIN}\n`)
    // One line per read, so the drain provably spans several calls.
    const reader = new LogReader(logPath, { maxBytesPerRead: bytes(`${SLAIN}\n`) })
    expect((await reader.readDelta()).lines).toEqual([SLAIN])

    const replacement = `${ENTERED}\n`.repeat(4)
    await overwrite(replacement)

    const flags: Array<{ rotated: boolean; backlog: boolean; lines: number }> = []
    for (;;) {
      const result = await reader.readDelta()
      flags.push({ rotated: result.rotated, backlog: result.backlog, lines: result.lines.length })
      if (result.bytesRead === 0) break
    }

    // Exactly one `rotated`, but backlog for the whole drain.
    expect(flags.filter((flag) => flag.rotated)).toHaveLength(1)
    const withLines = flags.filter((flag) => flag.lines > 0)
    expect(withLines.length).toBeGreaterThan(1)
    expect(withLines.every((flag) => flag.backlog)).toBe(true)

    // ...and the tail is live again once it has caught up.
    await append(`${SLAIN}\n`)
    const live = await reader.readDelta()
    expect(live.lines).toEqual([SLAIN])
    expect(live.backlog).toBe(false)
    expect(live.rotated).toBe(false)
  })

  it('treats content already in a file that appeared after file-missing as backlog', async () => {
    // REGRESSION: a locked/late-mounted drive means every open returns ENOENT and
    // the offset stays at 0. When the volume unlocks, a Client.txt with weeks of
    // history appears - it was NOT written while we watched, so publishing it as
    // live would fire a clip for every death in it.
    const reader = new LogReader(logPath)
    expect((await reader.seekToEnd()).status).toBe('file-missing')

    await append(`${SLAIN}\n${ENTERED}\n`)
    const first = await reader.readDelta()
    expect(first.status).toBe('ok')
    expect(first.lines).toEqual([SLAIN, ENTERED])
    expect(first.backlog).toBe(true)

    // Bytes written after we caught up are genuinely live.
    await append(`${GENERATING}\n`)
    const second = await reader.readDelta()
    expect(second.lines).toEqual([GENERATING])
    expect(second.backlog).toBe(false)
  })

  it('reports live reads as backlog:false after a normal seekToEnd', async () => {
    await append(`${SLAIN}\n`)
    const reader = new LogReader(logPath)
    await reader.seekToEnd()

    await append(`${ENTERED}\n`)
    const result = await reader.readDelta()
    expect(result.lines).toEqual([ENTERED])
    expect(result.backlog).toBe(false)
  })

  it('marks a deliberate seekToStart replay as backlog', async () => {
    await append(`${SLAIN}\n${ENTERED}\n`)
    const reader = new LogReader(logPath)
    await reader.seekToEnd()

    reader.seekToStart()
    const replay = await reader.readDelta()
    expect(replay.lines).toEqual([SLAIN, ENTERED])
    expect(replay.backlog).toBe(true)
    expect(replay.rotated).toBe(false)
  })
})

describe('partial lines', () => {
  it('holds a line written in two halves until its newline arrives', async () => {
    const reader = new LogReader(logPath)
    const head = '2026/07/26 19:26:31 1018412156 cffb0658 [INFO Client 5039'
    const tail = '6] : FyascoWorbinTime has been slain.\n'

    await append(head)
    const first = await reader.readDelta()
    expect(first.status).toBe('ok')
    expect(first.lines).toEqual([]) // consumed the bytes, emitted nothing
    expect(first.bytesRead).toBe(bytes(head))

    await append(tail)
    const second = await reader.readDelta()
    expect(second.lines).toEqual([SLAIN]) // exactly once, fully reassembled
    expect(second.bytesRead).toBe(bytes(tail))
  })

  it('never emits a trailing fragment that has no newline yet', async () => {
    await append(`${SLAIN}\n${ENTERED}`) // second line still being written
    const reader = new LogReader(logPath)

    const result = await reader.readDelta()
    expect(result.lines).toEqual([SLAIN])
    // The whole delta was consumed even though only one line came out.
    expect(result.bytesRead).toBe(bytes(`${SLAIN}\n${ENTERED}`))
  })
})

describe('UTF-8 safety', () => {
  it('decodes a multi-byte character split across two reads', async () => {
    // 💀 is 4 UTF-8 bytes (F0 9F 92 80); "ü" is 2. Both are cut mid-sequence.
    const line = 'Grüße 💀 has been slain.'
    const buffer = Buffer.from(`${line}\n`, 'utf8')
    const skullStart = Buffer.byteLength('Grüße ', 'utf8')
    const splitAt = skullStart + 2 // dead centre of the 4-byte emoji
    expect(buffer[splitAt]).toBeGreaterThanOrEqual(0x80) // a continuation byte

    const reader = new LogReader(logPath)
    await append(buffer.subarray(0, splitAt))
    const first = await reader.readDelta()
    expect(first.lines).toEqual([])
    expect(first.bytesRead).toBe(splitAt)

    await append(buffer.subarray(splitAt))
    const second = await reader.readDelta()
    expect(second.lines).toEqual([line])
    // No replacement character anywhere - the naive `chunk.toString()` failure mode.
    expect(second.lines[0]).not.toContain('�')
  })

  it('reassembles a character split by the read cap, not just by the writer', async () => {
    const line = 'Grüße 💀 has been slain.'
    const buffer = Buffer.from(`${line}\n`, 'utf8')
    const capAt = Buffer.byteLength('Grüße ', 'utf8') + 1 // inside the emoji

    // Whole line already on disk; the CAP is what cuts it mid-character.
    await append(buffer)
    const reader = new LogReader(logPath, { maxBytesPerRead: capAt })

    const first = await reader.readDelta()
    expect(first.bytesRead).toBe(capAt) // stopped mid-emoji
    expect(first.lines).toEqual([])

    // Drain the rest, still capAt bytes at a time.
    const collected: string[] = []
    for (;;) {
      const result = await reader.readDelta()
      collected.push(...result.lines)
      if (result.bytesRead === 0) break
    }
    expect(collected).toEqual([line])
    expect(reader.offset).toBe(buffer.length)
  })
})

describe('line endings', () => {
  it('strips CRLF terminators', async () => {
    await append(`${SLAIN}\r\n${ENTERED}\r\n`)
    const reader = new LogReader(logPath)

    const result = await reader.readDelta()
    expect(result.lines).toEqual([SLAIN, ENTERED])
    expect(result.lines.some((line) => line.includes('\r'))).toBe(false)
  })

  it('handles a CRLF split between the CR and the LF', async () => {
    const reader = new LogReader(logPath)
    await append(`${SLAIN}\r`)
    expect((await reader.readDelta()).lines).toEqual([])

    await append(`\n${ENTERED}\r\n`)
    expect((await reader.readDelta()).lines).toEqual([SLAIN, ENTERED])
  })
})

describe('missing and unreadable files', () => {
  it('returns file-missing instead of throwing when the file does not exist', async () => {
    const reader = new LogReader(path.join(dir, 'does-not-exist', 'Client.txt'))

    const result = await reader.readDelta()
    expect(result.status).toBe('file-missing')
    expect(result.lines).toEqual([])
    expect(result.rotated).toBe(false)
    expect(result.bytesRead).toBe(0)
    expect(result.error).toBeTypeOf('string')
    expect(result.code).toBe('ENOENT')
  })

  it('recovers on its own once the file appears', async () => {
    const reader = new LogReader(logPath)
    expect((await reader.readDelta()).status).toBe('file-missing')
    expect((await reader.readDelta()).status).toBe('file-missing')

    await append(`${SLAIN}\n`)
    const result = await reader.readDelta()
    expect(result.status).toBe('ok')
    expect(result.lines).toEqual([SLAIN])
  })

  it('reports read-error (never throws) when the path is not a readable file', async () => {
    // A directory: `open` succeeds on POSIX and the read fails with EISDIR;
    // Windows fails at `open`. Either way it must surface as data.
    const reader = new LogReader(dir)

    const result = await reader.readDelta()
    expect(result.status).toBe('read-error')
    expect(result.lines).toEqual([])
    expect(result.bytesRead).toBe(0)
    expect(result.error).toBeTypeOf('string')
  })
})

describe('read cap', () => {
  it('drains a large backlog across successive calls without losing or duplicating lines', async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `${SLAIN} #${i}`)
    const content = `${lines.join('\n')}\n`
    await append(content)

    // Deliberately tiny so the cap lands mid-line over and over.
    const reader = new LogReader(logPath, { maxBytesPerRead: 137 })

    const collected: string[] = []
    let guard = 0
    for (;;) {
      const result = await reader.readDelta()
      collected.push(...result.lines)
      if (result.bytesRead === 0) break
      if (++guard > 1000) throw new Error('read cap loop failed to terminate')
    }

    expect(collected).toEqual(lines)
    expect(reader.offset).toBe(bytes(content))
  })

  it('falls back to the default for a nonsensical cap', async () => {
    await append(`${SLAIN}\n${ENTERED}\n`)
    const reader = new LogReader(logPath, { maxBytesPerRead: 0 })

    // A literal 0 would read nothing forever; the guard turns it into the default.
    const result = await reader.readDelta()
    expect(result.lines).toEqual([SLAIN, ENTERED])
  })
})
