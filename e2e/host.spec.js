import { test, expect } from '@playwright/test';

test('public landing page explains the product and loads real disconnected backend state', async ({ page, request }) => {
  const consoleErrors = []; const pageErrors = []; const requestFailures = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (req) => requestFailures.push(`${req.method()} ${req.url()} ${req.failure()?.errorText}`));
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle(/Pulse Choir/);
  await expect(page.getByRole('heading', { name: /One chat\./ })).toBeVisible();
  await expect(page.getByText('No viewer sign-up. No extension. Just chat.')).toBeVisible();
  await expect(page.getByText('!pulse 1', { exact: false }).first()).toBeVisible();
  await expect(page.locator('#dashboard')).toBeHidden();
  const me = await request.get('/api/me');
  expect(me.status()).toBe(200);
  expect(await me.json()).toEqual({ connected: false, owner: null, state: null, overlayReady: false });
  const health = await request.get('/healthz');
  expect(health.status()).toBe(200);
  expect(await health.json()).toMatchObject({ service: 'pulse-choir', configured: true });
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(requestFailures).toEqual([]);
});

test('unauthenticated dashboard route stays in public onboarding without seeded success', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: /One chat\./ })).toBeVisible();
  await expect(page.locator('#dashboard')).toBeHidden();
  await expect(page.locator('#channel-name')).toHaveText('Loading channel…');
  await expect(page.locator('#note-lane .empty-note')).toBeVisible();
  await expect(page.locator('#note-lane .note-chip')).toHaveCount(0);
});

test('private overlay route reports missing credential and never fabricates audio or chat', async ({ page }) => {
  await page.goto('/overlay');
  await expect(page.locator('#overlay-status')).toHaveText('disconnected');
  await expect(page.locator('#gate-message')).toHaveText('This private source link has no key.');
  await expect(page.locator('#overlay-audio-state')).toHaveText('Audio not enabled');
  await expect(page.locator('#enable-audio')).toBeHidden();
  await expect(page.locator('#overlay-count')).toHaveText('0 notes');
  await expect(page.locator('#visual-notes')).toBeEmpty();
});

test('responsive and keyboard states remain usable with reduced motion', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.getByRole('link', { name: /Connect your channel/ })).toBeVisible();
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width + 1);
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('A');
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
  const animationDuration = await page.locator('.pulse-core i').first().evaluate((element) => getComputedStyle(element).animationDuration);
  expect(['1e-05s', '0.00001s', '0s']).toContain(animationDuration);
});

test('Twitch login preparation is scoped to read-chat and handles denial without claiming a connection', async ({ request }) => {
  const start = await request.get('/auth/twitch', { maxRedirects: 0 });
  expect(start.status()).toBe(302);
  const authUrl = new URL(start.headers().location);
  expect(authUrl.origin).toBe('https://id.twitch.tv');
  expect(authUrl.searchParams.get('scope')).toBe('user:read:chat');
  const state = authUrl.searchParams.get('state');
  expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const cookies = start.headers()['set-cookie'];
  expect(cookies).toContain(`pc_oauth=${state}`);
  const missingBrowserState = await request.get(`/auth/twitch/callback?state=${state}&error=access_denied`, { maxRedirects: 0 });
  expect(missingBrowserState.status()).toBe(400);
  expect((await request.get('/api/me')).status()).toBe(200);
});

test('authenticated-only controls and overlay exchange fail closed on the real backend', async ({ request }) => {
  const unauthenticated = await request.post('/api/settings', { headers: { Origin: process.env.PLAYWRIGHT_EXPECTED_ORIGIN || 'https://untrusted.test' }, data: { tempo: 100 } });
  expect(unauthenticated.status()).toBe(403);
  const invalidKey = await request.post('/api/overlay/exchange', { headers: { Origin: process.env.PLAYWRIGHT_EXPECTED_ORIGIN || 'https://untrusted.test' }, data: { key: 'x'.repeat(43) } });
  expect(invalidKey.status()).toBe(403);
});
