import {
  type Case,
  type DocumentKind,
  type DocumentRef,
  type EncounterBody,
  type FindingStatus,
  type OrderBody,
  type OrderReceiptBody,
  type PolicyPack,
  type RuleId,
  type SupplierStatusBody,
} from '@pa/contracts';

import { addCalendarMonths, addDays, compareIsoDates, instantOf, utcInstantOn } from './calendar.js';
import { type AssessedDocument, isQuarantined, labelOf, refOf } from './documents.js';

/** One condition that held, at the status its pack outcome reports. */
export interface HeldCondition {
  status: FindingStatus;
  text: string;
  /** Documents this condition concerns but cannot cite through facts (C07). */
  documents?: readonly DocumentRef[];
}

export interface RuleEvaluation {
  held: HeldCondition[];
  /** R09 names every affected document whichever status it reports (C07). */
  namesEveryAffectedDocument?: boolean;
}

export interface RuleContext {
  caseRecord: Case;
  pack: PolicyPack;
  assessmentDate: string;
  documents: readonly AssessedDocument[];
}

/** Six calendar months from the encounter, inclusive (SPEC R04, pack convention C01). */
export const ENCOUNTER_TO_ORDER_MONTHS = 6;

type BodyOf<K extends DocumentKind> = Extract<
  OrderBody | EncounterBody | OrderReceiptBody | SupplierStatusBody,
  { documentKind: K }
>;

interface Usable<K extends DocumentKind> {
  document: AssessedDocument;
  body: BodyOf<K>;
}

const sameRef = (a: DocumentRef, b: DocumentRef) => a.documentId === b.documentId && a.version === b.version;

/** Documents of a metadata kind that R02 did not quarantine. */
const candidatesOf = (context: RuleContext, kind: DocumentKind) =>
  context.documents.filter((document) => document.meta.kind === kind && !isQuarantined(document));

function usableOf<K extends DocumentKind>(context: RuleContext, kind: K): Usable<K>[] {
  return candidatesOf(context, kind).flatMap((document) =>
    document.usable && document.provenance.status === 'valid' && document.provenance.body.documentKind === kind
      ? [{ document, body: document.provenance.body as BodyOf<K> }]
      : [],
  );
}

/** Usable documents that no other usable document supersedes. */
function unsuperseded<K extends DocumentKind>(context: RuleContext, kind: K): Usable<K>[] {
  const superseded = context.documents
    .filter((document) => document.usable)
    .flatMap((document) => (document.meta.supersedes === null ? [] : [document.meta.supersedes]));
  return usableOf(context, kind).filter(({ document }) => !superseded.some((ref) => sameRef(ref, refOf(document.meta))));
}

/**
 * With no usable document of a kind, the restricted, unreadable or failed
 * candidates set the dependent rule's status and are named by it (R09 table,
 * C07). A provenance failure maps to `failedStatus`.
 */
function unavailableCandidates(context: RuleContext, kind: DocumentKind, noun: string, failedStatus: FindingStatus): HeldCondition[] {
  return candidatesOf(context, kind).flatMap((document): HeldCondition[] => {
    const { provenance } = document;
    const documents = [refOf(document.meta)];
    switch (provenance.status) {
      case 'restricted':
        return [{ status: 'restricted', text: `the candidate ${noun} ${labelOf(document.meta)} is access restricted`, documents }];
      case 'unreadable':
        return [{ status: 'unreadable', text: `the candidate ${noun} ${labelOf(document.meta)} is unreadable (${provenance.reason})`, documents }];
      case 'provenance_failed':
        return [{ status: failedStatus, text: `the candidate ${noun} ${labelOf(document.meta)} failed provenance validation (${provenance.reason})`, documents }];
      case 'valid':
        return [];
    }
  });
}

const list = (values: readonly string[]) => values.join(', ');
const both = (values: readonly string[]) => values.join(' and ');

