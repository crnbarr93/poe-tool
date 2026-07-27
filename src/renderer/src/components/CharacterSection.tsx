/**
 * src/renderer/src/components/CharacterSection.tsx
 * ================================================
 *
 * WHO COUNTS AS "ME" - and the loud warning for when the answer is "nobody".
 *
 * Client.txt logs party members' deaths in exactly the same format as your own, so the
 * resolved character name is the only thing separating "clip my death" from "clip every
 * death in a six-man party". `DeathEvent.isSelf` is computed from it in main, and when
 * nothing is resolved `isSelf` is false for EVERY death and the clipper never fires.
 *
 *
 * THE ANSWER IS MAIN'S, NOT THIS COMPONENT'S
 * ------------------------------------------
 * This section renders `character:active` - the RESOLVED `ActiveCharacter`, carrying the
 * `source` that says which rule produced it. It deliberately does not re-derive
 * "override, else detected" from `settings.character`, even though it holds those fields:
 * that rule belongs to the same code that stamps `isSelf`, and two copies of it would
 * eventually disagree in the one direction that matters - a window claiming clipping is
 * armed while nothing is being clipped.
 *
 * The settings half is still on screen, because it is the half the user can EDIT.
 *
 *
 * WHY `source: 'none'` GETS A FULL-WIDTH ALARM AND NOT A HINT
 * -----------------------------------------------------------
 * It is a completely silent failure. The log tails, the event feed scrolls, OBS says
 * connected, deaths appear in the feed - and not one clip is ever saved, because every
 * death is somebody else's as far as main can tell. There is no error anywhere, and the
 * user finds out hours later by looking in an empty folder.
 *
 * Auto-detection cannot fix this on its own either, because it needs a level-up line and
 * LEVEL-UPS ARE SPARSE: a level-98 character can be played for weeks without producing
 * one. So the warning does three jobs - it says clipping is idle, it explains why
 * detection has not happened, and it offers the names main has actually seen in the log
 * as one-click choices, so the fix does not depend on the user spelling their own
 * character name from memory.
 */

import type { ReactElement } from 'react'

import type { ActiveCharacter } from '../../../shared/events'
import type { PoeToolApi } from '../../../shared/ipc'
import type { AppSettings, DeepPartial } from '../../../shared/settings'
import type { DetectionSwap } from '../detection-swap'
import { useActiveCharacter, useCharacterSuggestions, useDetectionSwap } from '../hooks'
import { TextField } from './Fields'
import { Section } from './Section'
import type { BadgeDescriptor } from './StatusBadge'
import { StatusBadge } from './StatusBadge'

/** Case-insensitive, whitespace-tolerant - the same rule main compares names with. */
function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/**
 * Maps the resolved character onto the section badge.
 *
 * Exhaustive over `ActiveCharacter['source']`, and the return type excludes `undefined`,
 * so a fourth source would be a compile error here rather than a blank badge.
 */
function describeCharacter(character: ActiveCharacter | null): BadgeDescriptor {
  if (character === null) return { tone: 'idle', label: 'Checking', detail: 'asking main…' }

  switch (character.source) {
    case 'override':
      return { tone: 'ok', label: 'Set manually', detail: character.name ?? '' }
    case 'detected':
      return { tone: 'ok', label: 'Auto-detected', detail: character.name ?? '' }
    case 'none':
      // `bad`, not `warn`: nothing is broken in the sense of an error, but the headline
      // feature is switched off, which is worse than an error the user can see.
      return { tone: 'bad', label: 'No character', detail: 'clipping is idle' }
  }
}

/** `Berserker · level 92`, degrading to whichever half is known. */
function describeBuild(character: ActiveCharacter): string | null {
  const level = character.level === null ? null : `level ${character.level}`
  if (character.className === null && level === null) return null
  if (character.className === null) return level
  if (level === null) return character.className
  return `${character.className} · ${level}`
}

/**
 * The active character, rendered as the most prominent thing in the section.
 *
 * Big because it answers the question the whole section exists for, and because a user
 * scanning this window for "why am I not getting clips" should be able to read it from
 * across a desk.
 */
