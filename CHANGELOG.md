# Changelog

All notable changes to poe-tool are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html) — while the
major version is `0`, minor bumps may still change behaviour.

**This file generates the GitHub Release notes.** `.github/workflows/release.yml`
extracts the section matching the tag being built and sets it as the release body, and
it **fails the release** if the version has no section here. A release with empty notes
is not worth publishing, so the gate is deliberate: add the entry before you tag.

## [Unreleased]

Nothing yet.

## [0.3.0] — 2026-07-28

### Changed

- Rebuilt the interface from the Claude Design project "Path of Exile death tracker":
  a 208px sidebar, three views (Activity / Overlay / Settings), and the Nocturne
  component layer as plain CSS. Crimson `#cf4a52` on near-black `#100f11`.
- Live faults now appear as banners from **any** view rather than only inside the
  settings tab that owns them. A missing `Client.txt`, an unreadable log, an
  unresolved character and a stopped replay buffer are each a distinct banner
  carrying the main process's own message.
- Fonts fall back through system stacks instead of being fetched from Google Fonts.
  A desktop app has to render offline and should not make a network request per launch.

### Added

- Session stats in the Activity view — uptime, areas entered and deaths — counted from
  live events rather than derived from the bounded event ring buffer, which would have
  undercounted silently during a long session. Backlog events are ignored so a log
  rotation cannot inflate the counters.
- A Streamable settings tab. The design predates that feature and had no home for it.
- This changelog, wired into the release pipeline.

### Fixed

- The character detection-swap warning was unreachable unless the Character tab
  happened to be open. A throwaway mule levelling up would silently steal detection,
  every later death would read as another player's, and no clip would ever be saved.
  The warning now lives in the shell, which is mounted for the life of the window.
- The readiness pill counted OBS as ready on connection alone, ignoring whether the
  replay buffer was actually running — so it could read "Capturing 4 / 4" while no clip
  could possibly be saved. Readiness is now computed in one place that feeds both the
  pill and the banners, so they cannot disagree.

### Not implemented

The overlay, logout macro, area timers and notifications are visible in the UI as
explicit "coming soon" states. They are **not** built. In particular the sidebar shows
no armed/ready status for the logout macro, because telling a player they have a panic
button they do not have is the most harmful thing this app could claim.

## [0.2.0] — 2026-07-27

First published release.

### Added

- Read-only tailing of `Client.txt` with a typed event bus. Incremental delta reads,
  truncation and rotation handling, UTF-8 sequences split across reads, and partial
  trailing lines held back until complete.
- Death, zone-entered, area-generated and level-up parsing. Death and zone events are
  gated on the system-message marker, so a player typing "X has been slain." in chat
  cannot forge one.
- OBS replay-buffer clip on death via obs-websocket v5, with the saved path taken from
  the `ReplayBufferSaved` event. An inactive replay buffer, auth failure, save timeout
  and move failure are each surfaced as their own error.
- Clip library: moves each clip into a configurable folder with a timestamped,
  zone-tagged name, falling back to a verified copy-then-delete across volumes, with
  retry for Windows file locks and an optional JSON sidecar.
- Character auto-detection from level-up lines, persisted so one level-up is enough,
  with a manual override for group play and a warning when detection changes hands.
- `has committed suicide` (PoE's `/kill`) parsed as a death with a cause, and never
  clipped — the check runs before the debounce so a `/kill` cannot suppress a real
  death moments later.
- Credentials encrypted at rest with Electron `safeStorage`. Decryption failing on
  another machine degrades to a clear warning rather than silently losing the password.
- Automatic upload of death clips to Streamable, behind an off-by-default toggle.
  **Streamable's upload endpoint is undocumented and unofficial** — their own API
  documentation states uploading is not supported — so every assumption about it is
  isolated in one module and parsed defensively.
- Windows NSIS per-user installer requiring no administrator rights, in-app
  auto-update, and CI running typecheck and tests on Linux and Windows.
- `npm run tail:debug`, which prints every matched and unmatched log line plus a
  summary of the commonest unmatched line shapes, for verifying the parser against a
  real `Client.txt` before trusting it.

### Fixed

- A leading `~` in a configured path is expanded. `~` is a shell convention, so node
  was looking for a directory literally named `~`.
- `LogReader` rejects anything that is not a regular file. Opening a directory fails on
  POSIX but **succeeds** on Windows, where the handle reports size 0 — so a mistyped
  path showed a healthy "tailing" badge while reading nothing.

## [0.1.0]

Never released. Built once as a CI artifact only; its contents predate the Windows
directory fix, encrypted credentials and Streamable upload.

[Unreleased]: https://github.com/crnbarr93/poe-tool/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/crnbarr93/poe-tool/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/crnbarr93/poe-tool/releases/tag/v0.2.0
