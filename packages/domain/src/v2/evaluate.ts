import {
  type CaseV2,
  type ConditionField,
  type DocumentKind,
  type EncounterBodyExact,
  type EvidenceField,
  type OrderBodyExact,
  type PolicyScope,
  RuleId,
  type SourceDocumentBodyExact,
} from '@pa/contracts';

import { addCalendarMonths, compareIsoDates, instantOf } from '../calendar.js';
import { ENCOUNTER_TO_ORDER_MONTHS, orderDateSpan } from '../rules.js';
import { type HeldConditionsByRule, type HeldConditionV2 } from './backstop.js';
import { type ClassifiedVersion, type ExactValue, type R09Key } from './classify.js';
import { EVALUATOR_INVENTORY_V2 } from './inventory.js';
import { refKey } from './lineage.js';
import { type PreflightSnapshot } from './preflight.js';

// The version 2 rule predicates, written from the reviewed pack
// statements and conventions C01 to C09. Every rule is evaluated for every
// case: a scope hold or an LCMP condition never suppresses another condition.
// Rules read only current usable versions, as C09 defines them; candidates
// are current versions with an R09 condition, and quarantined versions are
// never candidates. Each named document carries the kind its validated
// metadata states. The evaluator returns every held condition and leaves
// outcome selection, and any representability failure, to the backstop.

/** A current usable version of one kind, with its exact body and extracted values. */
interface Readable<B extends SourceDocumentBodyExact> {
  version: ClassifiedVersion;
  body: B;
  values: ReadonlyMap<EvidenceField, ExactValue>;
}

type BodyOf<K extends DocumentKind> = Extract<SourceDocumentBodyExact, { documentKind: K }>;

const STATUS_OF = new Map(RuleId.options.flatMap((ruleId) => EVALUATOR_INVENTORY_V2[ruleId].conditions.map((entry) => [entry.conditionKey, entry.status] as const)));

/**
 * One held condition with its owning status from the inventory. A key outside
 * the inventory gets `pass`, which no condition entry has, so the backstop
 * rejects it instead of this module guessing a status.
 */
function held(conditionKey: string, field: ConditionField | null, versions: readonly ClassifiedVersion[]): HeldConditionV2 {
  return {
    status: STATUS_OF.get(conditionKey) ?? 'pass',
    conditionKey,
    field,
    documents: versions.map((version) => ({ ref: version.ref, kind: version.metadata.kind })),
  };
}

/** Every current usable version of a kind, in canonical reference order. */
function readable<K extends DocumentKind>(snapshot: PreflightSnapshot, kind: K): Readable<BodyOf<K>>[] {
  const found: Readable<BodyOf<K>>[] = [];
  for (const version of snapshot.versions) {
    const { classification } = version;
    if (!version.current || version.metadata.kind !== kind || classification.status !== 'usable' || classification.content === null) {
      continue;
    }
    // Classification guarantees the body kind equals the metadata kind.
    const body = classification.content.body as BodyOf<K>;
    found.push({ version, body, values: new Map(classification.content.values.map((value) => [value.field, value])) });
  }
  return found;
}

/** How a candidate's R09 condition explains a gap (pack R09 requirement). */
const CANDIDATE_CLASS: Readonly<Record<R09Key, 'failed_provenance' | 'restricted' | 'unreadable'>> = {
  'R09.access_restricted': 'restricted',
  'R09.hash_mismatch': 'failed_provenance',
  'R09.access_unreadable': 'unreadable',
  'R09.mime_unsupported': 'unreadable',
  'R09.body_invalid': 'unreadable',
  'R09.kind_mismatch': 'failed_provenance',
};

/** The candidate condition keys of R01, R03, R04 and R05, whose documents C07 lets the finding name. */
export const CANDIDATE_KEYS: ReadonlySet<string> = new Set(
  ['R01.supplier_record', 'R03.order', 'R04.encounter', 'R04.order', 'R05.receipt'].flatMap((prefix) => ['failed_provenance', 'restricted', 'unreadable'].map((name) => `${prefix}_${name}`)),
);

