import { generateNextDynamic2v2Match } from './scheduler';
import { Participant, Match } from '../types';

const assert = {
    ok: (cond: boolean, msg: string) => { if (!cond) throw new Error(msg); },
    strictEqual: (a: any, b: any, msg?: string) => { if (a !== b) throw new Error(msg || `${a} !== ${b}`); }
};

function test() {
    console.log("Running Dynamic 2v2 Scheduler tests...");

    // Test 1
    const participants: Participant[] = [
        { id: '1', name: 'A' },
        { id: '2', name: 'B' },
        { id: '3', name: 'C' },
        { id: '4', name: 'D' },
        { id: '5', name: 'E' },
        { id: '6', name: 'F' },
    ];

    let matches: Match[] = [];
    const pausedIds: string[] = [];

    let nextMatch = generateNextDynamic2v2Match(matches, participants, pausedIds);
    assert.ok(nextMatch !== null, "First match generated");
    if (nextMatch) matches.push(nextMatch);
    
    assert.strictEqual(matches.length, 1);
    assert.strictEqual(matches[0]!.teams.length, 2);
    
    nextMatch = generateNextDynamic2v2Match(matches, participants, pausedIds);
    assert.ok(nextMatch !== null, "Second match generated");
    if (nextMatch) matches.push(nextMatch);

    assert.strictEqual(matches.length, 2);

    // Test 2
    const participantsSmall: Participant[] = [
        { id: '1', name: 'A' },
        { id: '2', name: 'B' },
        { id: '3', name: 'C' },
        { id: '4', name: 'D' },
    ];
    let matchesSmall: Match[] = [];

    // Pause A
    // Test 3: Infinite generation
    const participantsInf: Participant[] = [
        { id: '1', name: 'A' },
        { id: '2', name: 'B' },
        { id: '3', name: 'C' },
        { id: '4', name: 'D' },
    ];
    let matchesInf: Match[] = [];
    
    // Generate 100 matches for 4 players (which requires heavy resetting)
    let passedInf = true;
    for (let i = 0; i < 100; i++) {
        const m = generateNextDynamic2v2Match(matchesInf, participantsInf, []);
        if (!m) {
            passedInf = false;
            break;
        }
        matchesInf.push(m);
    }
    assert.ok(passedInf, "Should generate infinitely due to resets");

    console.log("All tests passed!");
}

test();
