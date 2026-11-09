import { expect, test } from "@playwright/test";
import {
  addPlayer,
  createTournament,
  openGuestApp,
  registerSyntheticAccount,
  syntheticLabel,
} from "../helpers/browser";

test("guest can run a Norwegian rotating tournament, pause/score/skip, and review standings/history", async ({ page }) => {
  await openGuestApp(page);
  const names = Array.from({ length: 5 }, (_, index) => syntheticLabel(`Syntetisk spiller ${index + 1}`));
  for (const name of names) await addPlayer(page, name);

  const tournamentName = syntheticLabel("Syntetisk turnering");
  await createTournament(page, tournamentName, names.length);
  await page.getByTestId("start-tournament-button").click();
  await expect(page.getByTestId("tournament-status")).toHaveAttribute("data-status", "active");

  await page.getByTestId("tournament-pause-button").click();
  await expect(page.getByTestId("tournament-status")).toHaveAttribute("data-status", "paused");
  await page.getByTestId("tournament-resume-button").click();
  await expect(page.getByTestId("tournament-status")).toHaveAttribute("data-status", "active");

  await page.getByTestId("match-start-button").click();
  await page.getByTestId("match-pause-button").click();
  await expect(page.getByTestId("match-status")).toHaveAttribute("data-status", "paused");
  await page.getByTestId("match-resume-button").click();
  await page.getByTestId("score-side-1-input").fill("11");
  await page.getByTestId("score-side-2-input").fill("8");
  await page.getByTestId("submit-score-button").click();
  await expect(page.getByTestId("match-status")).toHaveAttribute("data-status", "completed");

  await page.getByTestId("skip-next-match-button").click();
  await expect(page.getByTestId("latest-match-status")).toHaveAttribute("data-status", "skipped");
  await page.getByTestId("finish-tournament-button").click();
  await expect(page.getByTestId("tournament-status")).toHaveAttribute("data-status", "completed");

  await page.getByTestId("nav-standings").click();
  await page.getByTestId("standings-player-row").first().waitFor({ state: "visible" });
  await expect(page.getByTestId("standings-player-row")).toHaveCount(names.length);
  for (const name of names) {
    await expect(page.getByTestId("standings-player-row").filter({ hasText: name })).toBeVisible();
  }

  await page.getByTestId("nav-history").click();
  await expect(page.getByTestId("history-tournament-row").filter({ hasText: tournamentName })).toBeVisible();
});

test("guest data transfers to an account without losing player identity", async ({ page }) => {
  await openGuestApp(page);
  const playerName = syntheticLabel("Transfer player");
  await addPlayer(page, playerName);

  const username = await registerSyntheticAccount(page);
  await expect(page.getByTestId("player-row").filter({ hasText: playerName })).toBeVisible();
  await expect(page.getByTestId("account-menu")).toContainText(username);
  await expect(page.getByTestId("transfer-status")).toHaveText(/overført|ingen data/i);
});

test("two browser sessions do not share players, tournaments, or history", async ({ browser }) => {
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  try {
    const firstPage = await firstContext.newPage();
    const secondPage = await secondContext.newPage();
    await openGuestApp(firstPage);
    await openGuestApp(secondPage);

    const firstNames = Array.from({ length: 4 }, (_, index) => syntheticLabel(`Første gjest ${index + 1}`));
    const secondNames = Array.from({ length: 4 }, (_, index) => syntheticLabel(`Andre gjest ${index + 1}`));
    for (const name of firstNames) await addPlayer(firstPage, name);
    for (const name of secondNames) await addPlayer(secondPage, name);
    const tournamentName = syntheticLabel("Første gjests turnering");
    await createTournament(firstPage, tournamentName, firstNames.length);

    for (const name of secondNames) {
      await expect(firstPage.getByTestId("player-row").filter({ hasText: name })).toHaveCount(0);
    }
    for (const name of firstNames) {
      await expect(secondPage.getByTestId("player-row").filter({ hasText: name })).toHaveCount(0);
    }
    await expect(secondPage.getByTestId("tournament-row").filter({ hasText: tournamentName })).toHaveCount(0);
    await expect(firstPage.getByTestId("history-tournament-row")).toHaveCount(0);
    await expect(secondPage.getByTestId("history-tournament-row")).toHaveCount(0);
  } finally {
    await firstContext.close();
    await secondContext.close();
  }
});
