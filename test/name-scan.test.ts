/**
 * test/name-scan.test.ts
 * ======================
 *
 * The bounded tail sweep that fills the character picker on a FRESH LAUNCH.
 *
 * The failure this file guards against is the silent one the picker itself exists to
 * prevent: the app starts, seeks to the end of a 41MB Client.txt without parsing a
 * byte of it, resolves `source: 'none'`, raises its "nothing will be clipped" alarm -
 * and then offers an EMPTY list of names, so the user is told to type a name from
 * memory while every name they need is in the file main already has open.
 *
 * Real temp files throughout, and every log line below is verbatim from the user's
 * 375,087-line reference Client.txt. Mocking `node:fs` here would prove only that the
 * mock was called; the interesting parts (the byte window, the partial first line, a
 * missing file) are all filesystem behaviour.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CharacterTracker } from '../src/main/log/character-tracker'
import {
  DEFAULT_SCAN_BYTES,
  scanLogForNameEvents,
  type NameBearingEvent
} from '../src/main/log/name-scan'

// ---------------------------------------------------------------------------
// Fixtures - all verbatim
// ---------------------------------------------------------------------------

const SLAIN_LINE =
  '2026/07/26 19:26:31 1018412156 cffb0658 [INFO Client 50396] : FyascoWorbinTime has been slain.'
const SUICIDE_LINE =
  '2025/07/13 09:52:01 176574078 cff945b9 [INFO Client 42816] : LargeThumbThomasReturns has committed suicide.'
const LEVEL_LINE =
  '2025/06/19 16:22:33 10127484 cff945b9 [INFO Client 6956] : LargeThumbThomasReturns (Marauder) is now level 2'
const ZONE_LINE =
  '2026/07/26 19:26:29 1018410000 cffb0658 [INFO Client 50396] : You have entered Karui Shores.'
const AREA_LINE =
  '2026/07/26 19:26:28 1018409000 cffb0658 [DEBUG Client 50396] Generating level 69 area "2_11_endgame_town" with seed 1'
/** Player chat. The `": "` system marker is absent, so this must never become a death. */
const CHAT_LINE =
  '2026/07/26 19:20:00 1018000000 cffb0658 [INFO Client 50396] aetetuya: Tenning has been slain.'
/** An indented continuation - one of the 1,071 lines with no envelope at all. */
const NO_ENVELOPE_LINE = '\tAction Id = 33623'

const T0 = 1_700_000_000_000

let dir = ''
let logPath = ''

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'poe-tool-namescan-'))
  logPath = path.join(dir, 'Client.txt')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Writes a Client.txt with CRLF line endings, exactly as the game does. */
async function writeLog(lines: readonly string[]): Promise<void> {
  await writeFile(logPath, `${lines.join('\r\n')}\r\n`, 'utf8')
}

/**
 * `maxBytes` is passed only when the test cares: `exactOptionalPropertyTypes` forbids
 * handing an explicit `undefined` to an optional property.
 */
function scan(maxBytes?: number): Promise<readonly NameBearingEvent[]> {
  return scanLogForNameEvents(
    logPath,
    maxBytes === undefined ? { now: () => T0 } : { now: () => T0, maxBytes }
  )
}

// ---------------------------------------------------------------------------

