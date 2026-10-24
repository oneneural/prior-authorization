import { z } from 'zod';

import { RequestKind } from '../case.js';
import { Identifier, IsoDate, ItemCode } from '../common.js';
import { DocumentKind } from '../document.js';
import { EvidenceField } from '../evidence.js';
import { FindingStatus, PolicyScope, ResponsibleRole, RuleBasis, RuleId, RuleSeverity, SourceRefId, StateEffect } from '../policy.js';
import { ConditionField, ConditionKey, ConditionQualifier, DocumentArity, fieldMatchesQualifier } from './conditions.js';
import { CanonicalText } from './text.js';

// `pa.policy-pack.v2`. Unchanged from v1 except that reviewed text is
// canonical (never trimmed on parse) and every non-pass outcome declares the
// complete set of conditions it owns (D2). The v1 schema and pack are kept
// unchanged as historical evidence.

const unique = <T>(values: readonly T[]) => new Set(values).size === values.length;

const STATE_EFFECT_RANK: Record<StateEffect, number> = { none: 0, needs_information: 1, needs_human_review: 2, scope_hold: 3 };

/**
 * A condition an outcome owns. `fields` lists the qualifier values the key may
 * carry (empty exactly when `qualifier` is `none`); `documentArity` and
 * `documentKinds` say which documents an instance names; `statement` is the
 * reviewed predicate, including which documents it names.
 */
export const ConditionDeclaration = z
  .strictObject({
    conditionKey: ConditionKey,
    qualifier: ConditionQualifier,
    fields: z.array(ConditionField),
    documentArity: DocumentArity,
    documentKinds: z.array(DocumentKind),
    statement: CanonicalText,
  })
  .superRefine((value, context) => {
    if ((value.qualifier === 'none') !== (value.fields.length === 0) || !unique(value.fields)) {
      context.addIssue({ code: 'custom', path: ['fields'], message: 'fields are unique and empty exactly when the qualifier is none' });
    }
    value.fields.forEach((field, index) => {
      if (!fieldMatchesQualifier(value.qualifier, field)) {
        context.addIssue({ code: 'custom', path: ['fields', index], message: `${field} is not a ${value.qualifier} value` });
      }
    });
    if ((value.documentArity === 'none') !== (value.documentKinds.length === 0) || !unique(value.documentKinds)) {
      context.addIssue({ code: 'custom', path: ['documentKinds'], message: 'document kinds are unique and empty exactly when the arity is none' });
    }
  });
export type ConditionDeclaration = z.infer<typeof ConditionDeclaration>;

/** One outcome: a pass owns no condition; every other status owns at least one. */
export const RuleOutcomeV2 = z
  .strictObject({
    status: FindingStatus,
    condition: CanonicalText,
    responsibleRole: ResponsibleRole,
    stateEffect: StateEffect,
    conditions: z.array(ConditionDeclaration),
  })
  .superRefine((value, context) => {
    if ((value.status === 'pass') !== (value.conditions.length === 0)) {
      context.addIssue({ code: 'custom', path: ['conditions'], message: 'a pass outcome declares no conditions; any other outcome declares at least one' });
    }
  });
export type RuleOutcomeV2 = z.infer<typeof RuleOutcomeV2>;

/**
 * One reviewed rule. Outcomes are in precedence order (the first owning a held
 * condition sets the finding status) and never precede an outcome with a
 * higher state effect (C05).
 */
export const PolicyRuleV2 = z
  .strictObject({
    ruleId: RuleId,
    title: CanonicalText,
    requirement: CanonicalText,
    applicability: z.strictObject({
      stage: z.enum(['initial_request_packet']),
      itemCodes: z.array(ItemCode).min(1),
      requestKinds: z.array(RequestKind).min(1),
      condition: CanonicalText,
    }),
    severity: RuleSeverity,
    evidenceFields: z.array(EvidenceField),
    basis: RuleBasis,
    basisNote: CanonicalText,
    sourceSections: z.array(z.strictObject({ sourceRefId: SourceRefId, section: CanonicalText })),
    outcomes: z.array(RuleOutcomeV2).min(1),
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
    value.outcomes.forEach((outcome, index) => {
      const previous = value.outcomes[index - 1];
      if (previous !== undefined && STATE_EFFECT_RANK[previous.stateEffect] < STATE_EFFECT_RANK[outcome.stateEffect]) {
        context.addIssue({ code: 'custom', path: ['outcomes', index], message: 'an outcome precedes one with a higher state effect' });
      }
      outcome.conditions.forEach((condition, conditionIndex) => {
        if (!condition.conditionKey.startsWith(`${value.ruleId}.`)) {
          context.addIssue({ code: 'custom', path: ['outcomes', index, 'conditions', conditionIndex], message: 'condition key belongs to another rule' });
        }
      });
    });
  });
export type PolicyRuleV2 = z.infer<typeof PolicyRuleV2>;

export const SourceRefV2 = z.strictObject({
  sourceRefId: SourceRefId,
  title: CanonicalText,
  publisher: CanonicalText,
  url: z.url({ protocol: /^https$/ }),
  retrievedOn: IsoDate,
  effectiveOn: IsoDate.nullable(),
  updatedOn: IsoDate.nullable(),
  version: CanonicalText.nullable(),
  usedFor: CanonicalText,
  limitation: CanonicalText,
});
export type SourceRefV2 = z.infer<typeof SourceRefV2>;

export const LabConventionV2 = z.strictObject({
  conventionId: z.string().regex(/^C[0-9]{2}$/),
  ruleIds: z.array(RuleId).min(1),
  statement: CanonicalText,
});
export type LabConventionV2 = z.infer<typeof LabConventionV2>;

/** An authored, source-linked pack. `reviewedAsOf` is `null` for an unreviewed pack, which R08 reports. */
export const PolicyPackV2 = z
  .strictObject({
    schemaVersion: z.literal('pa.policy-pack.v2'),
    packId: Identifier,
    version: z.int().min(1),
    title: CanonicalText,
    reviewedAsOf: IsoDate.nullable(),
    supportedAssessmentDates: z.array(IsoDate).min(1),
    scope: PolicyScope,
    rules: z.array(PolicyRuleV2).min(1),
    sourceRefs: z.array(SourceRefV2),
    labConventions: z.array(LabConventionV2),
    limitations: z.array(CanonicalText).min(1),
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
    const keys = value.rules.flatMap((rule) => rule.outcomes.flatMap((outcome) => outcome.conditions.map((condition) => condition.conditionKey)));
    if (!unique(keys)) {
      context.addIssue({ code: 'custom', path: ['rules'], message: 'condition keys must be unique across the pack' });
    }
    value.labConventions.forEach((convention, index) => {
      if (convention.ruleIds.some((ruleId) => !ruleIds.includes(ruleId))) {
        context.addIssue({ code: 'custom', path: ['labConventions', index, 'ruleIds'], message: 'convention names an unknown rule' });
      }
    });
    if (!unique(value.labConventions.map((convention) => convention.conventionId))) {
      context.addIssue({ code: 'custom', path: ['labConventions'], message: 'convention IDs must be unique' });
    }
  });
export type PolicyPackV2 = z.infer<typeof PolicyPackV2>;
