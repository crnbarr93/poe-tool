# poe-tool

A Windows companion app for **Path of Exile** that watches the game's `Client.txt` log
and asks **OBS** to save a replay-buffer clip when your character dies.

That is the whole feature today. You die in game, poe-tool sees the death line in the
log, tells OBS "save the replay buffer", and files the resulting video into a clips
folder with a name like `2026-07-26_19-26-31_Karui-Shores.mkv`.

---

## Is this safe? Will it get me banned?

**poe-tool only reads a text file.** Specifically, it opens
`…\Path of Exile\logs\Client.txt` read-only and follows it as the game appends to it.

It does **not**:

- read or write the game's memory,
- inject anything into the game process,
- send keystrokes, mouse input, or any other automation to the game,
- modify any game file (including `Client.txt` itself — it is opened `'r'`, read-only),
- attach a debugger to, hook, or otherwise interact with the game process in any way,
- talk to the PoE servers or your GGG account.

The only two things it touches are that one log file and your own local OBS instance
over a websocket on `127.0.0.1`. It is the same category of tool as a log-reading
overlay or a stream-deck helper — nothing it does is anything you could not do by
opening `Client.txt` in Notepad.

Everything about how the log is parsed lives in one small, commented file
(`src/main/log/patterns.ts`), and the `tail:debug` tool below lets you run the exact
same parser over your own log and see, line by line, what it read.

---

## Install

