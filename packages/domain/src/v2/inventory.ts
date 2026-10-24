import {
  BINDING_BASES,
  CASE_SCOPE_FIELDS,
  type ConditionField,
  type ConditionQualifier,
  type DocumentArity,
  type DocumentKind,
  type FindingStatus,
  ORDER_ELEMENTS,
  type PolicyPackV2,
  type ResponsibleRole,
  RuleId,
  type StateEffect,
} from '@pa/contracts';

// The evaluator-supported inventory (D6 clarification). For each rule
// it lists every status the v2 evaluator can select, `pass` included where
// supported, and every non-pass condition it can emit, with the qualifier
// values, document arity and kinds it emits and the routing it relies on. It
// is internal implementation metadata, written from the reviewed condition
// vocabulary (docs/policy-slice.md) independently of any pack bytes, and is
// never an output field. A pack may declare more than this, such as
// `R09.locator_unresolved`, which has no proposed-locator input yet (S6).

/** A status the evaluator can select, with any routing the evaluator requires of its outcome. */
export interface InventoryStatus {
  status: FindingStatus;
  responsibleRole?: ResponsibleRole;
  stateEffect?: StateEffect;
}

/** A non-pass condition the evaluator can emit under its owning status. */
export interface InventoryCondition {
  conditionKey: string;
  status: Exclude<FindingStatus, 'pass'>;
  qualifier: ConditionQualifier;
  /** The qualifier values the evaluator emits; empty exactly for `none`. */
  fields: readonly ConditionField[];
  documentArity: DocumentArity;
  /** The kinds of the documents the evaluator names. */
  documentKinds: readonly DocumentKind[];
}

export interface RuleInventory {
  statuses: readonly InventoryStatus[];
  conditions: readonly InventoryCondition[];
}

export type EvaluatorInventoryV2 = Readonly<Record<RuleId, RuleInventory>>;

const ALL_KINDS: readonly DocumentKind[] = ['order', 'encounter', 'order_receipt', 'supplier_status', 'supporting_note'];
const BOUND_KINDS: readonly DocumentKind[] = ['order', 'encounter', 'order_receipt', 'supporting_note'];
const SCOPE_UNSUPPORTED_FIELDS: readonly ConditionField[] = [
  'case.payerType',
  'case.payerPrimary',
  'case.beneficiaryState',
  'case.jurisdiction',
  'case.itemCode',
  'case.requestKind',
  'case.urgency',
  'case.accessories',
  'case.alreadyDelivered',
  'case.supplierStatus.status',
  'case.supplierStatus.established',
  'case.supplierStatus.newEnrollment',
  'case.supplierStatus.ownershipChange',
];
const SUPPLIER_RECORD_FIELDS: readonly ConditionField[] = [
  'supplier.status',
  'supplier.established',
  'supplier.new_enrollment',
  'supplier.ownership_change',
  'supplier.effective_from',
  'supplier.effective_to',
];
const ORDER_VALUE_FIELDS: readonly ConditionField[] = [
  'order.beneficiary_name',
  'order.beneficiary_identifier',
  'order.date',
  'order.item_description',
  'order.quantity',
  'order.practitioner_name',
  'order.practitioner_identifier',
  'order.signature_signer_name',
  'order.signature_date',
];

type Shape = Partial<Pick<InventoryCondition, 'qualifier' | 'fields' | 'documentArity' | 'documentKinds'>>;

/** A condition entry; the default is a case-level key with no qualifier. */
const condition = (conditionKey: string, status: InventoryCondition['status'], shape: Shape = {}): InventoryCondition => ({
  conditionKey,
  status,
  qualifier: shape.qualifier ?? 'none',
  fields: shape.fields ?? [],
  documentArity: shape.documentArity ?? 'none',
  documentKinds: shape.documentKinds ?? [],
});
const one = (...documentKinds: DocumentKind[]): Shape => ({ documentArity: 'one', documentKinds });
const pair = (...documentKinds: DocumentKind[]): Shape => ({ documentArity: 'two', documentKinds });
const statuses = (...names: FindingStatus[]): InventoryStatus[] => names.map((status) => ({ status }));

