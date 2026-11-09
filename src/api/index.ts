import { z } from 'zod';
import { type ApiContext, type Store } from '@agentage/extension';

const countPings = async (store: Store) => {
  const { rows } = await store.query<{ n: number }>('select count(*)::int as n from pings');
  const [{ n }] = rows as [{ n: number }]; // count(*) answers one row
  return n;
};

// Mounted at /api/v1; openapi.json is generated from these routes.
export function create({ route, store, extension }: ApiContext) {
  const input = z.object({ msg: z.string().min(1).max(200) });
  const output = z.object({ msg: z.string(), caller: z.string() });
  route('get', '/echo', { summary: 'Echo msg', input, output }, (req) => ({
    msg: req.input.msg,
    caller: req.caller.sub,
  }));
  const pong = z.object({ msg: z.string(), pings: z.int().nullable() });
  route('get', '/ping', { summary: 'Answer pong', scope: 'public', output: pong }, async () => ({
    msg: 'pong',
    pings: extension.store ? await countPings(store) : null,
  }));
}
