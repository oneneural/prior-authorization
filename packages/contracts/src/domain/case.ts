import { z } from 'zod';

import { CaseRevision, Identifier, IsoDate, ItemCode, NonEmptyText } from './common.js';

/** SPEC "Workflow and state". There is no approved, denied, submitted or paid state. */
export const CaseState = z.enum([
  'intake',
  'assessing',
  'scope_hold',
  'needs_information',
  'needs_human_review',
  'ready_for_review',
  'accepted_for_review',
  'recoverable_error',
  'cancelled',
]);
export type CaseState = z.infer<typeof CaseState>;

export const PayerType = z.enum(['medicare_ffs', 'medicare_advantage', 'medicaid', 'commercial', 'other', 'unknown']);
export type PayerType = z.infer<typeof PayerType>;

/** DME MAC jurisdiction as stated on the case; routing is never inferred from an address. */
export const Jurisdiction = z.enum(['noridian_ja', 'cgs_jb', 'cgs_jc', 'noridian_jd', 'unknown']);
export type Jurisdiction = z.infer<typeof Jurisdiction>;

/** USPS state and territory codes, plus an explicit `unknown`. */
export const BeneficiaryState = z.enum([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY',
  'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH',
  'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'AS', 'GU', 'MP',
  'PR', 'VI', 'unknown',
]);
export type BeneficiaryState = z.infer<typeof BeneficiaryState>;

export const RequestKind = z.enum(['initial', 'replacement', 'resubmission', 'appeal', 'unknown']);
export type RequestKind = z.infer<typeof RequestKind>;

export const Urgency = z.enum(['standard', 'expedited', 'unknown']);
export type Urgency = z.infer<typeof Urgency>;

export const SupplierExemption = z.enum(['non_exempt', 'exempt', 'unknown']);
export type SupplierExemption = z.infer<typeof SupplierExemption>;

/**
 * Supplier status as stated by its evidence record. `null` means the value is
 * explicitly unknown; it never defaults to the supported value.
 */
export const SupplierStatus = z
  .strictObject({
    schemaVersion: z.literal('pa.supplier-status.v1'),
    status: SupplierExemption,
    established: z.boolean().nullable(),
    newEnrollment: z.boolean().nullable(),
    ownershipChange: z.boolean().nullable(),
    effectiveFrom: IsoDate.nullable(),
    effectiveTo: IsoDate.nullable(),
    evidenceId: Identifier.nullable(),
  })
  .superRefine((value, context) => {
    if (value.effectiveFrom !== null && value.effectiveTo !== null && value.effectiveFrom > value.effectiveTo) {
      context.addIssue({ code: 'custom', path: ['effectiveTo'], message: 'effectiveTo must not precede effectiveFrom' });
    }
  });
export type SupplierStatus = z.infer<typeof SupplierStatus>;

/**
 * A synthetic case. Tri-state flags use `null` for an explicitly unknown value.
 * `subjectName` extends the SPEC minimum so that a document naming the
 * beneficiary without an identifier can still be bound to the subject (R02).
 */
export const Case = z
  .strictObject({
    schemaVersion: z.literal('pa.case.v1'),
    caseId: Identifier,
    revision: CaseRevision,
    synthetic: z.literal(true),
    subjectId: Identifier,
    subjectName: NonEmptyText,
    assessmentDate: IsoDate,
    payerType: PayerType,
    payerPrimary: z.boolean().nullable(),
    beneficiaryState: BeneficiaryState,
    jurisdiction: Jurisdiction,
    itemCode: ItemCode.nullable(),
    requestKind: RequestKind,
    urgency: Urgency,
    /** Accessory item codes requested with the base item; `null` means unknown. */
    accessories: z.array(ItemCode).nullable(),
    alreadyDelivered: z.boolean().nullable(),
    lcmpIncorporated: z.boolean().nullable(),
    supplierId: Identifier,
    supplierStatus: SupplierStatus,
    supplierStatusEvidenceId: Identifier.nullable(),
    policyPackId: Identifier,
    state: CaseState,
  })
  .superRefine((value, context) => {
    if (value.supplierStatus.evidenceId !== value.supplierStatusEvidenceId) {
      context.addIssue({
        code: 'custom',
        path: ['supplierStatusEvidenceId'],
        message: 'must equal supplierStatus.evidenceId',
      });
    }
  });
export type Case = z.infer<typeof Case>;

/** A case as supplied for assessment: the server assigns the initial `intake` state. */
export const IntakeCase = Case.superRefine((value, context) => {
  if (value.state !== 'intake') {
    context.addIssue({ code: 'custom', path: ['state'], message: 'a new case starts in intake' });
  }
});
export type IntakeCase = z.infer<typeof IntakeCase>;
