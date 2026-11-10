import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';

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
  ...{ host: name, cpu, cpu_avg: cpu, cpu_max: cpu, mem: 40, disk: 30, load1: 0.5 },
  ...{ containers: 2, at },
});
// The trace rows: two request hops, 38 ms apart, 3 ms each: 41 ms first start to last end.
const later = new Date(Date.parse(at) + 38).toISOString();
const ROUTE = '/api/v1/machines/{machineId}/extensions/{extensionId}/settings';
const stat = (part: string, failed: number, p95: number, extension = 'probe', route = '/a') => ({
  ...{ extension, part, route, calls: 100, failed, requests: 100 },
  ...{ availability: 1 - failed / 100, p50: 5, p95, p99: p95, users: 1 },
});
const DATA: Record<string, unknown> = {
  events: [event(1, 'info'), event(2, 'error')],
  trace: [event(1, 'info'), { ...event(3, 'info'), ts: later }],
  host: [host('next-logs', 20), host('next-2', 92)],
  container: [{ name: 'logs_api', cpu: 12.5, mem: 104_857_600, limit: 536_870_912 }],
  http: [stat('api', 0, 40), stat('mcp', 2, 30), stat('api', 0, 20, 'platform', ROUTE)],
  mcp: [],
};
const json = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});
// /stats answers by its kind, /events with an agcid is the trace.
const answer = ({ pathname, searchParams: q }: URL) =>
  DATA[pathname.endsWith('/stats') ? (q.get('kind') ?? '') : q.has('agcid') ? 'trace' : 'events'];

// The first answer is held until the test releases it, after the newer one has landed: no timer.
let release: () => void = () => undefined;
const slowly = async (route: Route) => {
  await new Promise<void>((resolve) => (release = resolve));
  await route.fulfill(json({ success: true, data: [1, 2, 3].map((i) => event(i, 'info')) }));
};
// Two frames after an answer: the widget has read it and rendered.
const settle = (page: Page) =>
  page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  );

type Mode = 'data' | 'empty' | 'error' | 'forbidden' | 'unauthorized' | 'offline' | 'hang';
const NOTE = 'truncated: more than 1000 groups; narrow by extension';

// The services widget calls logs__aggregate over /mcp: the same groups as a JSON-RPC result.
const rpc = (route: Route, mode: Mode | 'truncated') => {
  const { id, params } = route.request().postDataJSON() as {
    id: number;
    params: { arguments: { kind: string } };
  };
  const groups = mode === 'empty' ? [] : DATA[params.arguments.kind];
  const result = {
    content: [],
    structuredContent: { groups, meta: { truncated: mode === 'truncated' } },
  };
  return route.fulfill(json({ jsonrpc: '2.0', id, result }));
};

const open = async (page: Page, widget: string, mode: Mode | 'truncated' = 'data', slow = '') => {
  const seen: string[] = [];
  await page.route(/\/(api\/v1\/.*|mcp)$/, (route) => {
    const url = new URL(route.request().url());
    seen.push(url.pathname + url.search);
    if (mode === 'hang') return;
    if (mode === 'offline') return route.abort('internetdisconnected');
    if (mode === 'unauthorized')
      return route.fulfill(
        json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Missing token' } }, 401)
      );
    if (url.pathname + url.search === slow) return slowly(route);
    if (mode === 'forbidden')
      return route.fulfill(
        json({ success: false, error: { code: 'FORBIDDEN', message: 'Needs logs:admin' } }, 403)
      );
    if (mode === 'error')
      return route.fulfill(
        json({ success: false, error: { code: 'UNAVAILABLE', message: 'store down' } }, 503)
      );
    if (url.pathname.endsWith('/mcp')) return rpc(route, mode);
    return route.fulfill(json({ success: true, data: mode === 'empty' ? [] : answer(url) }));
  });
  await page.goto(`/ui/${version}/harness.html?widget=${widget}&token=aga_test`);
  return { el: page.locator(`logs-${widget}`), seen };
};

const axe = async (page: Page) => {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(violations.map((violation) => violation.id)).toEqual([]);
};
for (const widget of ['events', 'hosts', 'services']) {
  test(`${widget}: loading, empty and error states`, async ({ page, context }) => {
    await expect((await open(page, widget, 'hang')).el).toContainText('Loading...');
    const empty = await open(await context.newPage(), widget, 'empty');
    await expect(empty.el).toContainText('No rows');
    const failed = await open(await context.newPage(), widget, 'error');
    await expect(failed.el.getByRole('alert')).toHaveText('Could not load: store down');
    await axe(failed.el.page());
  });
  test(`${widget}: a token without logs:admin is named in the alert`, async ({ page }) => {
    const { el } = await open(page, widget, 'forbidden');
    await expect(el.getByRole('alert')).toHaveText('Could not load: Needs logs:admin');
  });
  test(`${widget}: a 401 and a network error each have their own alert`, async ({
    page,
    context,
  }) => {
    const { el } = await open(page, widget, 'unauthorized');
    await expect(el.getByRole('alert')).toHaveText('Could not load: Missing token');
    const offline = await open(await context.newPage(), widget, 'offline');
    await expect(offline.el.getByRole('alert')).toHaveText('Could not load: the network failed');
  });
  for (const colorScheme of ['light', 'dark'] as const)
    test(`${widget}: rows with the red rule, axe WCAG A/AA clean (${colorScheme})`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme });
      const { el } = await open(page, widget);
      await expect(el.locator('tr.red')).toHaveCount(1);
      await axe(page);
    });
}

