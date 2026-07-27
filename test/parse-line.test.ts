/**
 * test/parse-line.test.ts
 * =======================
 *
 * Coverage for `src/main/log/parse-line.ts` and the patterns it drives.
 *
 * The three constants below are REAL lines from a live Client.txt, verified by
 * the user - they are the ground truth this whole module is written against.
 * Every other input in this file is a deliberate mutation of one of them, so a
 * failure always points at a specific decision rather than at "some string".
 *
 * Runs on macOS against Windows-shaped data: nothing here touches the
 * filesystem except the fixture read, and the timestamp assertions are
 * expressed in LOCAL time (`new Date(y, m, d, ...)` on both sides) so they hold
 * in any timezone the test machine happens to be in.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { parseLine } from '../src/main/log/parse-line'
import type { ParseLineOptions } from '../src/main/log/parse-line'
import type {
  AreaGeneratedEvent,
  DeathEvent,
  LevelUpEvent,
  ParseResult,
  UnmatchedLine,
  ZoneEnteredEvent
} from '../src/shared/events'

// ---------------------------------------------------------------------------
// Ground truth
// ---------------------------------------------------------------------------

/** REAL LINE. Own-character death, system message. */
const LINE_DEATH =
  '2026/07/26 19:26:31 1018412156 cffb0658 [INFO Client 50396] : FyascoWorbinTime has been slain.'

/**
 * REAL LINE. `/kill`, system message. One of only SEVEN in the 375,087-line
 * reference log - a rate so low that a regression here would never be spotted
 * in the wild, which is the whole reason it is pinned in a test.
 */
const LINE_SUICIDE =
  '2025/07/13 09:52:01 176574078 cff945b9 [INFO Client 42816] : LargeThumbThomasReturns has committed suicide.'

/**
 * REAL LINE. Level-up, system message. Note there is NO TRAILING PERIOD - the
 * sentence ends on the digits, unlike every other body pattern in the project.
 */
const LINE_LEVEL_UP =
  '2025/06/19 16:22:33 10127484 cff945b9 [INFO Client 6956] : LargeThumbThomasReturns (Marauder) is now level 2'

/** REAL LINE. Zone transition, system message. */
const LINE_ZONE =
  '2026/07/26 19:28:42 1018543171 cffb0658 [INFO Client 50396] : You have entered Karui Shores.'

/** REAL LINE. Area generation, DEBUG, NO system marker. */
const LINE_AREA =
  '2026/07/26 19:28:41 1018542484 1186a8a3 [DEBUG Client 50396] Generating level 69 area "2_11_endgame_town" with seed 1'

const SELF = 'FyascoWorbinTime'
const DETECTED_AT = 1_800_000_000_000

const BASE_OPTS: ParseLineOptions = {
  detectedAt: DETECTED_AT,
  backlog: false,
  selfName: SELF
}

function parse(raw: string, overrides: Partial<ParseLineOptions> = {}): ParseResult {
  return parseLine(raw, { ...BASE_OPTS, ...overrides })
}

// ---------------------------------------------------------------------------
// Narrowing helpers - throw rather than cast, so no `any`/`!` appears in a test
// ---------------------------------------------------------------------------

function expectDeath(result: ParseResult): DeathEvent {
  if (result.type !== 'death') throw new Error(`expected a death event, got "${result.type}"`)
  return result
}

function expectLevelUp(result: ParseResult): LevelUpEvent {
  if (result.type !== 'level-up') throw new Error(`expected level-up, got "${result.type}"`)
  return result
}

function expectZone(result: ParseResult): ZoneEnteredEvent {
  if (result.type !== 'zone-entered') throw new Error(`expected zone-entered, got "${result.type}"`)
  return result
}

function expectArea(result: ParseResult): AreaGeneratedEvent {
  if (result.type !== 'area-generated') {
    throw new Error(`expected area-generated, got "${result.type}"`)
  }
  return result
}

function expectUnmatched(result: ParseResult): UnmatchedLine {
  if (result.type !== 'unmatched') throw new Error(`expected unmatched, got "${result.type}"`)
  return result
}

