import { AssessmentResult, type PolicyRule, RuleId } from '@pa/contracts';
import { describe, expect, it } from 'vitest';

import {
  bytesOf,
  citationsOf,
  encounterBody,
  findingOf,
  orderBody,
  outcomeOf,
  receiptBody,
  refsOf,
  replace,
  run,
  source,
  statusOf,
  SUBJECT_ID,
  SUBJECT_NAME,
  supportedCase,
  supportedDocuments,
  testPack,
  without,
} from '../test/builders.js';
import { selectOutcome } from './assess.js';
import { webCryptoSha256 } from './hash.js';
import { EVALUATOR_STATUSES } from './rules.js';

describe('supported case', () => {
  it('is ready for review with one finding per rule and the clinical finding visible', async () => {
    const result = await run(supportedCase(), await supportedDocuments());
    expect(AssessmentResult.safeParse(result).success).toBe(true);
    expect(result.state).toBe('ready_for_review');
    expect(result.findings.map((finding) => finding.ruleId)).toEqual(RuleId.options);
    expect(result.findings.map((finding) => finding.status)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass', 'manual_review', 'pass', 'pass', 'pass', 'not_applicable']);
    expect(findingOf(result, 'R06').responsibleRole).toBe('qualified_clinical_reviewer');
    expect(result.quarantinedDocumentIds).toEqual([]);
    expect(result.findings.every((finding) => finding.documentRefs.length === 0 && finding.caseRevision === 1)).toBe(true);
  });

  it('pins the exact policy pack bytes', async () => {
    const packBytes = bytesOf(testPack());
    const result = await run(supportedCase(), await supportedDocuments(), { pack: packBytes });
    expect(result.policyPackSha256).toBe(await webCryptoSha256(packBytes));
    const reformatted = new TextEncoder().encode(JSON.stringify(testPack()));
    expect((await run(supportedCase(), await supportedDocuments(), { pack: reformatted })).policyPackSha256).not.toBe(result.policyPackSha256);
  });

  it('uses an injected hasher for documents and the pack', async () => {
    const hashed: number[] = [];
    const documents = await supportedDocuments();
    const outcome = await outcomeOf(supportedCase(), documents);
    expect(outcome.outcome).toBe('assessed');
    const { assess } = await import('./assess.js');
    const counted = await assess(
      { caseRecord: supportedCase(), documents, policyPackBytes: bytesOf(testPack()), assessmentDate: '2026-10-18' },
      {
        sha256: async (bytes) => {
          hashed.push(bytes.length);
          return webCryptoSha256(bytes);
        },
      },
    );
    expect(counted.outcome).toBe('assessed');
    expect(hashed).toHaveLength(documents.length + 1);
  });
});

describe('deterministic extraction (PA-A03)', () => {
  it('cites the exact document version, fixed locator and source text of every fact', async () => {
    const documents = await supportedDocuments();
    const result = await run(supportedCase(), documents);
    expect(result.evidenceFacts.length).toBeGreaterThan(20);
    for (const fact of result.evidenceFacts) {
      const document = documents.find((candidate) => candidate.meta.documentId === fact.documentId);
      expect(document?.meta.version).toBe(fact.documentVersion);
      expect(fact).toMatchObject({ extractionMethod: 'deterministic', confidence: null, reviewStatus: 'proposed' });
      const body = JSON.parse(new TextDecoder().decode(document?.bytes ?? new Uint8Array())) as Record<string, unknown>;
      const value = fact.locator
        .slice(1)
        .split('/')
        .reduce<unknown>((current, token) => (current as Record<string, unknown>)[token], body);
      expect(value).toBe(fact.value);
      expect(fact.originalText).toBe(typeof value === 'string' ? value : JSON.stringify(value));
    }
    // A null value states nothing, so it yields no fact.
    expect(result.evidenceFacts.some((fact) => fact.field === 'order.timestamp' || fact.field === 'clinical.home_accessibility')).toBe(false);
    expect(result.evidenceFacts.map((fact) => fact.factId)).toEqual(result.evidenceFacts.map((_, index) => `fact-${String(index + 1).padStart(4, '0')}`));
  });

  it('quotes a number exactly as the source writes it', async () => {
    const text = new TextDecoder().decode(bytesOf(orderBody())).replace('"quantity": 1', '"quantity": 1.0');
    const order = await source('order', new TextEncoder().encode(text), { meta: { kind: 'order' } });
    const result = await run(supportedCase(), replace(await supportedDocuments(), 'order', order));
    const quantity = result.evidenceFacts.find((fact) => fact.field === 'order.quantity');
    expect(quantity).toMatchObject({ value: 1, originalText: '1.0', locator: '/item/quantity' });
  });

  it('cites, per rule, every fact of its evidence fields from usable documents only (C05)', async () => {
    const result = await run(supportedCase(), await supportedDocuments());
    expect(citationsOf(result, 'R05')).toEqual([
      'order@v1/orderDate',
      'receipt@v1/orderReference/documentId',
      'receipt@v1/orderReference/version',
      'receipt@v1/receivedAt',
    ]);
    expect(citationsOf(result, 'R06')).toEqual(['encounter@v1/clinical/diagnosisStatement', 'encounter@v1/clinical/mobilityLimitation', 'encounter@v1/clinical/abilityToOperate']);
    expect(citationsOf(result, 'R08')).toEqual([]);
  });
});

describe('schema rejection precedes every state', () => {
  it('rejects an invalid case even when it also has a scope problem', async () => {
    const invalid = { ...supportedCase({ payerType: 'medicare_advantage' }), unexpected: true } as unknown as ReturnType<typeof supportedCase>;
    const outcome = await outcomeOf(invalid, await supportedDocuments());
    expect(outcome).toEqual({ outcome: 'rejected', issues: [expect.stringMatching(/^case: .*unexpected/)] });
  });

  it.each([
    ['an assessment date other than the case date', { assessmentDate: '2026-10-19' }, /assessmentDate: 2026-10-19 differs/],
    ['an invalid assessment date', { assessmentDate: '2026-02-30' }, /assessmentDate: must be an ISO calendar date/],
  ])('rejects %s', async (_, options, issue) => {
    const outcome = await outcomeOf(supportedCase(), await supportedDocuments(), options);
    expect(outcome.outcome === 'rejected' && outcome.issues).toEqual([expect.stringMatching(issue)]);
  });

  it('rejects invalid document metadata, duplicate versions and misplaced bytes', async () => {
    const documents = await supportedDocuments();
    const [order] = documents;
    if (order === undefined) {
      throw new Error('no order');
    }
    const broken = [
      { ...order, meta: { ...order.meta, kind: 'prescription' } } as unknown as typeof order,
      order,
      order,
      { ...order, meta: { ...order.meta, documentId: 'held' }, bytes: null },
    ];
    const outcome = await outcomeOf(supportedCase(), broken);
    expect(outcome.outcome === 'rejected' && outcome.issues).toEqual([
      expect.stringMatching(/^documents\.0\.meta\.kind: /),
      'documents.2: order v1 is supplied twice',
      'documents.3: source bytes are held exactly when access is not restricted',
    ]);
  });

  it('rejects a policy pack that does not parse or does not define exactly R01 to R10', async () => {
    const documents = await supportedDocuments();
    const notJson = await outcomeOf(supportedCase(), documents, { pack: new TextEncoder().encode('{') });
    expect(notJson.outcome === 'rejected' && notJson.issues).toEqual(['policy pack: bytes are not valid UTF-8 JSON']);
    const pack = testPack();
    const partial = await outcomeOf(supportedCase(), documents, { pack: { ...pack, rules: pack.rules.filter((rule) => rule.ruleId !== 'R05') } });
    expect(partial.outcome === 'rejected' && partial.issues).toEqual([expect.stringMatching(/^policy pack: defines rules \[R01, R02, R03, R04, R06/)]);
    const invalid = await outcomeOf(supportedCase(), documents, { pack: { ...pack, supportedAssessmentDates: [] } });
    expect(invalid.outcome).toBe('rejected');
  });
});

describe('state precedence: scope hold, then human review, then missing evidence, then ready', () => {
  it('selects scope hold over identity conflict and missing evidence, and keeps every finding', async () => {
    const stranger = await source('stranger', encounterBody(), { meta: { subjectId: 'SYN-BEN-OTHER' } });
    const documents = [...without(await supportedDocuments(), 'order'), stranger];
    const result = await run(supportedCase({ payerType: 'medicare_advantage' }), documents);
    expect(result.state).toBe('scope_hold');
    expect([statusOf(result, 'R01'), statusOf(result, 'R02'), statusOf(result, 'R03'), statusOf(result, 'R04'), statusOf(result, 'R05')]).toEqual([
      'conflict',
      'conflict',
      'missing',
      'missing',
      'missing',
    ]);
  });

  it('selects human review over missing evidence', async () => {
    const stranger = await source('stranger', encounterBody(), { meta: { subjectId: 'SYN-BEN-OTHER' } });
    const result = await run(supportedCase(), [...without(await supportedDocuments(), 'order'), stranger]);
    expect(result.state).toBe('needs_human_review');
    expect(statusOf(result, 'R03')).toBe('missing');
  });

  it('selects missing evidence over ready', async () => {
    const result = await run(supportedCase(), without(await supportedDocuments(), 'receipt'));
    expect(result.state).toBe('needs_information');
  });

  it('never lets the clinical finding block or satisfy readiness', async () => {
    const ready = await run(supportedCase(), await supportedDocuments());
    expect(ready.state).toBe('ready_for_review');
    expect(statusOf(ready, 'R06')).toBe('manual_review');
    const missingOrder = await run(supportedCase(), without(await supportedDocuments(), 'order'));
    expect(missingOrder.state).toBe('needs_information');
    expect(statusOf(missingOrder, 'R06')).toBe('manual_review');
  });

  it('reads stateEffect and responsible role from the pack outcomes', async () => {
    const pack = testPack();
    const lenient = {
      ...pack,
      rules: pack.rules.map((rule) =>
        rule.ruleId === 'R05' ? { ...rule, outcomes: rule.outcomes.map((outcome) => ({ ...outcome, stateEffect: 'none' as const, responsibleRole: 'administrative_reviewer' as const })) } : rule,
      ),
    };
    const result = await run(supportedCase(), without(await supportedDocuments(), 'receipt'), { pack: lenient });
    expect(result.state).toBe('ready_for_review');
    expect(findingOf(result, 'R05')).toMatchObject({ status: 'missing', responsibleRole: 'administrative_reviewer' });
  });
});

describe('order of checks: R09 provenance before R02 subject binding', () => {
  it('excludes a tampered body with matching metadata that names another subject by R09, without quarantine', async () => {
    const order = await source('order', orderBody(), {
      bytes: bytesOf(orderBody({ beneficiary: { name: 'Morgan Othercase', identifier: 'SYN-BEN-X900' } })),
    });
    const result = await run(supportedCase(), replace(await supportedDocuments(), 'order', order));
    expect(result.quarantinedDocumentIds).toEqual([]);
    expect(statusOf(result, 'R02')).toBe('pass');
    expect(refsOf(result, 'R02')).toEqual([]);
    expect(findingOf(result, 'R09')).toMatchObject({ status: 'conflict', documentRefs: [{ documentId: 'order', version: 1 }] });
    expect(findingOf(result, 'R09').explanation).toContain('bytes differ from its contentHash');
    // The only order failed provenance: dependent rules route to review and name it (C07).
    expect([statusOf(result, 'R03'), refsOf(result, 'R03')]).toEqual(['manual_review', ['order@v1']]);
    expect([statusOf(result, 'R04'), refsOf(result, 'R04')]).toEqual(['manual_review', ['order@v1']]);
    expect(result.evidenceFacts.some((fact) => fact.documentId === 'order')).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/Othercase|SYN-BEN-X900/);
    expect(result.state).toBe('needs_human_review');
  });

  it('quarantines a document with mismatched metadata and failed provenance, named only by R02 (C07)', async () => {
    const order = await source('order', orderBody(), { meta: { subjectId: 'SYN-BEN-X900' }, bytes: bytesOf(orderBody({ orderDate: '2026-09-03' })) });
    const result = await run(supportedCase(), replace(await supportedDocuments(), 'order', order));
    expect(result.quarantinedDocumentIds).toEqual(['order']);
    expect(findingOf(result, 'R02')).toMatchObject({ status: 'conflict', documentRefs: [{ documentId: 'order', version: 1 }] });
    expect(findingOf(result, 'R02').explanation).toContain('metadata subjectId differs');
    expect([statusOf(result, 'R09'), refsOf(result, 'R09')]).toEqual(['pass', []]);
    for (const ruleId of RuleId.options.filter((id) => id !== 'R02')) {
      expect(refsOf(result, ruleId)).toEqual([]);
      expect(findingOf(result, ruleId).explanation).not.toContain('order v1 is');
    }
    expect([statusOf(result, 'R03'), statusOf(result, 'R04')]).toEqual(['missing', 'missing']);
    expect(result.evidenceFacts.some((fact) => fact.documentId === 'order')).toBe(false);
    expect(result.state).toBe('needs_human_review');
  });

  it('binds a restricted document by metadata alone and never reads its content', async () => {
    const receipt = await source('receipt', receiptBody(), { meta: { accessStatus: 'restricted' } });
    const result = await run(supportedCase(), replace(await supportedDocuments(), 'receipt', receipt));
    expect(result.quarantinedDocumentIds).toEqual([]);
    expect(statusOf(result, 'R02')).toBe('pass');
    expect([statusOf(result, 'R05'), refsOf(result, 'R05')]).toEqual(['restricted', ['receipt@v1']]);
    expect([statusOf(result, 'R09'), refsOf(result, 'R09')]).toEqual(['restricted', ['receipt@v1']]);
    expect(result.state).toBe('needs_information');
  });

  it('quarantines a restricted document whose metadata names another subject, not reported by R09', async () => {
    const receipt = await source('receipt', receiptBody(), { meta: { accessStatus: 'restricted', subjectId: 'SYN-BEN-X900' } });
    const result = await run(supportedCase(), replace(await supportedDocuments(), 'receipt', receipt));
    expect(result.quarantinedDocumentIds).toEqual(['receipt']);
    expect([statusOf(result, 'R09'), statusOf(result, 'R05'), refsOf(result, 'R05')]).toEqual(['pass', 'missing', []]);
  });

  it('keeps quarantined content out of facts, citations, references and finding text', async () => {
    const attachment = await source('attachment', encounterBody({ beneficiary: { name: 'Morgan Othercase', identifier: 'SYN-BEN-X900' }, narrative: 'Distinctive quarantined narrative.' }), {
      meta: { subjectId: 'SYN-BEN-X900' },
    });
    const result = await run(supportedCase(), [...(await supportedDocuments()), attachment]);
    expect(result.quarantinedDocumentIds).toEqual(['attachment']);
    expect(result.evidenceFacts.some((fact) => fact.documentId === 'attachment')).toBe(false);
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/Othercase|SYN-BEN-X900|Distinctive/);
    expect(result.findings.filter((finding) => finding.explanation.includes('attachment')).map((finding) => finding.ruleId)).toEqual(['R02']);
    expect(statusOf(result, 'R04')).toBe('pass');
  });
});

