import { type OrderBody, type OrderReceiptBody } from '@pa/contracts';
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
  READY,
  receipt,
  restricted,
  routingOf,
  sorted,
  statusesOf,
  supplier,
  tampered,
} from '../../test/builders-assess-v2.js';
import { documentV2 } from '../../test/builders-v2.js';

// R05 through `assessV2`: order-centred exact-version links (C09) and
// receipt sequencing (C06). A date-only order spans (date - 1) 10:00Z to
// (date + 1) 12:00Z inclusive; a stated order timestamp governs inside it, and
// a receipt at the stated instant is unsequenced. The default order is dated
// 2026-09-02 with no stated time.

const at = (timestamp: string) => ({ timestamp, timeZone: 'America/Los_Angeles' });
const r05 = async (receiptBody: Partial<OrderReceiptBody>, orderBody: Partial<OrderBody> = {}) =>
  conditionsOf(await assessed([await order('order', orderBody), await encounter(), await receipt('receipt', receiptBody), await supplier()]), 'R05');
const BEFORE = ['R05.receipt_before_order|-|order@1,receipt@1'];
const UNSEQUENCED = ['R05.receipt_unsequenced|-|order@1,receipt@1'];

describe('R05 sequencing against a date-only order span', () => {
  const SPAN: [string, string, string[]][] = [
    ['just before the span start', '2026-09-01T09:59:59Z', BEFORE],
    ['at the inclusive span start', '2026-09-01T10:00:00Z', UNSEQUENCED],
    ['inside the span', '2026-09-02T12:00:00Z', UNSEQUENCED],
    ['at the inclusive span end', '2026-09-03T12:00:00Z', UNSEQUENCED],
    ['just after the span end', '2026-09-03T12:00:01Z', []],
    ['well after the span', '2026-09-10T08:00:00Z', []],
  ];

  it.each(SPAN)('judges a receipt %s', async (_label, receivedAt, expected) => {
    expect(await r05({ receivedAt })).toEqual(expected);
  });

  it('routes a receipt before the order to a conflict and an unsequenced one to manual review', async () => {
    const before = await assessed([await order(), await encounter(), await receipt('receipt', { receivedAt: '2026-08-30T00:00:00Z' }), await supplier()]);
    expect(routingOf(before, 'R05')).toBe('conflict/administrative_reviewer');
    expect(statusesOf(before)).toEqual({ ...READY, state: 'needs_human_review', R05: 'conflict' });
    const unsequenced = await assessed([await order(), await encounter(), await receipt('receipt', { receivedAt: '2026-09-02T00:00:00Z' }), await supplier()]);
    expect(routingOf(unsequenced, 'R05')).toBe('manual_review/administrative_reviewer');
    expect(parentOf(unsequenced, 'R05')).toEqual([]);
  });
});