/** Indexing helper that keeps `noUncheckedIndexedAccess` happy without `!`. */
function nth<T>(items: readonly T[], index: number): T {
  const item = items[index]
  if (item === undefined) {
    throw new Error(`expected an item at index ${index}, but there are ${items.length}`)
  }
  return item
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

describe('envelope decoding', () => {
  it('decodes every field of the real death line', () => {
    const { meta } = expectDeath(parse(LINE_DEATH))

    expect(meta.raw).toBe(LINE_DEATH)
    expect(meta.clientMs).toBe(1018412156)
    expect(meta.threadTag).toBe('cffb0658')
    expect(meta.level).toBe('INFO')
    expect(meta.subsystem).toBe('Client')
    expect(meta.pid).toBe(50396)
    expect(meta.isSystemMessage).toBe(true)
    // The ": " marker is stripped off the exposed body.
    expect(meta.body).toBe('FyascoWorbinTime has been slain.')
  })

  it('parses the timestamp as LOCAL wall-clock time', () => {
    const { meta } = expectDeath(parse(LINE_DEATH))

    // Component-wise: immune to the test machine's timezone.
    expect(meta.timestamp.getFullYear()).toBe(2026)
    expect(meta.timestamp.getMonth()).toBe(6) // zero-based: July
    expect(meta.timestamp.getDate()).toBe(26)
    expect(meta.timestamp.getHours()).toBe(19)
    expect(meta.timestamp.getMinutes()).toBe(26)
    expect(meta.timestamp.getSeconds()).toBe(31)
    expect(meta.timestamp.getMilliseconds()).toBe(0)
    // And it is exactly the Date the documented constructor call would build.
    expect(meta.timestamp.getTime()).toBe(new Date(2026, 6, 26, 19, 26, 31).getTime())
  })

  it('keeps the DEBUG line flagged as NOT a system message', () => {
    const { meta } = expectArea(parse(LINE_AREA))

    expect(meta.level).toBe('DEBUG')
    expect(meta.threadTag).toBe('1186a8a3')
    expect(meta.isSystemMessage).toBe(false)
    expect(meta.body).toBe('Generating level 69 area "2_11_endgame_town" with seed 1')
  })

  it('tolerates an unknown level name rather than failing the envelope', () => {
    const line =
      '2026/07/26 19:28:42 1018543171 cffb0658 [TRACE Client 50396] : You have entered Karui Shores.'
    const event = expectZone(parse(line))

    expect(event.meta.level).toBe('TRACE')
    expect(event.zoneName).toBe('Karui Shores')
  })

  it('tolerates an absent body', () => {
    const line = '2026/07/26 19:26:31 1018412156 cffb0658 [INFO Client 50396]'
    const { meta } = expectUnmatched(parse(line))

    expect(meta).not.toBeNull()
    expect(meta?.body).toBe('')
    expect(meta?.isSystemMessage).toBe(false)
    expect(meta?.pid).toBe(50396)
  })

  it('tolerates a bracket followed by a space and nothing else', () => {
    const line = '2026/07/26 19:26:31 1018412156 cffb0658 [INFO Client 50396] '
    const { meta } = expectUnmatched(parse(line))

    expect(meta).not.toBeNull()
    expect(meta?.body).toBe('')
  })

  it('treats a system line with an unrecognised message as unmatched but decoded', () => {
    const line = '2026/07/26 19:30:00 1018600000 cffb0658 [INFO Client 50396] : Trade accepted.'
    const { meta } = expectUnmatched(parse(line))

    expect(meta?.isSystemMessage).toBe(true)
    expect(meta?.body).toBe('Trade accepted.')
  })
})

describe('malformed envelopes', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['a line that is not a log line at all', 'FyascoWorbinTime has been slain.'],
    ['an empty string', ''],
    ['whitespace only', '   '],
    [
      'a truncated partial write (cut mid-envelope)',
      '2026/07/26 19:26:31 1018412156 cffb065'
    ],
    [
      'a missing pid',
      '2026/07/26 19:26:31 1018412156 cffb0658 [INFO Client] : FyascoWorbinTime has been slain.'
    ],
    [
      'a two-digit year',
      '26/07/26 19:26:31 1018412156 cffb0658 [INFO Client 50396] : FyascoWorbinTime has been slain.'
    ],
    [
      'a missing bracket group',
      '2026/07/26 19:26:31 1018412156 cffb0658 : FyascoWorbinTime has been slain.'
    ]
  ]

  for (const [label, line] of cases) {
    it(`returns meta null for ${label}`, () => {
      const result = expectUnmatched(parse(line))

      expect(result.meta).toBeNull()
      // `raw` is always present so tail:debug can show what was skipped.
      expect(result.raw).toBe(line)
    })
  }
})

// ---------------------------------------------------------------------------
// Death
// ---------------------------------------------------------------------------