describe('explanations and affected documents (C05, C07)', () => {
  it('names every condition that held, not only the one that set the status', async () => {
    const result = await run(
      supportedCase({ payerType: 'medicare_advantage', beneficiaryState: 'NV', urgency: 'unknown' }),
      await supportedDocuments(),
    );
    const { explanation, status } = findingOf(result, 'R01');
    expect(status).toBe('conflict');
    expect(explanation).toContain('payerType medicare_advantage');
    expect(explanation).toContain('beneficiaryState NV');
    expect(explanation).toContain('urgency is unknown');
    expect(explanation.indexOf('payerType')).toBeLessThan(explanation.indexOf('urgency is unknown'));
  });

  it('never names a document from a pass, missing or not_applicable finding', async () => {
    const restricted = await source('receipt', receiptBody(), { meta: { accessStatus: 'restricted' } });
    const unreadable = await source('order', orderBody(), { meta: { mimeType: 'text/plain' } });
    const result = await run(supportedCase(), replace(replace(await supportedDocuments(), 'receipt', restricted), 'order', unreadable));
    for (const finding of result.findings) {
      if (['pass', 'missing', 'not_applicable'].includes(finding.status)) {
        expect(finding.documentRefs, finding.ruleId).toEqual([]);
      }
    }
    expect(refsOf(result, 'R09')).toEqual(['order@v1', 'receipt@v1']);
  });

  it('keeps the beneficiary name alternative visible without inventing an identifier', async () => {
    const order = await source('order', orderBody({ beneficiary: { name: SUBJECT_NAME, identifier: null } }));
    const result = await run(supportedCase(), replace(await supportedDocuments(), 'order', order));
    expect(result.state).toBe('ready_for_review');
    expect(citationsOf(result, 'R03')).not.toContain('order@v1/beneficiary/identifier');
    expect(findingOf(result, 'R03').explanation).toContain('name alternative suffices');
  });
});

