import { expect, Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { syntheticPassword } from "./testing-env";

export function syntheticLabel(prefix: string): string {
  return `${prefix} ${randomUUID().slice(0, 8)}`;
}

export async function openGuestApp(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Hovedmeny" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "nb");
  await expect(page.locator("body")).toContainText(/turnering|spillere|kamp/i);
}

export async function addPlayer(page: Page, name: string): Promise<void> {
  await page.getByRole("link", { name: "Spillere og lag" }).click();
  await page.getByLabel("Navn på ny spiller").fill(name);
  await page.getByRole("button", { name: "Legg til" }).click();
  await expect(page.locator(".person-row").filter({ hasText: name })).toBeVisible();
}

export async function createTournament(page: Page, name: string, playerNames: string[]): Promise<void> {
  await page.getByRole("link", { name: "Oversikt" }).click();
  await page.getByRole("link", { name: /Opprett turnering|Lag din første turnering/ }).first().click();
  await page.getByLabel("Turneringsnavn").fill(name);

  const rotatingMode = page.getByRole("radio", { name: /2 mot 2 · roterende lag/ });
  await expect(rotatingMode).toHaveAttribute("aria-checked", "true");
  for (const playerName of playerNames) {
    const option = page.locator(".select-player").filter({ hasText: playerName });
    const checkbox = option.locator('input[type="checkbox"]');
    await option.click();
    await expect(checkbox).toBeChecked();
  }

  await page.getByRole("button", { name: /Opprett kladd/ }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

export async function registerSyntheticAccount(page: Page): Promise<string> {
  const username = `qa_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await page.getByRole("link", { name: "Logg inn" }).click();
  await page.getByRole("button", { name: "Ny her? Opprett konto" }).click();
  await page.getByLabel("Brukernavn").fill(username);
  await page.getByLabel("Passord").fill(syntheticPassword());
  await page.getByRole("button", { name: "Opprett konto" }).click();
  await expect(page.locator(".account-label")).toContainText(username);
  return username;
}
