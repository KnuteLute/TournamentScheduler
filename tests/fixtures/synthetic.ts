import { ApiClient, JsonRecord } from "../helpers/api-client";

export interface GuestFixture {
  client: ApiClient;
  session: JsonRecord;
}

export async function guestFixture(): Promise<GuestFixture> {
  const client = ApiClient.create();
  const session = await client.bootstrapGuest();
  return { client, session };
}

export async function playerFixture(
  client: ApiClient,
  names: string[] = ["Synthetic Ada", "Synthetic Bjørn"],
): Promise<JsonRecord[]> {
  return client.createPlayers(names);
}

export async function activeOneOnOneFixture(
  client: ApiClient,
): Promise<{ tournament: JsonRecord; etag: string; matchId: string; playerIds: string[] }> {
  const players = await playerFixture(client);
  const tournament = await client.createTournament(players.map((player) => player.id));
  const started = await client.mutate("post", `/tournaments/${tournament.id}/start`, undefined, {
    ifMatch: tournament.__etag,
  });
  expect(started.status).toBe(200);

  const schedule = await client.get(`/tournaments/${tournament.id}/schedule`);
  expect(schedule.status).toBe(200);
  const matchId = schedule.body.rounds.flatMap((round: JsonRecord) => round.matchIds)[0];
  expect(matchId).toBeTruthy();
  const matches = await client.get(`/tournaments/${tournament.id}/matches`);
  expect(matches.status).toBe(200);
  expect(matches.body.items.map((match: JsonRecord) => match.id)).toContain(matchId);
  const match = await client.get(`/tournaments/${tournament.id}/matches/${matchId}`);
  expect(match.status).toBe(200);
  expect(match.body.status).toBe("scheduled");
  return {
    tournament,
    etag: started.headers.etag,
    matchId,
    playerIds: players.map((player) => player.id),
  };
}
