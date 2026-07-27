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
 * THE `[SCENE] Set Source` LINE EXISTS, AND IS STILL NOT A ZONE SIGNAL
 * -------------------------------------------------------------------
 * CORRECTION. An earlier version of this comment asserted that the string
 * `[SCENE] Set Source` "appears NOWHERE in a real log". That was FACTUALLY
 * WRONG and it is recorded here so nobody re-derives the same mistake. It
 * appears 16,898 times in the 375,087-line reference Client.txt, shaped like
 * this (verbatim - note the value is bracketed and there is NO `": "` marker,
 * this is not a system message):
 *
 * ```text
 * 2025/06/19 16:15:23 9696796 e03447a5 [INFO Client 32648] [SCENE] Set Source [The Twilight Strand]
 * ```
 *
 * It reads like a zone signal. It is not usable as one. Observed distribution
 * of the bracketed value across those 16,898 lines:
 *
 * ```text
 *   8,320  [(null)]              <- no zone at all
 *     514  [(unknown)]           <- no zone at all
 *   2,528  [Crucible Hideout]
 *     374  [Karui Shores]
 *     ...  364 further values, long tail (368 distinct values in all)
 * ```
 *
 * Over HALF of all occurrences (8,834 of 16,898) name no zone whatsoever, and
 * the named remainder is dominated by whatever the player idles in rather than
 * by transitions. {@link ZONE_ENTERED} (8,065 occurrences) and
 * {@link AREA_GENERATED} (8,070) already carry the same information completely,
 * and the first of the two is system-gated. There is nothing here to win.
 *
 * Do not re-litigate this: the line is real, it was measured, and it lost.
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
 * A character was killed BY THE GAME. GATED ON {@link SYSTEM_MARKER} - never run
 * this against a body that did not carry the marker.
 *
 * This is only ONE of the two ways a character dies; the other is
 * {@link SUICIDE}. Both produce a `DeathEvent`, discriminated by
 * `DeathEvent.cause` - `'slain'` here, `'suicide'` there. 348 occurrences in the
 * 375,087-line reference log, all 348 matched by this pattern.
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
 * A character killed ITSELF - this is PoE's `/kill` chat command. GATED ON
 * {@link SYSTEM_MARKER}, for exactly the same reason as {@link DEATH}: the
 * sentence is trivially typeable into global chat, and the marker is the only
 * thing that tells the two apart.
 *
 * Written against (marker already stripped, so the body is
 * `LargeThumbThomasReturns has committed suicide.`):
 * ```text
 * 2025/07/13 09:52:01 176574078 cff945b9 [INFO Client 42816] : LargeThumbThomasReturns has committed suicide.
 * ```
 *
 * Group 1 = the character's name. 7 occurrences in the 375,087-line reference
 * log, all 7 matched by this pattern - which is exactly why it earns a regex
 * rather than a heuristic: seven lines in thirteen months is far too rare to
 * ever be noticed going wrong.
 *
 * `^(\S+)` for the same reason as {@link DEATH}: PoE names have no spaces, so a
 * lazy `.+?` would let `"lol Bob has committed suicide."` report `"lol Bob"` as
 * dead. Fully anchored at both ends for the same reason too.
 *
 * NO `(?: by (.+))?` CLAUSE, unlike {@link DEATH}. `/kill` has no killer, and
 * the speculative clause on `DEATH` exists only because other client versions
 * are reported to log one for real deaths. Nothing suggests this sentence has a
 * variant, so it gets no speculative slack.
 *
 * WHAT THIS IS FOR: a suicide is a real death and counts for stats, but it is
 * DELIBERATE and must never produce a clip - `/kill` is how you leave a map
 * instantly or reset a boss, so the "highlight" would be thirty seconds of
 * nothing. The parser emits it as a `DeathEvent` with `cause: 'suicide'` and the
 * replay clipper is the single consumer that filters on that. See `DeathCause`
 * in src/shared/events.ts.
 */
export const SUICIDE = /^(\S+) has committed suicide\.$/

/**
 * A character gained a level. GATED ON {@link SYSTEM_MARKER} - this sentence is
 * as chat-shaped as the death ones, and letting a stranger in global chat name
 * the character we think we are playing would be worse than a fake death.
 *
 * Written against (marker already stripped, so the body is
 * `LargeThumbThomasReturns (Marauder) is now level 2`):
 * ```text
 * 2025/06/19 16:22:33 10127484 cff945b9 [INFO Client 6956] : LargeThumbThomasReturns (Marauder) is now level 2
 * ```
 *
 * Groups: 1 = character name, 2 = class, 3 = new level. 585 occurrences in the
 * 375,087-line reference log, all 585 matched by this pattern.
 *
 * NO TRAILING PERIOD. Unlike {@link DEATH}, {@link SUICIDE} and
 * {@link ZONE_ENTERED}, this sentence ends on the digits - hence `(\d+)$` and
 * not `(\d+)\.$`. That difference is load-bearing twice over: it is what makes
 * this pattern mutually exclusive with the three period-terminated ones, and it
 * is the single easiest thing to get wrong when writing this from memory.
 *
 * `\(([^)]+)\)` rather than `\((\S+)\)` for the class: every value observed in
 * the reference log is one word (Marauder, Berserker, Slayer, Duelist,
 * Elementalist, Witch, Ranger - base classes BEFORE ascending, ascendancies
 * after), but a negated class costs nothing, cannot backtrack past the closing
 * paren, and does not bake a "class names have no spaces" assumption into the
 * regex that the type in src/shared/events.ts explicitly refuses to make.
 *
 * `(\d+)` unbounded, not `([1-9][0-9]?|100)`: PoE 1 caps at 100 today, and a
 * pattern that silently stops matching if that ever changes is a worse failure
 * than a number the caller has to sanity-check.
 *
 * WHY THIS EXISTS AT ALL: this is the ONLY line in Client.txt that names a
 * character AND identifies it as the one being played, so it is the sole basis
 * for auto-detecting the active character. It is also SPARSE - the reference log
 * has 585 of them across thirteen months, and a level-98 character can play for
 * weeks without producing one. Anything derived from it MUST be persisted; see
 * `LevelUpEvent` and `ActiveCharacter` in src/shared/events.ts.
 */
export const LEVEL_UP = /^(\S+) \(([^)]+)\) is now level (\d+)$/

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