describe('every condition that held has a pack outcome', () => {
  it('rejects a pack whose rule lacks an outcome for a status the assessment can report', async () => {
    const pack = testPack();
    const rules = pack.rules.map((rule) => (rule.ruleId === 'R05' ? { ...rule, outcomes: rule.outcomes.filter((outcome) => outcome.status !== 'conflict') } : rule));
    const outcome = await outcomeOf(supportedCase(), await supportedDocuments(), { pack: { ...pack, rules } });
    expect(outcome).toEqual({ outcome: 'rejected', issues: ['policy pack: R05 has no outcome for conflict, which the assessment can report'] });
  });

  it('declares exactly the statuses the test pack, which mirrors the lab pack, gives each rule', () => {
    for (const rule of testPack().rules) {
      expect([...EVALUATOR_STATUSES[rule.ruleId]].sort()).toEqual(rule.outcomes.map((outcome) => outcome.status).sort());
    }
  });

  it('refuses to drop a held condition whose status has no outcome or was not declared', () => {
    const rule = testPack().rules.find((candidate) => candidate.ruleId === 'R05') as PolicyRule;
    const withoutConflict = { ...rule, outcomes: rule.outcomes.filter((outcome) => outcome.status !== 'conflict') };
    const held = [
      { status: 'conflict' as const, text: 'received before the order' },
      { status: 'pass' as const, text: 'received after the order' },
    ];
    expect(selectOutcome(rule, held).status).toBe('conflict');
    expect(() => selectOutcome(withoutConflict, held)).toThrow('R05: no pack outcome or declared status for the held condition statuses [conflict]');
    expect(() => selectOutcome(rule, [{ status: 'not_applicable', text: 'undeclared' }])).toThrow('[not_applicable]');
  });
});

