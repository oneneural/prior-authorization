import { type OrderBody } from '@pa/contracts';
import { describe, expect, it } from 'vitest';

import {
  assessed,
  citationsOf,
  conditionsOf,
  declaredUnreadable,
  encounter,
  order,
  parentOf,
  plainText,
  receipt,
  restricted,
  routingOf,
  sorted,
  supplier,
  tampered,
} from '../../test/builders-assess-v2.js';
import { bytesOf, documentV2, orderBody, SUBJECT_ID, SUBJECT_NAME } from '../../test/builders-v2.js';

// R03 through `assessV2`: every current usable order, final or draft, is
// checked on its own (C09); elements are never combined across orders, and
// stated values compare exactly as accepted (D1).

const base = orderBody();
const others = async () => [await encounter(), await receipt(), await supplier()];

describe('R03 required elements per order', () => {
  const ELEMENTS: [string, Partial<OrderBody>][] = [
    ['element.beneficiary', { beneficiary: { name: null, identifier: null } }],
    ['element.order_date', { orderDate: null }],
    ['element.item_description', { item: { ...base.item, description: null } }],
    ['element.quantity', { item: { ...base.item, quantity: null } }],
    ['element.practitioner', { treatingPractitioner: { name: null, identifier: null } }],
    ['element.signature', { signature: null }],
  ];
  const MATRIX = ELEMENTS.flatMap(([element, body]) => (['final', 'draft'] as const).map((status) => [element, status, body] as const));

  it.each(MATRIX)('holds element_missing for %s on a %s order and names it, with no parent', async (element, status, body) => {
    const result = await assessed([await order('order', { ...body, status }), ...(await others())]);
    expect(conditionsOf(result, 'R03')).toEqual([`R03.element_missing|${element}|order@1`]);
    expect(routingOf(result, 'R03')).toBe('missing/authorization_coordinator');
    expect(parentOf(result, 'R03')).toEqual([]);
  });

  it.each([
    ['a beneficiary name alone', { beneficiary: { name: SUBJECT_NAME, identifier: null } }],
    ['a beneficiary identifier alone', { beneficiary: { name: null, identifier: SUBJECT_ID } }],
    ['a practitioner name alone', { treatingPractitioner: { name: 'Casey Example, MD (synthetic)', identifier: null } }],
    ['a practitioner identifier alone', { treatingPractitioner: { name: null, identifier: 'SYN-PRAC-0001' } }],
  ])('accepts %s for an element with permitted alternatives', async (_label, body) => {
    const result = await assessed([await order('order', body), ...(await others())]);
    expect(conditionsOf(result, 'R03')).toEqual([]);
  });

  it('checks every order separately: a complete order never hides another order missing elements', async () => {
    const result = await assessed([await order('order'), await order('order-2', { signature: null, item: { ...base.item, description: null } }), ...(await others())]);
    expect(conditionsOf(result, 'R03')).toEqual(['R03.element_missing|element.item_description|order-2@1', 'R03.element_missing|element.signature|order-2@1']);
  });

  it('never pools elements across orders', async () => {
    const result = await assessed([await order('order-a', { signature: null }), await order('order-b', { item: { ...base.item, description: null } }), ...(await others())]);
    expect(conditionsOf(result, 'R03')).toEqual(['R03.element_missing|element.item_description|order-b@1', 'R03.element_missing|element.signature|order-a@1']);
  });

  it('cites every order evidence field from every current usable order, final or draft', async () => {
    const result = await assessed([await order('order'), await order('order-draft', { status: 'draft' }), ...(await others())]);
    const locators = ['/beneficiary/identifier', '/beneficiary/name', '/item/description', '/item/quantity', '/orderDate', '/signature/signedDate', '/signature/signerName', '/treatingPractitioner/identifier', '/treatingPractitioner/name'];
    expect(citationsOf(result, 'R03')).toEqual(sorted(['order', 'order-draft'].flatMap((documentId) => locators.map((locator) => `${documentId}@1${locator}`))));
  });
});

