import { createHash } from 'node:crypto';

import type Anthropic from '@anthropic-ai/sdk';

import { EVIDENCE_FIELD_SOURCES, EvidenceField, RecipientRole, RequestTemplate } from '@pa/contracts';

import { DEFAULT_LIMITS } from '../config.js';
import type { ToolName } from '../tools.js';

/**
 * Strict tool definitions for the live provider, one per allowlisted tool and
 * no others. They describe the candidate shapes the API gate checks; the graph
 * still validates every input against `TOOL_INPUTS`, and the gate rechecks
 * every candidate. Field locators come from the shared contract.
 */
const fieldMap = EvidenceField.options.map((field) => `${field} = ${EVIDENCE_FIELD_SOURCES[field].documentKind} ${EVIDENCE_FIELD_SOURCES[field].pointer}`).join('; ');

const object = (properties: Record<string, unknown>) => ({ type: 'object' as const, properties, required: Object.keys(properties), additionalProperties: false });

const factCandidate = object({
  field: { type: 'string', enum: EvidenceField.options },
  documentId: { type: 'string' },
  documentVersion: { type: 'integer' },
  locator: { type: 'string', description: 'The JSON Pointer the field map gives for this field.' },
  value: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }], description: 'The exact JSON value at the locator, with its JSON type.' },
  originalText: { type: 'string', description: 'For a string value, the same string; for a number or boolean, its JSON text.' },
  confidence: { type: 'number', description: 'From 0 to 1.' },
  sourceContentHash: { type: 'string', description: 'The contentHash returned by read_document for that exact document version.' },
});

const definitions: Record<ToolName, Pick<Anthropic.Tool, 'description' | 'input_schema'>> = {
  list_documents: {
    description: 'List the documents attached to the current case: documentId, version, kind, accessStatus, readable and contentHash. Takes no input.',
    input_schema: object({}),
  },
  read_document: {
    description: 'Read one readable document version of the current case. Returns documentId, version, kind, contentHash and the payload as JSON text. Unreadable, restricted or withheld versions return an error.',
    input_schema: object({ documentId: { type: 'string' }, version: { type: 'integer' } }),
  },
  get_policy_pack: {
    description: 'Return the deterministic rules outcome for the current case: the policy pack identity and each finding with findingId, ruleId, status and condition keys. Takes no input.',
    input_schema: object({}),
  },
  propose_facts: {
    description: `Propose 1 to 10 evidence facts for human review. Each fact quotes one exact value at its source locator in a document version you read. Field map (field = document kind, JSON Pointer): ${fieldMap}. Returns one gate result per candidate.`,
    input_schema: object({ candidates: { type: 'array', items: factCandidate } }),
  },
  propose_document_request: {
    description: 'Propose a neutral request for an existing finalized document, for a finding whose status is missing. The request text is fixed server text. Templates: existing_order to practitioner_records for an R03 finding; existing_encounter to practitioner_records for an R04 finding; existing_receipt to supplier_records for an R05 finding. Returns the gate result.',
    input_schema: object({
      candidate: object({ findingId: { type: 'string' }, templateId: { type: 'string', enum: RequestTemplate.options }, recipientRole: { type: 'string', enum: RecipientRole.options } }),
    }),
  },
};

export const LIVE_TOOLS: Anthropic.Tool[] = (Object.keys(definitions) as ToolName[]).sort().map((name) => ({ name, strict: true, ...definitions[name] }));

/** The fixed opening user turn; case content arrives only through tool results. */
export const LIVE_TASK = [
  'Investigate the current synthetic case with the tools and propose source-linked evidence for human review.',
  `You have at most ${DEFAULT_LIMITS.maxModelCalls} responses in total, including the final one, and each response may call one tool.`,
  'Finish by replying without a tool call.',
].join(' ');

/** Changes whenever the task text or a tool definition changes; part of the provider version. */
export const LIVE_TOOLS_VERSION = createHash('sha256').update(JSON.stringify({ task: LIVE_TASK, tools: LIVE_TOOLS })).digest('hex').slice(0, 16);
