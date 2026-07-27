/**
 * src/renderer/src/detection-swap.ts
 * ==================================
 *
 * "poe-tool has just decided you are someone else." The pure half of the warning that
 * fires when AUTO-DETECTION MOVES FROM ONE CHARACTER TO ANOTHER.
 *
 *
 * THE FAILURE THIS EXISTS FOR
 * ---------------------------
 * A level-up line REPLACES the detected character outright, and main persists the
 * replacement (`character.detected` in settings.json). That is the right default - it
 * is the only alt-swap signal there is, and it is how a league-start character or a
 * genuine swap starts getting clipped without the user touching anything.
 *
 * But it is also how a THROWAWAY character silently switches clipping off. From the
 * user's own reference log, four minutes apart at the very end of it:
 *
 * ```text
 * 2026/07/26 19:26:31 ... : FyascoWorbinTime has been slain.
 * 2026/07/26 19:30:47 ... : LargeThumbThomas (Marauder) is now level 2
 * ```
 *
 * A level-2 Marauder - a loot mule / name reservation / league-start test character,
 * routine in PoE - displaces a level-93 Elementalist. From that instant every death of
 * the character actually being played reads as somebody else's, `death:self` never
 * fires, and NOTHING anywhere reports a problem: the badge still says "Auto-detected",
 * the event feed still scrolls, OBS still says connected. Because the detection is
 * persisted (deliberately - level-ups are SPARSE), it survives every restart, and
 * because level-ups are sparse it does not self-correct: the next corrective one may be
 * days or weeks away. The same log contains this shape twice.
 *
 * So the swap is HONOURED and then SAID OUT LOUD, with the displaced name offered as a
 * one-click override - the one thing that out-ranks detection. Refusing the swap
 * instead would break the case the swap exists for (a brand-new character IS low
 * level), which is why this is a notice and not a veto.
 *
 *
 * WHY IT IS COMPUTED IN THE RENDERER, FROM A VALUE THE RENDERER ALREADY HOLDS
 * ---------------------------------------------------------------------------
 * This is NOT the "who counts as me" rule being re-derived - that stays main's, and the
 * `ActiveCharacter` this reduces over is main's answer, arriving on `push:character`.
 * All that happens here is a DIFF of two consecutive answers, which the window already
 * has both halves of (`useActiveCharacter` holds the previous one in state). Doing it
 * this way adds no IPC channel, no settings field and no second copy of the resolution
 * rule - the failure mode the whole architecture is arranged to avoid.
 *
 * KNOWN LIMIT, and it is deliberate: this catches a swap that happens WHILE THE WINDOW
 * IS OPEN. A swap that lands with the window closed to the tray is not re-announced on
 * the next open, because main pushes a current value, not a history. That is the
 * cheapest version that costs nothing elsewhere; carrying the displaced name across a
 * restart would mean persisting it, which is a settings-schema change for a strictly
 * smaller benefit than this covers.
 *
 * "WHILE THE WINDOW IS OPEN" IS ONLY TRUE IF SOMETHING IS ALWAYS LISTENING. The hook
 * around this reducer (`useDetectionSwap`) is therefore mounted in `App.tsx`, which lives
 * for the life of the window, and the notice is rendered in the shell. It was briefly
 * mounted inside `CharacterSection` instead - a component that exists only while Settings
 * › Character is the open tab - which reduced this file to dead code for every user who
 * was not sitting on that exact tab at the exact moment the mule levelled.
 *
 * PURE, TOTAL, NO REACT. Exported separately from `hooks.ts` so it can be unit-tested
 * without a DOM - see `test/detection-swap.test.ts`.
 */

import type { ActiveCharacter } from '../../shared/events'

/**
 * How far BELOW the displaced character's level a new detection has to be before the
 * warning calls it out as mule-shaped.
 *
 * Purely a wording decision - the swap is honoured and warned about either way. 20
 * levels is comfortably more than any legitimate "I swapped to my other endgame
 * character" gap is likely to be while still catching the level-1/2 throwaway that
 * motivates this file.
 */