describe('R03 disagreement between current usable orders', () => {
  const FIELDS: [string, Partial<OrderBody>][] = [
    ['order.date', { orderDate: '2026-09-03' }],
    ['order.item_description', { item: { ...base.item, description: 'Power wheelchair, standard base (synthetic test, revised)' } }],
    ['order.quantity', { item: { ...base.item, quantity: 2 } }],
    ['order.practitioner_name', { treatingPractitioner: { ...base.treatingPractitioner, name: 'Jordan Sample, MD (synthetic)' } }],
    ['order.practitioner_identifier', { treatingPractitioner: { ...base.treatingPractitioner, identifier: 'SYN-PRAC-0002' } }],
    ['order.signature_signer_name', { signature: { signerName: `${base.signature?.signerName ?? ''} `, signedDate: '2026-09-02' } }],
    ['order.signature_date', { signature: { signerName: base.signature?.signerName ?? '', signedDate: '2026-09-03' } }],
  ];

  it.each(FIELDS)('holds orders_disagree for two different stated %s values and names both orders', async (field, body) => {
    const result = await assessed([await order('order'), await order('order-2', { ...body, status: 'draft' }), ...(await others())]);
    expect(conditionsOf(result, 'R03')).toEqual([`R03.orders_disagree|${field}|order@1,order-2@1`]);
    expect(routingOf(result, 'R03')).toBe('conflict/administrative_reviewer');
    expect(parentOf(result, 'R03')).toEqual([]);
  });

  it('keeps signer whitespace exactly as written in its fact', async () => {
    const result = await assessed([await order('order', { signature: { signerName: '  Casey Example, MD (synthetic)', signedDate: '2026-09-02' } }), ...(await others())]);
    const fact = result.evidenceFacts.find((candidate) => candidate.field === 'order.signature_signer_name');
    expect(fact?.originalText).toBe('  Casey Example, MD (synthetic)');
  });

  it('names every order stating a value, and treats a stated value beside null as no disagreement', async () => {
    const result = await assessed([
      await order('order-a'),
      await order('order-b'),
      await order('order-c', { item: { ...base.item, quantity: 3 } }),
      await order('order-d', { item: { ...base.item, quantity: null } }),
      await order('order-e', { treatingPractitioner: { ...base.treatingPractitioner, name: null } }),
      ...(await others()),
    ]);
    expect(conditionsOf(result, 'R03')).toEqual(['R03.element_missing|element.quantity|order-d@1', 'R03.orders_disagree|order.quantity|order-a@1,order-b@1,order-c@1,order-e@1']);
  });

  it('compares number values, not their tokens, while keeping the token as written', async () => {
    const text = new TextDecoder().decode(bytesOf(orderBody())).replace('"quantity": 1', '"quantity": 1.0');
    const token = await documentV2('order-token.v1', 'order-token', new TextEncoder().encode(text), { meta: { kind: 'order' } });
    const result = await assessed([await order('order'), token, ...(await others())]);
    expect(conditionsOf(result, 'R03')).toEqual([]);
    const fact = result.evidenceFacts.find((candidate) => candidate.documentId === 'order-token' && candidate.field === 'order.quantity');
    expect([fact?.value, fact?.originalText]).toEqual([1, '1.0']);
  });

  it.each([
    ['order.beneficiary_name', { beneficiary: { name: 'Another Person', identifier: SUBJECT_ID } }, 'binding.stated_name'],
    ['order.beneficiary_identifier', { beneficiary: { name: SUBJECT_NAME, identifier: 'SYN-BEN-T99' } }, 'binding.stated_identifier'],
  ])('cannot reach orders_disagree on %s: R02 quarantines the differing version first', async (_field, body, basis) => {
    const result = await assessed([await order('order'), await order('order-2', body), ...(await others())]);
    expect(conditionsOf(result, 'R02')).toEqual([`R02.document_quarantined|${basis}|order-2@1`]);
    expect(conditionsOf(result, 'R03')).toEqual([]);
  });
});

describe('R03 with no current usable order (C09 candidates)', () => {
  const CANDIDATES: [string, Parameters<typeof order>[2], string, string][] = [
    ['restricted', restricted(), 'R03.order_restricted', 'restricted/authorization_coordinator'],
    ['declared unreadable', declaredUnreadable(), 'R03.order_unreadable', 'unreadable/authorization_coordinator'],
    ['of an unsupported MIME type', plainText(), 'R03.order_unreadable', 'unreadable/authorization_coordinator'],
    ['failed provenance', tampered(), 'R03.order_failed_provenance', 'manual_review/administrative_reviewer'],
  ];

  it.each(CANDIDATES)('reports a %s candidate instead of an absence and names it', async (_label, options, key, routing) => {
    const result = await assessed([await order('order', {}, options), ...(await others())]);
    expect(conditionsOf(result, 'R03')).toEqual([`${key}|-|order@1`]);
    expect(routingOf(result, 'R03')).toBe(routing);
    expect(parentOf(result, 'R03')).toEqual(['order@1']);
  });

  it.each(CANDIDATES)('reports no candidate for a %s version beside a current usable order', async (_label, options) => {
    const result = await assessed([await order('order-x', {}, options), await order('order'), ...(await others())]);
    expect(conditionsOf(result, 'R03')).toEqual([]);
  });

  it('keeps every candidate and names only those at the selected status', async () => {
    const result = await assessed([await order('order-a', {}, restricted()), await order('order-b', {}, tampered()), ...(await others())]);
    expect(conditionsOf(result, 'R03')).toEqual(['R03.order_failed_provenance|-|order-b@1', 'R03.order_restricted|-|order-a@1']);
    expect(routingOf(result, 'R03')).toBe('manual_review/administrative_reviewer');
    expect(parentOf(result, 'R03')).toEqual(['order-b@1']);
  });

  it('reports no_usable_order with no order, with a quarantined order only, or with a superseded candidate only', async () => {
    const none = await assessed(await others());
    expect(conditionsOf(none, 'R03')).toEqual(['R03.no_usable_order|-|']);
    expect(routingOf(none, 'R03')).toBe('missing/authorization_coordinator');

    const quarantined = await assessed([await order('order', {}, restricted({ meta: { subjectId: 'SYN-BEN-T99' } })), ...(await others())]);
    expect(conditionsOf(quarantined, 'R03')).toEqual(['R03.no_usable_order|-|']);

    const superseded = await assessed([
      await order('order', {}, restricted()),
      await order('order', { beneficiary: { name: 'Another Person', identifier: SUBJECT_ID } }, { version: 2, meta: { supersedes: { documentId: 'order', version: 1 } } }),
      ...(await others()),
    ]);
    expect(conditionsOf(superseded, 'R03')).toEqual(['R03.no_usable_order|-|']);
    expect(parentOf(superseded, 'R03')).toEqual([]);
  });
});