export const EVALUATOR_INVENTORY_V2: EvaluatorInventoryV2 = {
  R01: {
    statuses: statuses('conflict', 'manual_review', 'restricted', 'unreadable', 'missing', 'pass'),
    conditions: [
      condition('R01.scope_fact_unsupported', 'conflict', { qualifier: 'case_scope_field', fields: SCOPE_UNSUPPORTED_FIELDS }),
      condition('R01.case_supplier_interval_excludes_date', 'conflict'),
      condition('R01.supplier_id_disagrees', 'conflict', one('supplier_status')),
      condition('R01.supplier_record_disagrees', 'conflict', { qualifier: 'evidence_field', fields: SUPPLIER_RECORD_FIELDS, ...one('supplier_status') }),
      condition('R01.supplier_record_interval_excludes_date', 'conflict', one('supplier_status')),
      condition('R01.order_item_code_disagrees', 'conflict', one('order')),
      condition('R01.supplier_record_failed_provenance', 'manual_review', one('supplier_status')),
      condition('R01.supplier_record_restricted', 'restricted', one('supplier_status')),
      condition('R01.supplier_record_unreadable', 'unreadable', one('supplier_status')),
      condition('R01.scope_fact_unknown', 'missing', { qualifier: 'case_scope_field', fields: CASE_SCOPE_FIELDS }),
      condition('R01.supplier_record_value_unknown', 'missing', { qualifier: 'evidence_field', fields: SUPPLIER_RECORD_FIELDS, ...one('supplier_status') }),
      condition('R01.supplier_record_not_supplied', 'missing'),
    ],
  },
  R02: {
    statuses: statuses('conflict', 'pass'),
    conditions: [condition('R02.document_quarantined', 'conflict', { qualifier: 'binding_basis', fields: BINDING_BASES, ...one(...BOUND_KINDS) })],
  },
  R03: {
    statuses: statuses('conflict', 'manual_review', 'restricted', 'unreadable', 'missing', 'pass'),
    conditions: [
      condition('R03.orders_disagree', 'conflict', { qualifier: 'evidence_field', fields: ORDER_VALUE_FIELDS, documentArity: 'two_or_more', documentKinds: ['order'] }),
      condition('R03.order_failed_provenance', 'manual_review', one('order')),
      condition('R03.order_restricted', 'restricted', one('order')),
      condition('R03.order_unreadable', 'unreadable', one('order')),
      condition('R03.no_usable_order', 'missing'),
      condition('R03.element_missing', 'missing', { qualifier: 'order_element', fields: ORDER_ELEMENTS, ...one('order') }),
    ],
  },
  R04: {
    statuses: statuses('conflict', 'manual_review', 'restricted', 'unreadable', 'missing', 'pass'),
    conditions: [
      condition('R04.practitioner_identifier_differs', 'conflict', pair('encounter', 'order')),
      condition('R04.order_before_encounter', 'conflict', pair('encounter', 'order')),
      condition('R04.order_after_bound', 'conflict', pair('encounter', 'order')),
      condition('R04.encounters_disagree', 'conflict', { qualifier: 'evidence_field', fields: ['encounter.date'], documentArity: 'two_or_more', documentKinds: ['encounter'] }),
      condition('R04.orders_disagree', 'conflict', { qualifier: 'evidence_field', fields: ['order.date'], documentArity: 'two_or_more', documentKinds: ['order'] }),
      condition('R04.same_day_unsequenced', 'manual_review', pair('encounter', 'order')),
      condition('R04.practitioner_identifier_absent', 'manual_review', pair('encounter', 'order')),
      condition('R04.lcmp_stated_by_case', 'manual_review'),
      condition('R04.lcmp_stated_by_encounter', 'manual_review', one('encounter')),
      condition('R04.encounter_failed_provenance', 'manual_review', one('encounter')),
      condition('R04.order_failed_provenance', 'manual_review', one('order')),
      condition('R04.encounter_restricted', 'restricted', one('encounter')),
      condition('R04.order_restricted', 'restricted', one('order')),
      condition('R04.encounter_unreadable', 'unreadable', one('encounter')),
      condition('R04.order_unreadable', 'unreadable', one('order')),
      condition('R04.no_usable_encounter', 'missing'),
      condition('R04.no_usable_order', 'missing'),
      condition('R04.encounter_not_final', 'missing', one('encounter')),
      condition('R04.order_not_final', 'missing', one('order')),
      condition('R04.date_not_stated', 'missing', { qualifier: 'evidence_field', fields: ['encounter.date', 'order.date'], ...one('encounter', 'order') }),
    ],
  },
  R05: {
    statuses: statuses('conflict', 'manual_review', 'restricted', 'unreadable', 'missing', 'pass'),
    conditions: [
      condition('R05.receipt_before_order', 'conflict', pair('order_receipt', 'order')),
      condition('R05.receipt_unsequenced', 'manual_review', pair('order_receipt', 'order')),
      condition('R05.receipt_failed_provenance', 'manual_review', one('order_receipt')),
      condition('R05.receipt_restricted', 'restricted', one('order_receipt')),
      condition('R05.receipt_unreadable', 'unreadable', one('order_receipt')),
      condition('R05.no_usable_receipt', 'missing'),
      condition('R05.order_receipt_missing', 'missing', one('order')),
      condition('R05.no_usable_order', 'missing'),
    ],
  },
  // Qualified clinical review never changes administrative readiness and is
  // never assigned to an administrative role.
  R06: {
    statuses: [{ status: 'manual_review', responsibleRole: 'qualified_clinical_reviewer', stateEffect: 'none' }],
    conditions: [condition('R06.clinical_review', 'manual_review')],
  },
  R07: {
    statuses: statuses('manual_review', 'pass'),
    conditions: [condition('R07.lcmp_stated_by_case', 'manual_review'), condition('R07.lcmp_stated_by_encounter', 'manual_review', one('encounter'))],
  },
  R08: {
    statuses: statuses('conflict', 'missing', 'pass'),
    conditions: [
      condition('R08.pack_id_differs', 'conflict'),
      condition('R08.assessment_date_unsupported', 'conflict'),
      condition('R08.pack_unreviewed', 'missing'),
      condition('R08.pack_unsourced', 'missing'),
    ],
  },
  // The first applicable R09 condition per version; `R09.locator_unresolved`
  // is not emitted (no proposed-locator input exists).
  R09: {
    statuses: statuses('conflict', 'restricted', 'unreadable', 'pass'),
    conditions: [
      condition('R09.hash_mismatch', 'conflict', one(...ALL_KINDS)),
      condition('R09.kind_mismatch', 'conflict', one(...ALL_KINDS)),
      condition('R09.access_restricted', 'restricted', one(...ALL_KINDS)),
      condition('R09.access_unreadable', 'unreadable', one(...ALL_KINDS)),
      condition('R09.mime_unsupported', 'unreadable', one(...ALL_KINDS)),
      condition('R09.body_invalid', 'unreadable', one(...ALL_KINDS)),
    ],
  },
  // A pure assessment never blocks on R10.
  R10: {
    statuses: [{ status: 'not_applicable', stateEffect: 'none' }],
    conditions: [condition('R10.pure_assessment', 'not_applicable')],
  },
};

