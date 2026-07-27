/**
 * src/renderer/src/components/StreamableSection.tsx
 * =================================================
 *
 * Automatic upload of death clips to Streamable: the opt-in, the account credentials, a
 * one-shot credential test, and the auto-upload switch.
 *
 *
 * THIS SECTION SAYS OUT LOUD THAT THE FEATURE IS UNSUPPORTED
 * ----------------------------------------------------------
 * Streamable's documented API is READ-ONLY. Its own documentation says video uploading is
 * not supported by the API, and the endpoint poe-tool posts to is undocumented, is
 * authenticated with the account password (there is no revocable token), and can stop
 * working without notice or announcement.
 *
 * The user has been told that and has chosen to use it anyway. The UI still says it
 * plainly, in the section itself rather than in a tooltip, for two reasons that are not
 * about liability:
 *
 *  1. WHEN IT BREAKS, IT WILL LOOK LIKE POE-TOOL BROKE. Uploads will start failing in the
 *     clip list with a message about a response nobody can parse. A user who was told up
 *     front that this rides on an unofficial endpoint diagnoses that in five seconds; a
 *     user who was not files a bug and stops trusting the rest of the app.
 *  2. IT IS AN ACCOUNT PASSWORD. Typing a real, reusable credential into a third-party
 *     tool deserves to be an informed decision, made while looking at what the tool does
 *     with it - not something discovered later.
 *
 * The 90-day free-tier deletion gets the same treatment: a link that quietly dies three
 * months after it was shared is a promise this window made and should therefore qualify.
 *
 *
 * THE PASSWORD BOX LOOKS EMPTY EVEN WHEN A PASSWORD IS SAVED
 * ----------------------------------------------------------
 * Main blanks `streamable.password` in every settings payload it sends, so this window
 * genuinely does not have it and cannot display it. The field is therefore blank after
 * every save, which is correct and is also exactly what a lost credential looks like -
 * so the state is stated in words next to it, from `credentials:status`, which reports
 * whether a secret is stored and whether it could still be decrypted. Without that,
 * "your password could not be decrypted on this machine" and "you have not typed one yet"
 * would be the same empty box.
 */

import type { ReactElement } from 'react'
import { useState } from 'react'

import type {
  CredentialSlotStatus,
  PoeToolApi,
  StreamableTestResult
} from '../../../shared/ipc'
import type { AppSettings, DeepPartial } from '../../../shared/settings'
import { describeError } from '../format'
import { useCredentialStatus } from '../hooks'
import { TextField, ToggleField } from './Fields'
import { Section } from './Section'
import type { BadgeDescriptor } from './StatusBadge'
import { StatusBadge } from './StatusBadge'

/**
 * The section badge.
 *
 * `warn` for "on but not usable" is the important one: `enabled` with no credentials is a
 * setting that promises uploads and delivers none, and the only place that would otherwise
 * surface is a `skipped` row in the clip list after the next death.
 */
function describeStreamable(
  settings: AppSettings['streamable'],
  credentialsUsable: boolean
): BadgeDescriptor {
  if (!settings.enabled) {
    return { tone: 'idle', label: 'Uploading off', detail: 'nothing is sent to Streamable' }
  }
  if (settings.email === '' || !credentialsUsable) {
    return { tone: 'warn', label: 'Not configured', detail: 'account details missing' }
  }
  if (!settings.autoUpload) {
    return { tone: 'warn', label: 'Auto-upload paused', detail: 'clips stay on this PC only' }
  }
  return { tone: 'ok', label: 'Auto-upload on', detail: 'every death clip' }
}

/**
 * What `credentials:status` has to say about the stored Streamable password.
 *
 * `null` while the first answer is in flight. The three states need three different
 * sentences and one of them - `undecryptable` - is the entire reason this channel exists:
 * an encrypted blob is on disk, this machine can no longer read it (settings copied from
 * another PC or user profile, or Windows rotated its DPAPI key), and there is nothing to
 * do but type the password again. Nobody deduces that from an empty text box.
 */
