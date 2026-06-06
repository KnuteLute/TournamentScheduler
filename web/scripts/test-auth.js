"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const database_1 = require("../src/lib/database");
const auth_1 = require("../src/lib/auth");
async function runAuthTest() {
    console.log("=== Testing Authentication Flow ===");
    try {
        const testUser = `testuser_${Date.now()}`;
        const password = "mysecretpassword123";
        console.log("1. Hashing password...");
        const hash = await auth_1.AuthUtils.hashPassword(password);
        console.log(`Password hashed successfully.`);
        console.log("2. Creating user in database...");
        const userId = await database_1.Database.createUser(testUser, hash);
        if (!userId)
            throw new Error("Failed to create user.");
        console.log(`User created with ID: ${userId}`);
        console.log("3. Fetching user by username...");
        const userRec = await database_1.Database.getUserByUsername(testUser);
        if (!userRec)
            throw new Error("Failed to fetch user.");
        console.log(`Fetched user: ${userRec.username}`);
        console.log("4. Verifying password...");
        const isMatch = await auth_1.AuthUtils.comparePassword(password, userRec.password_hash);
        if (!isMatch)
            throw new Error("Password mismatch.");
        console.log(`Password match: ${isMatch}`);
        console.log("5. Generating JWT...");
        const token = auth_1.AuthUtils.generateToken(userId);
        console.log(`Generated token: ${token.substring(0, 20)}...`);
        console.log("6. Verifying JWT...");
        const decoded = auth_1.AuthUtils.verifyToken(token);
        if (!decoded || decoded.userId !== userId)
            throw new Error("Token decoding failed.");
        console.log(`Token verified for userId: ${decoded.userId}`);
        console.log("=== All Auth Tests Passed ===");
    }
    catch (e) {
        console.error("Test failed:", e);
    }
    finally {
        process.exit(0); // Exit process
    }
}
runAuthTest();
//# sourceMappingURL=test-auth.js.map