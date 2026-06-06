"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const scheduler_1 = require("./scheduler");
const assert = {
    ok: (cond, msg) => { if (!cond)
        throw new Error(msg); },
    strictEqual: (a, b, msg) => { if (a !== b)
        throw new Error(msg || `${a} !== ${b}`); }
};
function test() {
    console.log("Running Dynamic 2v2 Scheduler tests...");
    // Test 1
    const participants = [
        { id: '1', name: 'A' },
        { id: '2', name: 'B' },
        { id: '3', name: 'C' },
        { id: '4', name: 'D' },
        { id: '5', name: 'E' },
        { id: '6', name: 'F' },
    ];
    let matches = [];
    const pausedIds = [];
    let nextMatch = (0, scheduler_1.generateNextDynamic2v2Match)(matches, participants, pausedIds);
    assert.ok(nextMatch !== null, "First match generated");
    if (nextMatch)
        matches.push(nextMatch);
    assert.strictEqual(matches.length, 1);
    assert.strictEqual(matches[0].teams.length, 2);
    nextMatch = (0, scheduler_1.generateNextDynamic2v2Match)(matches, participants, pausedIds);
    assert.ok(nextMatch !== null, "Second match generated");
    if (nextMatch)
        matches.push(nextMatch);
    assert.strictEqual(matches.length, 2);
    // Test 2
    const participantsSmall = [
        { id: '1', name: 'A' },
        { id: '2', name: 'B' },
        { id: '3', name: 'C' },
        { id: '4', name: 'D' },
    ];
    let matchesSmall = [];
    // Pause A
    // Test 3: Infinite generation
    const participantsInf = [
        { id: '1', name: 'A' },
        { id: '2', name: 'B' },
        { id: '3', name: 'C' },
        { id: '4', name: 'D' },
    ];
    let matchesInf = [];
    // Generate 100 matches for 4 players (which requires heavy resetting)
    let passedInf = true;
    for (let i = 0; i < 100; i++) {
        const m = (0, scheduler_1.generateNextDynamic2v2Match)(matchesInf, participantsInf, []);
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
//# sourceMappingURL=scheduler.test.js.map