function CredentialNotice({
  slot,
  obs
}: {
  readonly slot: CredentialSlotStatus | null
  readonly obs: CredentialSlotStatus | null
}): ReactElement | null {
  if (slot === null) return null

  if (slot.status === 'undecryptable') {
    return (
      <div className="notice notice--bad notice--stack" role="alert">
        <p>
          <strong>Your saved Streamable password could not be decrypted on this PC.</strong> The
          encrypted value is still in your settings file, but Windows will no longer unlock it —
          which happens when the settings were copied from another machine or user account, or
          when the machine&apos;s encryption key was reset.
        </p>
        <p>
          The password is gone as far as poe-tool is concerned. Type it again below; uploads will
          keep failing until you do.
          {obs !== null && obs.status === 'undecryptable' && (
            <> Your saved OBS password is affected in the same way.</>
          )}
        </p>
      </div>
    )
  }

  if (slot.status === 'unavailable') {
    return (
      <div className="notice notice--warn notice--stack">
        <p>
          <strong>This PC will not give poe-tool an encryption key</strong>, so your Streamable
          password cannot be protected at rest here. A password you type now will not survive a
          restart, and this machine should not be holding an account password you reuse anywhere
          else.
        </p>
        {obs !== null && obs.status === 'unavailable' && (
          <p>Your OBS password is stored under the same mechanism and is equally affected.</p>
        )}
      </div>
    )
  }

  return null
}

export interface StreamableSectionProps {
  readonly api: PoeToolApi
  readonly settings: AppSettings
  readonly update: (patch: DeepPartial<AppSettings>) => void
  readonly commit: (patch: DeepPartial<AppSettings>) => void
  readonly flush: () => void
}

