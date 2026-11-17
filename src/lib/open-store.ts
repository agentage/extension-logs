import { type PartContext } from '@agentage/extension';
import { createEventsStore, openCh } from './store.js';

export const openStore = (ctx: Pick<PartContext, 'log' | 'store'>) => {
  const ch = openCh(ctx, ctx.log);
  return { ch, store: createEventsStore(ch, ctx.log) };
};
