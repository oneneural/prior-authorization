import { expect, it } from 'vitest';

import { assessmentInput, loadFixture } from '@pa/connectors';
import { ProposeRequestCommand, type RequestProposal } from '@pa/contracts';
import { assessV2 } from '@pa/domain';

import { requestTemplate } from './templates.js';

it('offers a fixed records request only for the matching missing finding and recipient', async () => {
  const outcome = await assessV2(assessmentInput(await loadFixture('F02')));
  if (outcome.outcome !== 'assessed') throw new Error('unexpected fixture rejection');
  const finding = outcome.result.findings.find((item) => item.ruleId === 'R03')!;
  const proposal: RequestProposal = { expectedRevision: 1, sourceRevisionHash: 'a'.repeat(64), policyPackSha256: 'b'.repeat(64), packetHash: 'c'.repeat(64), templateId: 'existing_order', recipientRole: 'practitioner_records', findingId: finding.findingId };
  expect(requestTemplate(proposal, finding).body).toContain('existing finalized order');
  expect(requestTemplate(proposal, finding).conditionKeys).toEqual(['R03.no_usable_order']);
  expect(requestTemplate(proposal, finding).body).toContain('Do not create, complete or amend');
  expect(() => requestTemplate({ ...proposal, recipientRole: 'supplier_records' }, finding)).toThrow('recipient role');
  expect(() => requestTemplate(proposal, { ...finding, status: 'pass', conditions: [] })).toThrow('missing finding');
  expect(ProposeRequestCommand.safeParse({ ...proposal, eventId: '00000000-0000-4000-8000-000000000001', idempotencyKey: 'request-key-000001', body: 'invented content', approvedBy: 'caller' }).success).toBe(false);
});
