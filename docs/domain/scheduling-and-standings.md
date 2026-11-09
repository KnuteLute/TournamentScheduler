# Scheduling and standings domain

This document defines the target behavior for tournament scheduling, match lifecycle, and standings. “MUST” and “MUST NOT” describe domain requirements; they are not claims that the current implementation already meets them.

## Product scope and mode visibility

The requested user-facing mode is **2v2 roterende** (rotating 2v2), and it MUST be listed before other modes in the game-mode selection. **2v2 fast** (fixed teams) remains a supported backend mode for compatibility and direct/internal use, but MUST NOT be offered in the HTML mode-selection UI. The 1v1 mode remains supported. User-facing tournament text should be Norwegian, consistent with `Features.txt`.

Starting either 2v2 mode requires at least four distinct selected players; a request with fewer MUST be rejected without creating or replacing an active tournament. This is the explicit “do not start a four-player game without four players” requirement. 1v1 requires at least two distinct players. A participant is identified by stable ID, not display name; duplicate names are disallowed by the product requirement, and duplicate IDs in a start request MUST also be rejected rather than silently creating duplicate roster entries.

## Core entities

- **Tournament**: stable ID, owner/scope, mode (`1v1`, `2v2_rotating`, or backend-only `2v2_fixed`), ordered roster, random seed and generator version, lifecycle status, current match reference, and its matches. A tournament is the isolation boundary for schedule, pause state, and results.
- **Participant**: stable player ID and display name. Names are labels, not identity keys.
- **Team in a match**: one or two distinct participants, a score, and a stable match-local ID. A fixed team's persistent identity is its configured pair; a rotating team's identity for team standings is the unordered pair of participant IDs.
- **Match**: stable ID, exactly two opposing teams, round/sequence, optional court, status, scores, and timing data. A match with two 2-person teams has four distinct participants total.
- **Court**: an optional resource assignment. A single-court tournament is modeled as one court, not as permission for overlapping matches.

For all match and team comparisons, participant IDs are canonicalized (for example, sort the two IDs in a pair); display names and input order do not determine identity.

## Round-robin scheduling

### 1v1

The round-robin schedule contains every unordered pair of roster participants exactly once. With `n` players there are `n(n-1)/2` matches. Matches are grouped into rounds such that no player occurs more than once in a round. A rotating/circle construction is acceptable, but schedule output MUST be stable for the same normalized roster, seed, and generator version. Home/away or left/right assignment is not a fairness or standings criterion; it must nevertheless be deterministic.

For odd `n`, each round has one explicit bye and each participant receives exactly one bye over the `n` rounds. A bye is a schedule event, not a match: it has no score, winner, match timing, or standings credit. The generated list of actual matches still has `n(n-1)/2` entries.

### 2v2 fixed teams (backend support)

The roster is partitioned into disjoint pairs once, using the explicit team assignment if supplied; if pairing from an ordered roster is the supported creation contract, adjacent players form each pair and that rule MUST be shown/validated at creation. A pair MUST NOT contain the same player twice, and a player MUST NOT belong to multiple fixed teams. Every unordered pair of fixed teams plays exactly once. With `t` teams, this produces `t(t-1)/2` matches.

If the number of fixed teams is odd, one team has a bye per round, with each team receiving one bye over the `t` rounds. A team bye does not count as a played match or affect standings. Fixed-team mode remains valid backend behavior even though it is hidden from the mode-selection HTML.

### 2v2 rotating teams

Every generated match consists of two disjoint pairs of active participants (four unique people). The partnership changes over time; the generator SHOULD avoid repeating a partnership until all feasible partner pairings have been used in the current partnership cycle. Opponent diversity is also desirable, but MUST NOT take priority over player participation fairness or the no-overlap constraints.

Rotating 2v2 is an open-ended schedule, not a finite all-pairs round robin: the organizer advances/generates matches until ending the tournament. A generated match is one four-person playing slot; all other eligible roster members are resting for that slot. This rest is a **bye/rest event**, not a scored match and not a tournament win/loss. A match MUST NOT be generated when fewer than four unpaused eligible participants are available; the tournament remains active and reports that it is waiting for enough players rather than manufacturing a bye opponent or an incomplete match.

