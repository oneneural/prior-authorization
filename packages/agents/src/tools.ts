import { z } from 'zod';

import { DocumentVersion, Identifier, type AgentProposalResult, type AgentProposalSubmission, type RevisionBinding } from '@pa/contracts';

/** A port result with the number of transient retries it consumed. */
export interface PortResult<T> { data: T; retries: number }

/**
 * Case-scoped business operations, implemented by the worker over the API's
 * internal routes. The API derives case scope from the persisted run; nothing
 * here carries a case ID, path, URL or approver.
 */
export interface ToolPort {
  listDocuments(): Promise<PortResult<unknown>>;
  readDocument(documentId: string, version: number): Promise<PortResult<unknown>>;
  getPolicyPack(): Promise<PortResult<unknown>>;
  propose(submission: AgentProposalSubmission): Promise<PortResult<AgentProposalResult>>;
  currentInputs(): Promise<PortResult<{ revision: number; binding: RevisionBinding | null }>>;
}

/** A failed port call; `retries` counts transient retries already spent. */
export class ToolPortError extends Error {
  constructor(readonly permanent: boolean, readonly retries: number, readonly status?: number) { super(permanent ? 'permanent_tool_failure' : 'tool_retries_exhausted'); }
}

const Empty = z.strictObject({});
/** Allowlist: only business read and proposal tools. No shell, URL, approval, source edit or oracle access exists. */
export const TOOL_INPUTS = {
  list_documents: Empty,
  read_document: z.strictObject({ documentId: Identifier, version: DocumentVersion }),
  get_policy_pack: Empty,
  // Candidates stay untrusted here; the API validates and records each one.
  propose_facts: z.strictObject({ candidates: z.array(z.unknown()).min(1).max(10) }),
  propose_document_request: z.strictObject({ candidate: z.unknown() }),
} as const;
export type ToolName = keyof typeof TOOL_INPUTS;
export const TOOL_NAMES = Object.keys(TOOL_INPUTS) as ToolName[];
const isToolName = (name: string): name is ToolName => Object.hasOwn(TOOL_INPUTS, name);

export type ToolOutcome = 'ok' | 'unsupported_tool' | 'invalid_input' | 'tool_error' | 'output_limit';
export interface ToolExecution {
  outcome: ToolOutcome;
  /** Bounded result handed back to the provider; withheld when the outcome is not `ok`. */
  observation: unknown;
  retries: number;
  proposals: AgentProposalResult[];
}

/**
 * Runs one provider-chosen action. Unknown names and invalid inputs are refused
 * before any port call, so an instruction inside a document cannot widen tools.
 */
export async function executeTool(tool: string, input: unknown, ctx: { port: ToolPort; proposalKey: string; maxOutputBytes: number }): Promise<ToolExecution> {
  if (!isToolName(tool)) return { outcome: 'unsupported_tool', observation: null, retries: 0, proposals: [] };
  const parsed = TOOL_INPUTS[tool].safeParse(input);
  if (!parsed.success) return { outcome: 'invalid_input', observation: null, retries: 0, proposals: [] };
  let retries = 0;
  const proposals: AgentProposalResult[] = [];
  const track = <T>(result: PortResult<T>) => { retries += result.retries; return result.data; };
  try {
    let observation: unknown;
    switch (tool) {
      case 'list_documents': observation = track(await ctx.port.listDocuments()); break;
      case 'get_policy_pack': observation = track(await ctx.port.getPolicyPack()); break;
      case 'read_document': {
        const { documentId, version } = TOOL_INPUTS.read_document.parse(parsed.data);
        observation = track(await ctx.port.readDocument(documentId, version));
        break;
      }
      case 'propose_facts': {
        const { candidates } = TOOL_INPUTS.propose_facts.parse(parsed.data);
        for (const [index, candidate] of candidates.entries()) {
          proposals.push(track(await ctx.port.propose({ proposalKey: `${ctx.proposalKey}:${index}`, kind: 'fact', candidate })));
        }
        observation = { proposals };
        break;
      }
      case 'propose_document_request': {
        const { candidate } = TOOL_INPUTS.propose_document_request.parse(parsed.data);
        proposals.push(track(await ctx.port.propose({ proposalKey: `${ctx.proposalKey}:0`, kind: 'request', candidate })));
        observation = { proposals };
        break;
      }
    }
    if (Buffer.byteLength(JSON.stringify(observation ?? null)) > ctx.maxOutputBytes) return { outcome: 'output_limit', observation: null, retries, proposals };
    return { outcome: 'ok', observation, retries, proposals };
  } catch (error) {
    if (error instanceof ToolPortError) return { outcome: 'tool_error', observation: { error: error.message }, retries: retries + error.retries, proposals };
    throw error;
  }
}
