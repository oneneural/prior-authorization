import { z } from 'zod';

import { DocumentRef } from '../document.js';
import { EvidenceField } from '../evidence.js';

// Finding conditions (decision D2). A finding keeps one status per
// rule and lists every non-pass condition that held, each identified by
// (ruleId, conditionKey, field, sorted document refs). Keys and their
// qualifier vocabulary, document arity and routing are declared once in the
// policy pack (`pa.policy-pack.v2`).

/** `R<nn>.<snake_case>`, for example `R04.practitioner_identifier_differs`. */
export const ConditionKey = z.string().regex(/^R(0[1-9]|10)\.[a-z][a-z0-9]*(_[a-z0-9]+)*$/, 'must be a rule ID, a dot and a snake_case name');
export type ConditionKey = z.infer<typeof ConditionKey>;

/** Case fields that R01 judges, as `case.<field>` (nested supplier status fields by dotted path). */
export const CASE_SCOPE_FIELDS = [
  'case.payerType',
  'case.payerPrimary',
  'case.beneficiaryState',
  'case.jurisdiction',
  'case.itemCode',
  'case.requestKind',
  'case.urgency',
  'case.accessories',
  'case.alreadyDelivered',
  'case.lcmpIncorporated',
  'case.supplierStatusEvidenceId',
  'case.supplierStatus.status',
  'case.supplierStatus.established',
  'case.supplierStatus.newEnrollment',
  'case.supplierStatus.ownershipChange',
  'case.supplierStatus.effectiveFrom',
  'case.supplierStatus.effectiveTo',
] as const;

/** R03 order elements; `beneficiary` and `practitioner` are satisfied by a name or an identifier. */
export const ORDER_ELEMENTS = [
  'element.beneficiary',
  'element.order_date',
  'element.item_description',
  'element.quantity',
  'element.practitioner',
  'element.signature',
] as const;

/** R02 binding bases, in the order R02 checks them. */
export const BINDING_BASES = ['binding.metadata_subject', 'binding.stated_identifier', 'binding.stated_name'] as const;

/** Every value a condition `field` may take. The pack restricts each key to one kind and a subset. */
export const ConditionField = z.enum([...CASE_SCOPE_FIELDS, ...EvidenceField.options, ...ORDER_ELEMENTS, ...BINDING_BASES]);
export type ConditionField = z.infer<typeof ConditionField>;

/** The kind of qualifier a condition key carries; `none` means `field` is always `null`. */
export const ConditionQualifier = z.enum(['none', 'case_scope_field', 'evidence_field', 'order_element', 'binding_basis']);
export type ConditionQualifier = z.infer<typeof ConditionQualifier>;

const QUALIFIER_VALUES: Record<Exclude<ConditionQualifier, 'none'>, readonly string[]> = {
  case_scope_field: CASE_SCOPE_FIELDS,
  evidence_field: EvidenceField.options,
  order_element: ORDER_ELEMENTS,
  binding_basis: BINDING_BASES,
};

/** True when `field` belongs to the qualifier kind's vocabulary (`null` exactly for `none`). */
export function fieldMatchesQualifier(qualifier: ConditionQualifier, field: string | null): boolean {
  return qualifier === 'none' ? field === null : field !== null && QUALIFIER_VALUES[qualifier].includes(field);
}

/**
 * How many documents a condition names: `none` (case-level), `one` (one
 * document), `two` (one pair, such as an encounter and an order, or a receipt
 * and the order it references) or `two_or_more` (an aggregate disagreement
 * naming every document that states a value).
 */
export const DocumentArity = z.enum(['none', 'one', 'two', 'two_or_more']);
export type DocumentArity = z.infer<typeof DocumentArity>;

export function arityAllows(arity: DocumentArity, count: number): boolean {
  return arity === 'none' ? count === 0 : arity === 'one' ? count === 1 : arity === 'two' ? count === 2 : count >= 2;
}

const refKey = (ref: DocumentRef) => `${ref.documentId}@v${ref.version}`;

/** Order of strings by UTF-16 code units (JavaScript's `<`), never locale collation. */
export function compareCodeUnits(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

/** Canonical document order: documentId by UTF-16 code units, then version numerically. */
export function compareDocumentRefs(a: DocumentRef, b: DocumentRef): number {
  return compareCodeUnits(a.documentId, b.documentId) || a.version - b.version;
}

/** Canonical order of reference lists: element by element, a shorter prefix first. */
export function compareDocumentRefLists(a: readonly DocumentRef[], b: readonly DocumentRef[]): number {
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const left = a[index];
    const right = b[index];
    const order = left !== undefined && right !== undefined ? compareDocumentRefs(left, right) : 0;
    if (order !== 0) {
      return order;
    }
  }
  return a.length - b.length;
}

/** `null` sorts before any string; strings compare by UTF-16 code units. */
export function compareNullableText(a: string | null, b: string | null): number {
  return a === b ? 0 : a === null ? -1 : b === null ? 1 : compareCodeUnits(a, b);
}

/** Canonical condition order: key, then field (`null` first), then document references. */
export function compareConditions(
  a: { conditionKey: string; field: string | null; documentRefs: readonly DocumentRef[] },
  b: { conditionKey: string; field: string | null; documentRefs: readonly DocumentRef[] },
): number {
  return compareCodeUnits(a.conditionKey, b.conditionKey) || compareNullableText(a.field, b.field) || compareDocumentRefLists(a.documentRefs, b.documentRefs);
}

/** The complete semantic identity of a condition inside its finding. */
export function conditionIdentity(condition: { conditionKey: string; field: string | null; documentRefs: readonly DocumentRef[] }): string {
  return JSON.stringify([condition.conditionKey, condition.field, [...condition.documentRefs].sort(compareDocumentRefs).map(refKey)]);
}

/**
 * One held condition. `documentRefs` are the exact document versions the
 * condition concerns (by ID and version only), in canonical order, with no
 * duplicates. They may name a usable document that the finding also cites; the
 * parent `Finding.documentRefs` keeps its own, narrower convention C07 meaning.
 */
export const FindingCondition = z
  .strictObject({
    conditionKey: ConditionKey,
    field: ConditionField.nullable(),
    documentRefs: z.array(DocumentRef),
  })
  .superRefine((value, context) => {
    const keys = value.documentRefs.map(refKey);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({ code: 'custom', path: ['documentRefs'], message: 'condition document references must be unique' });
    }
    for (let index = 1; index < value.documentRefs.length; index += 1) {
      const previous = value.documentRefs[index - 1];
      const current = value.documentRefs[index];
      if (previous !== undefined && current !== undefined && compareDocumentRefs(previous, current) > 0) {
        context.addIssue({ code: 'custom', path: ['documentRefs', index], message: 'condition document references must be in canonical order' });
      }
    }
  });
export type FindingCondition = z.infer<typeof FindingCondition>;