function ActiveCharacterCard({
  character
}: {
  readonly character: ActiveCharacter | null
}): ReactElement {
  if (character === null) {
    return (
      <div className="character">
        <span className="character__label">Active character</span>
        <span className="character__pending">Asking the background process…</span>
      </div>
    )
  }

  if (character.name === null) {
    // `name === null` if and only if `source === 'none'`. The alarm below carries the
    // explanation; this block only has to avoid pretending there is a name.
    return (
      <div className="character character--unknown">
        <span className="character__label">Active character</span>
        <span className="character__pending">Nobody — no character has been identified yet.</span>
      </div>
    )
  }

  const build = describeBuild(character)

  return (
    <div className="character">
      <span className="character__label">Active character</span>
      <div className="character__identity">
        <span className="character__name">{character.name}</span>
        <span className={character.source === 'override' ? 'tag tag--info' : 'tag tag--ok'}>
          {character.source === 'override' ? 'manual override' : 'auto-detected'}
        </span>
      </div>
      <span className="character__meta">
        {build ?? 'class and level unknown — no level-up seen for this name yet'}
      </span>
    </div>
  )
}

/** `level 2` / `level unknown`, for a name whose level may never have been seen. */
function levelPhrase(level: number | null): string {
  return level === null ? 'level unknown' : `level ${level}`
}

/**
 * "poe-tool has just decided you are someone else."
 *
 * The second silent failure in this section, and the harder one to notice: a level-up
 * line REPLACES the detected character, so a level-2 mule (a loot character, a name
 * reservation, a league-start test) permanently displaces the level-93 character being
 * played. Main persists that - correctly; it is the only alt-swap signal there is and
 * level-ups are far too sparse to re-learn - and from then on every death reads as
 * somebody else's while the badge above still says "Auto-detected" in green.
 *
 * So the swap is honoured and then said out loud, with the displaced name offered as a
 * one-click override, because an override is the only thing that out-ranks detection.
 * `warn`, not `bad`: the app may well be right, and it is right every time a user rolls
 * a new character and starts playing it.
 */
function DetectionSwapNotice({
  swap,
  onUsePrevious,
  onDismiss
}: {
  readonly swap: DetectionSwap
  readonly onUsePrevious: () => void
  readonly onDismiss: () => void
}): ReactElement {
  return (
    <div className="notice notice--warn notice--actions" role="alert">
      <p>
        poe-tool now thinks you are playing <strong>{swap.toName}</strong> (
        {levelPhrase(swap.toLevel)}) — it just levelled up, which replaced{' '}
        <strong>{swap.fromName}</strong> ({levelPhrase(swap.fromLevel)}). Only{' '}
        {swap.toName}&apos;s deaths will be clipped from now on.
      </p>
      {swap.suspicious && (
        <p>
          That is a big drop in level. A mule or a throwaway character levelling once is
          enough to cause this, and the change is remembered across restarts.
        </p>
      )}
      <div className="row">
        <button className="button button--small" type="button" onClick={onUsePrevious}>
          No — keep {swap.fromName}
        </button>
        <button className="button button--small" type="button" onClick={onDismiss}>
          That is me
        </button>
      </div>
    </div>
  )
}

export interface CharacterSectionProps {
  readonly api: PoeToolApi
  readonly settings: AppSettings
  readonly update: (patch: DeepPartial<AppSettings>) => void
  /** Apply and persist immediately - used by the picker and the clear button. */
  readonly commit: (patch: DeepPartial<AppSettings>) => void
  readonly flush: () => void
}