test('events: filters narrow the query, an agcid opens its trace list', async ({ page }) => {
  const { el, seen } = await open(page, 'events');
  await el.getByLabel('level').selectOption('error');
  await expect.poll(() => seen.at(-1)).toBe('/api/v1/events?level=error&limit=100');
  await el.getByLabel('extension').selectOption('probe');
  await expect.poll(() => seen.at(-1)).toBe('/api/v1/events?level=error&extension=probe&limit=100');
  await el
    .getByRole('button', { name: `trace ${A}` })
    .first()
    .click();
  await expect(el.getByRole('heading')).toBeFocused();
  await expect(el.getByRole('heading')).toHaveText(`agcid ${A} 2 hops · 41 ms · ok`);
  await expect(el.locator('tbody tr')).toHaveCount(2);
  expect(seen.at(-1)).toBe(`/api/v1/events?agcid=${A}&order=asc&since=30d&limit=1000`);
  await axe(page);
});

test('events: clearing the search applies at once', async ({ page }) => {
  const { el, seen } = await open(page, 'events');
  await el.getByLabel('search').fill('machines');
  await el.getByLabel('search').press('Enter');
  await expect.poll(() => seen.at(-1)).toBe('/api/v1/events?q=machines&limit=100');
  await el.getByLabel('search').fill('');
  await expect.poll(() => seen.at(-1)).toBe('/api/v1/events?limit=100');
});

test('events: a slow answer for an older filter never replaces the newer one', async ({ page }) => {
  const { el } = await open(page, 'events', 'data', '/api/v1/events?limit=100');
  await el.getByLabel('level').selectOption('error');
  await expect(el.locator('tbody tr')).toHaveCount(2);
  const late = page.waitForResponse((res) => res.url().endsWith('/api/v1/events?limit=100'));
  release();
  await late;
  await settle(page);
  await expect(el.locator('tbody tr')).toHaveCount(2);
});

test('hosts: a host opens its containers, axe clean there', async ({ page }) => {
  const { el, seen } = await open(page, 'hosts');
  await expect(el.locator('tr.red')).toContainText('cpu > 80');
  await el.getByRole('button', { name: 'containers of next-2' }).click();
  await expect(el.getByRole('heading')).toBeFocused();
  await expect(el).toContainText('logs_api12.5%100 MB512 MB');
  expect(seen.at(-1)).toBe('/api/v1/stats?kind=container&host=next-2&by=name&since=5m&limit=1000');
  await axe(page);
});

test('services: a cut /stats says so in the caption', async ({ page, context }) => {
  const { el } = await open(page, 'services', 'truncated');
  await expect(el.locator('caption')).toHaveText(`services, 24 h, ${NOTE}`);
  const full = await open(await context.newPage(), 'services');
  await expect(full.el.locator('caption')).toHaveText('services, 24 h');
});

test('services: the reason, availability and the worst route p95', async ({ page }) => {
  const { el } = await open(page, 'services');
  await expect(el.locator('tr.red')).toContainText('avail < 99.0 %probe/mcp1002.0%30 ms98.00%');
  await expect(el.getByRole('columnheader', { name: 'p95 worst route' })).toBeVisible();
});

// A fixed table gives its rest column only what the set widths leave; real names must still fit.
const NAMES = [
  ['events', 4, 'platform/api'],
  ['hosts', 2, 'next-logs'],
  ['services', 2, 'platform/api'],
] as const;
const clipped = (cells: Element[]) =>
  cells
    .map((td) => td.querySelector('button') ?? td)
    .filter((c) => c.scrollWidth > c.clientWidth || c.getBoundingClientRect().right > innerWidth)
    .map((c) => c.textContent);
for (const width of [400, 1280])
  for (const [widget, col, name] of NAMES)
    test(`${widget}: the name column reads in full at ${width} px, no page scroll`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const { el } = await open(page, widget);
      await expect(el.locator(`td:nth-child(${col})`, { hasText: name })).not.toHaveCount(0);
      expect(
        await el.locator(`th:nth-child(${col}), td:nth-child(${col})`).evaluateAll(clipped)
      ).toEqual([]);
      const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scroll).toBeLessThanOrEqual(width);
    });
