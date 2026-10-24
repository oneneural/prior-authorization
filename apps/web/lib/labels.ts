// Text labels for every state the workbench shows. Status is always stated in
// words; administrative readiness, qualified clinical review, payer
// authorization and payment are never merged into one label.

export const CASE_STATE_LABELS: Record<string, string> = {
  intake: 'Intake: not yet assessed',
  assessing: 'Assessing: administrative checks running',
  scope_hold: 'Scope hold: outside the supported lab scope',
  needs_information: 'Needs information: administrative documents missing',
  needs_human_review: 'Needs human review: conflict or unsupported branch',
  ready_for_review: 'Ready for administrative review (not an authorization)',
  accepted_for_review: 'Accepted for further review (administrative only, no payer decision)',
  recoverable_error: 'Recoverable error: operator action required',
  cancelled: 'Cancelled (terminal)',
};

export const caseStateLabel = (state: string) => CASE_STATE_LABELS[state] ?? state;

/** Finding statuses, with the four evidence gaps kept distinct. */
export const FINDING_STATUS_LABELS: Record<string, string> = {
  pass: 'Administrative requirement met',
  missing: 'Not supplied',
  unreadable: 'Unreadable',
  restricted: 'Not authorized to read',
  conflict: 'Contradictory',
  manual_review: 'Requires qualified clinical review',
  not_applicable: 'Not applicable',
};

export const ACCESS_STATUS_LABELS: Record<string, string> = {
  available: 'Readable',
  unreadable: 'Unreadable',
  restricted: 'Not authorized to read',
};

export const REQUEST_STATE_LABELS: Record<string, string> = {
  draft: 'Draft: awaiting local approval',
  approved_local: 'Approved locally: simulated delivery queued',
  simulated_delivered: 'Simulated local delivery recorded (nothing transmitted)',
  response_received: 'Fixture response received: reassessment queued',
  closed: 'Closed (reassessment resolved it, or the operator closed it)',
  cancelled: 'Cancelled',
};

export const RESPONSIBLE_ROLE_LABELS: Record<string, string> = {
  authorization_coordinator: 'Authorization coordinator',
  administrative_reviewer: 'Administrative reviewer',
  qualified_clinical_reviewer: 'Qualified clinical reviewer (outside this lab)',
};

export const REJECTION_LABELS: Record<string, string> = {
  invalid_schema: 'Rejected: invalid proposal shape',
  binding_stale: 'Rejected: case inputs changed',
  source_unavailable: 'Rejected: source unavailable or withheld',
  source_hash_mismatch: 'Rejected: source hash mismatch',
  locator_mismatch: 'Rejected: citation locator does not match',
  value_mismatch: 'Rejected: value does not match the cited source',
  low_confidence: 'Rejected: below the confidence floor',
  request_not_applicable: 'Rejected: request does not fit a current missing finding',
};

/**
 * Neutral request templates by rule and the condition keys each one answers.
 * The API owns the wording and repeats this check; any other condition needs
 * operator review rather than a request.
 */
export const REQUEST_TEMPLATES: Record<string, { templateId: string; recipientRole: string; label: string; conditionKeys: readonly string[] }> = {
  R03: { templateId: 'existing_order', recipientRole: 'practitioner_records', label: 'Existing finalized order', conditionKeys: ['R03.no_usable_order', 'R03.element_missing'] },
  R04: { templateId: 'existing_encounter', recipientRole: 'practitioner_records', label: 'Existing finalized encounter record', conditionKeys: ['R04.no_usable_encounter', 'R04.encounter_not_final'] },
  R05: { templateId: 'existing_receipt', recipientRole: 'supplier_records', label: 'Existing supplier receipt record', conditionKeys: ['R05.order_receipt_missing'] },
};

export const RECIPIENT_LABELS: Record<string, string> = {
  practitioner_records: 'Fictional practitioner records office',
  supplier_records: 'Fictional supplier records office',
};

export const shortHash = (hash: string) => hash.slice(0, 12);

export function sourceHref(caseId: string, documentId: string, version: number, locator?: string) {
  const base = `/cases/${encodeURIComponent(caseId)}/sources/${encodeURIComponent(documentId)}/${version}`;
  return locator === undefined ? base : `${base}?locator=${encodeURIComponent(locator)}`;
}