/** The R09 class of a version that has an R09 condition, as a candidate condition key under `prefix`. */
export function candidateKey(prefix: string, version: ClassifiedVersion): string | undefined {
  return version.classification.status === 'r09' ? `${prefix}_${CANDIDATE_CLASS[version.classification.conditionKey]}` : undefined;
}

/** C09 candidates: each current version of the kind with an R09 condition (never a quarantined one). */
function candidates(versions: readonly ClassifiedVersion[], prefix: string): HeldConditionV2[] {
  return versions.flatMap((version) => {
    const key = version.current ? candidateKey(prefix, version) : undefined;
    return key === undefined ? [] : [held(key, null, [version])];
  });
}

const ofKind = (snapshot: PreflightSnapshot, kind: DocumentKind) => snapshot.versions.filter((version) => version.metadata.kind === kind);

/** Two or more different stated values of one field; names every document stating it (C09). Values compare exactly as accepted. */
function disagreement(conditionKey: string, field: EvidenceField, documents: readonly Readable<SourceDocumentBodyExact>[]): HeldConditionV2[] {
  const stating = documents.filter((document) => document.values.has(field));
  const values = new Set(stating.map((document) => document.values.get(field)?.value));
  return values.size > 1 ? [held(conditionKey, field, stating.map((document) => document.version))] : [];
}

const contains = (date: string, from: string, to: string) => compareIsoDates(from, date) <= 0 && compareIsoDates(date, to) <= 0;
const known = <T>(value: T | null): value is T => value !== null && value !== 'unknown';

// R01. Scope values come from the pack's own scope; a null or `unknown` value
// is unknown before it can be unsupported. An LCMP incorporation is never a
// scope failure, and an unknown supplier value never implies an exempt one.

function caseScope(caseRecord: CaseV2, scope: PolicyScope): HeldConditionV2[] {
  const found: HeldConditionV2[] = [];
  const judge = (field: ConditionField, unknown: boolean, unsupported: boolean) => {
    if (unknown) {
      found.push(held('R01.scope_fact_unknown', field, []));
    } else if (unsupported) {
      found.push(held('R01.scope_fact_unsupported', field, []));
    }
  };
  const { supplierStatus } = caseRecord;
  judge('case.payerType', caseRecord.payerType === 'unknown', caseRecord.payerType !== scope.payerType);
  judge('case.payerPrimary', caseRecord.payerPrimary === null, caseRecord.payerPrimary !== scope.payerPrimary);
  judge('case.beneficiaryState', caseRecord.beneficiaryState === 'unknown', !scope.beneficiaryStates.includes(caseRecord.beneficiaryState));
  judge('case.jurisdiction', caseRecord.jurisdiction === 'unknown', !scope.jurisdictions.includes(caseRecord.jurisdiction));
  judge('case.itemCode', caseRecord.itemCode === null, caseRecord.itemCode !== null && !scope.itemCodes.includes(caseRecord.itemCode));
  judge('case.requestKind', caseRecord.requestKind === 'unknown', !scope.requestKinds.includes(caseRecord.requestKind));
  judge('case.urgency', caseRecord.urgency === 'unknown', !scope.urgencies.includes(caseRecord.urgency));
  judge('case.accessories', caseRecord.accessories === null, (caseRecord.accessories?.length ?? 0) > 0 && !scope.accessoriesPermitted);
  judge('case.alreadyDelivered', caseRecord.alreadyDelivered === null, caseRecord.alreadyDelivered === true && !scope.alreadyDeliveredPermitted);
  judge('case.lcmpIncorporated', caseRecord.lcmpIncorporated === null, false);
  judge('case.supplierStatusEvidenceId', caseRecord.supplierStatusEvidenceId === null, false);
  judge('case.supplierStatus.status', supplierStatus.status === 'unknown', !scope.supplier.statuses.includes(supplierStatus.status));
  judge('case.supplierStatus.established', supplierStatus.established === null, supplierStatus.established !== scope.supplier.established);
  judge('case.supplierStatus.newEnrollment', supplierStatus.newEnrollment === null, supplierStatus.newEnrollment !== scope.supplier.newEnrollment);
  judge('case.supplierStatus.ownershipChange', supplierStatus.ownershipChange === null, supplierStatus.ownershipChange !== scope.supplier.ownershipChange);
  judge('case.supplierStatus.effectiveFrom', supplierStatus.effectiveFrom === null, false);
  judge('case.supplierStatus.effectiveTo', supplierStatus.effectiveTo === null, false);
  return found;
}

