import { z } from 'zod';

import { BeneficiaryState, Jurisdiction, PayerType, RequestKind, SupplierExemption, Urgency } from './case.js';
import { Identifier, IsoDate, ItemCode, NonEmptyText } from './common.js';
import { MimeType } from './document.js';
import { EvidenceField } from './evidence.js';

export const RuleId = z.enum(['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08', 'R09', 'R10']);
export type RuleId = z.infer<typeof RuleId>;

/** SPEC `Finding.status`. Explicit clinical findings use `manual_review`. */
export const FindingStatus = z.enum(['pass', 'missing', 'conflict', 'unreadable', 'restricted', 'manual_review', 'not_applicable']);
export type FindingStatus = z.infer<typeof FindingStatus>;

/** Who acts next on a finding. None of these roles is a payer or a signer. */
export const ResponsibleRole = z.enum(['authorization_coordinator', 'administrative_reviewer', 'qualified_clinical_reviewer']);
export type ResponsibleRole = z.infer<typeof ResponsibleRole>;

export const RuleSeverity = z.enum(['blocking', 'non_blocking']);
export type RuleSeverity = z.infer<typeof RuleSeverity>;

/**
 * The case state an outcome calls for. The assessment selects the highest of
 * all findings' effects in SPEC precedence order: scope hold, then human review
 * (identity or administrative conflict), then missing information; with none,
 * the case is ready for review. `none` never blocks readiness.
 */
export const StateEffect = z.enum(['none', 'needs_information', 'needs_human_review', 'scope_hold']);
export type StateEffect = z.infer<typeof StateEffect>;

export const RuleOutcome = z.strictObject({
  status: FindingStatus,
  condition: NonEmptyText,
  responsibleRole: ResponsibleRole,
  stateEffect: StateEffect,
});
export type RuleOutcome = z.infer<typeof RuleOutcome>;

export const RuleBasis = z.enum(['source', 'lab', 'source_and_lab']);
export type RuleBasis = z.infer<typeof RuleBasis>;

export const SourceRefId = z.string().regex(/^S[0-9]{2}$/, 'must be a research register ID such as S09');

export const SourceSection = z.strictObject({
  sourceRefId: SourceRefId,
  section: NonEmptyText,
});
export type SourceSection = z.infer<typeof SourceSection>;

const unique = <T>(values: readonly T[]) => new Set(values).size === values.length;

/**
 * One reviewed rule. `outcomes` lists every status the rule can report, in
 * precedence order: the first outcome whose condition holds is the finding.
 */
export const PolicyRule = z
  .strictObject({
    ruleId: RuleId,
    title: NonEmptyText,
    requirement: NonEmptyText,
    applicability: z.strictObject({
      stage: z.enum(['initial_request_packet']),
      itemCodes: z.array(ItemCode).min(1),
      requestKinds: z.array(RequestKind).min(1),
      condition: NonEmptyText,
    }),
    severity: RuleSeverity,
    evidenceFields: z.array(EvidenceField),
    basis: RuleBasis,
    basisNote: NonEmptyText,
    sourceSections: z.array(SourceSection),
    outcomes: z.array(RuleOutcome).min(1),
  })
  .superRefine((value, context) => {
    if (!unique(value.evidenceFields)) {
      context.addIssue({ code: 'custom', path: ['evidenceFields'], message: 'evidence fields must be unique' });
    }
    if (!unique(value.outcomes.map((outcome) => outcome.status))) {
      context.addIssue({ code: 'custom', path: ['outcomes'], message: 'each status appears in at most one outcome' });
    }
    if ((value.basis === 'lab') !== (value.sourceSections.length === 0)) {
      context.addIssue({ code: 'custom', path: ['sourceSections'], message: 'a lab-only rule cites no source section; any other rule cites at least one' });
    }
  });
export type PolicyRule = z.infer<typeof PolicyRule>;

