/**
 * src/renderer/src/components/CharacterSection.tsx
 * ================================================
 *
 * The one setting that decides whether a logged death is YOURS.
 *
 * `Client.txt` logs party members' deaths in exactly the same format as your own, so
 * the character name is the only thing separating "clip my death" from "clip every
 * death in the party". An unconfigured name makes `DeathEvent.isSelf` permanently
 * false and leaves the clipper idle - deliberately, because guessing would produce a
 * folder full of somebody else's deaths. This section therefore says so out loud
 * rather than leaving the user to discover it from an empty clip list.
 */

import type { ReactElement } from 'react'

import type { AppSettings, DeepPartial } from '../../../shared/settings'
import { TextField } from './Fields'
import { Section } from './Section'
import { StatusBadge } from './StatusBadge'

export interface CharacterSectionProps {
  readonly settings: AppSettings
  readonly update: (patch: DeepPartial<AppSettings>) => void
  readonly flush: () => void
}

export function CharacterSection({
  settings,
  update,
  flush
}: CharacterSectionProps): ReactElement {
  const configured = settings.character.name !== ''

  return (
    <Section
      index="2"
      title="Character"
      description="Which character counts as you."
      aside={
        configured ? (
          <StatusBadge tone="ok" label="Configured" detail={settings.character.name} />
        ) : (
          <StatusBadge tone="warn" label="Not set" detail="deaths will never be clipped" />
        )
      }
    >
      <TextField
        label="Character name"
        value={settings.character.name}
        placeholder="e.g. FyascoWorbinTime"
        hint="Must match the in-game name exactly, apart from capitalisation. Surrounding spaces are trimmed automatically."
        onChange={(next) => {
          update({ character: { name: next } })
        }}
        onCommit={flush}
      />

      <ul className="notes">
        <li>
          Party members&apos; deaths are logged in exactly the same way as yours. Only deaths
          matching this name are treated as yours; everyone else&apos;s are ignored.
        </li>
        <li>
          Leave this empty and nothing is ever clipped — poe-tool will not guess which
          character is you.
        </li>
        <li>Change it whenever you swap characters; no restart needed.</li>
      </ul>
    </Section>
  )
}
