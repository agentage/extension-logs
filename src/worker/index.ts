import { type WorkerContext } from '@agentage/extension';

export function create({ schedule, log }: WorkerContext) {
  schedule('tick', '* * * * *', async () => log.info('tick'), { timeout: '30s' });
}
