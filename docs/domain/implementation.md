# Domain module implementation notes

The pure TypeScript domain API is in `web/src/domain/` and is re-exported from
`web/src/domain/index.ts`. It has no persistence or HTTP dependencies. Backend
services should validate owner-scoped records before passing them to this
module; domain IDs and valid shapes do not establish ownership.

## Schedule APIs

- `generate1v1RoundRobin(participants, seed, generatorVersion?)`
- `generateFixedTeamRoundRobin(participants, fixedTeams, seed, generatorVersion?)`
- `generateNextRotatingMatch(history, participants, pausedPlayerIds, seed, generatorVersion?)`
- `generateSchedule(mode, participants, seed, options?)`

Round-robin results expose `rounds`, each with `matches`, explicit
`byeEvents`, and `restPlayerIds`. A bye/rest is never a `DomainMatch`. Fixed
team input is an explicit, complete disjoint partition; fixed-team rosters with
unmatched players are rejected. Rotating generation returns `null` when fewer
than four unpaused players are available. Otherwise it returns the next
persistable match and the eligible players resting for that slot.

Generation requires a persisted seed; `GENERATOR_VERSION` currently equals
`1`. A server creating a tournament without a supplied seed must create and
persist one before calling the generator. Seeded PRNG, canonical ID ordering,
stable match IDs, and versioned namespaces make generation replayable without
`Math.random`. Identical participant/history/pause/seed/version inputs produce
identical results.

Fairness is computed from non-skipped generated/accepted match history, in
sequence order: appearances ascending, waiting descending, consecutive
appearances ascending, novel partnerships when feasible, then seeded ordering.
Thus a persisted pending/paused rotating match reserves its appearance for
future scheduling; a skipped match does not. This is separate from standings,
where only completed matches count.

The domain currently caps a tournament roster at `MAX_PARTICIPANTS` (32),
bounds IDs to 128 characters and scores to the OpenAPI limit of 1,000,000.
OpenAPI currently has no `maxItems` on roster/team selection arrays; the API
contract should add the matching roster bound before backend request validation
is considered complete.

## Lifecycle and validation APIs

`validateTournamentInput`, `validateRoster`, `validateFixedTeams`,
`validateMatch`, and `validateScore` return structured issues. Their matching
`assert*` helpers throw `DomainValidationError`, whose `issues` use stable codes
and JSON-pointer-like paths. Lifecycle helpers (`startTournament`,
`pauseTournament`, `resumeTournament`, `finishTournament`, `cancelTournament`,
`updatePlayerAvailability`, `startMatch`, `pauseMatch`, `resumeMatch`,
`completeMatch`, `correctMatchScore`, and `skipMatch`) are immutable and enforce
the documented status transitions. Callers must persist each state/result
change atomically and perform optimistic-concurrency checks in the service or
repository layer.

Availability changes exclude paused players only from future rotating
generation. They do not rewrite an assigned match. Pausing an active player
in the current in-progress match pauses that match with a
`participant_unavailable` interval; resuming availability does not resume play.
Use the explicit match resume operation after all match participants are
available.

## Standings APIs

- `computeTournamentStandings(mode, participants, matches, fixedTeams?)`
- `recalculateTournamentStandings(...)` (replay-based alias for correction flows)
- `computeOverallStandings({ tournaments, players? })`

The player and team projections are computed independently. Tournament player
rows include every roster participant. Fixed-team and 1v1 team projections
include configured zero-match rows; rotating-pair rows exist only after a
completed appearance. Overall input is explicit history, which lets the
service provide the authenticated owner's selected tournament scope without
process-global state. Completed score corrections replace a match before
recalculation; no incremental double-counting is performed.

Only completed, non-void matches contribute. Rows expose `matchesPlayed`,
`wins`, `draws`, `losses`, `pointsFor`, `pointsAgainst`, and
`pointDifferential`. Ranking is wins, differential, then points-for, all
descending; equal competitive values share competition rank. Normalized name
and stable key affect display order only.

## Tests

Unit tests beside the implementation cover odd byes, round-robin uniqueness,
partition/roster validation, seeded replay, rotating fairness and pauses,
partnership cycles, lifecycle and score bounds, standings ties, independent
projections, overall history, and score-correction recalculation.
