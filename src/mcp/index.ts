import { type McpContext } from '@agentage/extension';
import { z } from 'zod';

// The kit serves this tool as {id}__echo on POST /mcp; scope read is {id}:read.
export function create(ctx: McpContext) {
  ctx.tool(
    'echo',
    {
      description: 'Echo a message back',
      scope: 'read',
      input: z.object({ msg: z.string().min(1).max(200) }),
      output: z.object({ msg: z.string() }),
    },
    async ({ msg }) => ({ msg: `pong ${msg}` })
  );
}