/**
 * Every way the pack fails to cover the inventory, as internal diagnostics for
 * tests; an input rejection never carries them. A supported status needs an
 * outcome satisfying its routing; a supported condition needs a declaration
 * under its owning status with the same qualifier and arity, every emitted
 * field value and every named kind. Extra pack declarations are allowed.
 * Expects a pack holding every rule.
 */
export function packCoverageGaps(pack: PolicyPackV2, inventory: EvaluatorInventoryV2 = EVALUATOR_INVENTORY_V2): string[] {
  const gaps: string[] = [];
  for (const ruleId of RuleId.options) {
    const rule = pack.rules.find((candidate) => candidate.ruleId === ruleId);
    if (rule === undefined) {
      gaps.push(`${ruleId}: rule not declared`);
      continue;
    }
    for (const supported of inventory[ruleId].statuses) {
      const outcome = rule.outcomes.find((candidate) => candidate.status === supported.status);
      if (outcome === undefined) {
        gaps.push(`${ruleId}: no ${supported.status} outcome`);
      } else if ((supported.responsibleRole ?? outcome.responsibleRole) !== outcome.responsibleRole || (supported.stateEffect ?? outcome.stateEffect) !== outcome.stateEffect) {
        gaps.push(`${ruleId}: ${supported.status} outcome routing differs from the evaluator's`);
      }
    }
    for (const entry of inventory[ruleId].conditions) {
      const declaration = rule.outcomes.find((candidate) => candidate.status === entry.status)?.conditions.find((candidate) => candidate.conditionKey === entry.conditionKey);
      if (declaration === undefined) {
        gaps.push(`${entry.conditionKey}: not declared under ${entry.status}`);
        continue;
      }
      if (declaration.qualifier !== entry.qualifier || entry.fields.some((field) => !declaration.fields.includes(field))) {
        gaps.push(`${entry.conditionKey}: qualifier or field values differ`);
      }
      if (declaration.documentArity !== entry.documentArity || entry.documentKinds.some((kind) => !declaration.documentKinds.includes(kind))) {
        gaps.push(`${entry.conditionKey}: document arity or kinds differ`);
      }
    }
  }
  return gaps;
}