type SupplierBody = BodyOf<'supplier_status'>;
type CaseSupplier = CaseV2['supplierStatus'];

/** Each supplier record field with its case counterpart. */
const SUPPLIER_FIELDS: readonly [EvidenceField, (body: SupplierBody) => unknown, (status: CaseSupplier) => unknown][] = [
  ['supplier.status', (body) => body.status, (status) => status.status],
  ['supplier.established', (body) => body.established, (status) => status.established],
  ['supplier.new_enrollment', (body) => body.newEnrollment, (status) => status.newEnrollment],
  ['supplier.ownership_change', (body) => body.ownershipChange, (status) => status.ownershipChange],
  ['supplier.effective_from', (body) => body.effectiveFrom, (status) => status.effectiveFrom],
  ['supplier.effective_to', (body) => body.effectiveTo, (status) => status.effectiveTo],
];

/** Current versions of kind `supplier_status` with the document ID the case names, usable or not. */
export function namedSupplierVersions(snapshot: PreflightSnapshot): ClassifiedVersion[] {
  const named = snapshot.caseRecord.supplierStatusEvidenceId;
  return named === null ? [] : ofKind(snapshot, 'supplier_status').filter((version) => version.current && version.ref.documentId === named);
}

function evaluateR01(snapshot: PreflightSnapshot): HeldConditionV2[] {
  const { caseRecord, assessmentDate } = snapshot;
  const found = caseScope(caseRecord, snapshot.pack.scope);
  const { supplierStatus } = caseRecord;
  if (supplierStatus.effectiveFrom !== null && supplierStatus.effectiveTo !== null && !contains(assessmentDate, supplierStatus.effectiveFrom, supplierStatus.effectiveTo)) {
    found.push(held('R01.case_supplier_interval_excludes_date', null, []));
  }

  const named = namedSupplierVersions(snapshot);
  const usable = readable(snapshot, 'supplier_status').filter((record) => named.includes(record.version));
  if (caseRecord.supplierStatusEvidenceId !== null && named.length === 0) {
    found.push(held('R01.supplier_record_not_supplied', null, []));
  } else if (usable.length === 0) {
    // D4: unverified, restricted or unreadable named evidence with no usable replacement.
    found.push(...candidates(named, 'R01.supplier_record'));
  }
  for (const record of usable) {
    if (record.body.supplierId !== caseRecord.supplierId) {
      found.push(held('R01.supplier_id_disagrees', null, [record.version]));
    }
    for (const [field, recordValue, caseValue] of SUPPLIER_FIELDS) {
      const stated = recordValue(record.body);
      const expected = caseValue(supplierStatus);
      if (!known(stated)) {
        found.push(held('R01.supplier_record_value_unknown', field, [record.version]));
      } else if (known(expected) && stated !== expected) {
        found.push(held('R01.supplier_record_disagrees', field, [record.version]));
      }
    }
    const { effectiveFrom, effectiveTo } = record.body;
    if (effectiveFrom !== null && effectiveTo !== null && !contains(assessmentDate, effectiveFrom, effectiveTo)) {
      found.push(held('R01.supplier_record_interval_excludes_date', null, [record.version]));
    }
  }

  // No code is inferred: only a stated case code is compared with stated order codes.
  const itemCode = caseRecord.itemCode;
  for (const order of readable(snapshot, 'order')) {
    if (itemCode !== null && order.body.item.code !== null && order.body.item.code !== itemCode) {
      found.push(held('R01.order_item_code_disagrees', null, [order.version]));
    }
  }
  return found;
}

