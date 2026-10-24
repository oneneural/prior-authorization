import { z } from 'zod';

import type { ModelIdentity } from '@pa/contracts';

/**
 * One provider turn. The tool name is a free string so an unsupported or
 * prohibited choice is still parsed and then refused by the tool allowlist.
 */
export const ProviderTurn = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('call_tool'), tool: z.string().min(1).max(64), input: z.record(z.string(), z.unknown()) }),
  z.strictObject({ type: z.literal('finish') }),
]);
export type ProviderTurn = z.infer<typeof ProviderTurn>;

export interface Observation { tool: string; outcome: string; result: unknown }

export interface ProviderContext {
  /** Number of earlier provider turns in this investigation. */
  turn: number;
  observations: readonly Observation[];
  signal: AbortSignal;
}

/** Output is untrusted: the graph validates it against `ProviderTurn` and size limits. */
export interface AgentProvider {
  identity: ModelIdentity;
  /** Recorded in the run and checkpoint versions; a different value cannot resume a checkpoint. */
  version: string;
  next(context: ProviderContext): Promise<unknown>;
}