function evaluateR01(context: RuleContext): RuleEvaluation {
  const { caseRecord: c, pack, assessmentDate } = context;
  const scope = pack.scope;
  const held: HeldCondition[] = [];
  const conflict = (text: string) => held.push({ status: 'conflict', text });
  const missing = (text: string) => held.push({ status: 'missing', text });

  const enumFact = <T extends string>(name: string, value: T, supported: readonly T[]) => {
    if (value === 'unknown') {
      missing(`${name} is unknown`);
    } else if (!supported.includes(value)) {
      conflict(`${name} ${value} is outside the supported scope (${list(supported)})`);
    }
  };
  const flagFact = (name: string, value: boolean | null, supported: boolean) => {
    if (value === null) {
      missing(`${name} is not stated`);
    } else if (value !== supported) {
      conflict(`${name} is ${value}; the supported scope requires ${supported}`);
    }
  };

  enumFact('payerType', c.payerType, [scope.payerType]);
  flagFact('payerPrimary', c.payerPrimary, scope.payerPrimary);
  enumFact('beneficiaryState', c.beneficiaryState, scope.beneficiaryStates);
  enumFact('jurisdiction', c.jurisdiction, scope.jurisdictions);
  if (c.itemCode === null) {
    missing('itemCode is not stated');
  } else if (!scope.itemCodes.includes(c.itemCode)) {
    conflict(`itemCode ${c.itemCode} is outside the supported scope (${list(scope.itemCodes)})`);
  }
  enumFact('requestKind', c.requestKind, scope.requestKinds);
  enumFact('urgency', c.urgency, scope.urgencies);
  if (c.accessories === null) {
    missing('accessories are not stated');
  } else if (c.accessories.length > 0 && !scope.accessoriesPermitted) {
    conflict(`accessories are requested (${list(c.accessories)}); the supported scope has none`);
  }
  if (c.alreadyDelivered === null) {
    missing('alreadyDelivered is not stated');
  } else if (c.alreadyDelivered && !scope.alreadyDeliveredPermitted) {
    conflict('the item is stated as already delivered, which is outside the supported pre-delivery scope');
  }
  // A stated LCMP incorporation is not a scope failure; R07 routes it to human review.
  if (c.lcmpIncorporated === null) {
    missing('lcmpIncorporated is not stated');
  }

  const status = c.supplierStatus;
  enumFact('supplier status', status.status, scope.supplier.statuses);
  flagFact('supplier established', status.established, scope.supplier.established);
  flagFact('supplier newEnrollment', status.newEnrollment, scope.supplier.newEnrollment);
  flagFact('supplier ownershipChange', status.ownershipChange, scope.supplier.ownershipChange);
  const interval = (source: string, from: string | null, to: string | null) => {
    if (from === null) {
      missing(`${source} effectiveFrom is not stated`);
    } else if (compareIsoDates(from, assessmentDate) > 0) {
      conflict(`${source} is not yet effective on the assessment date ${assessmentDate} (effectiveFrom ${from})`);
    }
    if (to === null) {
      missing(`${source} effectiveTo is not stated`);
    } else if (compareIsoDates(to, assessmentDate) < 0) {
      conflict(`${source} expired before the assessment date ${assessmentDate} (effectiveTo ${to})`);
    }
  };
  interval('the case supplier status', status.effectiveFrom, status.effectiveTo);

  if (c.supplierStatusEvidenceId === null) {
    missing('no supplier status evidence record is named (supplierStatusEvidenceId is null)');
  } else {
    const evidenceId = c.supplierStatusEvidenceId;
    const records = context.documents.filter((document) => document.meta.documentId === evidenceId && document.meta.kind === 'supplier_status');
    const usable = usableOf(context, 'supplier_status').filter(({ document }) => document.meta.documentId === evidenceId);
    if (records.length === 0) {
      missing(`no supplier status record ${evidenceId} is supplied`);
    } else if (usable.length === 0) {
      // The pack gives R01 no review outcome, so a record that failed provenance
      // validation leaves no usable record (missing); R09 reports the failure.
      held.push(...unavailableCandidates({ ...context, documents: records }, 'supplier_status', 'supplier status record', 'missing'));
      missing(`no usable supplier status record ${evidenceId} is supplied`);
    }
    for (const { document, body } of usable) {
      const label = `supplier status record ${labelOf(document.meta)}`;
      if (body.supplierId !== c.supplierId) {
        conflict(`the case supplierId differs from the supplierId stated by ${label}`);
      }
      const pairs: [string, unknown, unknown][] = [
        ['status', status.status, body.status],
        ['established', status.established, body.established],
        ['newEnrollment', status.newEnrollment, body.newEnrollment],
        ['ownershipChange', status.ownershipChange, body.ownershipChange],
        ['effectiveFrom', status.effectiveFrom, body.effectiveFrom],
        ['effectiveTo', status.effectiveTo, body.effectiveTo],
      ];
      const differing = pairs.filter(([, stated, recorded]) => stated !== recorded).map(([name]) => name);
      if (differing.length > 0) {
        conflict(`the case supplier status differs from ${label} in ${list(differing)}`);
      }
      interval(label, body.effectiveFrom, body.effectiveTo);
    }
  }

  if (c.itemCode !== null) {
    for (const { document, body } of usableOf(context, 'order')) {
      if (body.item.code !== null && body.item.code !== c.itemCode) {
        conflict(`order ${labelOf(document.meta)} states item code ${body.item.code}, not the case item code ${c.itemCode}`);
      }
    }
  }
  held.push({ status: 'pass', text: 'every scope fact is explicit, supported and consistent with its bound evidence' });
  return { held };
}

