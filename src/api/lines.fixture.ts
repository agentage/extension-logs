// Lines as the kit and the shipper write them (logs-events section 2), one per kind.
const base = {
  ts: '2026-11-10T09:12:03.412Z',
  level: 'info',
  extension: 'probe',
  part: 'api',
  version: '0.6.0',
  host: 'next-1',
  agcid: '0193a1f0c3d18b5e9f3a6c4d0e8b7f03',
  sub: 'usr_7f3a',
  session: 'tok_01JC9V3K7Q',
  user_type: 'agent',
  client: 'claude-code',
};

export const LINES = {
  http: {
    ...base,
    kind: 'http',
    level: 'warn',
    msg: 'GET /api/v1/machines 401',
    fields: {
      'http.request.method': 'GET',
      'http.route': '/api/v1/machines',
      'http.response.status_code': 401,
      'agentage.duration_ms': 1,
      'agentage.auth.reason': 'missing_token',
    },
  },
  mcp: {
    ...base,
    kind: 'mcp',
    part: 'mcp',
    msg: 'probe__echo ok 9ms',
    fields: {
      'mcp.method.name': 'tools/call',
      'gen_ai.tool.name': 'probe__echo',
      'agentage.duration_ms': 9,
    },
  },
  job: {
    ...base,
    kind: 'job',
    part: 'worker',
    msg: 'tick ok',
    fields: {
      'agentage.job.name': 'tick',
      'agentage.job.run_id': '42',
      'agentage.duration_ms': 310,
      'error.type': 'Error',
    },
  },
  span: {
    ...base,
    kind: 'span',
    msg: 'store.query',
    fields: { 'agentage.span.name': 'store.query', 'agentage.duration_ms': 3 },
  },
  error: {
    ...base,
    kind: 'error',
    level: 'error',
    msg: 'Error: forced',
    fields: {
      'exception.type': 'Error',
      'exception.message': 'forced',
      'agentage.where': '/api/v1/emit',
    },
  },
  event: {
    ...base,
    kind: 'event',
    msg: 'probe.emitted',
    fields: { 'event.name': 'probe.emitted' },
  },
  log: { ...base, kind: 'log', msg: 'emit 1', fields: {} },
};