/** A registered source. Retrieval is recorded separately from the source's own dates. */
export const SourceRef = z.strictObject({
  sourceRefId: SourceRefId,
  title: NonEmptyText,
  publisher: NonEmptyText,
  url: z.url({ protocol: /^https$/ }),
  retrievedOn: IsoDate,
  effectiveOn: IsoDate.nullable(),
  updatedOn: IsoDate.nullable(),
  version: NonEmptyText.nullable(),
  usedFor: NonEmptyText,
  limitation: NonEmptyText,
});
export type SourceRef = z.infer<typeof SourceRef>;

/** A documented lab convention. It is an engineering choice, not a legal interpretation. */
export const LabConvention = z.strictObject({
  conventionId: z.string().regex(/^C[0-9]{2}$/),
  ruleIds: z.array(RuleId).min(1),
  statement: NonEmptyText,
});
export type LabConvention = z.infer<typeof LabConvention>;

export const PolicyScope = z.strictObject({
  payerType: PayerType,
  payerPrimary: z.boolean(),
  beneficiaryStates: z.array(BeneficiaryState).min(1),
  jurisdictions: z.array(Jurisdiction).min(1),
  itemCodes: z.array(ItemCode).min(1),
  requestKinds: z.array(RequestKind).min(1),
  urgencies: z.array(Urgency).min(1),
  accessoriesPermitted: z.boolean(),
  alreadyDeliveredPermitted: z.boolean(),
  supplier: z.strictObject({
    statuses: z.array(SupplierExemption).min(1),
    established: z.boolean(),
    newEnrollment: z.boolean(),
    ownershipChange: z.boolean(),
  }),
  documentMimeTypes: z.array(MimeType).min(1),
  lcmpIncorporation: z.enum(['manual_review_branch']),
});
export type PolicyScope = z.infer<typeof PolicyScope>;

/**
 * An authored, source-linked policy pack. `reviewedAsOf` is `null` for an
 * unreviewed pack, which R08 reports rather than the schema rejecting it.
 */
export const PolicyPack = z
  .strictObject({
    schemaVersion: z.literal('pa.policy-pack.v1'),
    packId: Identifier,
    version: z.int().min(1),
    title: NonEmptyText,
    reviewedAsOf: IsoDate.nullable(),
    supportedAssessmentDates: z.array(IsoDate).min(1),
    scope: PolicyScope,
    rules: z.array(PolicyRule).min(1),
    sourceRefs: z.array(SourceRef),
    labConventions: z.array(LabConvention),
    limitations: z.array(NonEmptyText).min(1),
  })
  .superRefine((value, context) => {
    const ruleIds = value.rules.map((rule) => rule.ruleId);
    if (!unique(ruleIds)) {
      context.addIssue({ code: 'custom', path: ['rules'], message: 'rule IDs must be unique' });
    }
    const sourceIds = value.sourceRefs.map((source) => source.sourceRefId);
    if (!unique(sourceIds)) {
      context.addIssue({ code: 'custom', path: ['sourceRefs'], message: 'source IDs must be unique' });
    }
    if (!unique(value.supportedAssessmentDates)) {
      context.addIssue({ code: 'custom', path: ['supportedAssessmentDates'], message: 'dates must be unique' });
    }
    value.rules.forEach((rule, index) => {
      rule.sourceSections.forEach((section, sectionIndex) => {
        if (!sourceIds.includes(section.sourceRefId)) {
          context.addIssue({ code: 'custom', path: ['rules', index, 'sourceSections', sectionIndex], message: `unknown source ${section.sourceRefId}` });
        }
      });
    });
    value.labConventions.forEach((convention, index) => {
      if (convention.ruleIds.some((ruleId) => !ruleIds.includes(ruleId))) {
        context.addIssue({ code: 'custom', path: ['labConventions', index, 'ruleIds'], message: 'convention names an unknown rule' });
      }
    });
    if (!unique(value.labConventions.map((convention) => convention.conventionId))) {
      context.addIssue({ code: 'custom', path: ['labConventions'], message: 'convention IDs must be unique' });
    }
  });
export type PolicyPack = z.infer<typeof PolicyPack>;