describe('exact source strings', () => {
  it('keeps an authentic padded string valid and quotes it exactly', async () => {
    const order = await source('order', orderBody({ item: { description: '  Synthetic power wheelchair\n', code: 'K0823', quantity: 1 } }));
    const result = await run(supportedCase(), replace(await supportedDocuments(), 'order', order));
    expect([statusOf(result, 'R09'), result.state]).toEqual(['pass', 'ready_for_review']);
    const fact = result.evidenceFacts.find((candidate) => candidate.field === 'order.item_description');
    expect([fact?.value, fact?.originalText]).toEqual(['  Synthetic power wheelchair\n', '  Synthetic power wheelchair\n']);
  });

  it('binds by exact string equality, so a padded name differs and quarantines', async () => {
    const receipt = await source('receipt', receiptBody({ beneficiary: { name: `${SUBJECT_NAME} `, identifier: SUBJECT_ID } }));
    const padded = await run(supportedCase(), replace(await supportedDocuments(), 'receipt', receipt));
    expect([statusOf(padded, 'R02'), statusOf(padded, 'R09'), padded.quarantinedDocumentIds]).toEqual(['conflict', 'pass', ['receipt']]);
    const both = await run(supportedCase({ subjectName: `${SUBJECT_NAME} ` }), replace(await supportedDocuments(), 'receipt', receipt));
    expect(both.quarantinedDocumentIds).toEqual(['order', 'encounter']);
  });
});

describe('a quarantined document ID with a usable version', () => {
  it('is refused with a stated reason, because the result quarantines by document ID', async () => {
    const wrongSubject = await source('receipt', receiptBody(), { meta: { subjectId: 'SYN-BEN-X900' } });
    const replacement = await source('receipt', receiptBody(), { meta: { version: 2, supersedes: { documentId: 'receipt', version: 1 } } });
    const outcome = await outcomeOf(supportedCase(), [...without(await supportedDocuments(), 'receipt'), wrongSubject, replacement]);
    expect(outcome).toEqual({
      outcome: 'rejected',
      issues: ['documents: receipt has a quarantined version and a usable version, which an AssessmentResult cannot represent because it quarantines by document ID'],
    });
  });
});
