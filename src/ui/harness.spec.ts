import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// The ui part in a browser through the local gateway (after up); the api answers are routed here.
const { version } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
) as { version: string };
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const at = new Date(Date.now() - 30_000).toISOString();
const A = '0193a1f0c3d18b5e9f3a6c4d0e8b7f03';
const event = (i: number, level: string) => ({
  ...{ id: `0193a1f0-c3d1-7b5e-9f3a-6c4d0e8b7f${String(i).padStart(2, '0')}`, ts: at, level },
  ...{ kind: 'http', msg: `GET /api/v1/machines ${i}`, extension: 'platform', part: 'api' },
  ...{ version: '', host: 'next-1', agcid: A, sub: null, session: null, userType: 'user' },
  ...{
    client: '',
    method: 'GET',
    route: '/api/v1/machines',
    status: 200,
    ms: 3,
    ok: true,
    fields: {},
  },
});
const host = (name: string, cpu: number) => ({
  ...{
    host: name,
    cpu,
    cpu1h: cpu,
    mem: 40,
    disk: 30,
    load1: 0.5,
    containers: 2,
    at,
    red: cpu > 80,
  },
});
const stat = (part: string, failed: number, p95: number) => ({
  ...{
    extension: 'probe',
    part,
    kind: 'http',
    method: 'GET',
    route: '/a',
    calls: 100,
    errors: failed,
  },
  ...{ failed, requests: 100, users: 1, availability: 1 - failed / 100, p50: 5, p95, p99: p95 },
});
const DATA: Record<string, unknown> = {
  events: [event(1, 'info'), event(2, 'error')],
  traces: { agcid: A, hops: 2, ms: 41, ok: true, events: [event(1, 'info'), event(3, 'info')] },
  hosts: [host('next-1', 20), host('next-2', 92)],
  containers: [{ name: 'logs_api', cpu: 12.5, mem: 104_857_600, limit: 536_870_912 }],
  stats: [stat('api', 0, 40), stat('mcp', 2, 30)],
};
const json = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});
const answer = (path: string) =>
  DATA[path.includes('/containers') ? 'containers' : (path.split('/')[3] ?? '')];

const open = async (
  page: Page,
  widget: string,
  mode: 'data' | 'empty' | 'error' | 'hang' = 'data'
) => {
  const seen: string[] = [];
  await page.route('**/api/v1/**', (route) => {
    const url = new URL(route.request().url());
    seen.push(url.pathname + url.search);
    if (mode === 'hang') return;
    if (mode === 'error')
      return route.fulfill(
        json({ success: false, error: { code: 'UNAVAILABLE', message: 'store down' } }, 503)
      );
    return route.fulfill(
      json({ success: true, data: mode === 'empty' ? [] : answer(url.pathname) })
    );
  });
  await page.goto(`/ui/${version}/harness.html?widget=${widget}&token=aga_test`);
  return { el: page.locator(`logs-${widget}`), seen };
};

for (const widget of ['events', 'hosts', 'services']) {
  test(`${widget}: loading, empty and error states`, async ({ page, context }) => {
    await expect((await open(page, widget, 'hang')).el).toContainText('Loading...');
    const empty = await open(await context.newPage(), widget, 'empty');
    await expect(empty.el).toContainText('No rows');
    const failed = await open(await context.newPage(), widget, 'error');
    await expect(failed.el.getByRole('alert')).toHaveText('Could not load: store down');
  });
  for (const colorScheme of ['light', 'dark'] as const)
    test(`${widget}: rows with the red rule, axe WCAG A/AA clean (${colorScheme})`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme });
      const { el } = await open(page, widget);
      await expect(el.locator('tr.red')).toHaveCount(1);
      const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
      expect(violations.map((violation) => violation.id)).toEqual([]);
    });
}

test('events: a level narrows the query, an agcid opens its trace list', async ({ page }) => {
  const { el, seen } = await open(page, 'events');
  await el.getByLabel('level').selectOption('error');
  await expect.poll(() => seen.at(-1)).toBe('/api/v1/events?level=error&limit=100');
  await el
    .getByRole('button', { name: A.slice(0, 12) })
    .first()
    .click();
  await expect(el).toContainText(`agcid ${A} 2 hops · 41 ms · ok`);
  await expect(el.locator('tbody tr')).toHaveCount(2);
  expect(seen.at(-1)).toBe(`/api/v1/traces/${A}`);
});

test('hosts: a host opens its containers; services: availability and p95', async ({
  page,
  context,
}) => {
  const hosts = await open(page, 'hosts');
  await hosts.el.getByRole('button', { name: 'next-2' }).click();
  await expect(hosts.el).toContainText('logs_api12.5%100 MB512 MB');
  const services = await open(await context.newPage(), 'services');
  await expect(services.el.locator('tr.red')).toContainText('probe/mcp1002.0%30 ms98.00%');
});
