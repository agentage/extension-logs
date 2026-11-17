import { type WorkerContext } from '@agentage/extension';
import { openStore } from '../lib/open-store.js';
import { retention } from './retention.js';

export function create({ schedule, log, store: kit }: WorkerContext) {
  schedule('retention', '17 3 * * *', retention(openStore({ log, store: kit }).store, log), {
    timeout: '60s',
  });
}
