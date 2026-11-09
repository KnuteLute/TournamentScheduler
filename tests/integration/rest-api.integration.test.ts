import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, jest, test } from "@jest/globals";
import {
  ApiClient,
  assertDisposablePostgres,
  freshKey,
  mutationRequest,
  syntheticPassword,
  syntheticUsername,
} from "../helpers/api-client";
import { activeOneOnOneFixture, guestFixture } from "../fixtures/synthetic";

jest.setTimeout(45_000);

beforeAll(async () => {
  await assertDisposablePostgres();
});

describe("REST API v1 — PostgreSQL integration and isolation", () => {
  test("guest bootstrap creates an opaque session; missing session is unauthorized", async () => {
    const client = ApiClient.create();
    const anonymous = await client.agent.get("/api/v1/session");
    expect(anonymous.status).toBe(401);

    const response = await client.agent
      .post("/api/v1/sessions")
      .set("Origin", process.env.TEST_API_ORIGIN!)
      .set("Sec-Fetch-Site", "same-origin");

    expect(response.status).toBe(201);
    expect(response.headers["cache-control"]).toContain("no-store");
    const setCookieHeader = response.headers["set-cookie"];
    const cookieHeaders = Array.isArray(setCookieHeader)
      ? setCookieHeader
      : setCookieHeader
        ? [setCookieHeader]
        : [];
    const cookie = cookieHeaders.find((value) => value.startsWith("__Host-ts_session="));
    const attributes = cookie?.split(";").slice(1).join(";").toLowerCase() ?? "";
    expect(Boolean(cookie)).toBe(true);
    expect(attributes).toContain("secure");
    expect(attributes).toContain("httponly");
    expect(attributes).toContain("samesite=lax");
    expect(attributes).toContain("path=/");
    expect(attributes).not.toContain("domain=");
    expect(response.body).not.toHaveProperty("ownerId");
    expect(typeof response.body.csrfToken).toBe("string");
    expect(response.body.csrfToken.length).toBeGreaterThanOrEqual(32);
  });

  test("CSRF is required and a rejected mutation has no side effect", async () => {
    const { client } = await guestFixture();
    const rejected = await client.withSessionCookie(client.agent
      .post("/api/v1/players"))
      .set("Origin", process.env.TEST_API_ORIGIN!)
      .set("Sec-Fetch-Site", "same-origin")
      .set("Idempotency-Key", freshKey())
      .send({ name: "Must Not Be Created" });

    expect(rejected.status).toBe(403);
    expect(rejected.headers["content-type"]).toContain("application/problem+json");
    const players = await client.get("/players");
    expect(players.status).toBe(200);
    expect(players.body.items).toEqual([]);
  });

  test("body and query validation rejects unknown fields, canonical duplicates, and unbounded limits", async () => {
    const { client } = await guestFixture();
    const extraField = await client.mutate("post", "/players", {
      name: "Synthetic player",
      ownerId: "caller-selected-owner",
    });
    expect(extraField.status).toBe(422);
    expect(extraField.headers["content-type"]).toContain("application/problem+json");
    expect(extraField.body.errors).toEqual(expect.any(Array));

    const first = await client.createPlayer("Åsa Synthetic");
    expect(first.name).toBe("Åsa Synthetic");
    const duplicate = await client.mutate("post", "/players", { name: "  A\u030Asa Synthetic  " });
    expect(duplicate.status).toBe(409);

    const invalidLimit = await client.get("/players?limit=101");
    expect([400, 422]).toContain(invalidLimit.status);
  });

  test("player updates require a current ETag and malformed/foreign IDs do not authorize access", async () => {
    const { client } = await guestFixture();
    const create = await client.mutate("post", "/players", { name: "Versioned player" });
    expect(create.status).toBe(201);
    const playerId = create.body.id;

    const missingPrecondition = await client.mutate("patch", `/players/${playerId}`, { name: "No ETag" }, {
      contentType: "application/merge-patch+json",
    });
    expect(missingPrecondition.status).toBe(428);

    const updated = await client.mutate("patch", `/players/${playerId}`, { name: "Updated player" }, {
      ifMatch: create.headers.etag,
      contentType: "application/merge-patch+json",
    });
    expect(updated.status).toBe(200);
    expect(updated.body.name).toBe("Updated player");
    expect(updated.headers.etag).not.toBe(create.headers.etag);

    const stale = await client.mutate("patch", `/players/${playerId}`, { name: "Stale edit" }, {
      ifMatch: create.headers.etag,
      contentType: "application/merge-patch+json",
    });
    expect(stale.status).toBe(412);

    const otherOwner = (await guestFixture()).client;
    const hidden = await otherOwner.get(`/players/${playerId}`);
    expect(hidden.status).toBe(404);
    const malformed = await client.get("/players/%00");
    expect([400, 404]).toContain(malformed.status);
  });

  test("teams enforce exactly two distinct owned players", async () => {
    const { client } = await guestFixture();
    const [one, two] = await client.createPlayers(["Team member one", "Team member two"]);
    const created = await client.mutate("post", "/teams", {
      name: "Synthetic doubles",
      playerIds: [one.id, two.id],
    });
    expect(created.status).toBe(201);
    expect((await client.get(`/teams/${created.body.id}`)).status).toBe(200);
    const teamPage = await client.get("/teams");
    expect(teamPage.body.items.map((team: { id: string }) => team.id)).toContain(created.body.id);
    expect(created.body.players.map((player: { id: string }) => player.id).sort()).toEqual(
      [one.id, two.id].sort(),
    );

    const repeatedPlayer = await client.mutate("post", "/teams", {
      name: "Invalid repeated roster",
      playerIds: [one.id, one.id],
    });
    expect(repeatedPlayer.status).toBe(422);

    const foreign = (await guestFixture()).client;
    const foreignReference = await foreign.mutate("post", "/teams", {
      name: "Foreign player attempt",
      playerIds: [one.id, (await foreign.createPlayer("Owned by second guest")).id],
    });
    expect(foreignReference.status).toBe(404);
  });

  test("fixed-team tournaments snapshot owned teams and compute an independent team table", async () => {
    const { client } = await guestFixture();
    const players = await client.createPlayers([
      "Fixed team player one",
      "Fixed team player two",
      "Fixed team player three",
      "Fixed team player four",
    ]);
    const firstTeam = await client.mutate("post", "/teams", {
      name: "Fixed side one",
      playerIds: players.slice(0, 2).map((player) => player.id),
    });
    const secondTeam = await client.mutate("post", "/teams", {
      name: "Fixed side two",
      playerIds: players.slice(2).map((player) => player.id),
    });
    expect(firstTeam.status).toBe(201);
    expect(secondTeam.status).toBe(201);

    const created = await client.mutate("post", "/tournaments", {
      name: "Synthetic fixed-team event",
      mode: "2v2_fixed",
      teamIds: [firstTeam.body.id, secondTeam.body.id],
      seed: randomUUID(),
    });
    expect(created.status).toBe(201);
    const tournament = { ...created.body, __etag: created.headers.etag };
    const listed = await client.get("/tournaments");
    expect(listed.body.items.map((item: { id: string }) => item.id)).toContain(tournament.id);
    expect((await client.get(`/tournaments/${tournament.id}`)).status).toBe(200);

    const started = await client.mutate("post", `/tournaments/${tournament.id}/start`, undefined, {
      ifMatch: tournament.__etag,
    });
    expect(started.status).toBe(200);
    const schedule = await client.get(`/tournaments/${tournament.id}/schedule`);
    const matchId = schedule.body.rounds.flatMap((round: { matchIds: string[] }) => round.matchIds)[0];
    const matchStart = await client.mutate("post", `/tournaments/${tournament.id}/matches/${matchId}/start`, undefined, {
      ifMatch: started.headers.etag,
    });
    expect(matchStart.status).toBe(200);
    const result = await client.mutate("post", `/tournaments/${tournament.id}/matches/${matchId}/result`, {
      scores: [21, 17],
    }, { ifMatch: matchStart.headers.etag });
    expect(result.status).toBe(200);

    const teamStandings = await client.get(`/tournaments/${tournament.id}/standings?view=teams`);
    expect(teamStandings.status).toBe(200);
    expect(teamStandings.body.rows).toHaveLength(2);
    expect(teamStandings.body.rows.map((row: { subjectType: string }) => row.subjectType)).toEqual([
      "fixed_team",
      "fixed_team",
    ]);
  });

  test("same idempotency key replays one create and rejects a different payload", async () => {
    const { client } = await guestFixture();
    const key = freshKey();
    const payload = { name: `Retry-safe ${randomUUID()}` };
    const [first, retry] = await Promise.all([
      mutationRequest(client, "post", "/players", payload, { idempotencyKey: key }),
      mutationRequest(client, "post", "/players", payload, { idempotencyKey: key }),
    ]);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(first.body.id);

    const changedPayload = await client.mutate("post", "/players", { name: "Different payload" }, {
      idempotencyKey: key,
    });
    expect(changedPayload.status).toBe(409);
    const page = await client.get("/players");
    expect(page.body.items.filter((item: { id: string }) => item.id === first.body.id)).toHaveLength(1);
  });

  test("competing match transitions are atomic; pause/resume, scores, standings, and history stay owner-scoped", async () => {
    const { client } = await guestFixture();
    const fixture = await activeOneOnOneFixture(client);

    const [startA, startB] = await Promise.all([
      client.mutate("post", `/tournaments/${fixture.tournament.id}/matches/${fixture.matchId}/start`, undefined, {
        ifMatch: fixture.etag,
      }),
      client.mutate("post", `/tournaments/${fixture.tournament.id}/matches/${fixture.matchId}/start`, undefined, {
        ifMatch: fixture.etag,
      }),
    ]);
    expect([startA.status, startB.status].filter((status) => status === 200)).toHaveLength(1);
    expect([409, 412]).toContain([startA, startB].find((response) => response.status !== 200)?.status);
    const started = startA.status === 200 ? startA : startB;

    const pause = await client.mutate(
      "post",
      `/tournaments/${fixture.tournament.id}/matches/${fixture.matchId}/pause`,
      undefined,
      { ifMatch: started.headers.etag },
    );
    expect(pause.status).toBe(200);

    const whilePaused = await client.mutate(
      "post",
      `/tournaments/${fixture.tournament.id}/matches/${fixture.matchId}/result`,
      { scores: [11, 7] },
      { ifMatch: pause.headers.etag },
    );
    expect(whilePaused.status).toBe(409);

    const resume = await client.mutate(
      "post",
      `/tournaments/${fixture.tournament.id}/matches/${fixture.matchId}/resume`,
      undefined,
      { ifMatch: pause.headers.etag },
    );
    expect(resume.status).toBe(200);

    const resultKey = freshKey();
    const resultBody = { scores: [11, 7] };
    const [resultA, resultB] = await Promise.all([
      mutationRequest(
        client,
        "post",
        `/tournaments/${fixture.tournament.id}/matches/${fixture.matchId}/result`,
        resultBody,
        { ifMatch: resume.headers.etag, idempotencyKey: resultKey },
      ),
      mutationRequest(
        client,
        "post",
        `/tournaments/${fixture.tournament.id}/matches/${fixture.matchId}/result`,
        resultBody,
        { ifMatch: resume.headers.etag, idempotencyKey: resultKey },
      ),
    ]);
    expect(resultA.status).toBe(200);
    expect(resultB.status).toBe(200);
    expect(resultA.body.match.status).toBe("completed");
    expect(resultA.body.match.sides.map((side: { score: number }) => side.score)).toEqual([11, 7]);

    const standings = await client.get(
      `/tournaments/${fixture.tournament.id}/standings?view=players`,
    );
    expect(standings.status).toBe(200);
    expect(standings.body.rows).toHaveLength(2);
    expect(standings.body.rows.reduce((sum: number, row: { matchesPlayed: number }) => sum + row.matchesPlayed, 0)).toBe(2);
    expect(standings.body.rows).toContainEqual(expect.objectContaining({
      wins: 1,
      pointsFor: 11,
      pointsAgainst: 7,
    }));

    const overall = await client.get("/standings?view=players");
    expect(overall.status).toBe(200);
    expect(overall.body.scope).toBe("overall");
    expect(overall.body.rows).toHaveLength(2);

    const anotherOwner = (await guestFixture()).client;
    const isolated = await anotherOwner.get("/standings?view=players");
    expect(isolated.status).toBe(200);
    expect(isolated.body.rows).toEqual([]);
    expect((await anotherOwner.get(`/tournaments/${fixture.tournament.id}`)).status).toBe(404);
  });

  test("skip is not a score and contributes nothing to standings", async () => {
    const { client } = await guestFixture();
    const players = await client.createPlayers(["Skip one", "Skip two", "Skip three"]);
    const tournament = await client.createTournament(players.map((player) => player.id));
    const started = await client.mutate("post", `/tournaments/${tournament.id}/start`, undefined, {
      ifMatch: tournament.__etag,
    });
    expect(started.status).toBe(200);

    const schedule = await client.get(`/tournaments/${tournament.id}/schedule`);
    const matchId = schedule.body.rounds.flatMap((round: { matchIds: string[] }) => round.matchIds)[0];
    const skipped = await client.mutate("post", `/tournaments/${tournament.id}/matches/${matchId}/skip`, undefined, {
      ifMatch: started.headers.etag,
    });
    expect(skipped.status).toBe(200);
    expect(skipped.body.status).toBe("skipped");
    expect(skipped.body.sides.every((side: { score: number | null }) => side.score === null)).toBe(true);

    const standings = await client.get(`/tournaments/${tournament.id}/standings?view=players`);
    expect(standings.status).toBe(200);
    expect(standings.body.rows).toHaveLength(3);
    expect(standings.body.rows.every((row: { matchesPlayed: number; wins: number; draws: number }) =>
      row.matchesPlayed === 0 && row.wins === 0 && row.draws === 0,
    )).toBe(true);
  });

  test("guest-to-account transfer preserves IDs and collision claims are explicit", async () => {
    const owner = await guestFixture();
    const transferredPlayer = await owner.client.createPlayer("Transfer on registration");
    const auth = await owner.client.register(syntheticUsername());
    expect(auth.transfer.status).toBe("transferred");
    expect((await owner.client.get(`/players/${transferredPlayer.id}`)).status).toBe(200);

    const existing = await owner.client.createPlayer("Åsa Claim Collision");
    const pending = await guestFixture();
    const guestPlayer = await pending.client.createPlayer("  A\u030Asa Claim Collision ");
    const accountUsername = auth.session.account?.username;
    if (!accountUsername) throw new Error("Registration response must include the authenticated account");
    const login = await pending.client.login(accountUsername, syntheticPassword());
    expect(login.session.pendingGuestClaim).toBe(true);
    expect(login.transfer.status).toBe("pending_conflicts");

    const session = await pending.client.refreshSession();
    const conflict = await pending.client.mutate("post", "/session/claim", {
      renames: [{ resourceType: "player", guestResourceId: guestPlayer.id, newName: existing.name }],
    }, { ifMatch: pending.client.sessionEtag });
    expect(conflict.status).toBe(409);

    const claimed = await pending.client.mutate("post", "/session/claim", {
      renames: [{ resourceType: "player", guestResourceId: guestPlayer.id, newName: "Åsa Guest History" }],
    }, { ifMatch: pending.client.sessionEtag });
    expect(claimed.status).toBe(200);
    expect(claimed.body.status).toBe("transferred");
    expect((await pending.client.get(`/players/${guestPlayer.id}`)).status).toBe(200);
    expect((await owner.client.get(`/players/${guestPlayer.id}`)).status).toBe(200);
    expect(session.pendingGuestClaim).toBe(true);
  });

  test("independent guest tournaments can be active concurrently without process-global state", async () => {
    const first = await guestFixture();
    const second = await guestFixture();
    const [firstPlayers, secondPlayers] = await Promise.all([
      first.client.createPlayers(["First guest A", "First guest B"]),
      second.client.createPlayers(["Second guest A", "Second guest B"]),
    ]);
    const [firstTournament, secondTournament] = await Promise.all([
      first.client.createTournament(firstPlayers.map((player) => player.id)),
      second.client.createTournament(secondPlayers.map((player) => player.id)),
    ]);

    const [firstStart, secondStart] = await Promise.all([
      first.client.mutate("post", `/tournaments/${firstTournament.id}/start`, undefined, {
        ifMatch: firstTournament.__etag,
      }),
      second.client.mutate("post", `/tournaments/${secondTournament.id}/start`, undefined, {
        ifMatch: secondTournament.__etag,
      }),
    ]);
    expect(firstStart.status).toBe(200);
    expect(secondStart.status).toBe(200);

    const [firstRead, secondRead] = await Promise.all([
      first.client.get(`/tournaments/${firstTournament.id}`),
      second.client.get(`/tournaments/${secondTournament.id}`),
    ]);
    expect(firstRead.body.status).toBe("active");
    expect(secondRead.body.status).toBe("active");
    expect(firstRead.body.participants.map((player: { id: string }) => player.id).sort()).toEqual(
      firstPlayers.map((player) => player.id).sort(),
    );
    expect(secondRead.body.participants.map((player: { id: string }) => player.id).sort()).toEqual(
      secondPlayers.map((player) => player.id).sort(),
    );
  });
});
