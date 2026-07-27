/**
 * test/detection-swap.test.ts
 * ===========================
 *
 * The warning that fires when AUTO-DETECTION MOVES TO A DIFFERENT CHARACTER.
 *
 * The defect this pins is the quietest one in the app: a level-2 mule's single
 * level-up displaces the level-93 character being played, main persists it (correctly -
 * it is the only alt-swap signal there is), and from that instant no death is ever
 * clipped while the badge still reads "Auto-detected" in green. Nothing anywhere said
 * so; this reducer is what says so.
 *
 * The values below are the RESOLVED `ActiveCharacter`s main pushes on `push:character`,
 * and the leading scenario is the one that actually happens at the end of the user's
 * reference Client.txt:
 *
 * ```text
 * 2026/07/26 19:26:31 ... : FyascoWorbinTime has been slain.
 * 2026/07/26 19:30:47 ... : LargeThumbThomas (Marauder) is now level 2
 * ```
 *
 * The reducer is pure and React-free precisely so this file can exist: the dependency
 * set is frozen, so there is no DOM test environment to render the component in.
 */

import { describe, expect, it } from 'vitest'

import {
  dismissDetectionSwap,
  INITIAL_DETECTION_SWAP_STATE,
  reduceDetectionSwap,
  SUSPICIOUS_LEVEL_DROP,
  type DetectionSwapState
} from '../src/renderer/src/detection-swap'
import type { ActiveCharacter } from '../src/shared/events'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function detected(name: string, className: string | null, level: number | null): ActiveCharacter {
  return { name, className, level, source: 'detected' }
}

function override(name: string): ActiveCharacter {
  return { name, className: null, level: null, source: 'override' }
}

const NOBODY: ActiveCharacter = { name: null, className: null, level: null, source: 'none' }

/** Feeds a sequence of pushed values through the reducer, newest last. */
function fold(...pushed: readonly ActiveCharacter[]): DetectionSwapState {
  let state = INITIAL_DETECTION_SWAP_STATE
  for (const next of pushed) state = reduceDetectionSwap(state, next)
  return state
}

// ---------------------------------------------------------------------------

describe('reduceDetectionSwap - the mule hijack', () => {
  it('warns, names both characters, and flags the level drop', () => {
    // Verbatim from the reference log: a level-2 Marauder displaces a level-93
    // Elementalist. Everything downstream of this is silent, so this notice is the
    // only thing between the user and weeks of clipping nothing.
    const state = fold(
      detected('FyascoWorbinTime', 'Elementalist', 93),
      detected('LargeThumbThomas', 'Marauder', 2)
    )

    expect(state.swap).toEqual({
      fromName: 'FyascoWorbinTime',
      fromLevel: 93,
      toName: 'LargeThumbThomas',
      toLevel: 2,
      suspicious: true
    })
  })

  it('still warns for an even swap between two endgame characters', () => {
    // Not mule-shaped, so `suspicious` is false and the wording softens - but the app
    // has still just changed whose deaths it clips, and must say so.
    const state = fold(
      detected('LargeThumbThomasReturns', 'Berserker', 97),
      detected('WorldWordleChamp', 'Slayer', 98)
    )

    expect(state.swap).toMatchObject({
      fromName: 'LargeThumbThomasReturns',
      toName: 'WorldWordleChamp',
      suspicious: false
    })
  })

  it('treats exactly SUSPICIOUS_LEVEL_DROP levels below as suspicious', () => {
    const boundary = fold(detected('A', null, 40), detected('B', null, 40 - SUSPICIOUS_LEVEL_DROP))
    const inside = fold(detected('A', null, 40), detected('B', null, 41 - SUSPICIOUS_LEVEL_DROP))

    expect(boundary.swap?.suspicious).toBe(true)
    expect(inside.swap?.suspicious).toBe(false)
  })

  it('does not claim a level drop it cannot see', () => {
    // A displaced character whose level was never observed (an override promoted to a
    // detection, a hand-edited settings.json) must not be reported as a big drop.
    const state = fold(detected('FyascoWorbinTime', null, null), detected('LargeThumbThomas', 'Marauder', 2))

    expect(state.swap).toMatchObject({ fromLevel: null, suspicious: false })
  })
})

