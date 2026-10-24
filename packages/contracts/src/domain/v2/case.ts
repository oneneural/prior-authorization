import { z } from 'zod';

import { BeneficiaryState, CaseState, Jurisdiction, PayerType, RequestKind, SupplierStatus, Urgency } from '../case.js';
import { CaseRevision, Identifier, IsoDate, ItemCode } from '../common.js';
import { CanonicalText } from './text.js';

/**
 * `pa.case.v2`: the v1 case with a canonical `subjectName`. A name with
 * surrounding whitespace is a schema rejection rather than a value that is
 * trimmed or that quarantines every document it is compared with (D1). Every
 * other field and invariant is unchanged from `pa.case.v1`.
 */
export const CaseV2 = z
  .strictObject({
    schemaVersion: z.literal('pa.case.v2'),
    caseId: Identifier,
    revision: CaseRevision,
    synthetic: z.literal(true),
    subjectId: Identifier,
    subjectName: CanonicalText,
    assessmentDate: IsoDate,
    payerType: PayerType,
    payerPrimary: z.boolean().nullable(),
    beneficiaryState: BeneficiaryState,
    jurisdiction: Jurisdiction,
    itemCode: ItemCode.nullable(),
    requestKind: RequestKind,
    urgency: Urgency,
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
      context.addIssue({ code: 'custom', path: ['supplierStatusEvidenceId'], message: 'must equal supplierStatus.evidenceId' });
    }
  });
export type CaseV2 = z.infer<typeof CaseV2>;

/** A `pa.case.v2` as supplied for assessment: the server assigns `intake`. */
export const IntakeCaseV2 = CaseV2.superRefine((value, context) => {
  if (value.state !== 'intake') {
    context.addIssue({ code: 'custom', path: ['state'], message: 'a new case starts in intake' });
  }
});
export type IntakeCaseV2 = z.infer<typeof IntakeCaseV2>;