export function CharacterSection({
  api,
  settings,
  update,
  commit,
  flush
}: CharacterSectionProps): ReactElement {
  const character = useActiveCharacter(api)
  const badge = describeCharacter(character)
  const detectionSwap = useDetectionSwap(character)
  /** Hoisted into a const so the click handler below narrows without a `?.`. */
  const swap = detectionSwap.swap

  // Only ask for suggestions when they are actually going to be shown. The picker exists
  // for one dead-end state; in every other state this costs no IPC.
  const unidentified = character !== null && character.source === 'none'
  const suggestions = useCharacterSuggestions(api, unidentified)

  const override = settings.character.override
  const detected = settings.character.detected

  /**
   * True when a manual override is masking a DIFFERENT auto-detected name. Worth saying
   * out loud: it is the exact situation the override exists for (group play), but it is
   * also what a stale override left over from an old character looks like.
   *
   * READ OFF `settings`, WHICH LAGS. There is no push channel for settings, so a level-up
   * detected since this window last saved leaves `detected` here out of date until the
   * next `settings:set` round-trip or reload. That is tolerable ONLY because this is a
   * hint: the thing the user actually has to be able to trust - who is active right now -
   * comes from `character:active`, which IS live and which the card and badge above
   * render. A hint that appears a few seconds late costs nothing; the resolved answer
   * being late would cost clips.
   */
  const overriding = override !== '' && detected !== null && !sameName(override, detected)

  const chooseName = (name: string): void => {
    // Writes `character.override`, EXPLICITLY. Picking a suggestion is the user making a
    // choice, not the app guessing - which is why it lands in the manual field and
    // out-ranks whatever detection later decides.
    commit({ character: { override: name } })
  }

  return (
    <Section
      index="2"
      title="Character"
      description="Which character counts as you. Only deaths matching it are clipped."
      aside={<StatusBadge {...badge} srPrefix="Active character" />}
    >
      <ActiveCharacterCard character={character} />

      {swap !== null && (
        <DetectionSwapNotice
          swap={swap}
          // Picking the displaced name writes the OVERRIDE, exactly like the picker
          // below: the user correcting the app is a manual choice, and only a manual
          // choice can out-rank the next level-up that mule happens to get.
          onUsePrevious={() => {
            chooseName(swap.fromName)
          }}
          onDismiss={detectionSwap.dismiss}
        />
      )}

      {unidentified && (
        <div className="alert" role="alert">
          <p className="alert__title">Nothing will be clipped</p>
          <p>
            poe-tool has not identified your character, so it treats <em>every</em> logged death
            as somebody else&apos;s and never asks OBS to save. Tailing, parsing and the event
            feed all keep working — the clipping is the part that is silently idle.
          </p>
          <p>
            Auto-detection needs one <span className="mono">… (Marauder) is now level 42</span>{' '}
            line, and those are rare: at high level you can play for weeks without one. It is
            remembered forever once it happens, so a single level-up is enough — but until then,
            pick your character below.
          </p>

          <div className="alert__picker">
            <div className="picker__head">
              <span className="picker__title">
                {suggestions.loading
                  ? 'Looking for names in your log…'
                  : suggestions.names.length > 0
                    ? 'Names seen in your log — pick yours:'
                    : 'Names seen in your log'}
              </span>
              <button
                className="button button--small"
                type="button"
                onClick={suggestions.refresh}
                disabled={suggestions.loading}
              >
                Refresh
              </button>
            </div>

            {suggestions.error !== null && (
              <p className="picker__note">Could not read the name list: {suggestions.error}</p>
            )}

            {suggestions.names.length > 0 && (
              <ul className="picker__list">
                {suggestions.names.map((name) => (
                  <li key={name}>
                    <button
                      className="picker__name"
                      type="button"
                      onClick={() => {
                        chooseName(name)
                      }}
                    >
                      {name}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {suggestions.loaded && !suggestions.loading && suggestions.names.length === 0 && (
              <p className="picker__note">
                None found — poe-tool reads the end of your Client.txt for names, and there is no
                death or level-up in it yet (or no log file is configured above). Play for a bit
                and press Refresh, or just type the name below.
              </p>
            )}
          </div>
        </div>
      )}

      <TextField
        label="Manual override — for group play"
        value={override}
        placeholder="e.g. FyascoWorbinTime"
        hint="Leave empty to auto-detect from level-up lines. Set it when you play in a party: a party member's level-up can land in your Client.txt too, and auto-detection would then honestly pick the wrong person. Capitalisation and surrounding spaces do not matter."
        onChange={(next) => {
          update({ character: { override: next } })
        }}
        onCommit={flush}
      />

      {override !== '' && (
        <div className="row">
          <button
            className="button"
            type="button"
            onClick={() => {
              commit({ character: { override: '' } })
            }}
          >
            Clear override
          </button>
          <span className="row__note">
            {detected === null
              ? 'Clearing goes back to auto-detect, which has nothing yet — the warning above will come back.'
              : `Clearing goes back to the auto-detected ${detected}.`}
          </span>
        </div>
      )}

      {overriding && (
        <p className="notice notice--warn">
          Your override (<strong>{override}</strong>) is not the character poe-tool last detected
          from a level-up (<strong>{detected}</strong>). That is exactly right if you are playing
          in a group — and exactly wrong if you swapped character and forgot this field.
        </p>
      )}

      <ul className="notes">
        <li>
          Party members&apos; deaths are logged the same way as yours. Only deaths matching the
          active character are treated as yours; everyone else&apos;s are counted and ignored.
        </li>
        <li>
          A detection is remembered across restarts, so one level-up ever is enough. Level-ups
          are the only line in the log that identifies a character as one being played — deaths
          name whoever died, so they cannot be used for this.
        </li>
        <li>
          The flip side: a level-up on any other character — a mule, a league-start test — moves
          the detection to it, and is remembered too. poe-tool says so when it happens while this
          window is open; if you play alts, set the override above and it will stop guessing.
        </li>
        <li>
          Deaths from <span className="mono">/kill</span> are recorded but never clipped: typing
          it is deliberate, so a clip of one is thirty seconds of nothing.
        </li>
        <li>Changes take effect on the next log line; no restart needed.</li>
      </ul>
    </Section>
  )
}
