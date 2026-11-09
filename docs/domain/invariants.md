# Scheduling and standings invariants

These are testable domain properties for schedule creation, match transitions, pause handling, and standings. They complement [`scheduling-and-standings.md`](scheduling-and-standings.md). Unless an invariant explicitly states otherwise, evaluate it within one tournament and on canonical participant IDs.

## Roster and mode validation

1. Every tournament roster has unique participant IDs and no duplicate display names, as requested in `Features.txt`; IDs, not names, are used for schedule identity.
2. 1v1 cannot start with fewer than two distinct participants. Either 2v2 mode cannot start with fewer than four distinct participants. Invalid starts create no tournament and do not replace another tournament.
3. Every fixed-team roster is a disjoint partition of selected participants into exactly two-person teams. No selected player is omitted or assigned twice. Starting with an odd number of players is rejected unless a separate, explicit unassigned-player policy is defined; a fixed-team bye is a bye for a team, not for an unmatched player.
4. Mode order exposed to the user starts with rotating 2v2. Fixed 2v2 stays backend-supported but does not appear in mode-selection HTML.

## Schedule correctness

5. Every match has exactly two teams, each with the mode's required cardinality (one in 1v1, two in 2v2); each team and match has no repeated participant ID.
6. Every participant in a match belongs to that tournament's roster. A match ID is unique within its tournament and remains stable after generation.
7. In a 1v1 round robin of `n` distinct players, every unordered player pair occurs exactly once and the match count is `n(n-1)/2`.
8. Each 1v1 round has at most one appearance per participant. If `n` is odd, there are `n` rounds and one bye per round, with each participant receiving exactly one bye; bye events do not add matches.
9. In fixed 2v2 round robin of `t >= 2` disjoint teams, every unordered team pair occurs exactly once and the match count is `t(t-1)/2`. No player partnership changes between matches. With odd `t`, every round has one team bye and every team receives one bye across `t` rounds.
10. Every rotating 2v2 match contains exactly four distinct, unpaused roster participants split into two pairs. Fewer than four eligible players results in no next match and no standings/fairness event.
11. Rotating matches never count a bye/resting player as a participant or as a scored side. For one live court, each accepted match schedules exactly four players and all other eligible players rest for that slot.
12. Within a round or same live slot, no participant is assigned more than once. A participant cannot occur in overlapping matches; a court cannot host overlapping matches. No new rotating match includes a paused participant.
13. Scheduling is deterministic: identical canonical roster/team assignments, mode, seed, generator version, accepted history, and pause set produce identical match assignments, order, and IDs. Replaying a persisted/generated match does not invoke a new random choice.
14. Fairness selection follows the documented lexicographic ordering: appearances ascending, waiting time descending, consecutive appearances ascending, partnership novelty when feasible, then seeded tie resolution. Skipped/void matches do not influence these counters. Pause/resume does not erase prior fairness history.

## Lifecycle, timing, and mutation

15. A match transitions only along the documented lifecycle. A completed or skipped match is terminal unless an explicit score-correction operation is used; a completed tournament cannot accept new matches or scores.
16. A scheduled or previewed match has no `startTime`. A match has `endTime` if and only if it is completed. For a completed match, `endTime >= startTime` when a start time exists. Skipped matches have no result and are not represented as a zero-score draw.
17. Completed-match scores are present, finite, non-negative integers. Both opposing scores are recorded atomically; invalid input leaves the match and all derived values unchanged.
18. Pausing a player affects eligibility for future rotating matches but does not rewrite, remove, or rescore already generated matches. If a paused participant is in the current match, it cannot proceed until resumed or explicitly skipped.
19. Skip and pause are distinct operations. A pause update alone does not advance/delete a match; skip marks the current match void, and void matches contribute neither standings nor fairness appearances.
20. Completing a match adds its result once. Repeating the same completion request cannot double-count standings or player totals. A score correction replaces the old result and recomputes dependent standings rather than adding a second result.

## Standings properties

21. Only completed, non-void matches contribute to any standings. A bye, rest, scheduled, in-progress, paused, or skipped event contributes zero games and zero points.
22. For each completed match, each participant and each match-side team has exactly one appearance; each receives the side score as points-for and the opposing score as points-against. For every row, `pointDifferential = pointsFor - pointsAgainst`.
23. A completed match yields exactly one win/draw/loss per participating player and per side team. Side outcomes are complementary: one win and one loss, or two draws. A 0–0 completed match is a draw, not an unplayed match.
24. Tournament player standings include every roster participant, even with zero appearances. Fixed-team standings include every configured fixed team; rotating-team standings include only pairs with a completed appearance. In 1v1, team rows are the single-player sides.
25. Rotating team identity is the unordered pair of stable player IDs. Reversing partner order or side position does not create another row; changing either partner does.
26. Player and team standings are independent projections. A rotating player’s aggregate is not copied into any one pair row, and pair rows do not merge merely because one player is shared.
27. Ranking uses wins descending, point differential descending, then points scored descending. Rows equal on all competitive criteria share a rank; name/ID ordering is display-only and cannot break the tie. No unstated tiebreaker is applied.
28. Tournament standings are isolated to one tournament. Overall player/team standings aggregate only the explicitly selected owner/guest history scope and completed matches; they never incorporate another user's/session's matches or the active tournament's process-global state by accident.

## State isolation

29. Tournament roster, mode, seed/version, schedule, current match, lifecycle, pause set, and results are scoped to one tournament and its owner/session. One user's start/pause/score/finish operation cannot mutate another user's tournament.
30. Concurrent changes to the same tournament cannot lose an accepted score, pause update, or generated match through an unguarded overwrite. Generation and completion are committed atomically with the state they depend on.
31. This is a target invariant, not a description of current code: `web/src/app.ts` currently stores `tournamentState` as a single module-level value, shared across requests in the process. Tests should make that discrepancy visible until state is tournament-scoped and durable.

## Determinism test cases

- Run schedule generation twice with identical inputs and assert exact match IDs/order/participant IDs match.
- Reorder the same roster input while preserving canonical IDs, then assert identical generated schedules for a fixed-team assignment and seed.
- Run rotating generation with the same seed/history/pause set twice; assert identical selected players and partners. Change only the seed in a fairness tie and verify reproducibility for each seed without violating fairness/conflict constraints.
- Mark a generated match skipped, then verify it is absent from standings and from rotating appearance/partnership history.
- Pause a player already on a generated match; verify that match is unchanged and no future generated match contains the player until resumed.