export const SUSPICIOUS_LEVEL_DROP = 20

/** One unacknowledged "detection moved to a different character" event. */
export interface DetectionSwap {
  /** The character the detection was on before. Non-empty; the offer is to go back to it. */
  readonly fromName: string
  /** Its level, when a level-up for it was ever seen. */
  readonly fromLevel: number | null
  /** The character auto-detection has just moved to. Non-empty. */
  readonly toName: string
  /** Its level from the level-up line that caused the swap. */
  readonly toLevel: number | null
  /**
   * True when the new character is {@link SUSPICIOUS_LEVEL_DROP}+ levels below the
   * displaced one - the mule/throwaway shape, as opposed to an even swap between two
   * characters that are both being played.
   */
  readonly suspicious: boolean
}

/**
 * What {@link reduceDetectionSwap} carries between pushes.
 *
 * `seen` is the last resolved character this window was told about, and it is the ONLY
 * memory involved: the diff is always against the immediately preceding answer.
 */
export interface DetectionSwapState {
  readonly seen: ActiveCharacter | null
  readonly swap: DetectionSwap | null
}

/** Nothing seen yet, nothing to warn about. */
export const INITIAL_DETECTION_SWAP_STATE: DetectionSwapState = Object.freeze({
  seen: null,
  swap: null
})

/** Case-insensitive, whitespace-tolerant - the same rule main compares names with. */
function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/**
 * Folds the newest resolved character in, deciding whether it displaced a previous
 * DETECTION.
 *
 * The rules, and why each one is a non-event rather than a warning:
 *
 *  - `next.source !== 'detected'` - an override now decides, or nothing does. A typed
 *    name is the user's own choice and out-ranks detection by design, so there is
 *    nothing to second-guess; any outstanding warning is cleared, which is also what
 *    makes the "use the old name" button self-dismissing.
 *  - nothing seen yet - the first answer of the session, including a detection read
 *    back off settings.json. It is the state of the world, not a change to it.
 *  - the previous answer was not itself a detection - coming from `'none'` is the good
 *    news case (detection finally worked), and coming from `'override'` means the user
 *    just cleared their override on purpose.
 *  - the same name - levelling up, or ascending. `LargeThumbThomasReturns` going
 *    Marauder -> Berserker at 41 is one character, not two.
 *
 * Everything else is a real swap. An existing warning SURVIVES a same-name update, so a
 * mule that levels 2 -> 3 while the user is reading the notice does not erase it.
 *
 * Returns the SAME state object when nothing changed, so a redundant push cannot cause
 * a re-render.
 */
export function reduceDetectionSwap(
  state: DetectionSwapState,
  next: ActiveCharacter
): DetectionSwapState {
  const swap = nextSwap(state, next)
  if (state.seen === next && state.swap === swap) return state
  return { seen: next, swap }
}

function nextSwap(state: DetectionSwapState, next: ActiveCharacter): DetectionSwap | null {
  if (next.source !== 'detected' || next.name === null) return null

  const previous = state.seen
  if (previous === null || previous.source !== 'detected' || previous.name === null) {
    return state.swap
  }
  if (sameName(previous.name, next.name)) return state.swap

  return {
    fromName: previous.name,
    fromLevel: previous.level,
    toName: next.name,
    toLevel: next.level,
    suspicious:
      previous.level !== null &&
      next.level !== null &&
      next.level + SUSPICIOUS_LEVEL_DROP <= previous.level
  }
}

/**
 * Acknowledges the warning without changing anything else.
 *
 * Keeps `seen`, so dismissing does not re-arm on the next push, and does not touch
 * settings: "I know, that IS me" is a valid answer, and the app must not start writing
 * an override the user did not ask for.
 */
export function dismissDetectionSwap(state: DetectionSwapState): DetectionSwapState {
  if (state.swap === null) return state
  return { seen: state.seen, swap: null }
}
