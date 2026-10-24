import { z } from 'zod';

import { CaseRevision, Identifier, NonEmptyText, Sha256Hex } from './common.js';
import { DocumentRef } from './document.js';
import { EvidenceFact } from './evidence.js';
import { FindingStatus, ResponsibleRole, RuleId, RuleSeverity } from './policy.js';

/**
 * One rule's result for one case revision. Evidence is cited by fact ID; the
 * facts themselves carry document, version and locator. `documentRefs` names
 * documents the finding concerns that cannot be cited through facts: the rule
 * that excluded a document (R02 quarantine; R09 access, readability or
 * provenance) lists it, and so does a dependent rule whose status it caused
 * (restricted, unreadable or manual_review). It never carries content.
 * `explanation` names every condition that held, not only the one that set
 * the status.
 */
export const Finding = z
  .strictObject({
    schemaVersion: z.literal('pa.finding.v2'),
    findingId: Identifier,
    ruleId: RuleId,
    status: FindingStatus,
    severity: RuleSeverity,
    evidenceFactIds: z.array(Identifier),
    documentRefs: z.array(DocumentRef),
    explanation: NonEmptyText,
    responsibleRole: ResponsibleRole,
    caseRevision: CaseRevision,
  })
  .superRefine((value, context) => {
    if (new Set(value.evidenceFactIds).size !== value.evidenceFactIds.length) {
      context.addIssue({ code: 'custom', path: ['evidenceFactIds'], message: 'evidence fact IDs must be unique' });
    }
    const refs = value.documentRefs.map((ref) => `${ref.documentId}@v${ref.version}`);
    if (new Set(refs).size !== refs.length) {
      context.addIssue({ code: 'custom', path: ['documentRefs'], message: 'document references must be unique' });
    }
  });
export type Finding = z.infer<typeof Finding>;

/** States an assessment can select (SPEC: the allowed next states of `assessing`, less recovery). */
export const AssessedState = z.enum(['scope_hold', 'needs_information', 'needs_human_review', 'ready_for_review']);
export type AssessedState = z.infer<typeof AssessedState>;

/**
 * The complete result of assessing one case revision against one policy pack,
 * identified by ID and by the SHA-256 of its exact bytes so that a changed pack
 * under the same ID is detectable. Every rule reports exactly one finding.
 * Quarantined documents contribute no facts, so no finding can cite them.
 */
export const AssessmentResult = z
  .strictObject({
    schemaVersion: z.literal('pa.assessment-result.v2'),
    caseId: Identifier,
    caseRevision: CaseRevision,
    policyPackId: Identifier,
    policyPackSha256: Sha256Hex,
    state: AssessedState,
    findings: z.array(Finding),
    quarantinedDocumentIds: z.array(Identifier),
    evidenceFacts: z.array(EvidenceFact),
  })
  .superRefine((value, context) => {
    const factIds = value.evidenceFacts.map((fact) => fact.factId);
    if (new Set(factIds).size !== factIds.length) {
      context.addIssue({ code: 'custom', path: ['evidenceFacts'], message: 'fact IDs must be unique' });
    }
    if (new Set(value.findings.map((finding) => finding.findingId)).size !== value.findings.length) {
      context.addIssue({ code: 'custom', path: ['findings'], message: 'finding IDs must be unique' });
    }
    if (new Set(value.findings.map((finding) => finding.ruleId)).size !== value.findings.length) {
      context.addIssue({ code: 'custom', path: ['findings'], message: 'each rule reports exactly one finding' });
    }
    if (new Set(value.quarantinedDocumentIds).size !== value.quarantinedDocumentIds.length) {
      context.addIssue({ code: 'custom', path: ['quarantinedDocumentIds'], message: 'quarantined document IDs must be unique' });
    }
    const known = new Set(factIds);
    value.findings.forEach((finding, index) => {
      if (finding.caseRevision !== value.caseRevision) {
        context.addIssue({ code: 'custom', path: ['findings', index, 'caseRevision'], message: 'finding is for another case revision' });
      }
      finding.evidenceFactIds.forEach((factId, factIndex) => {
        if (!known.has(factId)) {
          context.addIssue({ code: 'custom', path: ['findings', index, 'evidenceFactIds', factIndex], message: `unknown fact ${factId}` });
        }
      });
    });
    const quarantined = new Set(value.quarantinedDocumentIds);
    value.evidenceFacts.forEach((fact, index) => {
      if (quarantined.has(fact.documentId)) {
        context.addIssue({ code: 'custom', path: ['evidenceFacts', index, 'documentId'], message: 'a quarantined document contributes no facts' });
      }
    });
  });
export type AssessmentResult = z.infer<typeof AssessmentResult>;
