import { describe, expect, it } from 'vitest';
import { LINES } from './lines.fixture.js';
import { toRow } from './rows.js';

describe('a line to a row', () => {
  it.each([
    ['http', { method: 'GET', route: '/api/v1/machines', status: 401, ms: 1, ok: true }],
    ['mcp', { method: '', route: 'probe__echo', status: 0, ms: 9, ok: true }],
    ['job', { method: '', route: '', status: 0, ms: 310, ok: false }],
    ['span', { method: '', route: '', status: 0, ms: 3, ok: true }],
    ['error', { method: '', route: '', status: 0, ms: 0, ok: false }],
    ['event', { method: '', route: '', status: 0, ms: 0, ok: true }],
    ['log', { method: '', route: '', status: 0, ms: 0, ok: true }],
  ] as const)('%s: keeps the line and promotes the hot columns', (kind, hot) => {
    const line = LINES[kind];
    expect(toRow(line)).toEqual({ ...line, ...hot });
  });

  it('http: a 5xx is not ok', () => {
    const line = { ...LINES.http, fields: { 'http.response.status_code': 502 } };
    expect(toRow(line)).toMatchObject({ status: 502, ok: false });
  });

  it('a raw line: a log row, no agcid, error when the text says ERROR or FATAL', () => {
    const line = { ...LINES.http, msg: 'FATAL: the database system is shutting down' };
    const row = toRow({ ...line, fields: { 'agentage.raw': true } });
    expect(row).toMatchObject({ kind: 'log', agcid: null, level: 'error', method: '' });
    const quiet = toRow({
      ...line,
      msg: 'LOG: checkpoint complete',
      fields: { 'agentage.raw': true },
    });
    expect(quiet).toMatchObject({ level: 'info' });
  });

  it('fills what a line may leave out, and stores an unknown client as empty', () => {
    const { ts, level, kind, msg, extension, part } = LINES.log;
    expect(toRow({ ts, level, kind, msg, extension, part })).toMatchObject({
      version: '',
      host: '',
      agcid: null,
      sub: null,
      user_type: 'service',
      client: '',
      fields: {},
    });
    expect(toRow({ ts, kind, msg, extension, part }), 'no level').toBeNull();
  });

  it.each([
    ['no ts', { ...LINES.log, ts: undefined }],
    ['an unknown kind', { ...LINES.log, kind: 'trace' }],
    ['an agcid that is not 32 hex', { ...LINES.log, agcid: 'abc' }],
    [
      'a ts older than 30 days',
      { ...LINES.log, ts: new Date(Date.now() - 31 * 86_400_000).toISOString() },
    ],
    [
      'a ts over an hour ahead',
      { ...LINES.log, ts: new Date(Date.now() + 2 * 3_600_000).toISOString() },
    ],
    ['a year outside the store range', { ...LINES.log, ts: '9999-01-01T00:00:00Z' }],
    ['a sub that is an email', { ...LINES.log, sub: 'someone@example.com' }],
    ['a sub without usr_ or svc_', { ...LINES.log, sub: 'tok_1' }],
    ['not an object', 'a line'],
  ])('refuses %s', (_name, line) => {
    expect(toRow(line)).toBeNull();
  });

  it('cuts msg at 200 characters', () => {
    expect(toRow({ ...LINES.log, msg: 'x'.repeat(300) })?.msg).toHaveLength(200);
  });
});

describe('redaction (the package rules on every stored line)', () => {
  const stored = (fields: object, msg = LINES.log.msg) => toRow({ ...LINES.log, msg, fields });

  it('hides secret keys, cuts strings at 200, caps depth at 3', () => {
    const fields = {
      'agentage.api_key': 'k',
      Authorization: 'Bearer x',
      'session.token': 't',
      note: 'y'.repeat(250),
      a: { b: { c: { d: 1 } } },
      list: ['z'.repeat(201)],
    };
    expect(stored(fields)?.fields).toEqual({
      'agentage.api_key': '[redacted]',
      Authorization: '[redacted]',
      'session.token': '[redacted]',
      note: 'y'.repeat(200),
      a: { b: { c: '[depth]' } },
      list: ['z'.repeat(200)],
    });
  });

  it('masks a credential in a value and in msg, under any key', () => {
    const bearer = `Bearer ${'Ab1'.repeat(8)}`;
    const row = stored({ 'http.request.header.x': `sent ${bearer}` }, `GET / with ${bearer}`);
    expect(row?.fields).toEqual({ 'http.request.header.x': 'sent [redacted]' });
    expect(row?.msg).toBe('GET / with [redacted]');
  });

  it('cuts on a code point: never half a surrogate pair', () => {
    const msg = `${'x'.repeat(199)}\u{1F600}`;
    expect(toRow({ ...LINES.log, msg })?.msg).toBe('x'.repeat(199));
  });
});
