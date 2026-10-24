import type { FindingV3, RequestProposal } from '@pa/contracts';

import { CaseError } from '../cases/service.js';

const templates = {
  existing_order: {
    role: 'practitioner_records', rule: 'R03', keys: ['R03.no_usable_order', 'R03.element_missing'],
    body: 'Please provide the existing finalized order from your records for this synthetic case, if available. Do not create, complete or amend an order in response to this request.',
  },
  existing_encounter: {
    role: 'practitioner_records', rule: 'R04', keys: ['R04.no_usable_encounter', 'R04.encounter_not_final'],
    body: 'Please provide the existing finalized encounter record for this synthetic case, if available. Do not create, complete or amend a medical note in response to this request.',
  },
  existing_receipt: {
    role: 'supplier_records', rule: 'R05', keys: ['R05.order_receipt_missing'],
    body: 'Please provide the existing supplier receipt record for the finalized order in this synthetic case, if available. This is a records request only.',
  },
} as const;

export function requestTemplate(proposal: RequestProposal, finding: FindingV3 | undefined) {
  const template = templates[proposal.templateId];
  if (finding?.findingId !== proposal.findingId || finding.ruleId !== template.rule || finding.status !== 'missing' || template.role !== proposal.recipientRole) {
    throw new CaseError(409, 'request template does not match a current missing finding and recipient role');
  }
  const keys = finding.conditions.map((condition) => condition.conditionKey);
  if (keys.length === 0 || keys.some((key) => !(template.keys as readonly string[]).includes(key))) {
    throw new CaseError(409, 'finding requires operator review rather than this request template');
  }
  return { body: template.body, conditionKeys: [...new Set(keys)] };
}