### Fairness and pauses in rotating 2v2

For every next-match selection, calculate fairness from the ordered, non-void match history within this tournament. The selection objective is lexicographic:

1. Select the four eligible players with the fewest completed/accepted appearances in this tournament.
2. Among equal totals, prefer the players who have waited the longest since their last appearance (never-played players count as waiting longest).
3. Among remaining ties, prefer the players with fewer consecutive appearances.
4. Form partnerships that have not yet occurred in the current partnership cycle whenever feasible. Reset the partnership cycle only when no valid selection can honor the no-repeat constraint; then continue with the least-repeated feasible pairs.
5. Resolve all remaining ties using the tournament's seeded deterministic ordering.

Skipped/voided matches do not count as an appearance for fairness or partnership history. Paused participants are excluded from newly generated matches. Pausing a player MUST NOT silently alter, delete, or rescore a match already generated; if that player is on the current match, the match is blocked/paused until resumed or explicitly skipped. When a participant is resumed, they re-enter the eligible pool with their prior appearances and wait history intact. Pause changes apply to the next selection even when the current scheduled match is unchanged.

The fairness statistics are tournament-local. They MUST NOT be inferred from global player career totals or another tournament's results.

## Deterministic generation

All schedule generation, including tie-breaking in rotating mode, MUST be reproducible. A generation request is a pure function of the canonicalized roster (including fixed-team assignments), mode, persisted seed, generator version, and relevant tournament history / pause set. The same inputs MUST yield byte-for-byte equivalent match participant assignments, order, and IDs. A seed alone is insufficient if the algorithm/version or participant normalization changes, so both seed and generator version MUST be retained with the tournament.

Use a documented seeded pseudo-random source only for choices that remain tied after the fairness rules; do not use ambient/unseeded randomness. Canonicalize IDs before seeded ordering so that equivalent rosters submitted in a different order do not accidentally change identity. Store each generated match once, and use that persisted result for previews, navigation, and replay rather than re-generating an already-visible match with changed inputs. For a rotating match, generation history is the ordered sequence of accepted, non-void matches; changing pause state only affects future generated matches.

**Current-state discrepancy:** `web/src/lib/scheduler.ts` shuffles candidate partnerships with `Math.random()`, and the rotating tie fallback follows input iteration order. It does not accept or persist a seed or generator version. This is not deterministic behavior and must be replaced/isolated when implementing this contract.

## Match, court, and player conflicts

- A match has exactly two non-empty opposing teams. A participant occurs at most once in a match; teams within a match are disjoint.
- A participant MUST NOT be assigned to two matches that overlap in time. In a round-based pre-generated schedule, a player appears at most once per round. In a live schedule, only one active match per player is allowed.
- A court MUST NOT host overlapping active matches. Without explicit parallel-court support, only one match may be in progress at a time.
- A paused player MUST NOT be newly assigned a live rotating match. A match that was already assigned to that player is retained but cannot proceed until the pause is resolved.
- A bye/rest event is exclusive with playing in that scheduling slot and cannot coexist with a match assignment for that participant in the same slot.
- Starting a tournament MUST validate the roster, mode constraints, fixed-team partition (when applicable), and initial schedule before replacing any existing tournament.
- An invalid score, duplicate participant, incomplete team, or conflict MUST be rejected atomically; it MUST NOT partially mutate match history, fairness counters, or standings.

## Match and tournament lifecycle; timing

Tournament lifecycle: `draft -> active -> completed`, with `active <-> paused` as an organizer-level pause/resume transition and `active|paused -> cancelled` as an explicit cancellation. Completed and cancelled tournaments are terminal. Ending early is permitted: completed matches remain results; pending matches are not fabricated as played.