function evaluateR02(context: RuleContext): RuleEvaluation {
  const held: HeldCondition[] = context.documents
    .filter(isQuarantined)
    .map((document) => ({
      status: 'conflict',
      text: `${labelOf(document.meta)} is quarantined because ${both(document.quarantineReasons)}; it contributes no facts`,
      documents: [refOf(document.meta)],
    }));
  const excluded = context.documents.filter((document) => !isQuarantined(document) && document.provenance.status === 'provenance_failed');
  const note = excluded.length > 0 ? `; ${list(excluded.map((document) => labelOf(document.meta)))} failed provenance validation, so R09 excludes it and its body was not compared` : '';
  held.push({ status: 'pass', text: `every subject-scoped document is bound to the case subject or exempt${note}` });
  return { held };
}

const ORDER_ELEMENTS: readonly [string, (body: OrderBody) => boolean][] = [
  ['the beneficiary name or identifier', (body) => body.beneficiary.name !== null || body.beneficiary.identifier !== null],
  ['the order date', (body) => body.orderDate !== null],
  ['an item description', (body) => body.item.description !== null],
  ['a quantity', (body) => body.item.quantity !== null],
  ['the treating practitioner name or identifier', (body) => body.treatingPractitioner.name !== null || body.treatingPractitioner.identifier !== null],
  ['signature metadata', (body) => body.signature !== null],
];

const ORDER_VALUES: readonly [string, (body: OrderBody) => unknown][] = [
  ['beneficiary name', (body) => body.beneficiary.name],
  ['beneficiary identifier', (body) => body.beneficiary.identifier],
  ['order date', (body) => body.orderDate],
  ['item description', (body) => body.item.description],
  ['quantity', (body) => body.item.quantity],
  ['practitioner name', (body) => body.treatingPractitioner.name],
  ['practitioner identifier', (body) => body.treatingPractitioner.identifier],
  ['signer name', (body) => body.signature?.signerName ?? null],
  ['signed date', (body) => body.signature?.signedDate ?? null],
];

function alternativesUsed(body: OrderBody): string {
  const notes: string[] = [];
  if (body.beneficiary.identifier === null) {
    notes.push('the beneficiary is named without an identifier, and the name alternative suffices');
  } else if (body.beneficiary.name === null) {
    notes.push('the beneficiary is identified without a name, and the identifier alternative suffices');
  }
  if (body.treatingPractitioner.identifier === null) {
    notes.push('the practitioner is named without an identifier, and the name alternative suffices');
  } else if (body.treatingPractitioner.name === null) {
    notes.push('the practitioner is identified without a name, and the identifier alternative suffices');
  }
  return notes.length > 0 ? `; ${notes.join('; ')}` : '';
}

