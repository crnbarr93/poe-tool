/**
 * src/main/log/patterns.ts
 * ========================
 *
 * EVERY regular expression in this project lives in this file. Nothing else -
 * no parsing, no helpers, no state. Each pattern is documented with the EXACT
 * real Client.txt line it was written against (verified by the user against a
 * live PoE install, not invented), so a future reader can re-derive the regex
 * from the evidence instead of trusting it.
 *
 * NO IMPORTS. This module is pulled in by `src/main/log/**`, which must run
 * under plain node and vitest and must never touch `electron`.
 *
 *
 * SCOPE / KNOWN LIMITS
 * --------------------
 *  - ENGLISH CLIENT ONLY. The message bodies ("has been slain.", "You have
 *    entered ...") are localised by the game. A German or Brazilian client
 *    writes different sentences and NONE of the body patterns below will match.
 *    Only {@link ENVELOPE} is language-independent.
 *  - PATH OF EXILE 1 ONLY. PoE 2 ships a different client and a differently
 *    shaped log; none of this is assumed to carry over.
 *  - Patterns are matched against a SINGLE line. `$` therefore means
 *    "end of the line we were handed" - none of these carry the `m` flag.
 *
 *
 * WHY NO `g` (OR `y`) FLAG ON ANY OF THESE
 * ----------------------------------------
 * These are module-level singletons shared by every call to `parseLine`. A `g`
 * or `y` flagged regex carries mutable `lastIndex` state between calls, so
 * `test()`/`exec()` would match on one line and then MISS on the next, in an
 * alternating pattern that is maddening to debug. Anchored single-shot patterns
 * need neither flag. Do not add one.
 *
 *
 * THE `[SCENE] Set Source` LINE DOES NOT EXIST
 * -------------------------------------------
 * An earlier design guessed that OBS-relevant scene changes would show up in
 * Client.txt as a `[SCENE] Set Source` line. They do not - that string appears
 * NOWHERE in a real log. Nothing in this project may depend on it.
 *
 * The supported way to discover a new pattern is the `npm run tail:debug` CLI
 * (`src/main/tools/tail-debug.ts`): it tails a real Client.txt and prints every
 * line that falls through to `UnmatchedLine`. Do the thing in-game, watch what
 * the log actually prints, paste the verbatim line into a comment here, and
 * only then write the regex. Never the other way round.
 */

// ---------------------------------------------------------------------------
// Line hygiene
// ---------------------------------------------------------------------------

/**
 * Trailing carriage return(s) left over from Windows CRLF line endings.
 *
 * Client.txt is written on Windows with `\r\n`. Splitting a chunk on `\n`
 * therefore leaves a dangling `\r` at the end of every line. That single
 * invisible character breaks every `$`-anchored pattern below - `/\.$/` does
 * NOT match `"... has been slain.\r"`, because in JavaScript `$` (without the
 * `m` flag) only matches at the true end of the string and `\r` is not treated
 * as a terminator there. Strip before matching, always.
 *
 * `\r+` rather than `\r?` so a double-converted file (`\r\r\n`, produced when a
 * CRLF log is run through a naive text tool) is also handled.
 */
export const TRAILING_CR = /\r+$/

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/**
 * The common prefix on every Client.txt line.
 *
 * Written against these three verbatim lines:
 *
 * ```text
 * 2026/07/26 19:26:31 1018412156 cffb0658 [INFO Client 50396] : FyascoWorbinTime has been slain.
 * 2026/07/26 19:28:42 1018543171 cffb0658 [INFO Client 50396] : You have entered Karui Shores.
 * 2026/07/26 19:28:41 1018542484 1186a8a3 [DEBUG Client 50396] Generating level 69 area "2_11_endgame_town" with seed 1
 * ```
 *
 * Field by field:
 *
 * ```text
 * 2026/07/26 19:26:31 1018412156 cffb0658 [INFO Client 50396] : FyascoWorbinTime has been slain.
 * |-----stamp-------| |-clientMs| |thread| |lvl| |sub| |pid|  |------------body---------------|
 * ```
 *
 * NAMED GROUPS (`match.groups`), all of them non-optional except `body`:
 *  - `stamp`    - the whole `YYYY/MM/DD HH:MM:SS` timestamp, LOCAL time, no UTC
 *                 offset. Also exposed decomposed as `year`/`month`/`day`/
 *                 `hour`/`minute`/`second` so the caller can build a Date with
 *                 `new Date(y, m - 1, d, ...)` - which is the ONLY correct way
 *                 to read it. Never hand this string to `new Date(string)`:
 *                 `"2026/07/26 19:26:31"` is not an ISO-8601 form, so its
 *                 interpretation is implementation-defined.
 *  - `clientMs` - milliseconds since the client process started.
 *  - `threadTag`- opaque subsystem hash, e.g. `cffb0658`. Constrained to hex
 *                 digits because that is what every observed line uses, and a
 *                 tight pattern here is what stops the regex from backtracking
 *                 into a wrong split on a weird line.
 *  - `level`    - `\S+`, NOT an alternation of the five known levels. An
 *                 unrecognised level added in a future patch must flow through
 *                 as a plain string rather than fail the whole envelope; see
 *                 `LogLineMeta.level` in src/shared/events.ts.
 *  - `subsystem`- `\S+`, in practice always `Client`.
 *  - `pid`      - the process id.
 *  - `body`     - EVERYTHING after `"] "`, still carrying the `": "` system
 *                 marker when there is one. Optional: a line may legitimately
 *                 end right after the `]` with no message at all, and that is a
 *                 successful envelope parse with an empty body, NOT a failure.
 *                 `undefined` when absent, so callers must default it to `""`.
 *
 * Deliberately NOT tolerant of a missing/short date: a truncated line from a
 * partial write must fail here and surface as `UnmatchedLine` with `meta: null`
 * rather than be half-parsed into plausible-looking garbage.
 */
