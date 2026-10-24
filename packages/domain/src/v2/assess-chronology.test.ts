import { type EncounterBody, type OrderBody } from '@pa/contracts';
import { describe, expect, it } from 'vitest';

import {
  assessed,
  citationsOf,
  conditionsOf,
  declaredUnreadable,
  encounter,
  order,
  packet,
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
import { caseV2, documentV2, encounterBody, noteBody } from '../../test/builders-v2.js';

// R04 (encounter-to-order chronology), R06 (clinical review), R07 (LCMP) and
// the always-held R10 through `assessV2`. Only final current usable
// encounters and orders are sequenced (C09); dates are calendar dates with a
// clamped, inclusive six-month bound (C01); a same date is sequenced only by
// explicit instants (C02); practitioner sameness is by identifier (C03); and
// LCMP never suppresses another condition (C04).

const at = (timestamp: string, timeZone = 'America/Los_Angeles') => ({ timestamp, timeZone });
const pairOf = (encounterBody: Partial<EncounterBody>, orderBody: Partial<OrderBody>) => [encounter('encounter', encounterBody), order('order', orderBody)];
const rest = async () => [await receipt(), await supplier()];
const r04 = async (encounterBody: Partial<EncounterBody>, orderBody: Partial<OrderBody>) => conditionsOf(await assessed([...(await Promise.all(pairOf(encounterBody, orderBody))), ...(await rest())]), 'R04');

describe('R04 calendar-month bound (C01)', () => {
  const BOUNDS: [string, string, string, boolean][] = [
    ['an interior date', '2026-03-15', '2026-06-01', false],
    ['the same day six months later', '2026-03-15', '2026-09-15', false],
    ['the day after six months', '2026-03-15', '2026-09-16', true],
    ['a clamped month end', '2026-08-31', '2027-02-28', false],
    ['the day after a clamped month end', '2026-08-31', '2027-03-01', true],
    ['a leap-day clamp', '2027-08-31', '2028-02-29', false],
    ['the day after a leap-day clamp', '2027-08-31', '2028-03-01', true],
    ['a non-leap February end', '2025-08-29', '2026-02-28', false],
    ['the next day after a non-leap February end', '2025-08-29', '2026-03-01', true],
  ];

  it.each(BOUNDS)('judges %s against the inclusive bound', async (_label, encounterDate, orderDate, after) => {
    expect(await r04({ encounterDate }, { orderDate, signature: { signerName: 'Casey Example, MD (synthetic)', signedDate: orderDate } })).toEqual(
      after ? ['R04.order_after_bound|-|encounter@1,order@1'] : [],
    );
  });

  it('applies no order-age limit against the assessment date', async () => {
    // The order follows the assessment date but is within six months of the encounter.
    expect(await r04({ encounterDate: '2026-08-20' }, { orderDate: '2027-01-15' })).toEqual([]);
  });

  it('holds order_before_encounter for an earlier order date, as a conflict', async () => {
    const result = await assessed([...(await Promise.all(pairOf({ encounterDate: '2026-09-03' }, { orderDate: '2026-09-02' }))), ...(await rest())]);
    expect(conditionsOf(result, 'R04')).toEqual(['R04.order_before_encounter|-|encounter@1,order@1']);
    expect(routingOf(result, 'R04')).toBe('conflict/administrative_reviewer');
    expect(parentOf(result, 'R04')).toEqual([]);
    expect(statusesOf(result)).toEqual({ ...READY, state: 'needs_human_review', R04: 'conflict' });
  });
});

describe('R04 same-day sequencing (C02)', () => {
  const day = { encounterDate: '2026-09-02' };
  const SAME: [string, Partial<EncounterBody>, Partial<OrderBody>, boolean][] = [
    ['neither time stated', day, {}, false],
    ['only the completion time stated', { ...day, completionTime: at('2026-09-02T10:00:00-07:00') }, {}, false],
    ['only the order time stated', day, { orderTime: at('2026-09-02T11:00:00-07:00') }],
    ['the order strictly after completion', { ...day, completionTime: at('2026-09-02T10:00:00-07:00') }, { orderTime: at('2026-09-02T10:00:01-07:00') }, true],
    ['the order at the completion instant', { ...day, completionTime: at('2026-09-02T10:00:00-07:00') }, { orderTime: at('2026-09-02T10:00:00-07:00') }, false],
    ['the order before completion', { ...day, completionTime: at('2026-09-02T10:00:00-07:00') }, { orderTime: at('2026-09-02T09:59:59-07:00') }, false],
    ['the same instant in other offsets', { ...day, completionTime: at('2026-09-02T10:00:00-07:00') }, { orderTime: at('2026-09-02T13:00:00-04:00', 'America/New_York') }, false],
    ['a later wall clock that is an earlier instant', { ...day, completionTime: at('2026-09-02T10:00:00-07:00') }, { orderTime: at('2026-09-02T12:00:00-04:00', 'America/New_York') }, false],
    ['an earlier wall clock that is a later instant', { ...day, completionTime: at('2026-09-02T12:00:00-04:00', 'America/New_York') }, { orderTime: at('2026-09-02T10:00:00-07:00') }, true],
  ].map(([label, encounterBody, orderBody, sequenced]) => [label, encounterBody, orderBody, sequenced ?? false] as [string, Partial<EncounterBody>, Partial<OrderBody>, boolean]);

  it.each(SAME)('judges a same-day pair with %s', async (_label, encounterBody, orderBody, sequenced) => {
    expect(await r04(encounterBody, orderBody)).toEqual(sequenced ? [] : ['R04.same_day_unsequenced|-|encounter@1,order@1']);
  });

  it('routes an unsequenced same day to manual review, not a conflict', async () => {
    const result = await assessed([...(await Promise.all(pairOf(day, {}))), ...(await rest())]);
    expect(routingOf(result, 'R04')).toBe('manual_review/administrative_reviewer');
    expect(result.state).toBe('needs_human_review');
  });

  it('never uses a stated time to sequence different dates', async () => {
    // Times are ignored once the dates differ; the earlier order date is a conflict.
    expect(await r04({ encounterDate: '2026-09-03', completionTime: at('2026-09-03T08:00:00-07:00') }, { orderDate: '2026-09-02', orderTime: at('2026-09-02T09:00:00-07:00') })).toEqual([
      'R04.order_before_encounter|-|encounter@1,order@1',
    ]);
  });
});

describe('R04 practitioner identity (C03)', () => {
  const PRACTITIONERS: [string, EncounterBody['practitioner'], OrderBody['treatingPractitioner'], string[]][] = [
    ['the same identifier under different names', { name: 'Casey Example', identifier: 'SYN-PRAC-0001' }, { name: 'C. Example, MD', identifier: 'SYN-PRAC-0001' }, []],
    ['different identifiers under the same name', { name: 'Casey Example', identifier: 'SYN-PRAC-0001' }, { name: 'Casey Example', identifier: 'SYN-PRAC-0002' }, ['R04.practitioner_identifier_differs|-|encounter@1,order@1']],
    ['no encounter identifier and the same name', { name: 'Casey Example', identifier: null }, { name: 'Casey Example', identifier: 'SYN-PRAC-0001' }, ['R04.practitioner_identifier_absent|-|encounter@1,order@1']],
    ['no order identifier and the same name', { name: 'Casey Example', identifier: 'SYN-PRAC-0001' }, { name: 'Casey Example', identifier: null }, ['R04.practitioner_identifier_absent|-|encounter@1,order@1']],
    ['no identifier on either', { name: 'Casey Example', identifier: null }, { name: 'Casey Example', identifier: null }, ['R04.practitioner_identifier_absent|-|encounter@1,order@1']],
  ];

  it.each(PRACTITIONERS)('judges %s by identifier only', async (_label, practitioner, treatingPractitioner, expected) => {
    expect(await r04({ practitioner }, { treatingPractitioner })).toEqual(expected);
  });

  it('routes an absent identifier to manual review and a different one to a conflict', async () => {
    const absent = await assessed([...(await Promise.all(pairOf({ practitioner: { name: 'Casey Example', identifier: null } }, {}))), ...(await rest())]);
    expect(routingOf(absent, 'R04')).toBe('manual_review/administrative_reviewer');
    const differs = await assessed([...(await Promise.all(pairOf({}, { treatingPractitioner: { name: null, identifier: 'SYN-PRAC-0002' } }))), ...(await rest())]);
    expect(routingOf(differs, 'R04')).toBe('conflict/administrative_reviewer');
  });
});

describe('R04 every final pair, aggregate dates and missing dates', () => {
  it('judges every final encounter and order pair separately', async () => {
    const result = await assessed([
      await encounter('encounter-a'),
      await encounter('encounter-b', { practitioner: { name: null, identifier: 'SYN-PRAC-0009' } }),
      await order('order-a'),
      await order('order-b', { orderDate: '2026-08-19', signature: { signerName: 'Casey Example, MD (synthetic)', signedDate: '2026-08-19' } }),
      await receipt('receipt-a', { orderReference: { documentId: 'order-a', version: 1 } }),
      await receipt('receipt-b', { orderReference: { documentId: 'order-b', version: 1 } }),
      await supplier(),
    ]);
    expect(conditionsOf(result, 'R04')).toEqual(
      sorted([
        'R04.order_before_encounter|-|encounter-a@1,order-b@1',
        'R04.order_before_encounter|-|encounter-b@1,order-b@1',
        'R04.orders_disagree|order.date|order-a@1,order-b@1',
        'R04.practitioner_identifier_differs|-|encounter-b@1,order-a@1',
        'R04.practitioner_identifier_differs|-|encounter-b@1,order-b@1',
      ]),
    );
  });

  it('holds encounters_disagree for two final encounter dates, alongside each pair result', async () => {
    const result = await assessed([await encounter('encounter-a'), await encounter('encounter-b', { encounterDate: '2026-08-21' }), await order(), ...(await rest())]);
    expect(conditionsOf(result, 'R04')).toEqual(['R04.encounters_disagree|encounter.date|encounter-a@1,encounter-b@1']);
    expect(routingOf(result, 'R04')).toBe('conflict/administrative_reviewer');
  });

  it('does not count a draft date in an aggregate disagreement', async () => {
    const result = await assessed([await encounter('encounter'), await encounter('encounter-draft', { status: 'draft', encounterDate: '2026-08-01' }), await order(), ...(await rest())]);
    expect(conditionsOf(result, 'R04')).toEqual([]);
  });

  it.each([
    ['encounter.date', 'encounter@1', { encounterDate: null }, {}],
    ['order.date', 'order@1', {}, { orderDate: null }],
  ] as [string, string, Partial<EncounterBody>, Partial<OrderBody>][])('holds date_not_stated on %s, and no pair date condition', async (field, ref, encounterBody, orderBody) => {
    const result = await assessed([...(await Promise.all(pairOf(encounterBody, orderBody))), ...(await rest())]);
    expect(conditionsOf(result, 'R04')).toEqual([`R04.date_not_stated|${field}|${ref}`]);
    expect(routingOf(result, 'R04')).toBe('missing/authorization_coordinator');
  });

  it('keeps the practitioner check when a date is missing', async () => {
    expect(await r04({ encounterDate: null, practitioner: { name: null, identifier: 'SYN-PRAC-0002' } }, {})).toEqual([
      'R04.date_not_stated|encounter.date|encounter@1',
      'R04.practitioner_identifier_differs|-|encounter@1,order@1',
    ]);
  });
});

describe('R04 drafts, candidates and absence', () => {
  const others = (kind: 'encounter' | 'order') => (kind === 'encounter' ? [order()] : [encounter()]);

  it.each(['encounter', 'order'] as const)('reports a draft-only %s as not final, naming it, and sequences nothing', async (kind) => {
    const draft = kind === 'encounter' ? encounter('draft', { status: 'draft', encounterDate: '2027-09-01' }) : order('draft', { status: 'draft', orderDate: '2020-01-01' });
    const result = await assessed([await draft, ...(await Promise.all(others(kind))), ...(await rest())]);
    expect(conditionsOf(result, 'R04')).toEqual([`R04.${kind}_not_final|-|draft@1`]);
    expect(routingOf(result, 'R04')).toBe('missing/authorization_coordinator');
    expect(parentOf(result, 'R04')).toEqual([]);
  });

  it.each(['encounter', 'order'] as const)('reports no condition for a draft %s beside a final one', async (kind) => {
    const draft = kind === 'encounter' ? encounter('draft', { status: 'draft' }) : order('draft', { status: 'draft' });
    const result = await assessed([await draft, await encounter(), await order(), ...(await rest())]);
    expect(conditionsOf(result, 'R04')).toEqual([]);
  });

  const CLASSES: [string, (options: Parameters<typeof order>[2]) => Parameters<typeof order>[2], string, string][] = [
    ['restricted', restricted, 'restricted', 'restricted/authorization_coordinator'],
    ['declared unreadable', declaredUnreadable, 'unreadable', 'unreadable/authorization_coordinator'],
    ['of an unsupported MIME type', plainText, 'unreadable', 'unreadable/authorization_coordinator'],
    ['failed provenance', tampered, 'failed_provenance', 'manual_review/administrative_reviewer'],
  ];
  const MATRIX = (['encounter', 'order'] as const).flatMap((kind) => CLASSES.map(([label, options, name, routing]) => [kind, label, options, name, routing] as const));

  it.each(MATRIX)('reports the only %s when %s, naming it as the parent', async (kind, _label, options, name, routing) => {
    const candidate = kind === 'encounter' ? encounter('candidate', {}, options({})) : order('candidate', {}, options({}));
    const result = await assessed([await candidate, ...(await Promise.all(others(kind))), ...(await rest())]);
    expect(conditionsOf(result, 'R04')).toEqual([`R04.${kind}_${name}|-|candidate@1`]);
    expect(routingOf(result, 'R04')).toBe(routing);
    expect(parentOf(result, 'R04')).toEqual(['candidate@1']);
  });

  it.each(MATRIX)('reports no %s candidate when %s beside a final current usable one', async (kind, _label, options) => {
    const candidate = kind === 'encounter' ? encounter('candidate', {}, options({})) : order('candidate', {}, options({}));
    const result = await assessed([await candidate, await encounter(), await order(), ...(await rest())]);
    expect(conditionsOf(result, 'R04')).toEqual([]);
  });

  it('reports candidates and drafts together when no final version of a kind is usable', async () => {
    const result = await assessed([await encounter('candidate', {}, restricted()), await encounter('draft', { status: 'draft' }), await order(), ...(await rest())]);
    expect(conditionsOf(result, 'R04')).toEqual(['R04.encounter_not_final|-|draft@1', 'R04.encounter_restricted|-|candidate@1']);
    expect(routingOf(result, 'R04')).toBe('restricted/authorization_coordinator');
    expect(parentOf(result, 'R04')).toEqual(['candidate@1']);
  });

  it.each(['encounter', 'order'] as const)('reports no_usable_%s with no version of that kind', async (kind) => {
    const result = await assessed([...(await Promise.all(others(kind))), ...(await rest())]);
    expect(conditionsOf(result, 'R04')).toEqual([`R04.no_usable_${kind}|-|`]);
    expect(routingOf(result, 'R04')).toBe('missing/authorization_coordinator');
  });

  it('cites only final versions, while R06 and R07 still cite a draft encounter and R03 a draft order', async () => {
    const result = await assessed([
      await encounter('encounter'),
      await encounter('encounter-draft', { status: 'draft' }),
      await order('order'),
      await order('order-draft', { status: 'draft' }),
      await receipt('receipt'),
      await receipt('receipt-draft', { orderReference: { documentId: 'order-draft', version: 1 } }),
      await supplier(),
    ]);
    const r04Documents = new Set(citationsOf(result, 'R04').map((citation) => citation.split('/')[0]));
    expect(r04Documents).toEqual(new Set(['encounter@1', 'order@1']));
    expect(citationsOf(result, 'R06').some((citation) => citation.startsWith('encounter-draft@1/'))).toBe(true);
    expect(citationsOf(result, 'R07').some((citation) => citation.startsWith('encounter-draft@1/'))).toBe(true);
    expect(citationsOf(result, 'R03').some((citation) => citation.startsWith('order-draft@1/'))).toBe(true);
  });

  it('names a draft in an authorized diagnostic condition without citing it', async () => {
    const result = await assessed([await encounter('encounter-draft', { status: 'draft' }), await order(), ...(await rest())]);
    expect(conditionsOf(result, 'R04')).toEqual(['R04.encounter_not_final|-|encounter-draft@1']);
    expect(citationsOf(result, 'R04').every((citation) => citation.startsWith('order@1/'))).toBe(true);
  });

  it('cites stated R04 fields of final versions, including status and time tokens', async () => {
    const result = await assessed([
      await encounter('encounter', { completionTime: at('2026-08-20T10:00:00-07:00') }),
      await order('order', { orderTime: at('2026-09-02T09:00:00-07:00') }),
      ...(await rest()),
    ]);
    expect(citationsOf(result, 'R04')).toEqual(
      sorted([
        'encounter@1/status',
        'encounter@1/encounterDate',
        'encounter@1/completionTime/timestamp',
        'encounter@1/practitioner/identifier',
        'order@1/status',
        'order@1/orderDate',
        'order@1/orderTime/timestamp',
        'order@1/treatingPractitioner/identifier',
      ]),
    );
  });
});

describe('LCMP in R04 and R07 (C04)', () => {
  it('holds the case LCMP statement in both rules without a document', async () => {
    const result = await assessed(await packet(), { caseRecord: caseV2({ lcmpIncorporated: true }) });
    expect(conditionsOf(result, 'R04')).toEqual(['R04.lcmp_stated_by_case|-|']);
    expect(conditionsOf(result, 'R07')).toEqual(['R07.lcmp_stated_by_case|-|']);
    expect(routingOf(result, 'R07')).toBe('manual_review/administrative_reviewer');
    expect(parentOf(result, 'R04')).toEqual([]);
    expect(statusesOf(result)).toEqual({ ...READY, state: 'needs_human_review', R04: 'manual_review', R07: 'manual_review' });
  });

  it('holds an encounter LCMP statement from every current usable encounter, draft included', async () => {
    const incorporated = { lcmpReport: { incorporated: true, evaluationDate: '2026-08-10' } };
    const result = await assessed([await encounter('encounter', incorporated), await encounter('encounter-draft', { ...incorporated, status: 'draft' }), await order(), ...(await rest())]);
    expect(conditionsOf(result, 'R04')).toEqual(['R04.lcmp_stated_by_encounter|-|encounter-draft@1', 'R04.lcmp_stated_by_encounter|-|encounter@1']);
    expect(conditionsOf(result, 'R07')).toEqual(['R07.lcmp_stated_by_encounter|-|encounter-draft@1', 'R07.lcmp_stated_by_encounter|-|encounter@1']);
    expect(parentOf(result, 'R07')).toEqual([]);
  });

  it.each([
    ['not incorporated', { incorporated: false, evaluationDate: null }],
    ['incorporation unknown', { incorporated: null, evaluationDate: '2026-08-10' }],
  ])('holds nothing for an encounter whose LCMP report is %s', async (_label, lcmpReport) => {
    const result = await assessed([await encounter('encounter', { lcmpReport }), await order(), ...(await rest())]);
    expect(conditionsOf(result, 'R04')).toEqual([]);
    expect(conditionsOf(result, 'R07')).toEqual([]);
    expect(routingOf(result, 'R07')).toBe('pass/administrative_reviewer');
  });

  it('takes no LCMP statement from an unusable encounter', async () => {
    const result = await assessed([await encounter('encounter'), await encounter('encounter-r', { lcmpReport: { incorporated: true, evaluationDate: null } }, restricted()), await order(), ...(await rest())]);
    expect(conditionsOf(result, 'R07')).toEqual([]);
  });

  it('keeps every other condition and rule beside LCMP statements', async () => {
    const result = await assessed(
      [
        await encounter('encounter', { encounterDate: '2026-09-03', lcmpReport: { incorporated: true, evaluationDate: null }, practitioner: { name: null, identifier: null } }),
        await order(),
        await receipt('receipt', { receivedAt: '2026-08-31T10:00:00Z' }),
        await supplier(),
      ],
      { caseRecord: caseV2({ lcmpIncorporated: true, urgency: 'expedited' }) },
    );
    expect(conditionsOf(result, 'R04')).toEqual([
      'R04.lcmp_stated_by_case|-|',
      'R04.lcmp_stated_by_encounter|-|encounter@1',
      'R04.order_before_encounter|-|encounter@1,order@1',
      'R04.practitioner_identifier_absent|-|encounter@1,order@1',
    ]);
    expect(routingOf(result, 'R04')).toBe('conflict/administrative_reviewer');
    expect(conditionsOf(result, 'R05')).toEqual(['R05.receipt_before_order|-|order@1,receipt@1']);
    expect(statusesOf(result)).toEqual({ ...READY, state: 'scope_hold', R01: 'conflict', R04: 'conflict', R05: 'conflict', R07: 'manual_review' });
  });

  it('adds no ATP, specialty evaluation or proof-of-delivery condition from note text', async () => {
    const result = await assessed([...(await packet()), await documentV2('note.v1', 'note', noteBody())]);
    expect(conditionsOf(result, 'R07')).toEqual([]);
    expect(statusesOf(result)).toEqual(READY);
  });
});

describe('always-held R06 and R10', () => {
  const noClinical = { clinical: { diagnosisStatement: null, mobilityLimitation: null, lowerLevelDevices: null, homeAccessibility: null, abilityToOperate: null } };
  const VARIATIONS: [string, () => Promise<Parameters<typeof assessed>>][] = [
    ['the supported packet', async () => [await packet()]],
    ['an encounter with no clinical facts', async () => [[await encounter('encounter', noClinical), await order(), ...(await rest())]]],
    ['no encounter at all', async () => [[await order(), ...(await rest())]]],
    ['an encounter with every clinical fact', async () => [[await documentV2('encounter.v1', 'encounter', encounterBody({ clinical: { ...encounterBody().clinical, lowerLevelDevices: 'Synthetic.', homeAccessibility: 'Synthetic.' } })), await order(), ...(await rest())]]],
    ['a scope hold', async () => [await packet(), { caseRecord: caseV2({ payerType: 'commercial' }) }]],
    ['an LCMP statement', async () => [await packet(), { caseRecord: caseV2({ lcmpIncorporated: true }) }]],
    ['information needed', async () => [[await order('order', {}, restricted()), await encounter(), ...(await rest())]]],
  ];

  it.each(VARIATIONS)('holds exactly one R06 clinical review and one R10 pure assessment for %s, with no state effect', async (_label, build) => {
    const result = await assessed(...(await build()));
    expect(conditionsOf(result, 'R06')).toEqual(['R06.clinical_review|-|']);
    expect(routingOf(result, 'R06')).toBe('manual_review/qualified_clinical_reviewer');
    expect(findingSeverity(result, 'R06')).toBe('non_blocking');
    expect(conditionsOf(result, 'R10')).toEqual(['R10.pure_assessment|-|']);
    expect(routingOf(result, 'R10')).toBe('not_applicable/administrative_reviewer');
    expect(parentOf(result, 'R06')).toEqual([]);
    expect(parentOf(result, 'R10')).toEqual([]);
    expect(citationsOf(result, 'R10')).toEqual([]);
  });

  it('leaves a ready packet ready with R06 open', async () => {
    const result = await assessed(await packet());
    expect(statusesOf(result)).toEqual(READY);
  });

  it('cites every stated clinical fact of current usable encounters and asserts nothing about absent ones', async () => {
    const result = await assessed(await packet());
    expect(citationsOf(result, 'R06')).toEqual(['encounter@1/clinical/abilityToOperate', 'encounter@1/clinical/diagnosisStatement', 'encounter@1/clinical/mobilityLimitation']);
    const empty = await assessed([await encounter('encounter', noClinical), await order(), ...(await rest())]);
    expect(citationsOf(empty, 'R06')).toEqual([]);
    expect(findingOfExplanation(empty)).not.toMatch(/absent|insufficient|necess/i);
  });
});

const findingSeverity = (result: Awaited<ReturnType<typeof assessed>>, ruleId: 'R06') => result.findings.find((finding) => finding.ruleId === ruleId)?.severity;
const findingOfExplanation = (result: Awaited<ReturnType<typeof assessed>>) => result.findings.find((finding) => finding.ruleId === 'R06')?.explanation ?? '';
