// FormCoach AI — end-to-end suite. Drives the real app in a real browser:
// landing, sign-in/encrypted accounts, tabs, a full demo workout with live
// rep counting, the privacy counter, the AI report, and user isolation.
import { test, expect } from "@playwright/test";

async function dismissWelcome(page, how = "guest") {
  const modal = page.locator("#welcomeModal");
  await expect(modal).toBeVisible();
  if (how === "guest") await page.click("#authGuest");
}

test("landing page: hero, photos, features, launch CTA", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/FormCoach AI/);
  await expect(page.locator(".hero-shot img")).toBeVisible();
  await expect(page.locator(".sport-band img")).toBeVisible();
  await expect(page.locator("#features .how-card")).toHaveCount(8);
  await expect(page.locator(".statement-big")).toContainText("MEASURE");
  await page.click('a[href="app.html"] >> nth=0');
  await expect(page).toHaveURL(/app\.html/);
});

test("app: sign-in modal, guest entry, tab navigation", async ({ page }) => {
  await page.goto("/app.html");
  await dismissWelcome(page);
  // 7 drills present
  await expect(page.locator(".ex-card")).toHaveCount(7);
  // tabs: progress shows, train hides
  await page.click('a[data-tab="progress"]');
  await expect(page.locator("#progress")).toBeVisible();
  await expect(page.locator("#train")).toBeHidden();
  await page.click('a[data-tab="coach"]');
  await expect(page.locator("#coach")).toBeVisible();
  await page.click('a[data-tab="train"]');
  await expect(page.locator("#train")).toBeVisible();
});

test("accounts: register, sign out, wrong password rejected, re-sign-in", async ({ page }) => {
  await page.goto("/app.html");
  await expect(page.locator("#welcomeModal")).toBeVisible();
  await page.fill("#authEmail", "e2e@test.com");
  await page.fill("#authPass", "secret123");
  await page.click("#authRegister");
  await expect(page.locator("#profileChip")).toContainText("e2e@test.com");
  // sign out
  await page.click("#profileChip");
  await page.click("#authSignOut");
  // wrong password
  await page.click("#profileChip");
  await page.fill("#authEmail", "e2e@test.com");
  await page.fill("#authPass", "wrongpass");
  await page.click("#authSignIn");
  await expect(page.locator("#authError")).toContainText(/wrong password/i);
  // correct password
  await page.fill("#authPass", "secret123");
  await page.click("#authSignIn");
  await expect(page.locator("#profileChip")).toContainText("e2e@test.com");
});

test("demo workout: reps count live, privacy counter runs, summary + report render", async ({ page }) => {
  await page.goto("/app.html");
  await dismissWelcome(page);
  await page.click("#btnDemo");
  await expect(page.locator("#btnSession")).toBeEnabled();
  await page.click("#btnSession");
  // the synthetic athlete squats every ~2.6s — expect >= 3 reps
  await expect(page.locator("#repCount")).not.toHaveText(/^[0-2]$/, { timeout: 20_000 });
  // form score computed
  await expect(page.locator("#scoreVal")).not.toHaveText("–");
  // privacy proof counter is counting frames
  await expect(page.locator("#framesCount")).not.toHaveText("0");
  // finish -> summary cards + rep strip
  await page.click("#btnSession");
  await expect(page.locator("#summary")).toBeVisible();
  await expect(page.locator("#summaryCards .sum-card").first()).toBeVisible();
  await expect(page.locator("#repStrip .rep-bar").first()).toBeVisible();
  // AI report section responds (agents, or an honest offline notice)
  await expect(page.locator("#report")).toBeVisible();
  await expect(page.locator("#reportBody")).not.toBeEmpty();
  await expect(page.locator("#reportBody")).not.toContainText("analyzing your session in parallel", { timeout: 60_000 });
  // progress tab now has data
  await page.click('a[data-tab="progress"]');
  await expect(page.locator("#streakTiles .sum-card").first()).toBeVisible();
  await expect(page.locator("#chart svg")).toBeVisible();
});

test("isolation: a second account cannot see the first account's history", async ({ page }) => {
  await page.goto("/app.html");
  // user A registers and records a session marker via a quick demo rep set
  await page.fill("#authEmail", "alice@e2e.com");
  await page.fill("#authPass", "alicepass");
  await page.click("#authRegister");
  await page.click("#btnDemo");
  await page.click("#btnSession");
  await expect(page.locator("#repCount")).not.toHaveText(/^[0-2]$/, { timeout: 20_000 });
  await page.click("#btnSession"); // finish -> saved to alice's encrypted vault
  await page.click('a[data-tab="progress"]');
  await expect(page.locator("#chart svg")).toBeVisible();
  // switch to user B
  await page.click("#profileChip");
  await page.click("#authSignOut");
  await page.click("#profileChip");
  await page.fill("#authEmail", "bob@e2e.com");
  await page.fill("#authPass", "bobpass99");
  await page.click("#authRegister");
  await page.click('a[data-tab="progress"]');
  await expect(page.locator("#chartEmpty")).toBeVisible(); // bob sees nothing of alice's
});

test("backend: health, coach-key gate, dashboard page", async ({ request }) => {
  const health = await request.get("http://localhost:8001/api/health");
  expect(health.ok()).toBeTruthy();
  expect((await health.json()).ok).toBe(true);
  const denied = await request.get("http://localhost:8001/api/reports");
  expect(denied.status()).toBe(403);
  const allowed = await request.get("http://localhost:8001/api/reports?key=coach-demo");
  expect(allowed.ok()).toBeTruthy();
  const dash = await request.get("http://localhost:8001/dashboard");
  expect(await dash.text()).toContain("Coach Dashboard");
});