Match lifecycle: `scheduled -> in_progress -> completed`, with `in_progress -> paused -> in_progress` for an interrupted match. An unplayed match may be explicitly `skipped`/voided. A skipped match is terminal, is not a win/loss/draw, and is omitted from standings and rotating fairness history. “Skip match” and “update pause status” may share a user-facing control as requested in `Features.txt`, but they remain distinct domain operations: changing pause selections alone does not skip, score, or complete a match.

Scores are non-negative integers. A completed match has both scores and exactly one `endTime`; the score comparison determines its result (win/draw/loss). If a product rule disallows draws for a particular game, it must be expressed as a validation rule for that game, not inferred by standings. `startTime` is set when play actually begins, not when a match is merely generated or previewed. `endTime` is set when it is completed, including an explicitly completed match whose score is a draw. Paused intervals SHOULD be retained separately if elapsed playing time is needed; wall-clock duration is `endTime - startTime`, while active duration subtracts recorded pause intervals. Timestamps are instants in a consistent timezone representation.

Completion requires a valid score and records the result once. Editing/correcting a completed score is an explicit correction to that match and MUST recalculate affected tournament and overall standings; it is not a second match. A skipped match MUST NOT be saved as a zero-zero draw. Tournament completion saves only valid completed results plus the schedule/status history needed for audit; a finish request MUST be idempotent.

## Stand-alone standings and tie rules

Standings are read models computed from **completed, non-void matches only**. Pending, paused, skipped, and bye/rest events do not contribute. A valid 0–0 completed match is a draw and does contribute. Scores are credited once per match to each participant/team. Standings MUST be independently viewable as player standings and team standings; neither is derived by sorting the other.

### Player standings

Create one row for every tournament roster participant, including those with no completed appearances (all statistics zero). For each appearance, add the score of the participant's side to points-for and the opposing side's score to points-against; increment matches played and exactly one of wins, draws, or losses. `pointDifferential = pointsFor - pointsAgainst`.

For overall/career player standings, apply the same calculation to the explicitly selected owner's/guest's completed match history, not to the current process or whichever tournament happens to be active. A tournament table and an overall table are separate scopes and MUST be labeled as such.

### Team standings

In fixed 2v2, one row represents each persistent fixed team. In rotating 2v2, one row represents each unordered two-player partnership that actually completed a match; the same pair on either side/order is one team, and different pairs are distinct teams. In 1v1, the team projection represents each single-player side. Aggregate each match-side score and result once per corresponding team row. A player can therefore appear in multiple rotating team rows without those rows being merged. Include zero-match fixed/1v1 roster teams as zero-stat rows; a rotating pair with no completed match has no standings row.

“Overall team” standings are scoped to a stable team identity and an explicitly selected owner/history scope. Rotating partnerships are not presumed to persist across unrelated tournaments; if aggregated across tournaments, identify the row by the canonical pair of stable player IDs and label that it is a partnership aggregate, not a permanent registered team.

### Ranking

For both player and team tables, sort by these criteria in order:

1. Wins, descending.
2. Point differential, descending.
3. Points scored, descending.

If all three competitive values are equal, entries share the same competitive rank. For deterministic display only, order tied rows by normalized display name and then stable ID; that presentation order MUST NOT break the competitive tie or change rank. Do not silently add head-to-head or draw-count tiebreakers. If a future competition needs them, introduce an explicit versioned tournament rule and apply it consistently to all rows.

Wins-first is retained from the current database calculation (`wins`, then differential); points-scored as the third criterion and explicit shared-rank behavior make the tie policy complete and deterministic. Overall career statistics are additive totals, while each tournament's standings are calculated independently from that tournament's matches.

## Current process-state discrepancy

The current active tournament state in `web/src/app.ts` is a module-level `tournamentState` containing mode, matches, roster, pause IDs, and current index. It is process-global: requests from different users/guest sessions or concurrent tournaments can overwrite or observe the same state, and it is not durable across process restarts. This conflicts with the tournament ownership/history model and with pause/fairness isolation above. Target behavior requires state to be associated with a tournament ID and its owner/session, not shared globally; persistence, request scoping, and concurrent-write handling are implementation concerns outside this domain contract.
