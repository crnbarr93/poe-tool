/**
 * src/renderer/src/components/ComingSoon.tsx
 * ==========================================
 *
 * The ONE treatment every unbuilt feature gets.
 *
 * WHY THIS COMPONENT EXISTS AT ALL
 * --------------------------------
 * The design this window is built from draws several features that DO NOT EXIST: a logout
 * macro, an in-game overlay, area timers, overlay notifications. Drawing them as working
 * chrome - a hotkey pill, an "Armed" status line, a layout grid - would be the most
 * dangerous kind of lie this app could tell. A player who believes a logout macro is armed
 * takes fights they would otherwise walk away from, and finds out it was a mock-up at the
 * moment their character dies. So every one of those surfaces routes through here instead.
 *
 * THE RULES, and they are not negotiable:
 *  - NO LIVE VALUES. Not a hotkey, not a status word, not a count, not a placeholder
 *    number that "looks about right". Nothing here may be mistaken for a reading.
 *  - NO CONTROLS. No buttons, no toggles, no inputs - not even disabled ones, because a
 *    disabled toggle still says "this feature is here, just switched off".
 *  - SAY WHAT IT WILL DO. An empty state that only says "coming soon" tells the user
 *    nothing about whether they should wait for it or go and find another tool. Every
 *    caller passes a real description, and usually the specifics as bullets.
 *
 * VISUALLY CALM ON PURPOSE. A muted surface card with a neutral chip - deliberately NOT
 * the accent, which in this app is the alarm colour used for deaths and failures. An
 * unbuilt feature is not a fault, and it must not compete with the parts of the window
 * that report real problems.
 */

import { useId } from 'react'
import type { ReactElement } from 'react'

export interface ComingSoonProps {
  /** The feature's name, as it appears in the nav or tab that led here. */
  readonly title: string
  /**
   * What the feature WILL do once it exists, in the present-tense-of-the-future.
   * A complete sentence or two; this is the whole reason the panel is not just a shrug.
   */
  readonly description: string
  /** Optional specifics - the individual things it is planned to do. */
  readonly bullets?: readonly string[] | undefined
  /**
   * Small uppercase label above the title, for callers that sit in a slot the design gave
   * a kicker to (the sidebar's LOGOUT MACRO card).
   */
  readonly kicker?: string | undefined
  /**
   * Tighter type and padding, for the sidebar rail. Same component, same words, same
   * honesty - only the density changes.
   */
  readonly compact?: boolean | undefined
}

export function ComingSoon({
  title,
  description,
  bullets,
  kicker,
  compact = false
}: ComingSoonProps): ReactElement {
  const headingId = useId()

  return (
    <section
      className={compact ? 'soon soon--compact' : 'soon'}
      aria-labelledby={headingId}
    >
      {kicker !== undefined && <span className="soon__kicker">{kicker}</span>}

      <div className="soon__head">
        <h2 className="soon__title" id={headingId}>
          {title}
        </h2>
        {/*
          Neutral, never accent. This chip is the load-bearing word in the whole component:
          it is what stops the calm styling from reading as a finished, quiet feature.
        */}
        <span className="tag tag-neutral">Not built yet</span>
      </div>

      <p className="soon__body">{description}</p>

      {bullets !== undefined && bullets.length > 0 && (
        <ul className="soon__list">
          {bullets.map((bullet) => (
            <li key={bullet}>{bullet}</li>
          ))}
        </ul>
      )}
    </section>
  )
}