export const ENVELOPE =
  /^(?<stamp>(?<year>\d{4})\/(?<month>\d{2})\/(?<day>\d{2}) (?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})) (?<clientMs>\d+) (?<threadTag>[0-9a-fA-F]+) \[(?<level>\S+) (?<subsystem>\S+) (?<pid>\d+)\](?: (?<body>.*))?$/

/**
 * THE SECURITY-CRITICAL PATTERN. Matches the leading `": "` on a body, which is
 * how the client distinguishes an engine-generated message from player chat.
 *
 * System message (engine wrote it) - note `"] : "`:
 * ```text
 * 2026/07/26 19:26:31 1018412156 cffb0658 [INFO Client 50396] : FyascoWorbinTime has been slain.
 *                                                             ^^^ marker
 * ```
 *
 * Player chat (a human typed it) - note `"] Name: "`, i.e. NO marker at the
 * start of the body:
 * ```text
 * 2026/07/26 19:26:40 1018421337 cffb0658 [INFO Client 50396] TrollMcSpoof: FyascoWorbinTime has been slain.
 * ```
 *
 * Both lines contain the literal text `FyascoWorbinTime has been slain.`. The
 * ONLY thing separating a real death from a griefer in global chat spoofing one
 * is this marker, which is why {@link DEATH} and {@link ZONE_ENTERED} are gated
 * on it. A player cannot produce a leading `": "` on their own body: the client
 * always prefixes chat with the speaker's name and a colon, so the body starts
 * with the name.
 */
export const SYSTEM_MARKER = /^: /

// ---------------------------------------------------------------------------
// Event bodies (matched against the MARKER-STRIPPED body)
// ---------------------------------------------------------------------------

/**
 * A character died. GATED ON {@link SYSTEM_MARKER} - never run this against a
 * body that did not carry the marker.
 *
 * Written against (marker already stripped, so the body is
 * `FyascoWorbinTime has been slain.`):
 * ```text
 * 2026/07/26 19:26:31 1018412156 cffb0658 [INFO Client 50396] : FyascoWorbinTime has been slain.
 * ```
 *
 * Groups: 1 = victim's character name, 2 = killer (see below), possibly
 * `undefined`.
 *
 * `^(\S+)` AND NOT `^(.+?)`: PoE character names cannot contain spaces, so the
 * name is exactly one whitespace-free token. A lazy `.+?` would happily swallow
 * a whole chat sentence and report `"lol Bob"` as the dead character - it is
 * the second line of defence behind the system-marker gate. Both anchors matter
 * too: without `$`, `"Bob has been slain. gg"` would match.
 *
 * The optional `(?: by (.+))?` clause is SPECULATIVE. No observed line includes
 * it, but some client versions are reported to log `"X has been slain by Y."`,
 * and an unmatched death is a silently missed clip. The killer is captured but
 * currently DISCARDED by `parse-line.ts`, because `DeathEvent` in
 * src/shared/events.ts is a frozen contract with no killer field. If that field
 * is ever added, the data is already here - do not re-shape the regex for it.
 */
export const DEATH = /^(\S+) has been slain(?: by (.+))?\.$/

/**
 * The player entered a new area. GATED ON {@link SYSTEM_MARKER} - a player
 * typing "You have entered Hillock's living room." must not move the zone
 * tracker.
 *
 * Written against (body after marker strip: `You have entered Karui Shores.`):
 * ```text
 * 2026/07/26 19:28:42 1018543171 cffb0658 [INFO Client 50396] : You have entered Karui Shores.
 * ```
 *
 * Group 1 = the display name with its trailing period already removed.
 *
 * `(.+)` (greedy) is correct here even though {@link DEATH} needs `\S+`: zone
 * names DO contain spaces ("Karui Shores", "The Twilight Strand") and
 * apostrophes ("Lioneye's Watch"), and non-English installs can put non-ASCII
 * characters in them. Greedy + the `\.$` anchor means a name that itself ends
 * in a period keeps as much as possible, which is the behaviour we want. The
 * `$` anchor is what makes this safe despite `.+`.
 */
export const ZONE_ENTERED = /^You have entered (.+)\.$/

/**
 * The client generated an area instance. NOT SYSTEM-GATED - this is a DEBUG
 * line with NO `": "` marker, so requiring the marker would drop it entirely.
 * That is safe: the sentence is not player-reachable (it is not chat-shaped and
 * `Generating level ...` never appears as a chat body prefix), and the pattern
 * is fully anchored.
 *
 * Written against, verbatim:
 * ```text
 * 2026/07/26 19:28:41 1018542484 1186a8a3 [DEBUG Client 50396] Generating level 69 area "2_11_endgame_town" with seed 1
 * ```
 *
 * Groups: 1 = area (monster) level, 2 = internal area id, 3 = layout seed.
 *
 * `"([^"]+)"` rather than `"(.+?)"`: the id is quoted and ids never contain a
 * quote, so a negated class both documents that and cannot backtrack.
 *
 * TIMING: this line fires roughly ONE SECOND BEFORE the matching "You have
 * entered" line, and it is the only place the internal id / area level / seed
 * appear. `seed 1` means a NON-procedural area - town, hideout, or a static
 * zone. The zone tracker buffers this and merges it into the zone-entered that
 * follows.
 */
export const AREA_GENERATED = /^Generating level (\d+) area "([^"]+)" with seed (\d+)$/