1. Go to the [Releases page](https://github.com/crnbarr93/poe-tool/releases) and
   download `poe-tool Setup X.Y.Z.exe` from the latest release.
2. Run it. It is a **per-user install**: it writes to
   `%LOCALAPPDATA%\Programs\poe-tool`, needs **no administrator rights**, and will
   **not** show a UAC prompt. The install location is fixed and the "install for all
   users" option is disabled on purpose — an all-users install lands in Program Files,
   which needs elevation to install *and* breaks background updates, because
   electron-updater can only replace the app in place when the folder is writable
   without admin rights.

### "Windows protected your PC" — expected, here's why

The installer is **not code-signed**, so the first time you run it Windows SmartScreen
will show a blue box saying *"Windows protected your PC"* with a single **Don't run**
button.

Click **More info**, then **Run anyway**.

This is what Windows shows for *any* unsigned installer that it has not seen enough
times before. It is not a virus warning and it does not mean the download is damaged or
tampered with — a code-signing certificate costs money per year and this project does
not have one. If you would rather not take that on trust, the source is all here and
you can build the installer yourself (see [Development](#development)).

### Updates

The app checks GitHub Releases for a newer version and downloads it in the background.
It **never restarts itself** — the update is applied the next time you quit poe-tool
normally, so an update can't yank the app out from under a clip that is being saved.
Auto-update is disabled entirely when running from source in dev mode.

---

## Setup

Open poe-tool and work down the config window. Everything is saved to
`%APPDATA%\poe-tool\settings.json` as you go.

### 1. Point it at Client.txt

Press **Auto-detect Client.txt**. That checks the standard install locations, built
from your real `%ProgramFiles%` variables rather than hardcoded `C:\` paths:

- Steam — `…\Steam\steamapps\common\Path of Exile\logs\Client.txt`
- Standalone (Grinding Gear Games installer) — `…\Grinding Gear Games\Path of Exile\logs\Client.txt`
- Epic Games Store — `…\Epic Games\PathOfExile\logs\Client.txt`

**Auto-detect cannot find a Steam library on a second drive.** Steam lets you put game
libraries anywhere (`D:\SteamLibrary`, an external disk, a second SSD) and nothing in
the standard locations points at them. If auto-detect comes back empty, that is almost
certainly why — it is a normal outcome, not an error. Paste the full path into the
**Client.txt path** field by hand instead. Your log is at
`<wherever Path of Exile is installed>\logs\Client.txt`.

Whatever you type wins over auto-detection, always.

### 2. Set up OBS

poe-tool does not record anything itself. It asks OBS to save *its* replay buffer, so
OBS has to be doing the recording.

1. **Enable the websocket server.** In OBS: **Tools → WebSocket Server Settings** →
   tick *Enable WebSocket server*. The defaults (port **4455**) are what poe-tool
   expects; leave the host as `127.0.0.1`. If you enable authentication, copy the
   password into poe-tool's **Password** field — leave it empty if authentication is
   off. This needs OBS 28 or newer, which is where obs-websocket v5 ships built in.
2. **Set up the replay buffer.** In OBS: **Settings → Output → Replay Buffer** → enable
   it and choose how many seconds it should keep.
3. **Start the replay buffer.** Click **Start Replay Buffer** in the OBS Controls
   panel (or bind a hotkey to it).

**poe-tool will not start the replay buffer for you.** That is deliberate: starting a
recording output on your behalf writes video to your disk without you asking. If the
buffer is not running when you die, you get an explicit *"OBS is connected but its
replay buffer is not running"* message in the app rather than silence — but you get no
clip. Starting the buffer is a step you have to do yourself, every session.

Use **Test connection** in the app to confirm the websocket half works.

> Note: your obs-websocket password is stored in plain text in
> `%APPDATA%\poe-tool\settings.json`. It only grants control of a local OBS instance,
> not any account, but it is worth knowing.

### 3. Confirm the character

poe-tool only clips **your** deaths, so it has to know which name is yours. It learns
that from level-up lines in the log:

```text
… [INFO Client 6956] : LargeThumbThomasReturns (Marauder) is now level 2
```

That is the only line in `Client.txt` that names the character you are playing, so the
detected name is remembered permanently once seen — level-ups are sparse and a level-95
character can play for weeks without producing one.

**If you play in a group, set the manual override.** A party member's level-up lands in
*your* `Client.txt` looking exactly like your own, so auto-detection can honestly pick
the wrong person. Type your character name into **Manual override — for group play**
and it wins over detection. Clear it to fall back to detection again.

### 4. Clips

- Clips land in the **Clip library folder**, defaulting to
  `C:\Users\<you>\Videos\poe-tool\clips`.
- They are named `YYYY-MM-DD_HH-mm-ss_Zone-Name.<ext>`, keeping whatever container OBS
  wrote (`.mkv`, `.mp4`, …), so a plain directory listing sorts in the order you died.
- **Minimum gap between clips** (default 5 s) stops a party wipe or a death during a
  zone transition from firing several overlapping saves.
- Optionally a `.json` sidecar is written next to each clip with the zone, character
  and event details.
- `/kill` (suicide) is recorded as a death but **never** produces a clip — it is a
  deliberate act for leaving a map or resetting a boss, so the "highlight" would be
  thirty seconds of nothing.

---

## Status — read this before you get excited

**What works (phases 1–2, implemented and unit-tested):**

- Read-only `Client.txt` tailing, including rotation and CRLF handling.
- Parsing of deaths, suicides, level-ups, zone entries and area generation, with chat
  spoofing defended against (a stranger typing *"YourName has been slain."* into global
  chat cannot trigger a clip — engine messages carry a marker chat does not).
- A typed event bus, zone tracking, and character auto-detection with manual override.
- OBS websocket client, replay-buffer save on your own death, clip renaming, clip
  library, `.json` sidecars, debouncing.
- Config UI with a live event feed, persisted settings, and auto-update wiring.

**What does not exist.** These are planned, not built. Nothing in this repo does any of
them today:

- an in-game **overlay**
- **instant logout**
- **zone stats** / run tracking

**Honest caveats about what has and has not been verified:**

- The OBS integration has **never been run against a live OBS instance**. It is written
  against the installed `obs-websocket-js` type definitions and covered by unit tests
  with a faked socket, but nobody has yet watched a real clip come out the other end.
- **The app has not been run on Windows.** It was developed on macOS. The release
  workflow packages the installer on a real `windows-latest` runner, but nobody has yet
  installed it on a gaming PC and used it.
- The log patterns are **English client, Path of Exile 1 only**. A localised client
  writes different sentences and none of the message patterns will match. PoE 2 ships a
  differently shaped log and is not supported (a couple of PoE 2 install paths are
  offered by auto-detect as a convenience, but pointing the watcher at a PoE 2 log will
  most likely produce no events at all).

Treat this as early software that has been carefully written and carefully tested in
isolation, not as something proven in the field.

---

## Development

Requires Node.js 24 (that is what CI uses).

```bash
npm install        # install dependencies
npm run dev        # electron-vite dev server + Electron, with hot reload
npm test           # vitest, once
npm run typecheck  # strict tsc over main, renderer and tests
```

Other useful scripts:

```bash
npm run test:watch  # vitest in watch mode
npm run build       # typecheck + bundle main/preload/renderer into out/
npm run package:dir # build + package the unpacked app only (release/win-unpacked/) - fast
npm run package:win # build + full NSIS installer (release/…Setup X.Y.Z.exe) - slow
```

Both packaging scripts pass `--x64` explicitly. The `arch` list in `electron-builder.yml`
hangs off the *nsis target entry*, and `--dir` substitutes the `dir` target instead of
building nsis, so without the flag `package:dir` silently falls back to the host
architecture — on an Apple-silicon Mac that produced a `win-arm64` build of an app that
only ever ships x64.

**Packaging from macOS works, but proves less than it looks.** electron-builder 26 needs
no Wine to assemble a Windows NSIS installer, so both scripts above genuinely run on
macOS and produce a real PE32 installer. What that does *not* prove is anything about
Windows: the installer has never been executed, so the per-user install path, the absence
of a UAC prompt, the shortcuts and the auto-update handoff are all unverified. The only
build that counts as evidence is the one from the `windows-latest` runner in
`.github/workflows/release.yml`, actually installed and run on a Windows machine.

Architecture in one paragraph: all log and OBS logic lives in the **main** process; the
renderer is a config UI and nothing more, and the app tails and clips perfectly well
with no window open. `src/shared/**`, `src/main/log/**` and `src/main/events/**` must
never import `electron` — that is what makes them testable under plain vitest on
macOS. Strict TypeScript throughout: no `any`, no `@ts-ignore`. The source is heavily
commented, and the comments explain *why*, not *what* — read them before changing
anything.

---

## `tail:debug` — verify the patterns against your own log

Every feature in this app is downstream of one regex file. A pattern that is subtly
wrong produces an app that silently does nothing, so before you trust poe-tool with
your deaths, point this at your real `Client.txt` and see what it actually reads.

```bash
npm run tail:debug -- --replay
```

That reads your whole log history from the start, prints every line it recognised, and
finishes with a summary — including the five most common line shapes it did **not**
recognise, which is the list of patterns that are missing.

Useful variations:

```bash
npm run tail:debug -- --help
npm run tail:debug -- --replay --limit=5000
npm run tail:debug -- --replay --filter=death
npm run tail:debug -- --replay --filter=level-up     # who has this log ever been?
npm run tail:debug -- --replay --unmatched-only --limit=20000
npm run tail:debug -- --path="D:\SteamLibrary\steamapps\common\Path of Exile\logs\Client.txt"
```

The summary ends with a **characters seen** table ordered by death count — the name at
the top is the one to type into the app's manual override.

It opens the log **read-only**, never writes to it, and never writes your
`settings.json` either, so a detection here lasts only for that run. `Ctrl-C` prints
the summary and exits cleanly.

Two limits worth repeating: the patterns are **English-client only** and **Path of
Exile 1 only**. If `tail:debug` reports almost everything as unmatched, that is the
first thing to check.

---

## Releasing

The version comes from `package.json`, **not** from the git tag. The tag only triggers
the workflow. If they disagree, the build does not fail — it quietly produces an
installer with the wrong version number, and auto-update then compares against the
wrong value and clients may never see the release. So:

1. Bump `"version"` in `package.json`.
2. Commit it.
3. Tag **that commit** with a matching `vX.Y.Z` — `package.json` `0.2.0` ↔ tag `v0.2.0`.
4. Push the tag.

`.github/workflows/release.yml` then typechecks, tests, builds and packages on a native
Windows runner, and publishes the installer, its `.blockmap` and `latest.yml` to a
GitHub Release. If the commit is red, no release is produced at all — fix it, delete
the tag, re-tag.

**The release is created as a draft.** electron-builder's GitHub publisher defaults to
that, and a draft is invisible to unauthenticated clients, so electron-updater will not
see the new version until you open the release on GitHub and click **Publish release**.
If updates seem broken after tagging, check your drafts first.

There is also a manual **workflow_dispatch** trigger on the same workflow: it runs the
identical packaging step, publishes nothing, and uploads the installer as a downloadable
workflow artifact. Use that to smoke-test the installer on a real Windows box before
cutting a tag.