// R02 and R09 report classification, which already ran on every supplied version.

function evaluateR02(snapshot: PreflightSnapshot): HeldConditionV2[] {
  return snapshot.versions.flatMap((version) =>
    version.classification.status === 'quarantined' ? version.classification.bases.map((basis) => held('R02.document_quarantined', basis, [version])) : [],
  );
}

function evaluateR09(snapshot: PreflightSnapshot): HeldConditionV2[] {
  return snapshot.versions.flatMap((version) => (version.classification.status === 'r09' ? [held(version.classification.conditionKey, null, [version])] : []));
}

// R03. Each current usable order is checked on its own, final or draft; one
// complete order never hides another's missing element.

const ORDER_VALUE_FIELDS: readonly EvidenceField[] = [
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

function missingElements(body: OrderBodyExact): ConditionField[] {
  const missing: ConditionField[] = [];
  if (body.beneficiary.name === null && body.beneficiary.identifier === null) {
    missing.push('element.beneficiary');
  }
  if (body.orderDate === null) {
    missing.push('element.order_date');
  }
  if (body.item.description === null) {
    missing.push('element.item_description');
  }
  if (body.item.quantity === null) {
    missing.push('element.quantity');
  }
  if (body.treatingPractitioner.name === null && body.treatingPractitioner.identifier === null) {
    missing.push('element.practitioner');
  }
  if (body.signature === null) {
    missing.push('element.signature');
  }
  return missing;
}

function evaluateR03(snapshot: PreflightSnapshot): HeldConditionV2[] {
  const orders = readable(snapshot, 'order');
  if (orders.length === 0) {
    const found = candidates(ofKind(snapshot, 'order'), 'R03.order');
    return found.length > 0 ? found : [held('R03.no_usable_order', null, [])];
  }
  return [
    ...orders.flatMap((order) => missingElements(order.body).map((element) => held('R03.element_missing', element, [order.version]))),
    ...ORDER_VALUE_FIELDS.flatMap((field) => disagreement('R03.orders_disagree', field, orders)),
  ];
}

// R04. Only final current usable encounters and orders are sequenced. With no
// final usable document of a kind, its candidates and its usable drafts are
// all reported, so a draft never hides a version that may be the final one.

function finalDocuments<B extends EncounterBodyExact | OrderBodyExact>(
  snapshot: PreflightSnapshot,
  usable: readonly Readable<B>[],
  kind: 'encounter' | 'order',
  prefix: 'R04.encounter' | 'R04.order',
): { final: Readable<B>[]; found: HeldConditionV2[] } {
  const final = usable.filter((document) => document.body.status === 'final');
  if (final.length > 0) {
    return { final, found: [] };
  }
  const found = [...candidates(ofKind(snapshot, kind), prefix), ...usable.map((draft) => held(`${prefix}_not_final`, null, [draft.version]))];
  return { final, found: found.length > 0 ? found : [held(kind === 'encounter' ? 'R04.no_usable_encounter' : 'R04.no_usable_order', null, [])] };
}

/** C02: the same date is sequenced only when both sources state explicit times placing the order strictly after completion. */
function sequencedSameDay(encounter: EncounterBodyExact, order: OrderBodyExact): boolean {
  const completed = encounter.completionTime === null ? undefined : instantOf(encounter.completionTime.timestamp);
  const ordered = order.orderTime === null ? undefined : instantOf(order.orderTime.timestamp);
  return completed !== undefined && ordered !== undefined && ordered > completed;
}

function evaluateR04(snapshot: PreflightSnapshot): HeldConditionV2[] {
  const encounters = finalDocuments(snapshot, readable(snapshot, 'encounter'), 'encounter', 'R04.encounter');
  const orders = finalDocuments(snapshot, readable(snapshot, 'order'), 'order', 'R04.order');
  const found = [...encounters.found, ...orders.found];

  for (const encounter of encounters.final) {
    if (encounter.body.encounterDate === null) {
      found.push(held('R04.date_not_stated', 'encounter.date', [encounter.version]));
    }
  }
  for (const order of orders.final) {
    if (order.body.orderDate === null) {
      found.push(held('R04.date_not_stated', 'order.date', [order.version]));
    }
  }
  found.push(...disagreement('R04.encounters_disagree', 'encounter.date', encounters.final), ...disagreement('R04.orders_disagree', 'order.date', orders.final));

  for (const encounter of encounters.final) {
    for (const order of orders.final) {
      const pair = [encounter.version, order.version];
      // C03: sameness by identifier only; a name never decides it.
      const [encounterPractitioner, orderPractitioner] = [encounter.body.practitioner.identifier, order.body.treatingPractitioner.identifier];
      if (encounterPractitioner === null || orderPractitioner === null) {
        found.push(held('R04.practitioner_identifier_absent', null, pair));
      } else if (encounterPractitioner !== orderPractitioner) {
        found.push(held('R04.practitioner_identifier_differs', null, pair));
      }
      const [encounterDate, orderDate] = [encounter.body.encounterDate, order.body.orderDate];
      if (encounterDate === null || orderDate === null) {
        continue;
      }
      const orderVsEncounter = compareIsoDates(orderDate, encounterDate);
      if (orderVsEncounter < 0) {
        found.push(held('R04.order_before_encounter', null, pair));
      } else if (orderVsEncounter === 0) {
        if (!sequencedSameDay(encounter.body, order.body)) {
          found.push(held('R04.same_day_unsequenced', null, pair));
        }
      } else if (compareIsoDates(orderDate, addCalendarMonths(encounterDate, ENCOUNTER_TO_ORDER_MONTHS)) > 0) {
        found.push(held('R04.order_after_bound', null, pair));
      }
    }
  }

  // C04: the LCMP branch is added to, and never suppresses, every other condition.
  found.push(...lcmpConditions(snapshot, 'R04'));
  return found;
}

function lcmpConditions(snapshot: PreflightSnapshot, ruleId: 'R04' | 'R07'): HeldConditionV2[] {
  const found = snapshot.caseRecord.lcmpIncorporated === true ? [held(`${ruleId}.lcmp_stated_by_case`, null, [])] : [];
  for (const encounter of readable(snapshot, 'encounter')) {
    if (encounter.body.lcmpReport.incorporated === true) {
      found.push(held(`${ruleId}.lcmp_stated_by_encounter`, null, [encounter.version]));
    }
  }
  return found;
}

// R05. Order-centred (C09): every current usable order needs a linked receipt
// that follows it, and every linked receipt is sequenced (C06).

/**
 * C06 for one linked receipt: certainly before the order when it precedes
 * the stated order timestamp or the start of the order date's span; not
 * sequenced at the same instant as the stated timestamp, within the inclusive
 * span when no timestamp is stated, or when the order states neither; else it
 * follows. A stated timestamp governs inside the span.
 */
export function receiptSequence(receivedAt: string, order: OrderBodyExact): 'before' | 'unsequenced' | 'follows' {
  const received = instantOf(receivedAt);
  const stated = order.orderTime === null ? undefined : instantOf(order.orderTime.timestamp);
  const span = order.orderDate === null ? undefined : orderDateSpan(order.orderDate);
  if (received === undefined) {
    return 'unsequenced';
  }
  if ((stated !== undefined && received < stated) || (span !== undefined && received < span.start)) {
    return 'before';
  }
  if (stated !== undefined) {
    return received === stated ? 'unsequenced' : 'follows';
  }
  return span === undefined || received <= span.end ? 'unsequenced' : 'follows';
}

function evaluateR05(snapshot: PreflightSnapshot): HeldConditionV2[] {
  const receipts = readable(snapshot, 'order_receipt');
  if (receipts.length === 0) {
    // No link is ever read from a candidate.
    const found = candidates(ofKind(snapshot, 'order_receipt'), 'R05.receipt');
    return found.length > 0 ? found : [held('R05.no_usable_receipt', null, [])];
  }
  const orders = readable(snapshot, 'order');
  if (orders.length === 0) {
    return [held('R05.no_usable_order', null, [])];
  }
  const found: HeldConditionV2[] = [];
  for (const order of orders) {
    const linked = receipts.filter(
      ({ body }) =>
        body.receivedAt !== null && body.orderReference !== null && body.orderReference.documentId === order.version.ref.documentId && body.orderReference.version === order.version.ref.version,
    );
    if (linked.length === 0) {
      found.push(held('R05.order_receipt_missing', null, [order.version]));
    }
    for (const receipt of linked) {
      const sequence = receipt.body.receivedAt === null ? 'unsequenced' : receiptSequence(receipt.body.receivedAt, order.body);
      if (sequence === 'before') {
        found.push(held('R05.receipt_before_order', null, [receipt.version, order.version]));
      } else if (sequence === 'unsequenced') {
        found.push(held('R05.receipt_unsequenced', null, [receipt.version, order.version]));
      }
    }
  }
  return found;
}

function evaluateR08(snapshot: PreflightSnapshot): HeldConditionV2[] {
  const { caseRecord, pack } = snapshot;
  return [
    ...(caseRecord.policyPackId !== pack.packId ? [held('R08.pack_id_differs', null, [])] : []),
    ...(!pack.supportedAssessmentDates.includes(caseRecord.assessmentDate) ? [held('R08.assessment_date_unsupported', null, [])] : []),
    ...(pack.reviewedAsOf === null ? [held('R08.pack_unreviewed', null, [])] : []),
    ...(pack.sourceRefs.length === 0 ? [held('R08.pack_unsourced', null, [])] : []),
  ];
}

/** Every condition each rule holds for a preflighted snapshot. */
export function evaluateRulesV2(snapshot: PreflightSnapshot): HeldConditionsByRule {
  return {
    R01: evaluateR01(snapshot),
    R02: evaluateR02(snapshot),
    R03: evaluateR03(snapshot),
    R04: evaluateR04(snapshot),
    R05: evaluateR05(snapshot),
    // Clinical questions always remain for qualified review, with or without clinical facts.
    R06: [held('R06.clinical_review', null, [])],
    R07: lcmpConditions(snapshot, 'R07'),
    R08: evaluateR08(snapshot),
    R09: evaluateR09(snapshot),
    // A pure assessment creates no request, approval or acceptance to protect.
    R10: [held('R10.pure_assessment', null, [])],
  };
}

/**
 * The versions whose facts a rule may cite (C05): the documents it
 * reads under C09. R01 reads the named supplier record and every order; R04
 * reads only final encounters and orders; R02 and R09 classify every version;
 * R08 and R10 read no document.
 */
export function documentsRead(ruleId: RuleId, snapshot: PreflightSnapshot): ReadonlySet<string> {
  const keys = (documents: readonly Readable<SourceDocumentBodyExact>[]) => documents.map((document) => refKey(document.version.ref));
  const named = new Set(namedSupplierVersions(snapshot));
  const finalOnly = (kind: 'encounter' | 'order') => readable(snapshot, kind).filter((document) => document.body.status === 'final');
  const every = (['order', 'encounter', 'order_receipt', 'supplier_status', 'supporting_note'] as const).flatMap((kind) => keys(readable(snapshot, kind)));
  const read: Record<RuleId, () => string[]> = {
    R01: () => [...keys(readable(snapshot, 'supplier_status').filter((record) => named.has(record.version))), ...keys(readable(snapshot, 'order'))],
    R02: () => every,
    R03: () => keys(readable(snapshot, 'order')),
    R04: () => [...keys(finalOnly('encounter')), ...keys(finalOnly('order'))],
    R05: () => [...keys(readable(snapshot, 'order_receipt')), ...keys(readable(snapshot, 'order'))],
    R06: () => keys(readable(snapshot, 'encounter')),
    R07: () => keys(readable(snapshot, 'encounter')),
    R08: () => [],
    R09: () => every,
    R10: () => [],
  };
  return new Set(read[ruleId]());
}
