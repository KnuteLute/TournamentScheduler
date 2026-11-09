import { expect, Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { syntheticPassword } from "./testing-env";

export function syntheticLabel(prefix: string): string {
  return `${prefix} ${randomUUID().slice(0, 8)}`;
}

export async function openGuestApp(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("app-shell")).toBeVisible();
  const language = await page.locator("html").getAttribute("lang");
  expect(language).toMatch(/^(no|nb)(-|$)/i);
  await expect(page.locator("body")).toContainText(/turnering|spillere|kamp/i);
}

export async function addPlayer(page: Page, name: string): Promise<void> {
  await page.getByTestId("player-name-input").fill(name);
  await page.getByTestId("add-player-button").click();
  await expect(page.getByTestId("player-row").filter({ hasText: name })).toBeVisible();
}

export async function createTournament(
  page: Page,
  name: string,
  playerCount = 4,
): Promise<void> {
  await page.getByTestId("new-tournament-button").click();
  await page.getByTestId("tournament-name-input").fill(name);
  await expect(page.getByTestId("mode-option").first()).toHaveAttribute("data-mode", "2v2_rotating");
  await page.getByTestId("mode-2v2_rotating").check();
  const choices = page.getByTestId("tournament-player-option");
  await expect(choices).toHaveCount(playerCount);
  for (let index = 0; index < playerCount; index += 1) {
    await choices.nth(index).check();
  }
  await page.getByTestId("create-tournament-button").click();
  await expect(page.getByTestId("tournament-detail")).toBeVisible();
}

export async function registerSyntheticAccount(page: Page): Promise<string> {
  const username = `qa_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await page.getByTestId("register-link").click();
  await page.getByTestId("username-input").fill(username);
  await page.getByTestId("password-input").fill(syntheticPassword());
  await page.getByTestId("register-submit").click();
  await expect(page.getByTestId("account-menu")).toContainText(username);
  return username;
}