describe('reduceDetectionSwap - what is NOT a swap', () => {
  it('says nothing about the first answer of the session', () => {
    // A detection read back off settings.json is the state of the world at launch, not
    // a change to it. Warning here would fire on every single start-up.
    expect(fold(detected('FyascoWorbinTime', 'Elementalist', 93)).swap).toBeNull()
  })

  it('says nothing when the same character levels up', () => {
    expect(fold(detected('OneLongToe', 'Berserker', 54), detected('OneLongToe', 'Berserker', 55)).swap).toBeNull()
  })

  it('says nothing when the same character ascends', () => {
    // Real: LargeThumbThomasReturns is a Marauder to 40 and a Berserker from 41. One
    // character, two class names - the class is display metadata, never identity.
    const state = fold(
      detected('LargeThumbThomasReturns', 'Marauder', 40),
      detected('LargeThumbThomasReturns', 'Berserker', 41)
    )

    expect(state.swap).toBeNull()
  })

  it('compares names the way main does - case-insensitively', () => {
    expect(fold(detected('Burgertrash', 'Slayer', 84), detected('burgertrash', 'Slayer', 85)).swap).toBeNull()
  })

  it('says nothing when detection finally works for the first time', () => {
    // `none` -> `detected` is the good news case: the clipper just came online.
    expect(fold(NOBODY, detected('Burgertrash', 'Slayer', 84)).swap).toBeNull()
  })

  it('says nothing when the user clears an override and detection takes back over', () => {
    // The user did that on purpose, and the name that appears is the one main has been
    // showing under the override the whole time.
    expect(fold(override('WorldWordleChamp'), detected('Burgertrash', 'Slayer', 84)).swap).toBeNull()
  })

  it('clears an outstanding warning as soon as an override wins', () => {
    // This is what makes the notice's "No - keep FyascoWorbinTime" button self-
    // dismissing: it writes the override, main re-resolves, and the push that comes
    // back carries `source: 'override'`.
    const state = fold(
      detected('FyascoWorbinTime', 'Elementalist', 93),
      detected('LargeThumbThomas', 'Marauder', 2),
      override('FyascoWorbinTime')
    )

    expect(state.swap).toBeNull()
  })

  it('clears the warning if detection resolves to nobody', () => {
    const state = fold(
      detected('FyascoWorbinTime', 'Elementalist', 93),
      detected('LargeThumbThomas', 'Marauder', 2),
      NOBODY
    )

    expect(state.swap).toBeNull()
  })
})

describe('reduceDetectionSwap - keeping the warning on screen', () => {
  it('survives the mule levelling again while the user is reading it', () => {
    // 2 -> 3 is the same character, so it is not a new swap; erasing the notice on it
    // would make the warning disappear exactly while the mule is being played.
    const state = fold(
      detected('FyascoWorbinTime', 'Elementalist', 93),
      detected('LargeThumbThomas', 'Marauder', 2),
      detected('LargeThumbThomas', 'Marauder', 3)
    )

    expect(state.swap).toMatchObject({ fromName: 'FyascoWorbinTime', toName: 'LargeThumbThomas' })
  })

  it('reports the LATEST displacement when detection moves twice', () => {
    const state = fold(
      detected('A', null, 90),
      detected('B', null, 91),
      detected('C', null, 92)
    )

    expect(state.swap).toMatchObject({ fromName: 'B', toName: 'C' })
  })

  it('returns the same state object when nothing changed, so no re-render is forced', () => {
    const first = reduceDetectionSwap(INITIAL_DETECTION_SWAP_STATE, detected('OneLongToe', 'Berserker', 55))
    const again = reduceDetectionSwap(first, first.seen ?? NOBODY)

    expect(again).toBe(first)
  })
})

describe('dismissDetectionSwap', () => {
  it('acknowledges the warning without re-arming on the next push', () => {
    const swapped = fold(detected('FyascoWorbinTime', 'Elementalist', 93), detected('LargeThumbThomas', 'Marauder', 2))

    const dismissed = dismissDetectionSwap(swapped)
    // A later level-up for the character the user just accepted must stay quiet.
    const after = reduceDetectionSwap(dismissed, detected('LargeThumbThomas', 'Marauder', 3))

    expect(dismissed.swap).toBeNull()
    expect(after.swap).toBeNull()
    // "That is me" changes no settings: the app must not start writing an override the
    // user never asked for.
    expect(dismissed.seen).toEqual(detected('LargeThumbThomas', 'Marauder', 2))
  })

  it('is a no-op with nothing to dismiss', () => {
    expect(dismissDetectionSwap(INITIAL_DETECTION_SWAP_STATE)).toBe(INITIAL_DETECTION_SWAP_STATE)
  })
})