/** Different stated (non-null) values for one element across orders or encounters. */
function disagreements<T>(items: readonly { body: T }[], values: readonly [string, (body: T) => unknown][]): string[] {
  return values.flatMap(([name, read]) => {
    const stated = new Set(items.map(({ body }) => read(body)).filter((value) => value !== null));
    return stated.size > 1 ? [name] : [];
  });
}

function evaluateR03(context: RuleContext): RuleEvaluation {
  const held: HeldCondition[] = [];
  const orders = unsuperseded(context, 'order');
  if (orders.length === 0) {
    held.push(...unavailableCandidates(context, 'order', 'order', 'manual_review'));
    held.push({ status: 'missing', text: 'no bound, usable order is supplied' });
    return { held };
  }
  if (orders.length > 1) {
    const differing = disagreements(orders, ORDER_VALUES);
    if (differing.length > 0) {
      held.push({ status: 'conflict', text: `orders ${list(orders.map(({ document }) => labelOf(document.meta)))} state different ${list(differing)}` });
    }
  }
  const complete = orders.find(({ body }) => ORDER_ELEMENTS.every(([, present]) => present(body)));
  if (complete === undefined) {
    for (const { document, body } of orders) {
      const absent = ORDER_ELEMENTS.filter(([, present]) => !present(body)).map(([name]) => name);
      held.push({ status: 'missing', text: `order ${labelOf(document.meta)} does not state ${list(absent)}` });
    }
  } else {
    held.push({
      status: 'pass',
      text: `order ${labelOf(complete.document.meta)} states every required element${alternativesUsed(complete.body)}; signature metadata only shows that the document claims a signature`,
    });
  }
  return { held };
}

/** LCMP incorporation stated by the case or a bound, usable encounter (R07, C04). */
function lcmpStated(context: RuleContext): string[] {
  const sources: string[] = [];
  if (context.caseRecord.lcmpIncorporated === true) {
    sources.push('the case');
  }
  for (const { document, body } of usableOf(context, 'encounter')) {
    if (body.lcmpReport.incorporated === true) {
      sources.push(`encounter ${labelOf(document.meta)}`);
    }
  }
  return sources;
}