export function StreamableSection({
  api,
  settings,
  update,
  commit,
  flush
}: StreamableSectionProps): ReactElement {
  const credentials = useCredentialStatus(api)
  const streamable = settings.streamable

  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<StreamableTestResult | null>(null)
  const [testCrash, setTestCrash] = useState<string | null>(null)

  const status = credentials.status
  const slot = status === null ? null : status.streamable
  const obsSlot = status === null ? null : status.obs

  /** A password is stored in main AND main can still read it. */
  const storedPassword = slot !== null && slot.present
  /**
   * Either main holds a usable password, or the user has just typed one that has not been
   * saved (and therefore blanked) yet. Both are testable; neither is guessed at from the
   * settings payload alone, which always reads `''`.
   */
  const havePassword = storedPassword || streamable.password !== ''
  const haveEmail = streamable.email.trim() !== ''

  const canTest = streamable.enabled && haveEmail && havePassword && !testing

  const runTest = (): void => {
    // Persist first, exactly like the OBS test: testing a credential the user can see but
    // that was never saved would be a lie the moment they close the window. It also means
    // the password reaches main by the ordinary settings path, so the fallback below has
    // something to fall back TO.
    flush()

    setTesting(true)
    setTestResult(null)
    setTestCrash(null)

    void api
      .testStreamable({
        email: streamable.email,
        // Usually `''`, because this window holds a redacted blank once a save has
        // round-tripped. Main substitutes the stored password in that case - see
        // `narrowStreamableTestRequest` - so the button tests what the uploader will
        // actually use rather than an empty string.
        password: streamable.password
      })
      .then(
        (result) => {
          setTesting(false)
          setTestResult(result)
          // The save that ran just before this may have been the first time a password was
          // stored, so the "is one saved" line beside the field is now stale.
          credentials.refresh()
        },
        (error: unknown) => {
          // `streamable:test` is contracted never to reject; this branch means the IPC call
          // itself broke, which is worth showing rather than swallowing.
          setTesting(false)
          setTestCrash(describeError(error))
        }
      )
  }

  const badge = describeStreamable(streamable, havePassword && haveEmail)

  return (
    <Section
      index="5"
      title="Streamable uploads"
      description="Optionally publish each death clip to your own Streamable account and get a link you can share."
      aside={<StatusBadge {...badge} srPrefix="Streamable" />}
    >
      {/*
        Shown whether or not the feature is switched on: it is the explanation a user needs
        BEFORE deciding, and the thing they need to remember afterwards.
      */}
      <div className="notice notice--warn notice--stack">
        <p>
          <strong>This uses an unofficial Streamable endpoint.</strong> Streamable&apos;s own API
          documentation says that video uploading, clipping and editing are not supported by its
          API. The address poe-tool posts to is undocumented, is not covered by any support
          commitment, and can stop working without notice. If that happens, uploads fail visibly
          in the clip list below — nothing else in poe-tool is affected, and your clips stay on
          disk.
        </p>
        <p>
          <strong>It signs in with your account email and password.</strong> Streamable has no
          upload token to issue or revoke, so this is the real credential. poe-tool encrypts it
          with this PC&apos;s own encryption before saving it, never writes it to a log, and never
          sends it back to this window.
        </p>
        <p>
          <strong>Free Streamable accounts delete videos after 90 days</strong>, and cap a video at
          250 MB and 10 minutes. A link you shared stops working when that happens. Your local
          clips are never touched by any of this.
        </p>
      </div>

      <ToggleField
        label="Upload my death clips to Streamable"
        checked={streamable.enabled}
        hint="Off by default, and off means poe-tool never contacts Streamable at all — no upload, no status check, not even a credential test."
        onChange={(next) => {
          commit({ streamable: { enabled: next } })
        }}
      />

      <div className="grid grid--split">
        <TextField
          label="Streamable account email"
          value={streamable.email}
          placeholder="you@example.com"
          hint="The email you sign in to streamable.com with. It is used as the sign-in name for the upload."
          onChange={(next) => {
            update({ streamable: { email: next } })
          }}
          onCommit={flush}
        />
        <TextField
          label="Streamable account password"
          value={streamable.password}
          kind="password"
          hint="Stored encrypted on this PC. This box is blank after every save because poe-tool never sends a stored password back to this window — that is deliberate, not a lost setting."
          onChange={(next) => {
            update({ streamable: { password: next } })
          }}
          onCommit={() => {
            // Save, then re-ask whether a secret is now stored. Main handles these two
            // calls in the order they arrive and the save is synchronous on its side, so
            // the answer normally reflects the write; if it ever does not, the line below
            // is one press of "Test credentials" (or one reopen) away from being right.
            flush()
            credentials.refresh()
          }}
        />
      </div>

      <p className="row__note">
        {slot === null
          ? 'Checking whether a password is saved…'
          : storedPassword
            ? 'A password is saved on this PC. Type a new one above to replace it.'
            : 'No password is saved yet.'}
      </p>

      {credentials.error !== null && (
        <p className="notice notice--warn">
          Could not check the saved credentials: {credentials.error}
        </p>
      )}

      <CredentialNotice slot={slot} obs={obsSlot} />

      <div className="row">
        <button className="button" type="button" onClick={runTest} disabled={!canTest}>
          {testing ? 'Checking…' : 'Test credentials'}
        </button>
        <span className="row__note">
          {!streamable.enabled
            ? 'Turn uploading on first — with it off, poe-tool will not contact Streamable even to test.'
            : !haveEmail
              ? 'Enter your account email first.'
              : !havePassword
                ? 'Enter your account password first.'
                : 'Signs in once and uploads nothing.'}
        </span>
      </div>

      {testCrash !== null && (
        <p className="notice notice--bad">Could not run the check: {testCrash}</p>
      )}

      {testResult !== null && testResult.ok && (
        <p className="notice notice--ok">Streamable accepted these account details.</p>
      )}

      {testResult !== null && !testResult.ok && (
        <p className="notice notice--bad">Streamable check failed: {testResult.error}</p>
      )}

      <ToggleField
        label="Upload every death clip automatically"
        checked={streamable.autoUpload}
        hint="On: each clip is uploaded as soon as it has been filed. Off: nothing is uploaded — poe-tool has no manual upload button, so this is a pause switch that keeps your account details configured."
        onChange={(next) => {
          commit({ streamable: { autoUpload: next } })
        }}
      />

      <ul className="notes">
        <li>
          Every upload shows its progress on the clip&apos;s row above — queued, uploading,
          processing, then the link. Clips that were skipped or failed say so there too, with the
          reason.
        </li>
        <li>
          A clip over Streamable&apos;s free-plan size limit is refused before anything is sent,
          so a 300 MB clip fails in a second with a readable message instead of after a long
          upload.
        </li>
        <li>
          Uploading never moves or deletes your local clip. A failed upload costs you a link, not
          a recording.
        </li>
        <li>
          Turning uploading off stops every request immediately. The saved password stays
          encrypted in your settings file until you replace it — there is no &quot;forget it&quot;
          button yet.
        </li>
      </ul>
    </Section>
  )
}
