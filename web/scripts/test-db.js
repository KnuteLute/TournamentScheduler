"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const database_1 = require("../src/lib/database");
async function runTest() {
    console.log("=== Testing Database Connection ===");
    try {
        console.log("Adding players...");
        const p1 = await database_1.Database.addPlayer("Alice");
        const p2 = await database_1.Database.addPlayer("Bob");
        console.log("Added:", p1, p2);
        console.log("Fetching all players...");
        const players = await database_1.Database.getPlayers();
        console.log("Players:", players);
        console.log("=== Test Complete ===");
    }
    catch (e) {
        console.error("Test failed", e);
    }
    finally {
        process.exit(0);
    }
}
runTest();
//# sourceMappingURL=test-db.js.map