function evaluateR04(context: RuleContext): RuleEvaluation {
  const held: HeldCondition[] = [];
  const lcmp = lcmpStated(context);
  if (lcmp.length > 0) {
    held.push({ status: 'manual_review', text: `${both(lcmp)} ${lcmp.length > 1 ? 'state' : 'states'} that an LCMP report is incorporated, so the encounter date does not settle chronology automatically (C04)` });
  }
  const encounters = unsuperseded(context, 'encounter');
  const orders = unsuperseded(context, 'order');
  for (const [items, kind, noun] of [
    [encounters, 'encounter', 'encounter'],
    [orders, 'order', 'order'],
  ] as const) {
    if (items.length === 0) {
      held.push(...unavailableCandidates(context, kind, noun, 'manual_review'));
      held.push({ status: 'missing', text: `no bound, usable ${noun} is supplied` });
    }
    for (const { document, body } of items) {
      if (body.status !== 'final') {
        held.push({ status: 'missing', text: `${noun} ${labelOf(document.meta)} is not final (${body.status})` });
      }
    }
  }
  const finalEncounters = encounters.filter(({ body }) => body.status === 'final');
  const finalOrders = orders.filter(({ body }) => body.status === 'final');
  if (disagreements(finalEncounters, [['encounter date', (body) => body.encounterDate]]).length > 0) {
    held.push({ status: 'conflict', text: `final encounters ${list(finalEncounters.map(({ document }) => labelOf(document.meta)))} state different encounter dates` });
  }
  if (disagreements(finalOrders, [['order date', (body) => body.orderDate]]).length > 0) {
    held.push({ status: 'conflict', text: `final orders ${list(finalOrders.map(({ document }) => labelOf(document.meta)))} state different order dates` });
  }

  for (const encounter of finalEncounters) {
    for (const order of finalOrders) {
      const pair = `encounter ${labelOf(encounter.document.meta)} and order ${labelOf(order.document.meta)}`;
      const encounterPractitioner = encounter.body.practitioner.identifier;
      const orderPractitioner = order.body.treatingPractitioner.identifier;
      if (encounterPractitioner === null || orderPractitioner === null) {
        held.push({ status: 'manual_review', text: `${pair}: a practitioner identifier is not stated, and sameness is not decided by name (C03)` });
      } else if (encounterPractitioner !== orderPractitioner) {
        held.push({ status: 'conflict', text: `${pair} name different practitioner identifiers` });
      }
      const { encounterDate } = encounter.body;
      const { orderDate } = order.body;
      if (encounterDate === null) {
        held.push({ status: 'missing', text: `encounter ${labelOf(encounter.document.meta)} states no encounter date` });
      }
      if (orderDate === null) {
        held.push({ status: 'missing', text: `order ${labelOf(order.document.meta)} states no order date` });
      }
      if (encounterDate === null || orderDate === null) {
        continue;
      }
      const bound = addCalendarMonths(encounterDate, ENCOUNTER_TO_ORDER_MONTHS);
      const orderVsEncounter = compareIsoDates(orderDate, encounterDate);
      if (orderVsEncounter < 0) {
        held.push({ status: 'conflict', text: `${pair}: the order date ${orderDate} precedes the encounter date ${encounterDate}` });
      } else if (compareIsoDates(orderDate, bound) > 0) {
        held.push({ status: 'conflict', text: `${pair}: the order date ${orderDate} is after the six-calendar-month bound ${bound} (C01)` });
      } else if (orderVsEncounter === 0) {
        const completed = encounter.body.completionTime === null ? undefined : instantOf(encounter.body.completionTime.timestamp);
        const ordered = order.body.orderTime === null ? undefined : instantOf(order.body.orderTime.timestamp);
        if (completed !== undefined && ordered !== undefined && ordered > completed) {
          held.push({ status: 'pass', text: `${pair} share the date ${orderDate}, and explicit times place the order after encounter completion (C02)` });
        } else {
          held.push({ status: 'manual_review', text: `${pair} share the date ${orderDate} without explicit times placing the order after encounter completion; no time is inferred (C02)` });
        }
      } else {
        held.push({ status: 'pass', text: `${pair}: the order date ${orderDate} follows the encounter date ${encounterDate} within the inclusive bound ${bound} (C01), with the same practitioner identifier` });
      }
    }
  }
  return { held };
}

/** Order date span across time zones (C06): previous day 10:00 UTC to next day 12:00 UTC. */
export function orderDateSpan(orderDate: string): { start: bigint; end: bigint } {
  return { start: utcInstantOn(addDays(orderDate, -1), '10:00:00'), end: utcInstantOn(addDays(orderDate, 1), '12:00:00') };
}