describe('R05 sequencing against a stated order timestamp', () => {
  // 2026-09-02T09:00:00-07:00 is 16:00:00Z, inside the span.
  const timed = { orderTime: at('2026-09-02T09:00:00-07:00') };
  const STATED: [string, string, string[]][] = [
    ['one second before the stated instant', '2026-09-02T15:59:59Z', BEFORE],
    ['at the stated instant', '2026-09-02T16:00:00Z', UNSEQUENCED],
    ['one second after the stated instant, inside the span', '2026-09-02T16:00:01Z', []],
    ['before the span start', '2026-09-01T09:00:00Z', BEFORE],
  ];

  it.each(STATED)('judges a receipt %s', async (_label, receivedAt, expected) => {
    expect(await r05({ receivedAt }, timed)).toEqual(expected);
  });

  it('compares instants, not wall clocks, for an order time in another offset', async () => {
    const offset = { orderTime: { timestamp: '2026-09-02T21:30:00+05:30', timeZone: 'Asia/Kolkata' } };
    expect(await r05({ receivedAt: '2026-09-02T16:00:00Z' }, offset)).toEqual(UNSEQUENCED);
    expect(await r05({ receivedAt: '2026-09-02T16:00:01Z' }, offset)).toEqual([]);
  });

  it('accepts only UTC receipt times: an offset receipt time is an invalid body', async () => {
    expect(await r05({ receivedAt: '2026-09-02T12:00:00-04:00' }, timed)).toEqual(['R05.receipt_unreadable|-|receipt@1']);
  });

  it('judges a stated timestamp outside its own date span conflict-first', async () => {
    // A timestamp days before its order date: a receipt after the timestamp but before the span start is still before the order.
    expect(await r05({ receivedAt: '2026-08-30T00:00:00Z' }, { orderTime: at('2026-08-25T10:00:00Z') })).toEqual(BEFORE);
    expect(await r05({ receivedAt: '2026-09-01T10:00:00Z' }, { orderTime: at('2026-08-25T10:00:00Z') })).toEqual([]);
  });

  it('sequences by the stated timestamp alone when the order states no date', async () => {
    expect(await r05({ receivedAt: '2026-09-02T16:00:01Z' }, { ...timed, orderDate: null })).toEqual([]);
    expect(await r05({ receivedAt: '2026-09-02T16:00:00Z' }, { ...timed, orderDate: null })).toEqual(UNSEQUENCED);
    expect(await r05({ receivedAt: '2026-09-02T15:00:00Z' }, { ...timed, orderDate: null })).toEqual(BEFORE);
  });

  it('cannot sequence a receipt against an order stating neither date nor timestamp', async () => {
    expect(await r05({ receivedAt: '2027-01-01T00:00:00Z' }, { orderDate: null, orderTime: null })).toEqual(UNSEQUENCED);
  });
});

describe('R05 exact-version links', () => {
  const MISSING = ['R05.order_receipt_missing|-|order@1'];
  const LINKS: [string, Partial<OrderReceiptBody>][] = [
    ['another document ID', { orderReference: { documentId: 'order-other', version: 1 } }],
    ['another version', { orderReference: { documentId: 'order', version: 2 } }],
    ['no order reference', { orderReference: null }],
    ['no received time', { receivedAt: null }],
  ];

  it.each(LINKS)('links a receipt with %s to nothing', async (_label, body) => {
    const result = await assessed([await order(), await encounter(), await receipt('receipt', body), await supplier()]);
    expect(conditionsOf(result, 'R05')).toEqual(MISSING);
    expect(routingOf(result, 'R05')).toBe('missing/authorization_coordinator');
    expect(parentOf(result, 'R05')).toEqual([]);
  });

  it('requires a linked receipt for every current usable order, draft included', async () => {
    const result = await assessed([
      await order('order-a'),
      await order('order-b', { status: 'draft' }),
      await encounter(),
      await receipt('receipt', { orderReference: { documentId: 'order-a', version: 1 } }),
      await supplier(),
    ]);
    expect(conditionsOf(result, 'R05')).toEqual(['R05.order_receipt_missing|-|order-b@1']);
  });

  it('links nothing to a superseded order: the superseder needs its own receipt', async () => {
    const result = await assessed([await order('order'), await order('order', {}, { version: 2, meta: { supersedes: { documentId: 'order', version: 1 } } }), await encounter(), await receipt(), await supplier()]);
    expect(conditionsOf(result, 'R05')).toEqual(['R05.order_receipt_missing|-|order@2']);
  });

  it('sequences every linked receipt, so a following receipt never hides a bad or ambiguous one', async () => {
    const result = await assessed([
      await order(),
      await encounter(),
      await receipt('receipt-good'),
      await receipt('receipt-early', { receivedAt: '2026-08-01T00:00:00Z' }),
      await receipt('receipt-close', { receivedAt: '2026-09-02T00:00:00Z' }),
      await supplier(),
    ]);
    expect(conditionsOf(result, 'R05')).toEqual(['R05.receipt_before_order|-|order@1,receipt-early@1', 'R05.receipt_unsequenced|-|order@1,receipt-close@1']);
    expect(routingOf(result, 'R05')).toBe('conflict/administrative_reviewer');
  });

  it('cites receipt links and times with order dates and timestamps from every current usable version', async () => {
    const result = await assessed([await order('order', { orderTime: at('2026-09-02T09:00:00-07:00') }), await encounter(), await receipt(), await receipt('receipt-other', { orderReference: null }), await supplier()]);
    expect(citationsOf(result, 'R05')).toEqual(
      sorted([
        'order@1/orderDate',
        'order@1/orderTime/timestamp',
        'receipt@1/orderReference/documentId',
        'receipt@1/orderReference/version',
        'receipt@1/receivedAt',
        'receipt-other@1/receivedAt',
      ]),
    );
  });
});