describe('death detection', () => {
  it('parses the real death line into a DeathEvent', () => {
    const event = expectDeath(parse(LINE_DEATH))

    expect(event.type).toBe('death')
    expect(event.characterName).toBe('FyascoWorbinTime')
    expect(event.isSelf).toBe(true)
    // The game killed us. Contrast LINE_SUICIDE below.
    expect(event.cause).toBe('slain')
  })

  it('marks a party member death as not self', () => {
    const line =
      '2026/07/26 19:26:35 1018416002 cffb0658 [INFO Client 50396] : PartyHealerBot has been slain.'
    const event = expectDeath(parse(line))

    expect(event.characterName).toBe('PartyHealerBot')
    expect(event.isSelf).toBe(false)
  })

  it('matches the configured name case-insensitively', () => {
    expect(expectDeath(parse(LINE_DEATH, { selfName: 'fyascoworbintime' })).isSelf).toBe(true)
    expect(expectDeath(parse(LINE_DEATH, { selfName: 'FYASCOWORBINTIME' })).isSelf).toBe(true)
    expect(expectDeath(parse(LINE_DEATH, { selfName: 'FyAsCoWoRbInTiMe' })).isSelf).toBe(true)
  })

  it('ignores surrounding whitespace on the configured name', () => {
    expect(expectDeath(parse(LINE_DEATH, { selfName: '  FyascoWorbinTime  ' })).isSelf).toBe(true)
  })

  it('is never self when no character name is configured', () => {
    expect(expectDeath(parse(LINE_DEATH, { selfName: '' })).isSelf).toBe(false)
    expect(expectDeath(parse(LINE_DEATH, { selfName: '   ' })).isSelf).toBe(false)
  })

  it('does not match a name that is merely a prefix of the configured one', () => {
    const line =
      '2026/07/26 19:26:31 1018412156 cffb0658 [INFO Client 50396] : Fyasco has been slain.'
    const event = expectDeath(parse(line))

    expect(event.characterName).toBe('Fyasco')
    expect(event.isSelf).toBe(false)
  })

  it('accepts the optional " by <killer>" clause and reports the victim', () => {
    const line =
      '2026/07/26 19:26:31 1018412156 cffb0658 [INFO Client 50396] : FyascoWorbinTime has been slain by Hillock.'
    const event = expectDeath(parse(line))

    expect(event.characterName).toBe('FyascoWorbinTime')
    expect(event.isSelf).toBe(true)
    // Still an ordinary death: the killer clause does not change the cause.
    expect(event.cause).toBe('slain')
  })

  it('refuses a multi-word "name" - PoE names have no spaces', () => {
    const line =
      '2026/07/26 19:26:31 1018412156 cffb0658 [INFO Client 50396] : lol Fyasco has been slain.'
    const result = expectUnmatched(parse(line))

    expect(result.meta?.isSystemMessage).toBe(true)
  })

  it('refuses trailing text after the final period', () => {
    const line =
      '2026/07/26 19:26:31 1018412156 cffb0658 [INFO Client 50396] : FyascoWorbinTime has been slain. gg'
    expectUnmatched(parse(line))
  })

  it('still recognises every real slain shape - the 348/348 baseline', () => {
    // The reference log contains 348 "has been slain." lines and the parser
    // matched all 348 before suicide/level-up were added. These are the shapes
    // those 348 take: six distinct own-alt names, all bare (no killer clause).
    // If adding a pattern ever shadowed DEATH, this is what would break.
    const names = [
      'LargeThumbThomasReturns',
      'WorldWordleChamp',
      'LargerThumbThomas',
      'Burgertrash',
      'OneLongToe',
      'FyascoWorbinTime'
    ] as const

    for (const name of names) {
      const line = `2026/07/26 19:26:31 1018412156 cffb0658 [INFO Client 50396] : ${name} has been slain.`
      const event = expectDeath(parse(line, { selfName: name }))

      expect(event.characterName).toBe(name)
      expect(event.cause).toBe('slain')
      expect(event.isSelf).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Suicide (`/kill`)
// ---------------------------------------------------------------------------

describe('suicide detection', () => {
  it('parses the real suicide line as a DeathEvent with cause "suicide"', () => {
    const event = expectDeath(parse(LINE_SUICIDE, { selfName: 'LargeThumbThomasReturns' }))

    // It IS a death - it counts for stats and rides the same bus channels.
    expect(event.type).toBe('death')
    expect(event.characterName).toBe('LargeThumbThomasReturns')
    expect(event.isSelf).toBe(true)
    // ...and the discriminator is the ONLY thing that tells the clipper to
    // ignore it. Getting this wrong means clipping thirty seconds of nothing.
    expect(event.cause).toBe('suicide')
  })

  it('decodes the envelope of the real suicide line', () => {
    const { meta } = expectDeath(parse(LINE_SUICIDE))

    expect(meta.isSystemMessage).toBe(true)
    expect(meta.body).toBe('LargeThumbThomasReturns has committed suicide.')
    expect(meta.pid).toBe(42816)
    expect(meta.clientMs).toBe(176574078)
  })

  it('applies the same isSelf rule as a slaying', () => {
    // Case-insensitive + trimmed, exactly like DEATH.
    expect(expectDeath(parse(LINE_SUICIDE, { selfName: 'largethumbthomasreturns' })).isSelf).toBe(
      true
    )
    expect(
      expectDeath(parse(LINE_SUICIDE, { selfName: '  LargeThumbThomasReturns  ' })).isSelf
    ).toBe(true)
    // A party member's /kill is still reported, just not as ours.
    expect(expectDeath(parse(LINE_SUICIDE, { selfName: 'SomeoneElse' })).isSelf).toBe(false)
    // Nothing configured and nothing detected => never self.
    expect(expectDeath(parse(LINE_SUICIDE, { selfName: '' })).isSelf).toBe(false)
  })

  it('refuses a multi-word "name" - PoE names have no spaces', () => {
    const line =
      '2025/07/13 09:52:01 176574078 cff945b9 [INFO Client 42816] : lol Bob has committed suicide.'
    const result = expectUnmatched(parse(line))

    expect(result.meta?.isSystemMessage).toBe(true)
  })

  it('refuses trailing text after the final period', () => {
    const line =
      '2025/07/13 09:52:01 176574078 cff945b9 [INFO Client 42816] : Bob has committed suicide. lol'
    expectUnmatched(parse(line))
  })

  it('has no speculative " by <killer>" clause, unlike a slaying', () => {
    // DEATH tolerates "slain by Hillock." because other clients are reported to
    // log it. Nothing suggests a suicide variant, so it gets no such slack.
    const line =
      '2025/07/13 09:52:01 176574078 cff945b9 [INFO Client 42816] : Bob has committed suicide by Hillock.'
    expectUnmatched(parse(line))
  })
})

// ---------------------------------------------------------------------------
// Level up - the sole basis for auto-detecting the active character
// ---------------------------------------------------------------------------

describe('level-up detection', () => {
  it('parses the real level-up line', () => {
    const event = expectLevelUp(parse(LINE_LEVEL_UP))

    expect(event.type).toBe('level-up')
    expect(event.characterName).toBe('LargeThumbThomasReturns')
    expect(event.className).toBe('Marauder')
    expect(event.level).toBe(2)
    expect(event.meta.isSystemMessage).toBe(true)
    // No trailing period on this sentence - the body ends on the digit.
    expect(event.meta.body).toBe('LargeThumbThomasReturns (Marauder) is now level 2')
  })

  it('emits a number, not a string, for the level', () => {
    expect(typeof expectLevelUp(parse(LINE_LEVEL_UP)).level).toBe('number')
  })

  it('parses an ASCENDANCY class, not just a base class', () => {
    // REAL LINE. The same character that levelled as a Marauder above is a
    // Berserker after ascending - which is exactly why className is display
    // metadata and nothing may be keyed on it.
    const line =
      '2025/06/19 21:04:27 27066859 cff945b9 [INFO Client 7816] : LargeThumbThomasReturns (Berserker) is now level 41'
    const event = expectLevelUp(parse(line))

    expect(event.characterName).toBe('LargeThumbThomasReturns')
    expect(event.className).toBe('Berserker')
    expect(event.level).toBe(41)
  })

  it('parses the highest level actually observed in the reference log', () => {
    // REAL LINE. Level 98, two digits, a different alt and a third class.
    const line =
      '2026/03/17 15:10:58 398336625 cffb06dd [INFO Client 46332] : WorldWordleChamp (Slayer) is now level 98'
    const event = expectLevelUp(parse(line))

    expect(event.characterName).toBe('WorldWordleChamp')
    expect(event.className).toBe('Slayer')
    expect(event.level).toBe(98)
  })

  it('parses a THREE-DIGIT level', () => {
    // Synthetic: the reference log tops out at 98, but PoE 1 caps at 100 and
    // `(\d+)` is deliberately unbounded. A pattern that quietly stopped matching
    // at the cap would lose the level-100 detection - the rarest and most
    // interesting one there is.
    const line =
      '2026/03/17 15:10:58 398336625 cffb06dd [INFO Client 46332] : WorldWordleChamp (Slayer) is now level 100'
    const event = expectLevelUp(parse(line))

    expect(event.level).toBe(100)
    expect(event.className).toBe('Slayer')
  })

  it('keeps an underscore in a character name', () => {
    // REAL LINE. `\S+` covers the whole token, punctuation included.
    const line =
      '2026/07/24 17:53:15 840012609 cffb06dd [INFO Client 44504] : Frogo_ (Witch) is now level 2'
    const event = expectLevelUp(parse(line))

    expect(event.characterName).toBe('Frogo_')
    expect(event.className).toBe('Witch')
  })

  it('tolerates a multi-word class name', () => {
    // Synthetic. No observed class contains a space, but the pattern uses
    // `[^)]+` rather than `\S+` so that assumption is not baked in.
    const line =
      '2026/03/17 15:10:58 398336625 cffb06dd [INFO Client 46332] : WorldWordleChamp (Some Future Class) is now level 42'
    expect(expectLevelUp(parse(line)).className).toBe('Some Future Class')
  })

  it('refuses a trailing period - this sentence genuinely has none', () => {
    const line =
      '2025/06/19 16:22:33 10127484 cff945b9 [INFO Client 6956] : LargeThumbThomasReturns (Marauder) is now level 2.'
    const result = expectUnmatched(parse(line))

    expect(result.meta?.isSystemMessage).toBe(true)
  })

  it('refuses a multi-word "name" - PoE names have no spaces', () => {
    const line =
      '2025/06/19 16:22:33 10127484 cff945b9 [INFO Client 6956] : lol Bob (Marauder) is now level 2'
    expectUnmatched(parse(line))
  })

  it('refuses a missing or empty class', () => {
    const stamp = '2025/06/19 16:22:33 10127484 cff945b9 [INFO Client 6956] : '

    expectUnmatched(parse(`${stamp}Bob is now level 2`))
    expectUnmatched(parse(`${stamp}Bob () is now level 2`))
  })

  it('refuses a non-numeric level', () => {
    const line =
      '2025/06/19 16:22:33 10127484 cff945b9 [INFO Client 6956] : Bob (Marauder) is now level two'
    expectUnmatched(parse(line))
  })

  it('refuses trailing text after the level', () => {
    const line =
      '2025/06/19 16:22:33 10127484 cff945b9 [INFO Client 6956] : Bob (Marauder) is now level 2 gz'
    expectUnmatched(parse(line))
  })
})

// ---------------------------------------------------------------------------
// The anti-spoofing gate
// ---------------------------------------------------------------------------

describe('system-marker gate (anti-spoofing)', () => {
  it('does NOT produce a DeathEvent for a chat line containing "has been slain."', () => {
    // "] TrollMcSpoof: ..." - player chat, so the body has no leading ": ".
    const line =
      '2026/07/26 19:26:40 1018421337 cffb0658 [INFO Client 50396] TrollMcSpoof: FyascoWorbinTime has been slain.'
    const result = expectUnmatched(parse(line))

    expect(result.meta?.isSystemMessage).toBe(false)
    // The dangerous text IS in the body - only the gate stopped it.
    expect(result.meta?.body).toBe('TrollMcSpoof: FyascoWorbinTime has been slain.')
  })

  it('does NOT produce a DeathEvent for a chat line containing "has committed suicide."', () => {
    // "] Troll: ..." - player chat, so the body has no leading ": ".
    const line =
      '2025/07/13 09:52:01 176574078 cff945b9 [INFO Client 42816] Troll: Bob has committed suicide.'
    const result = expectUnmatched(parse(line))

    expect(result.meta?.isSystemMessage).toBe(false)
    // The dangerous text IS in the body - only the gate stopped it.
    expect(result.meta?.body).toBe('Troll: Bob has committed suicide.')
  })

  it('does NOT produce a LevelUpEvent for a chat line containing "is now level"', () => {
    // The worst of the three to get wrong: this one does not fake an event, it
    // fakes WHO WE ARE. A stranger in global chat could point auto-detection at
    // a name that is not ours, and every subsequent real death of ours would
    // then read as someone else's and never clip.
    const line =
      '2025/06/19 16:22:33 10127484 cff945b9 [INFO Client 6956] Troll: Bob (Slayer) is now level 99'
    const result = expectUnmatched(parse(line))

    expect(result.meta?.isSystemMessage).toBe(false)
    expect(result.meta?.body).toBe('Troll: Bob (Slayer) is now level 99')
  })

  it('is not fooled by a leading colon typed before either new sentence', () => {
    // Renders as "] Name: : text" - the body starts with the name, never ": ".
    const stamp = '2025/07/13 09:52:01 176574078 cff945b9 [INFO Client 42816] Troll: : '

    expect(expectUnmatched(parse(`${stamp}Bob has committed suicide.`)).meta?.isSystemMessage).toBe(
      false
    )
    expect(expectUnmatched(parse(`${stamp}Bob (Slayer) is now level 99`)).meta?.isSystemMessage).toBe(
      false
    )
  })

  it('is not fooled by guild or whisper prefixes on either new sentence', () => {
    // Real chat renders as "] &<Guild> Name: msg" and "] @To Name: msg".
    const head = '2025/07/13 09:52:01 176574078 cff945b9 [INFO Client 42816] '

    expectUnmatched(parse(`${head}&Guild Troll: Bob has committed suicide.`))
    expectUnmatched(parse(`${head}@To Troll: Bob (Slayer) is now level 99`))
  })

  it('does NOT produce a ZoneEnteredEvent for a chat line containing "You have entered"', () => {
    const line =
      '2026/07/26 19:29:12 1018573210 cffb0658 [INFO Client 50396] TrollMcSpoof: You have entered Karui Shores.'
    const result = expectUnmatched(parse(line))

    expect(result.meta?.isSystemMessage).toBe(false)
  })

  it('is not fooled by a player typing a leading colon', () => {
    // Renders as "] Name: : text" - the body starts with the name, never ": ".
    const line =
      '2026/07/26 19:26:40 1018421337 cffb0658 [INFO Client 50396] TrollMcSpoof: : FyascoWorbinTime has been slain.'
    const result = expectUnmatched(parse(line))

    expect(result.meta?.isSystemMessage).toBe(false)
  })

  it('is not fooled by a global-chat prefix', () => {
    const line =
      '2026/07/26 19:26:40 1018421337 cffb0658 [INFO Client 50396] #TrollMcSpoof: FyascoWorbinTime has been slain.'
    expectUnmatched(parse(line))
  })
})

// ---------------------------------------------------------------------------
// Zone entered
// ---------------------------------------------------------------------------

describe('zone-entered detection', () => {
  it('parses the real zone line', () => {
    const event = expectZone(parse(LINE_ZONE))

    expect(event.type).toBe('zone-entered')
    expect(event.zoneName).toBe('Karui Shores')
    expect(event.meta.isSystemMessage).toBe(true)
    expect(event.meta.clientMs).toBe(1018543171)
  })

  it('keeps apostrophes and multiple words intact', () => {
    const line =
      "2026/07/26 19:28:42 1018543171 cffb0658 [INFO Client 50396] : You have entered Lioneye's Watch."
    expect(expectZone(parse(line)).zoneName).toBe("Lioneye's Watch")
  })

  it('handles a non-ASCII zone name', () => {
    const line =
      '2026/07/26 19:29:03 1018564511 cffb0658 [INFO Client 50396] : You have entered Épreuve du Chaos.'
    expect(expectZone(parse(line)).zoneName).toBe('Épreuve du Chaos')
  })
})

// ---------------------------------------------------------------------------
// Area generated
// ---------------------------------------------------------------------------

describe('area-generated detection', () => {
  it('parses the real DEBUG line without needing a system marker', () => {
    const event = expectArea(parse(LINE_AREA))

    expect(event.type).toBe('area-generated')
    expect(event.areaLevel).toBe(69)
    expect(event.areaId).toBe('2_11_endgame_town')
    expect(event.seed).toBe(1) // seed 1 => non-procedural (town/hideout)
    expect(event.meta.isSystemMessage).toBe(false)
  })

  it('parses a procedural map instance with a large seed', () => {
    const line =
      '2026/07/26 19:29:02 1018563900 1186a8a3 [DEBUG Client 50396] Generating level 68 area "MapWorldsSpiderForest" with seed 2145678123'
    const event = expectArea(parse(line))

    expect(event.areaLevel).toBe(68)
    expect(event.areaId).toBe('MapWorldsSpiderForest')
    expect(event.seed).toBe(2145678123)
  })

  it('emits numbers, not strings', () => {
    const event = expectArea(parse(LINE_AREA))

    expect(typeof event.areaLevel).toBe('number')
    expect(typeof event.seed).toBe('number')
  })
})

// ---------------------------------------------------------------------------
// Pattern independence
// ---------------------------------------------------------------------------

describe('no pattern shadows another', () => {
  // parse-line.ts orders its checks purely for cost (latency-critical DEATH
  // first, then descending frequency), and that is only defensible because the
  // five sentence shapes are mutually exclusive. If that ever stopped being
  // true, the ordering would silently start deciding which event you get.
  // NOTE both death shapes resolve to the SAME `type` ('death') and differ only
  // in `cause` - that is the design, not an oversight, so the table carries the
  // label separately from the discriminant it is checking.
  const cases: ReadonlyArray<readonly [label: string, line: string, type: string]> = [
    ['slain', LINE_DEATH, 'death'],
    ['suicide', LINE_SUICIDE, 'death'],
    ['level-up', LINE_LEVEL_UP, 'level-up'],
    ['zone-entered', LINE_ZONE, 'zone-entered'],
    ['area-generated', LINE_AREA, 'area-generated']
  ]

  for (const [label, line, type] of cases) {
    it(`resolves the real ${label} line to exactly "${type}"`, () => {
      expect(parse(line).type).toBe(type)
    })
  }

  it('separates the two death causes by `cause`, not by `type`', () => {
    expect(expectDeath(parse(LINE_DEATH)).cause).toBe('slain')
    expect(expectDeath(parse(LINE_SUICIDE)).cause).toBe('suicide')
  })

  it('does not read a level-up as a death, or a death as a level-up', () => {
    // The two share a leading `\S+` and are only three checks apart.
    expect(parse(LINE_LEVEL_UP).type).not.toBe('death')
    expect(parse(LINE_DEATH).type).not.toBe('level-up')
    expect(parse(LINE_SUICIDE).type).not.toBe('level-up')
  })
})

// ---------------------------------------------------------------------------
// CRLF
// ---------------------------------------------------------------------------

describe('CRLF tolerance', () => {
  it('strips the carriage return before matching a level-up', () => {
    // Sharpest case in the project: LEVEL_UP ends on `(\d+)$`, so a surviving
    // `\r` puts a non-digit at the end of the string and the pattern misses.
    const event = expectLevelUp(parse(`${LINE_LEVEL_UP}\r`))

    expect(event.level).toBe(2)
    expect(event.characterName).toBe('LargeThumbThomasReturns')
    expect(event.meta.raw.endsWith('\r')).toBe(false)
  })

  it('strips the carriage return before matching a suicide', () => {
    const event = expectDeath(parse(`${LINE_SUICIDE}\r`))

    expect(event.cause).toBe('suicide')
    expect(event.meta.body).toBe('LargeThumbThomasReturns has committed suicide.')
  })

  it('strips a trailing carriage return before matching', () => {
    const event = expectDeath(parse(`${LINE_DEATH}\r`))

    expect(event.characterName).toBe('FyascoWorbinTime')
    expect(event.isSelf).toBe(true)
    expect(event.meta.raw.endsWith('\r')).toBe(false)
    expect(event.meta.raw).toBe(LINE_DEATH)
    expect(event.meta.body).toBe('FyascoWorbinTime has been slain.')
  })

  it('strips a doubled carriage return', () => {
    expect(expectZone(parse(`${LINE_ZONE}\r\r`)).zoneName).toBe('Karui Shores')
  })

  it('leaves an interior carriage return alone', () => {
    // Not a real log shape; asserts the strip is anchored to the END only.
    const result = expectUnmatched(parse(`${LINE_DEATH}\rtrailing`))

    expect(result.raw.includes('\r')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Injected options
// ---------------------------------------------------------------------------

describe('injected options', () => {
  it('copies detectedAt and backlog onto every event type', () => {
    const opts: Partial<ParseLineOptions> = { detectedAt: 42, backlog: true }

    expect(expectDeath(parse(LINE_DEATH, opts)).detectedAt).toBe(42)
    expect(expectDeath(parse(LINE_DEATH, opts)).backlog).toBe(true)
    expect(expectDeath(parse(LINE_SUICIDE, opts)).detectedAt).toBe(42)
    expect(expectDeath(parse(LINE_SUICIDE, opts)).backlog).toBe(true)
    expect(expectLevelUp(parse(LINE_LEVEL_UP, opts)).detectedAt).toBe(42)
    expect(expectLevelUp(parse(LINE_LEVEL_UP, opts)).backlog).toBe(true)
    expect(expectZone(parse(LINE_ZONE, opts)).detectedAt).toBe(42)
    expect(expectZone(parse(LINE_ZONE, opts)).backlog).toBe(true)
    expect(expectArea(parse(LINE_AREA, opts)).detectedAt).toBe(42)
    expect(expectArea(parse(LINE_AREA, opts)).backlog).toBe(true)
  })

  it('defaults to live (non-backlog) when told so', () => {
    expect(expectDeath(parse(LINE_DEATH)).backlog).toBe(false)
    expect(expectDeath(parse(LINE_DEATH)).detectedAt).toBe(DETECTED_AT)
  })

  it('is pure: the same input yields an equal result every time', () => {
    const a = expectDeath(parse(LINE_DEATH))
    const b = expectDeath(parse(LINE_DEATH))

    expect(a).toEqual(b)
    expect(a.meta.timestamp.getTime()).toBe(b.meta.timestamp.getTime())
  })
})

// ---------------------------------------------------------------------------
// Whole-file fixture
// ---------------------------------------------------------------------------

describe('client-sample.txt fixture', () => {
  const text = readFileSync(new URL('./fixtures/client-sample.txt', import.meta.url), 'utf8')
  // Split on \n only - exactly what the tail loop does. The CRLF line therefore
  // arrives here still carrying its \r, which is the point.
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  const results = lines.map((line) => parse(line))

  const deaths = results.filter((r): r is DeathEvent => r.type === 'death')
  const zones = results.filter((r): r is ZoneEnteredEvent => r.type === 'zone-entered')
  const areas = results.filter((r): r is AreaGeneratedEvent => r.type === 'area-generated')
  const unmatched = results.filter((r): r is UnmatchedLine => r.type === 'unmatched')

  it('reads 12 lines', () => {
    expect(lines).toHaveLength(12)
  })

  it('contains a CRLF line ending', () => {
    expect(lines.some((line) => line.endsWith('\r'))).toBe(true)
  })

  it('finds exactly the two real deaths and not the chat spoof', () => {
    expect(deaths).toHaveLength(2)
    expect(deaths.map((d) => d.characterName)).toEqual(['FyascoWorbinTime', 'PartyHealerBot'])
    expect(deaths.map((d) => d.isSelf)).toEqual([true, false])
    expect(deaths.map((d) => d.cause)).toEqual(['slain', 'slain'])
  })

  it('parses the CRLF-terminated party death cleanly', () => {
    const partyDeath = nth(deaths, 1)

    expect(partyDeath.characterName).toBe('PartyHealerBot')
    expect(partyDeath.meta.raw.endsWith('\r')).toBe(false)
    expect(partyDeath.meta.body).toBe('PartyHealerBot has been slain.')
  })

  it('finds both zone transitions including the non-ASCII one', () => {
    expect(zones.map((z) => z.zoneName)).toEqual(['Karui Shores', 'Épreuve du Chaos'])
  })

  it('finds both generated areas', () => {
    expect(areas).toHaveLength(2)
    expect(nth(areas, 0).areaId).toBe('2_11_endgame_town')
    expect(nth(areas, 0).seed).toBe(1)
    expect(nth(areas, 1).areaId).toBe('MapWorldsSpiderForest')
    expect(nth(areas, 1).areaLevel).toBe(68)
  })

  it('leaves the noise and the spoof lines unmatched, but fully decoded', () => {
    expect(unmatched).toHaveLength(6)
    // Every fixture line is a well-formed log line, so none may have null meta.
    expect(unmatched.every((u) => u.meta !== null)).toBe(true)
  })

  it('keeps the spoof body visible while refusing to act on it', () => {
    const spoof = unmatched.find((u) => u.raw.includes('TrollMcSpoof: FyascoWorbinTime'))

    expect(spoof).toBeDefined()
    expect(spoof?.meta?.isSystemMessage).toBe(false)
  })

  it('sees the area-generated line ~1s BEFORE its matching zone-entered', () => {
    const generated = nth(areas, 0)
    const entered = nth(zones, 0)

    expect(generated.meta.clientMs).toBeLessThan(entered.meta.clientMs)
    expect(entered.meta.clientMs - generated.meta.clientMs).toBeLessThan(2000)
    expect(generated.meta.timestamp.getTime()).toBeLessThan(entered.meta.timestamp.getTime())
  })
})
