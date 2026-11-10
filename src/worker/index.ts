import { type WorkerContext } from '@agentage/extension';
import { openStore } from '../lib/open-store.js';
import { retention } from './retention.js';

export function create({ schedule, log }: WorkerContext) {
  schedule('retention', '17 3 * * *', retention(openStore(log).store, log), { timeout: '60s' });
}
