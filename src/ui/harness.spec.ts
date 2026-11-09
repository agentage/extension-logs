import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// The ui part in a browser through the local gateway (after up): the harness mounts {id}-echo.
const { version, agentage } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
) as { version: string; agentage: { id: string } };
const echo = `${agentage.id}-echo`;
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

for (const colorScheme of ['light', 'dark'] as const) {
  test(`the echo widget answers pong hi, axe WCAG A/AA clean (${colorScheme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme });
    await page.goto(`/ui/${version}/harness.html`);
    await page.getByRole('button', { name: 'ping' }).click();
    await expect(page.locator(echo)).toContainText('pong hi');
    const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(violations.map((violation) => violation.id)).toEqual([]);
  });
}

test('the echo widget shows the refusal when its token is refused', async ({ page }) => {
  await page.goto(`/ui/${version}/harness.html?token=aga_refused`);
  await page.getByRole('button', { name: 'ping' }).click();
  await expect(page.locator(echo)).toContainText('Invalid token');
});
