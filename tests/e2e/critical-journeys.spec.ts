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
  await createTournament(page, tournamentName, names);
  await page.getByRole("button", { name: "Start turneringen" }).click();
  await expect(page.locator(".hero-status .status-pill")).toHaveText("Pågår");

  await page.getByRole("button", { name: /Pause turnering/ }).click();
  await expect(page.locator(".hero-status .status-pill")).toHaveText("Satt på pause");
  await page.getByRole("button", { name: "Fortsett turnering" }).click();
  await expect(page.locator(".hero-status .status-pill")).toHaveText("Pågår");

  await page.getByRole("button", { name: "Start kamp" }).first().click();
  const pauseResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && /\/matches\/[^/]+\/pause$/.test(url.pathname);
  });
  await page.getByRole("button", { name: /^Ⅱ Pause$/ }).click();
  expect((await pauseResponse).status()).toBe(200);
  await expect(page.locator(".match-card .status-pill").first()).toHaveText("Pause");
  await page.getByRole("button", { name: "Fortsett kamp" }).click();
  const scoreInputs = page.locator(".score-form input[type=number]");
  await scoreInputs.nth(0).fill("11");
  await scoreInputs.nth(1).fill("8");
  await page.getByRole("button", { name: "Lagre resultat" }).click();
  await expect(page.locator(".match-card .status-pill").filter({ hasText: "Ferdig" })).toHaveCount(1);

  const skipButton = page.getByRole("button", { name: "Hopp over", exact: true }).last();
  const scheduledMatchCard = page.locator(".match-card").filter({ has: skipButton });
  const skippedMatchSequence = await scheduledMatchCard.locator(".match-sequence").innerText();
  const skipResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && /\/matches\/[^/]+\/skip$/.test(url.pathname);
  });
  page.once("dialog", (dialog) => dialog.accept());
  await skipButton.click();
  expect((await skipResponse).status()).toBe(200);
  const skippedMatchCard = page.locator(".match-card").filter({ hasText: skippedMatchSequence });
  await expect(skippedMatchCard.locator(".status-pill.status-match")).toHaveText("Hoppet over");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Avslutt" }).click();
  await expect(page.locator(".hero-status .status-pill")).toHaveText("Ferdig");

  const standingsRows = page.locator(".standings-card tbody tr");
  await expect(standingsRows).toHaveCount(names.length);
  for (const name of names) await expect(standingsRows.filter({ hasText: name })).toBeVisible();

  await page.getByRole("link", { name: "Historikk", exact: true }).click();
  await expect(page.locator(".history-item").filter({ hasText: tournamentName })).toBeVisible();
});

test("guest data transfers to an account without losing the player", async ({ page }) => {
  await openGuestApp(page);
  const playerName = syntheticLabel("Transfer player");
  await addPlayer(page, playerName);

  const username = await registerSyntheticAccount(page);
  await page.getByRole("link", { name: "Spillere og lag" }).click();
  await expect(page.locator(".person-row").filter({ hasText: playerName })).toBeVisible();
  await expect(page.locator(".account-label")).toContainText(username);
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
    await createTournament(firstPage, tournamentName, firstNames);

    await firstPage.getByRole("link", { name: "Spillere og lag" }).click();
    await secondPage.getByRole("link", { name: "Spillere og lag" }).click();
    for (const name of secondNames) await expect(firstPage.locator(".person-row").filter({ hasText: name })).toHaveCount(0);
    for (const name of firstNames) await expect(secondPage.locator(".person-row").filter({ hasText: name })).toHaveCount(0);

    await secondPage.getByRole("link", { name: "Oversikt" }).click();
    await expect(secondPage.getByRole("link", { name: new RegExp(tournamentName) })).toHaveCount(0);
    await secondPage.getByRole("link", { name: "Historikk", exact: true }).click();
    await expect(secondPage.locator(".history-item").filter({ hasText: tournamentName })).toHaveCount(0);
  } finally {
    await firstContext.close();
    await secondContext.close();
  }
});