describe('scanLogForNameEvents', () => {
  it('finds every name-bearing line in a small log, in file order', async () => {
    await writeLog([AREA_LINE, ZONE_LINE, SLAIN_LINE, LEVEL_LINE, SUICIDE_LINE])

    const events = await scan()

    expect(events.map((e) => e.characterName)).toEqual([
      'FyascoWorbinTime',
      'LargeThumbThomasReturns',
      'LargeThumbThomasReturns'
    ])
  })

  it('keeps deaths and level-ups only - a zone name is a place, not a person', async () => {
    await writeLog([ZONE_LINE, AREA_LINE, ZONE_LINE])

    expect(await scan()).toEqual([])
  })

  it('does not let a chat message forge a name', async () => {
    // The `": "` system marker is the ONLY thing separating an engine message from a
    // player typing a death line into global chat. The scan runs the same `parseLine`
    // the tail loop does, so the gate holds here too.
    await writeLog([CHAT_LINE, NO_ENVELOPE_LINE])

    expect(await scan()).toEqual([])
  })

  it('stamps the events as backlog - they predate us by construction', async () => {
    await writeLog([SLAIN_LINE])

    const events = await scanLogForNameEvents(logPath, { now: () => T0 })

    expect(events).toHaveLength(1)
    expect(events[0]?.backlog).toBe(true)
    expect(events[0]?.detectedAt).toBe(T0)
  })

  it('never claims a death is ours: isSelf is false regardless of who is playing', async () => {
    // The scan exists to help the user CHOOSE the active character, so it cannot assume
    // one. Publishing these events is impossible anyway (they are returned, not emitted),
    // but a value object that guessed `isSelf` would be a trap for the next consumer.
    await writeLog([SLAIN_LINE])

    const events = await scanLogForNameEvents(logPath, { now: () => T0 })

    expect(events[0]).toMatchObject({ type: 'death', isSelf: false, cause: 'slain' })
  })

  it('reads the TAIL: a name only in the head of an over-long file is not offered', async () => {
    // 4KB window over a much bigger file. The old name is genuinely in the log, and is
    // genuinely not what the user is playing now.
    const filler = Array.from(
      { length: 200 },
      (_, i) =>
        `2026/07/26 19:26:${String(i % 60).padStart(2, '0')} 100000${i} cffb0658 [INFO Client 50396] : Some unremarkable line ${i}`
    )
    await writeLog([LEVEL_LINE, ...filler, SLAIN_LINE])

    const events = await scan(4 * 1024)

    expect(events.map((e) => e.characterName)).toEqual(['FyascoWorbinTime'])
  })

  it('drops the partial first line a mid-file start produces', async () => {
    // The window is sized to land INSIDE the first death line. Half a line must not be
    // parsed: a truncated envelope would be an `unmatched` anyway, but a body cut at
    // the wrong byte is exactly how a half-read name would sneak into the picker.
    const tail = `${SLAIN_LINE}\r\n${LEVEL_LINE}\r\n`
    const head = `${SUICIDE_LINE}\r\n`
    await writeFile(logPath, head + tail, 'utf8')

    const events = await scan(Buffer.byteLength(tail, 'utf8') + 20)

    expect(events.map((e) => e.characterName)).toEqual([
      'FyascoWorbinTime',
      'LargeThumbThomasReturns'
    ])
  })

  it('handles a window that covers the whole file with no first-line loss', async () => {
    await writeLog([SLAIN_LINE, LEVEL_LINE])

    // maxBytes far larger than the file: `start` is 0, so nothing is dropped.
    const events = await scan(DEFAULT_SCAN_BYTES)

    expect(events).toHaveLength(2)
  })

  it('survives multi-byte characters split by the window boundary', async () => {
    // PoE logs non-ASCII item and player names. A byte-sliced window can cut one in
    // half; the damage is confined to the dropped first line.
    const head = `2026/07/26 19:00:00 1000000000 cffb0658 [INFO Client 50396] : Vaal Ähnliches Ding gefunden\r\n`
    await writeFile(logPath, `${head}${SLAIN_LINE}\r\n`, 'utf8')

    const events = await scan(Buffer.byteLength(SLAIN_LINE, 'utf8') + 12)

    expect(events.map((e) => e.characterName)).toEqual(['FyascoWorbinTime'])
  })

  // -------------------------------------------------------------------------
  // Total: every failure is an empty list, never a throw
  // -------------------------------------------------------------------------

  it('returns nothing when no log path is configured', async () => {
    expect(await scanLogForNameEvents(null)).toEqual([])
    expect(await scanLogForNameEvents('   ')).toEqual([])
  })

  it('returns nothing - and reports - when the file does not exist', async () => {
    const errors: unknown[] = []

    const events = await scanLogForNameEvents(path.join(dir, 'nope', 'Client.txt'), {
      onError: (error) => errors.push(error)
    })

    // The game has simply never run. Normal, not an error the user should see.
    expect(events).toEqual([])
    expect(errors).toHaveLength(1)
  })

  it('returns nothing for an empty file', async () => {
    await writeFile(logPath, '', 'utf8')

    expect(await scan()).toEqual([])
  })

  it('is not derailed by a throwing onError hook', async () => {
    const events = await scanLogForNameEvents(path.join(dir, 'missing.txt'), {
      onError: () => {
        throw new Error('logger exploded')
      }
    })

    expect(events).toEqual([])
  })

  it('feeds CharacterTracker.suggestionsFrom, most frequent first', async () => {
    // The actual production pipeline: scan -> tally -> picker.
    await writeLog([SLAIN_LINE, LEVEL_LINE, SUICIDE_LINE, ZONE_LINE, LEVEL_LINE])

    const names = CharacterTracker.suggestionsFrom(await scanLogForNameEvents(logPath))

    expect(names).toEqual(['LargeThumbThomasReturns', 'FyascoWorbinTime'])
  })
})
