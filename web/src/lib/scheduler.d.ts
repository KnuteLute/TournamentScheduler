import { Participant, Match } from '../types';
/**
 * Ported from round_robin_1v1_scheduler.cpp
 * Generates 1v1 matchups using a rotational pattern (circle method)
 */
export declare function generate1v1Matches(participants: Participant[]): Match[];
/**
 * Ported from round_robin_2v2_rotating.cpp
 * Generates 2v2 matches with rotating teams
 */
export declare function generateRotating2v2Matches(participants: Participant[]): Match[];
/**
 * Ported from round_robin_2v2_same_team.cpp
 * Generates 2v2 matches with fixed teams (pairs of players)
 */
export declare function generateFixed2v2Matches(participants: Participant[]): Match[];
export declare function generateNextDynamic2v2Match(pastMatches: Match[], participants: Participant[], pausedIds: string[]): Match | null;
//# sourceMappingURL=scheduler.d.ts.map