import type { FastifyReply } from 'fastify';

import type { ErrorCode, ErrorResponse } from '@pa/contracts';

export function sendError(reply: FastifyReply, status: number, code: ErrorCode, message: string): FastifyReply {
  const body: ErrorResponse = { error: { code, message } };
  return reply.code(status).send(body);
}