describe('R05 absence and candidates', () => {
  it('holds only no_usable_receipt with no receipt and no candidate, even with no order', async () => {
    expect(conditionsOf(await assessed([await order(), await encounter(), await supplier()]), 'R05')).toEqual(['R05.no_usable_receipt|-|']);
    const neither = await assessed([await encounter(), await supplier()]);
    expect(conditionsOf(neither, 'R05')).toEqual(['R05.no_usable_receipt|-|']);
    expect(routingOf(neither, 'R05')).toBe('missing/authorization_coordinator');
  });

  it('holds no_usable_order for a usable receipt without a current usable order', async () => {
    const result = await assessed([await order('order', {}, restricted()), await encounter(), await receipt(), await supplier()]);
    expect(conditionsOf(result, 'R05')).toEqual(['R05.no_usable_order|-|']);
    expect(routingOf(result, 'R05')).toBe('missing/authorization_coordinator');
    expect(parentOf(result, 'R05')).toEqual([]);
  });

  const CANDIDATES: [string, Parameters<typeof receipt>[2], string, string][] = [
    ['restricted', restricted(), 'R05.receipt_restricted', 'restricted/authorization_coordinator'],
    ['declared unreadable', declaredUnreadable(), 'R05.receipt_unreadable', 'unreadable/authorization_coordinator'],
    ['of an unsupported MIME type', plainText(), 'R05.receipt_unreadable', 'unreadable/authorization_coordinator'],
    ['failed provenance', tampered(), 'R05.receipt_failed_provenance', 'manual_review/administrative_reviewer'],
  ];

  it.each(CANDIDATES)('reports a %s receipt candidate without a usable receipt, reading no link from it', async (_label, options, key, routing) => {
    const result = await assessed([await order(), await encounter(), await receipt('receipt', {}, options), await supplier()]);
    expect(conditionsOf(result, 'R05')).toEqual([`${key}|-|receipt@1`]);
    expect(routingOf(result, 'R05')).toBe(routing);
    expect(parentOf(result, 'R05')).toEqual(['receipt@1']);
    expect(result.evidenceFacts.some((fact) => fact.documentId === 'receipt')).toBe(false);
  });

  it.each(CANDIDATES)('reports no %s candidate beside a usable receipt, and never takes its link', async (_label, options) => {
    const result = await assessed([await order(), await encounter(), await receipt('receipt-x', {}, options), await receipt('receipt', { orderReference: null }), await supplier()]);
    expect(conditionsOf(result, 'R05')).toEqual(['R05.order_receipt_missing|-|order@1']);
  });

  it('reports a candidate from an invalid receipt body', async () => {
    const invalid = await documentV2('receipt.v1', 'receipt', new TextEncoder().encode('{"documentKind":"order_receipt"}'), { meta: { kind: 'order_receipt' } });
    const result = await assessed([await order(), await encounter(), invalid, await supplier()]);
    expect(conditionsOf(result, 'R05')).toEqual(['R05.receipt_unreadable|-|receipt@1']);
  });
});