function evaluateR05(context: RuleContext): RuleEvaluation {
  const held: HeldCondition[] = [];
  const receipts = unsuperseded(context, 'order_receipt');
  if (receipts.length === 0) {
    held.push(...unavailableCandidates(context, 'order_receipt', 'receipt record', 'manual_review'));
    held.push({ status: 'missing', text: 'no bound, usable supplier receipt record is supplied; nothing is concluded about delivery' });
    return { held };
  }
  const orders = unsuperseded(context, 'order');
  const linked = receipts.flatMap((receipt) => {
    const reference = receipt.body.orderReference;
    const order = reference === null ? undefined : orders.find(({ document }) => sameRef(refOf(document.meta), reference));
    return order === undefined || receipt.body.receivedAt === null ? [] : [{ receipt, order, receivedAt: receipt.body.receivedAt }];
  });
  if (linked.length === 0) {
    for (const { document, body } of receipts) {
      const reasons = [
        ...(body.orderReference === null ? ['references no order'] : []),
        ...(body.orderReference !== null && !orders.some(({ document: order }) => sameRef(refOf(order.meta), body.orderReference as DocumentRef))
          ? ['does not reference a bound, usable order by ID and version']
          : []),
        ...(body.receivedAt === null ? ['states no receipt time'] : []),
      ];
      held.push({ status: 'missing', text: `receipt record ${labelOf(document.meta)} ${list(reasons)}` });
    }
    return { held };
  }
  for (const { receipt, order, receivedAt } of linked) {
    const pair = `receipt ${labelOf(receipt.document.meta)} for order ${labelOf(order.document.meta)}`;
    const received = instantOf(receivedAt);
    const stated = order.body.orderTime;
    const orderedAt = stated === null ? undefined : instantOf(stated.timestamp);
    if (received === undefined) {
      held.push({ status: 'manual_review', text: `${pair}: the receipt time cannot be read as an instant, so the sequence is not established` });
    } else if (stated !== null && orderedAt !== undefined) {
      if (received < orderedAt) {
        held.push({ status: 'conflict', text: `${pair}: received at ${receivedAt}, before the stated order time ${stated.timestamp} (C06)` });
      } else if (received === orderedAt) {
        // Neither before nor after the order, so the sequence is ambiguous (pack limitations).
        held.push({ status: 'manual_review', text: `${pair}: received at ${receivedAt}, the same instant as the stated order time ${stated.timestamp}, so the sequence is not established (C06)` });
      } else {
        held.push({ status: 'pass', text: `${pair}: received at ${receivedAt}, after the stated order time ${stated.timestamp} (C06)` });
      }
    } else if (order.body.orderDate === null) {
      held.push({ status: 'manual_review', text: `${pair}: the order states no date or readable time, so the sequence is not established (C06)` });
    } else {
      const span = orderDateSpan(order.body.orderDate);
      if (received < span.start) {
        held.push({ status: 'conflict', text: `${pair}: received at ${receivedAt}, before the order date ${order.body.orderDate} begins in any time zone (C06)` });
      } else if (received <= span.end) {
        held.push({ status: 'manual_review', text: `${pair}: received at ${receivedAt}, within the order date ${order.body.orderDate} across time zones, and the order states no time (C06)` });
      } else {
        held.push({ status: 'pass', text: `${pair}: received at ${receivedAt}, after the order date ${order.body.orderDate} in every time zone (C06)` });
      }
    }
  }
  return { held };
}

function evaluateR06(context: RuleContext): RuleEvaluation {
  const sources = context.documents.filter(
    (document) => document.usable && document.provenance.status === 'valid' && document.provenance.values.some(({ field }) => field.startsWith('clinical.')),
  );
  const text =
    sources.length > 0
      ? `clinical statements in ${list(sources.map((document) => labelOf(document.meta)))} are evidence candidates for qualified clinical review; no medical necessity conclusion is drawn, and they neither block nor satisfy administrative readiness`
      : 'no bound, usable document states a clinical fact; an unavailable record is not evidence that a clinical fact is absent, and clinical questions remain for qualified review';
  return { held: [{ status: 'manual_review', text }] };
}

function evaluateR07(context: RuleContext): RuleEvaluation {
  const { requestKinds, itemCodes } = context.pack.scope;
  const lcmp = lcmpStated(context);
  const held: HeldCondition[] = [];
  if (lcmp.length > 0) {
    held.push({ status: 'manual_review', text: `${both(lcmp)} ${lcmp.length > 1 ? 'state' : 'states'} that an LCMP report is incorporated, an unsupported automatic branch routed to human review` });
  }
  held.push({
    status: 'pass',
    text: `no LCMP incorporation is stated; no ATP evaluation, specialty evaluation, home assessment or proof of delivery is required for ${requestKinds.join(' or ')} ${itemCodes.join(' or ')} packets`,
  });
  return { held };
}

