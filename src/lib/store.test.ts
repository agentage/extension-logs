import { createServer, type Server } from 'node:net';
import { createTestContext } from '@agentage/extension';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { DEDUP_SETTING, EVENTS_DDL, EVENTS_DEDUP, SHOW_EVENTS } from './ddl.js';
import { readConnection } from './connection.js';
import {
  clickhouse,
  clickhouseCheck,
  createEventsStore,
  diskCheck,
  isOutage,
  lazy,
  type Clickhouse,
} from './store.js';

const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

const fake = (command = vi.fn(async () => undefined)) => {
  const ch: Clickhouse = {
    command,
    insert: vi.fn(async () => undefined),
    query: vi.fn(async () => []),
    ping: vi.fn(async () => true),
  };
  return { ch, store: createEventsStore(ch, createTestContext().log) };
};

describe('the events store', () => {
  it('runs the DDL once, before the first use', async () => {
    const { ch, store } = fake();
    await Promise.all([store.ready(), store.insert([{ a: 1 }]), store.query('SELECT 1')]);
    expect(vi.mocked(ch.command).mock.calls).toEqual([[EVENTS_DDL], [EVENTS_DEDUP]]);
    expect(ch.query).toHaveBeenCalledWith(SHOW_EVENTS);
    expect(ch.insert).toHaveBeenCalledWith(
      'events',
      [{ a: 1 }],
      expect.stringMatching(/^[0-f]{64}$/)
    );
  });

  it('skips the ALTER when the table already has the setting', async () => {
    const { ch, store } = fake();
    const statement = `CREATE TABLE logs.events (...) SETTINGS index_granularity = 8192, ${DEDUP_SETTING}`;
    vi.mocked(ch.query).mockResolvedValueOnce([{ statement }]);
    await store.ready();
    expect(vi.mocked(ch.command).mock.calls).toEqual([[EVENTS_DDL]]);
  });

  it('gives the same batch the same token and another batch another', async () => {
    const { ch, store } = fake();
    await store.insert([{ a: 1 }]);
    await store.insert([{ a: 1 }]);
    await store.insert([{ a: 2 }]);
    const tokens = vi.mocked(ch.insert).mock.calls.map((call) => call[2]);
    expect(tokens[0]).toBe(tokens[1]);
    expect(tokens[2]).not.toBe(tokens[0]);
  });

  it.each(['159', '202', '241', '173', '252', '396'])(
    'answers a store limit (code %s) as UNAVAILABLE busy, never a 500',
    async (code) => {
      const { ch, store } = fake();
      vi.mocked(ch.query).mockRejectedValueOnce(Object.assign(new Error('limit'), { code }));
      await expect(store.query('SELECT 1')).rejects.toMatchObject({
        code: 'UNAVAILABLE',
        message: 'The store is busy: narrow the query or retry',
      });
    }
  );

  it.each(['243', '242', '204', '294', '75'])(
    'answers a store that cannot write (code %s) as UNAVAILABLE, never a 500; a read never says write',
    async (code) => {
      const { ch, store } = fake();
      const err = Object.assign(new Error(`Code: ${code}`), { code });
      vi.mocked(ch.insert).mockRejectedValueOnce(err);
      vi.mocked(ch.query).mockResolvedValueOnce([]).mockRejectedValueOnce(err);
      await expect(store.insert([{ a: 1 }])).rejects.toMatchObject({
        code: 'UNAVAILABLE',
        message: 'The store cannot write now: retry later',
      });
      await expect(store.query('SELECT 1')).rejects.toMatchObject({
        code: 'UNAVAILABLE',
        message: 'The store is unavailable',
      });
    }
  );

  it('answers UNAVAILABLE while the store is down, and runs the DDL again when it is back', async () => {
    const command = vi.fn().mockRejectedValueOnce(refused).mockResolvedValue(undefined);
    const { ch, store } = fake(command);
    await expect(store.ready()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await store.insert([]);
    expect(ch.command).toHaveBeenCalledTimes(3);
  });

  it('passes a SQL error through as it is', async () => {
    const { ch, store } = fake();
    vi.mocked(ch.query).mockRejectedValueOnce(new Error('Syntax error'));
    await expect(store.query('SELEC')).rejects.toThrow('Syntax error');
  });

  it.each([
    [refused, true],
    [new Error('Timeout error.'), true],
    [Object.assign(new Error('Syntax error'), { code: '62' }), false],
    [null, false],
  ])('tells an outage from a fault (%#)', (err, outage) => {
    expect(isOutage(err)).toBe(outage);
  });
});

describe('checks.disk', () => {
  const GIB = 1024 ** 3;
  it.each([
    [[{ free: 2 * GIB }], 'ok'],
    [[{ free: 1.5 * GIB }], 'ok'],
    [[{ free: 1.5 * GIB - 1 }], 'degraded'],
    [[{ free: 0 }], 'degraded'],
    [[], 'degraded'],
  ])(
    'reads the free bytes of the table disks %j as %s, never unavailable',
    async (rows, status) => {
      const { ch } = fake();
      vi.mocked(ch.query).mockResolvedValueOnce(rows);
      expect(await diskCheck(ch, createTestContext().log)()).toBe(status);
      expect(ch.query).toHaveBeenCalledWith(
        expect.stringContaining('system.storage_policies'),
        {},
        expect.any(AbortSignal)
      );
    }
  );

  it('reads degraded with the reason logged when system.disks is refused', async () => {
    const ctx = createTestContext();
    const { ch } = fake();
    const denied = Object.assign(new Error('Not enough privileges'), { code: '497' });
    vi.mocked(ch.query).mockRejectedValueOnce(denied);
    expect(await diskCheck(ch, ctx.log)()).toBe('degraded');
    expect(ctx.logs).toContainEqual(
      expect.objectContaining({ level: 'warn', message: 'checks.disk cannot read system.disks' })
    );
  });
});

describe('the lazy client', () => {
  it('opens on first use, once', async () => {
    const { ch } = fake();
    const open = vi.fn(() => ch);
    const client = lazy(open, createTestContext().log);
    expect(open).not.toHaveBeenCalled();
    await client.query('SELECT 1');
    await client.ping();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('answers UNAVAILABLE and logs while the file is missing, and opens once it is there', async () => {
    const ctx = createTestContext();
    const { ch } = fake();
    const missing = (): string => {
      throw Object.assign(new Error('no file'), { code: 'ENOENT' });
    };
    let read: () => string = missing;
    const client = lazy(() => (readConnection(read), ch), ctx.log);
    await expect(client.ping()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(ctx.logs.map((l) => l.level)).toContain('error');
    read = () => 'http://a:b@c:8123/d';
    await expect(client.ping()).resolves.toBe(true);
  });

  it('answers UNAVAILABLE on a malformed store-url, never quoting it', async () => {
    const ctx = createTestContext();
    const client = lazy(() => clickhouse(readConnection(() => 'postgres://u:secret@h/d')), ctx.log);
    await expect(client.query('SELECT 1')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(client.insert('events', [], 't')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(JSON.stringify(ctx.logs)).not.toContain('secret');
  });
});

describe('the client against a store that never answers or is not there', () => {
  const hung: Server = createServer(() => undefined).listen(0);
  afterAll(() => void hung.close());
  const at = (port: number) => ({
    url: `http://127.0.0.1:${port}`,
    username: 'u',
    password: 'p',
    database: 'd',
  });
  const port = () => (hung.address() as { port: number }).port;

  it('gives up on a hung store at its timeout: query, insert and ping are UNAVAILABLE', async () => {
    const store = createEventsStore(clickhouse(at(port()), 300), createTestContext().log);
    const started = Date.now();
    await expect(store.query('SELECT 1')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(store.insert([{ a: 1 }])).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(Date.now() - started).toBeLessThan(2_000);
    await expect(clickhouseCheck(clickhouse(at(port()), 300))()).resolves.toBe('unavailable');
  });

  it('bounds both /health checks under the kit 1 s bound, whatever the client timeout', async () => {
    const ch = clickhouse(at(port()));
    const started = Date.now();
    const log = createTestContext().log;
    const checks = await Promise.all([clickhouseCheck(ch)(), diskCheck(ch, log)()]);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(checks).toEqual(['unavailable', 'degraded']);
  });

  it('answers UNAVAILABLE at once on a closed port', async () => {
    const closed = createServer().listen(0);
    const free = (closed.address() as { port: number }).port;
    closed.close();
    const store = createEventsStore(clickhouse(at(free), 300), createTestContext().log);
    await expect(store.query('SELECT 1')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
});