function evaluateR08(context: RuleContext): RuleEvaluation {
  const { caseRecord, pack, assessmentDate } = context;
  const held: HeldCondition[] = [];
  if (caseRecord.policyPackId !== pack.packId) {
    held.push({ status: 'conflict', text: `the case names policy pack ${caseRecord.policyPackId}, not ${pack.packId}` });
  }
  if (!pack.supportedAssessmentDates.includes(assessmentDate)) {
    held.push({ status: 'conflict', text: `the assessment date ${assessmentDate} is not a supported assessment date (${list(pack.supportedAssessmentDates)})` });
  }
  if (pack.reviewedAsOf === null) {
    held.push({ status: 'missing', text: 'the policy pack has no reviewed date' });
  }
  if (pack.sourceRefs.length === 0) {
    held.push({ status: 'missing', text: 'the policy pack has no source references' });
  }
  held.push({ status: 'pass', text: `the case names pack ${pack.packId} version ${pack.version}, reviewed as of ${pack.reviewedAsOf ?? 'never'}, for the supported assessment date ${assessmentDate}` });
  return { held };
}

function evaluateR09(context: RuleContext): RuleEvaluation {
  const held: HeldCondition[] = [];
  for (const document of context.documents) {
    if (isQuarantined(document)) {
      continue;
    }
    const { provenance } = document;
    const documents = [refOf(document.meta)];
    const label = labelOf(document.meta);
    if (provenance.status === 'provenance_failed') {
      held.push({ status: 'conflict', text: `${label} failed provenance validation: ${provenance.reason}; it and all its facts are excluded`, documents });
    } else if (provenance.status === 'restricted') {
      held.push({ status: 'restricted', text: `${label} is access restricted; this is not evidence that any fact is absent`, documents });
    } else if (provenance.status === 'unreadable') {
      held.push({ status: 'unreadable', text: `${label} is unreadable (${provenance.reason}); this is not evidence that any fact is absent`, documents });
    }
  }
  held.push({
    status: 'pass',
    text: 'every document not quarantined by R02 is available, of a supported MIME type, matches its contentHash, parses for its kind and its locators resolve',
  });
  return { held, namesEveryAffectedDocument: true };
}

function evaluateR10(): RuleEvaluation {
  return {
    held: [{ status: 'not_applicable', text: 'a pure assessment creates no request, approval or acceptance; the durable workflow enforces this rule' }],
  };
}

/**
 * Every status each evaluator can report. A pack must give each rule an outcome
 * for all of them, so that no condition that held is dropped (and no blocker
 * silently becomes a pass) under a pack other than the one these rules follow.
 */
export const EVALUATOR_STATUSES: Readonly<Record<RuleId, readonly FindingStatus[]>> = {
  R01: ['conflict', 'restricted', 'unreadable', 'missing', 'pass'],
  R02: ['conflict', 'pass'],
  R03: ['conflict', 'manual_review', 'restricted', 'unreadable', 'missing', 'pass'],
  R04: ['conflict', 'manual_review', 'restricted', 'unreadable', 'missing', 'pass'],
  R05: ['conflict', 'manual_review', 'restricted', 'unreadable', 'missing', 'pass'],
  R06: ['manual_review'],
  R07: ['manual_review', 'pass'],
  R08: ['conflict', 'missing', 'pass'],
  R09: ['conflict', 'restricted', 'unreadable', 'pass'],
  R10: ['not_applicable'],
};

export const RULE_EVALUATORS: Readonly<Record<RuleId, (context: RuleContext) => RuleEvaluation>> = {
  R01: evaluateR01,
  R02: evaluateR02,
  R03: evaluateR03,
  R04: evaluateR04,
  R05: evaluateR05,
  R06: evaluateR06,
  R07: evaluateR07,
  R08: evaluateR08,
  R09: evaluateR09,
  R10: evaluateR10,
};
