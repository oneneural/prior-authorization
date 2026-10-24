import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { InputRejection, PolicyPackV2 } from '@pa/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CORE_BATCH } from '../frozen-v2.js';
import { REPO_ROOT } from './files.js';
import { loadFixture, type LoadOutcome } from './loader.js';
import { checkOracle, type OracleContext } from './oracle-check.js';
import { FixtureManifestV2 } from './schemas.js';
import { digest, json, makeTempDir, metadata, orderBody, removeTempDirs, standardDocuments, standardOracle, writeFixture } from './test-support.js';

// Structural oracle checks on a small synthetic fixture loaded from a temporary
// directory. Each negative case changes one declared value in an in-memory
// copy of the oracle; no source content is turned into a finding.

interface Ref {
  documentId: string;
  version: number;
}
interface Citation {
  documentId: string;
  documentVersion: number;
  locator: string;
}
interface LooseFinding {
  ruleId: string;
  status: string;
  responsibleRole: string;
  affectedDocuments: Ref[];
  citations: Citation[];
  conditions: { conditionKey: string; field: string | null; documents: Ref[] }[];
}
interface LooseOracle {
  fixtureId: string;
  fixtureManifestSha256: string;
  policyInput: { packId: string; sha256: string };
  specReferences: { fixtureRow: string; sources: string[] } & Record<string, unknown>;
  expectation: Record<string, unknown> & {
    state?: string;
    findings: LooseFinding[];
    clinicalReviewRequired?: boolean;
    exactText?: (Citation & { originalText: string })[];
    deferredExpectations?: { stage: string; statement: string }[];
  };
  [key: string]: unknown;
}

const packBytes = await readFile(join(REPO_ROOT, CORE_BATCH.policyPack.path));
const reviewedPack = PolicyPackV2.parse(JSON.parse(packBytes.toString('utf8')));
const fixtures = new Map<string, { manifestText: string; load: LoadOutcome }>();

beforeAll(async () => {
  const suite = await makeTempDir();
  const unusual = {
    ...standardDocuments(),
    't-hidden.v1': { meta: metadata('t-hidden', 1, 'order', null) },
    't-badhash.v1': { meta: { ...metadata('t-badhash', 1, 'order', json(orderBody())), contentHash: digest('other bytes') }, payload: json(orderBody()) },
    't-plain.v1': { meta: metadata('t-plain', 1, 'order', json(orderBody()), { mimeType: 'text/plain' }), payload: json(orderBody()) },
    't-broken.v1': { meta: metadata('t-broken', 1, 'order', '{ not json'), payload: '{ not json' },
    // Invalid sidecars: one whose identity parses, one whose version does not, one that is not JSON.
    't-badkind.v1': { meta: metadata('t-badkind', 1, 'not_a_kind', json(orderBody())), payload: json(orderBody()) },
    't-badversion.v1': { meta: { ...metadata('t-badversion', 1, 'order', json(orderBody())), version: 0 }, payload: json(orderBody()) },
    't-notjson.v1': { meta: '{ not json', payload: json(orderBody()) },
  };
  for (const [fixtureId, documents] of [
    ['F01t', standardDocuments()],
    ['F16t', unusual],
  ] as const) {
    const manifestText = await writeFixture(suite, { fixtureId, documents });
    fixtures.set(fixtureId, { manifestText, load: await loadFixture(suite, fixtureId) });
  }
});
afterAll(removeTempDirs);

const fixture = (fixtureId: string) => {
  const found = fixtures.get(fixtureId);
  if (found === undefined) {
    throw new Error(`fixture ${fixtureId} not loaded`);
  }
  return found;
};

const oracleFor = (fixtureId: string) => structuredClone(standardOracle(fixtureId, digest(fixture(fixtureId).manifestText))) as unknown as LooseOracle;

const finding = (oracle: LooseOracle, ruleId: string) => {
  const found = oracle.expectation.findings.find((candidate) => candidate.ruleId === ruleId);
  if (found === undefined) {
    throw new Error(`no ${ruleId} finding`);
  }
  return found;
};

function check(mutate: (oracle: LooseOracle) => void = () => undefined, overrides: Partial<OracleContext> = {}, fixtureId = 'F01t'): string[] {
  const { manifestText, load } = fixture(fixtureId);
  const oracle = oracleFor(fixtureId);
  mutate(oracle);
  const bytes = Buffer.from(json(oracle));
  return checkOracle({
    fixtureId,
    pin: { manifestSha256: digest(manifestText), oracleSha256: digest(bytes) },
    oracleBytes: bytes,
    manifest: FixtureManifestV2.parse(JSON.parse(manifestText)),
    manifestBytes: Buffer.from(manifestText),
    load,
    policyPin: { ...CORE_BATCH.policyPack },
    policyBytes: packBytes,
    reviewedPack,
    ...overrides,
  });
}

const fails = (problems: string[], fragment: string) => expect(problems.some((problem) => problem.includes(fragment)), `${fragment} in ${JSON.stringify(problems)}`).toBe(true);

describe('assessed oracle structure', () => {
  it('accepts the hand-written synthetic oracle and loads its fixture', () => {
    expect(fixture('F01t').load.outcome).toBe('loaded');
    expect(check()).toEqual([]);
  });

  it('never compares deferred expectations', () => {
    expect(check((oracle) => (oracle.expectation.deferredExpectations = [{ stage: 'S6', statement: 'Anything at all, never compared.' }]))).toEqual([]);
    expect(check((oracle) => delete oracle.expectation.deferredExpectations)).toEqual([]);
  });

  it('requires exactly one finding per rule R01 to R10', () => {
    fails(check((oracle) => (oracle.expectation.findings = oracle.expectation.findings.filter((candidate) => candidate.ruleId !== 'R07'))), 'R07: 0 findings');
    fails(check((oracle) => oracle.expectation.findings.push(structuredClone(finding(oracle, 'R03')))), 'R03: 2 findings');
  });

  it('refuses undeclared and other-rule condition keys', () => {
    fails(check((oracle) => finding(oracle, 'R03').conditions.push({ conditionKey: 'R03.made_up_condition', field: null, documents: [] })), 'not declared by the policy input');
    fails(check((oracle) => finding(oracle, 'R03').conditions.push({ conditionKey: 'R04.order_before_encounter', field: null, documents: [] })), 'declared under R04');
  });

  it('checks the qualifier vocabulary, arity and document kinds the pack declares', () => {
    fails(check((oracle) => ((finding(oracle, 'R02').conditions[0] ?? { field: null }).field = 'case.payerType')), "field is not one of the key's declared binding_basis values");
    fails(check((oracle) => ((finding(oracle, 'R02').conditions[0] ?? { field: null }).field = null)), "field is not one of the key's declared binding_basis values");
    fails(check((oracle) => ((finding(oracle, 'R02').conditions[0] ?? { documents: [] }).documents = [])), "the key's arity is one");
    fails(
      check((oracle) => ((finding(oracle, 'R02').conditions[0] ?? { documents: [] }).documents = [{ documentId: 't-supplier', version: 1 }])),
      "is a supplier_status, not one of the key's document kinds",
    );
    fails(check((oracle) => ((finding(oracle, 'R02').conditions[0] ?? { documents: [] }).documents = [{ documentId: 't-missing', version: 1 }])), 'is not a supplied version');
  });

  const r04 = (oracle: LooseOracle, status: string, keys: string[]) => {
    const target = finding(oracle, 'R04');
    target.status = status;
    target.conditions = keys.map((conditionKey) => ({ conditionKey, field: null, documents: [{ documentId: 't-encounter', version: 1 }, { documentId: 't-order', version: 2 }] }));
  };

  it('accepts a correctly declared multi-condition finding with per-condition routing', () => {
    expect(check((oracle) => r04(oracle, 'conflict', ['R04.order_before_encounter', 'R04.same_day_unsequenced']))).toEqual([]);
  });

  it('refuses non-canonical, duplicate and unsorted conditions', () => {
    fails(check((oracle) => r04(oracle, 'conflict', ['R04.practitioner_identifier_differs', 'R04.order_before_encounter'])), 'conditions are not in canonical order');
    fails(check((oracle) => r04(oracle, 'conflict', ['R04.order_before_encounter', 'R04.order_before_encounter'])), 'duplicate condition identity');
    fails(
      check((oracle) => {
        r04(oracle, 'conflict', ['R04.order_before_encounter']);
        finding(oracle, 'R04').conditions[0]?.documents.reverse();
      }),
      'canonical order',
    );
  });

  it('selects the status, role and state from the declared outcomes only', () => {
    fails(check((oracle) => r04(oracle, 'manual_review', ['R04.order_before_encounter', 'R04.same_day_unsequenced'])), 'the first outcome owning a held condition is conflict');
    fails(check((oracle) => (finding(oracle, 'R06').responsibleRole = 'administrative_reviewer')), 'role administrative_reviewer');
    fails(check((oracle) => (oracle.expectation.state = 'ready_for_review')), 'selects needs_human_review');
    fails(check((oracle) => (finding(oracle, 'R07').status = 'manual_review')), 'status manual_review, but the first outcome owning a held condition is pass');
    fails(
      check((oracle) => {
        finding(oracle, 'R10').conditions = [];
        finding(oracle, 'R10').status = 'pass';
      }),
      'the rule has no pass outcome',
    );
    fails(check((oracle) => (oracle.expectation.clinicalReviewRequired = false)), 'clinicalReviewRequired');
  });

  it('keeps quarantined versions in R02 and superseded versions in R02 and R09', () => {
    fails(
      check((oracle) => {
        const r09 = finding(oracle, 'R09');
        r09.status = 'conflict';
        r09.conditions = [{ conditionKey: 'R09.hash_mismatch', field: null, documents: [{ documentId: 't-note', version: 1 }] }];
        r09.affectedDocuments = [{ documentId: 't-note', version: 1 }];
      }),
      'names quarantined version t-note@v1; only R02 does',
    );
    fails(check((oracle) => finding(oracle, 'R03').citations.push({ documentId: 't-order', documentVersion: 1, locator: '/orderDate' })), 'names superseded version t-order@v1');
    fails(check((oracle) => finding(oracle, 'R03').citations.push({ documentId: 't-order', documentVersion: 1, locator: '/orderDate' })), 'cites a quarantined, superseded or R09-condition version');
    fails(check((oracle) => (finding(oracle, 'R02').affectedDocuments = [])), 'differ from C07');
  });

  it('derives C07 parent references from declared conditions only', () => {
    const restricted = (oracle: LooseOracle, affected: Ref[]) => {
      const r01 = finding(oracle, 'R01');
      r01.status = 'restricted';
      r01.responsibleRole = 'authorization_coordinator';
      r01.conditions = [{ conditionKey: 'R01.supplier_record_restricted', field: null, documents: [{ documentId: 't-supplier', version: 1 }] }];
      r01.affectedDocuments = affected;
      oracle.expectation.state = 'scope_hold';
    };
    expect(check((oracle) => restricted(oracle, [{ documentId: 't-supplier', version: 1 }]))).toEqual([]);
    fails(check((oracle) => restricted(oracle, [])), 'R01: affectedDocuments [] differ from C07 [t-supplier@v1]');
    fails(check((oracle) => (finding(oracle, 'R03').affectedDocuments = [{ documentId: 't-order', version: 2 }])), 'R03: affectedDocuments [t-order@v2] differ from C07 []');
    fails(
      check((oracle) => {
        const r09 = finding(oracle, 'R09');
        r09.status = 'conflict';
        r09.conditions = [{ conditionKey: 'R09.hash_mismatch', field: null, documents: [{ documentId: 't-receipt', version: 1 }] }];
      }),
      'R09: affectedDocuments [] differ from C07 [t-receipt@v1]',
    );
  });
});

describe('citations and exact text', () => {
  it('binds citations to supplied versions, rule evidence fields and non-null values', () => {
    fails(check((oracle) => finding(oracle, 'R05').citations.push({ documentId: 't-receipt', documentVersion: 9, locator: '/receivedAt' })), 't-receipt@v9 is not a supplied version');
    fails(check((oracle) => finding(oracle, 'R05').citations.push({ documentId: 't-receipt', documentVersion: 1, locator: '/recordedByRole' })), "not one of the rule's evidence fields");
    fails(check((oracle) => finding(oracle, 'R04').citations.push({ documentId: 't-encounter', documentVersion: 1, locator: '/completionTime/timestamp' })), 'does not resolve to a non-null value');
    fails(check((oracle) => finding(oracle, 'R06').citations.push({ documentId: 't-encounter', documentVersion: 1, locator: '/clinical/mobilityLimitation' })), 'does not resolve to a non-null value');
    fails(check((oracle) => finding(oracle, 'R05').citations.push({ documentId: 't-receipt', documentVersion: 1, locator: '/receivedAt' })), 'duplicate citation');
  });

  it('refuses citations of restricted, mismatched, unsupported or invalid sources', () => {
    const cite = (documentId: string) => (oracle: LooseOracle) => finding(oracle, 'R03').citations.push({ documentId, documentVersion: 1, locator: '/orderDate' });
    expect(check(undefined, {}, 'F16t')).toEqual([]);
    fails(check(cite('t-hidden'), {}, 'F16t'), 'without available payload bytes');
    fails(check(cite('t-badhash'), {}, 'F16t'), 'cited bytes differ from the metadata contentHash');
    fails(check(cite('t-plain'), {}, 'F16t'), 'unsupported MIME type');
    fails(check(cite('t-broken'), {}, 'F16t'), 'not a valid source body');
    fails(check((oracle) => finding(oracle, 'R09').citations.push({ documentId: 't-supplier', documentVersion: 1, locator: '/supplierId' })), "not one of the rule's evidence fields");
  });

  it('compares exact text with the raw source token', () => {
    expect(check((oracle) => oracle.expectation.exactText?.push({ documentId: 't-order', documentVersion: 2, locator: '/orderDate', originalText: '2026-09-02' }))).toEqual([]);
    fails(check((oracle) => ((oracle.expectation.exactText ?? [])[0] = { documentId: 't-order', documentVersion: 2, locator: '/item/quantity', originalText: '1' })), 'originalText differs');
    fails(check((oracle) => oracle.expectation.exactText?.push({ documentId: 't-order', documentVersion: 2, locator: '/item/description', originalText: 'x' })), 'names no cited fact');
  });
});

describe('identity, pins and references', () => {
  it('checks every identity cross-field', () => {
    fails(check((oracle) => (oracle.fixtureId = 'F02t')), 'oracle fixtureId differ');
    fails(check(undefined, { fixtureId: 'F01u' }), 'oracle fixtureId differ');
    fails(check((oracle) => (oracle.specReferences.fixtureRow = 'F02')), 'specReferences.fixtureRow differs');
    fails(check((oracle) => (oracle.fixtureManifestSha256 = digest('other manifest'))), 'fixtureManifestSha256');
    fails(check(undefined, { pin: { manifestSha256: digest('x'), oracleSha256: digest('y') } }), 'oracle SHA-256 differs from its batch pin');
    fails(check(undefined, { pin: { manifestSha256: digest('x'), oracleSha256: digest('y') } }), 'the batch pin differ');
  });

  it('checks the policy input against the manifest and the batch', () => {
    fails(check((oracle) => (oracle.policyInput.sha256 = digest('other pack'))), 'the oracle policyInput differs');
    fails(check((oracle) => (oracle.policyInput.packId = CORE_BATCH.policyInputs[0].packId)), 'the oracle policyInput differs');
    fails(check(undefined, { policyPin: undefined }), 'not pinned by its batch');
    fails(check(undefined, { policyPin: { ...CORE_BATCH.policyPack, sha256: digest('other') } }), 'policyInput.sha256 differs from its batch pin');
    fails(check(undefined, { policyBytes: Buffer.from('{}') }), 'needs a policy input that parses');
    fails(check((oracle) => (oracle.specReferences.sources = ['S13'])), 'S13 is not a source of the pack');
  });

  it('refuses malformed oracles', () => {
    fails(check((oracle) => (oracle.extra = true)), 'Unrecognized key');
    fails(check((oracle) => (oracle.expectation.unexpected = 1)), 'Unrecognized key');
    fails(checkOracle({ ...contextOf('F01t'), oracleBytes: Buffer.from('{') }), 'oracle is not UTF-8 JSON');
  });
});

function contextOf(fixtureId: string): OracleContext {
  const { manifestText, load } = fixture(fixtureId);
  return {
    fixtureId,
    pin: { manifestSha256: digest(manifestText), oracleSha256: digest('') },
    oracleBytes: Buffer.from(''),
    manifest: FixtureManifestV2.parse(JSON.parse(manifestText)),
    manifestBytes: Buffer.from(manifestText),
    load,
    policyPin: { ...CORE_BATCH.policyPack },
    policyBytes: packBytes,
    reviewedPack,
  };
}

describe('rejected expectations', () => {
  const rejected = (stage: string, reasons: unknown[]) => (oracle: LooseOracle) => (oracle.expectation = { outcome: 'rejected', stage, reasons } as unknown as LooseOracle['expectation']);
  const reason = (code: string, documentRef: Ref | null, path: string | null) => ({ code, documentRef, path });

  it('binds declared schema and snapshot reasons to supplied slots and their references', () => {
    expect(check(rejected('schema', [reason('case_invalid', null, '/case')]))).toEqual([]);
    expect(check(rejected('schema', [reason('document_metadata_invalid', { documentId: 't-order', version: 2 }, '/documents/t-order.v2/metadata')]))).toEqual([]);
    expect(check(rejected('snapshot_integrity', [reason('document_bytes_missing', { documentId: 't-order', version: 2 }, '/documents/t-order.v2/payload')]))).toEqual([]);
    fails(check(rejected('schema', [reason('document_metadata_invalid', null, '/documents/nope.v1/metadata')])), 'slot nope.v1 is not supplied');
    fails(check(rejected('snapshot_integrity', [reason('duplicate_document_version', { documentId: 't-order', version: 1 }, '/documents/t-order.v2/metadata')])), "not the slot's metadata reference");
    fails(check(rejected('schema', [reason('document_metadata_invalid', { documentId: 't-order', version: 1 }, '/documents/t-order.v2/metadata')])), "not the identity written in the slot's metadata");
  });

  it('refuses reasons outside the frozen shapes and order', () => {
    fails(check(rejected('schema', [reason('case_invalid', null, '/policyPack')])), 'case_invalid path must be /case');
    fails(check(rejected('schema', [reason('document_count_exceeded', null, '/documents')])), 'is not a schema reason');
    fails(check(rejected('schema', [reason('policy_pack_invalid', null, '/policyPack'), reason('case_invalid', null, '/case')])), 'unique and in canonical order');
    fails(check(rejected('schema', [])), 'expectation.reasons: Too small');
    fails(check((oracle) => (oracle.expectation = { outcome: 'rejected', stage: 'schema', reasons: [reason('case_invalid', null, '/case')], exactText: [] } as unknown as LooseOracle['expectation'])), 'Unrecognized key');
  });

  it('matches input-boundary expectations exactly against the loader', () => {
    const count = InputRejection.parse({ schemaVersion: 'pa.input-rejection.v1', stage: 'input_boundary', reasons: [reason('document_count_exceeded', null, '/documents')] });
    const load: LoadOutcome = { outcome: 'rejected', rejection: count };
    expect(check(rejected('input_boundary', count.reasons), { load })).toEqual([]);
    fails(check(undefined, { load }), 'but the oracle expects an assessed result');
    fails(check(rejected('schema', [reason('case_invalid', null, '/case')]), { load }), 'but the oracle expects a schema rejection');
    fails(check(rejected('input_boundary', [reason('path_outside_root', null, null)]), { load }), "differ from the loader's");
    fails(check(rejected('input_boundary', count.reasons)), 'that the loader does not produce');
  });
});

describe('declared-structure cross-checks', () => {
  it('requires a two-arity pair to name one document of each declared kind', () => {
    const pair = (documents: Ref[]) => (oracle: LooseOracle) => {
      const target = finding(oracle, 'R04');
      target.status = 'conflict';
      target.conditions = [{ conditionKey: 'R04.order_before_encounter', field: null, documents }];
    };
    expect(check(pair([{ documentId: 't-encounter', version: 1 }, { documentId: 't-order', version: 2 }]))).toEqual([]);
    fails(check(pair([{ documentId: 't-order', version: 1 }, { documentId: 't-order', version: 2 }])), "the key's arity two needs one document of each declared kind");
  });

  it('requires the R02 condition documents to equal the quarantine list', () => {
    fails(
      check((oracle) => ((finding(oracle, 'R02').conditions[0] ?? { documents: [] }).documents = [{ documentId: 't-receipt', version: 1 }])),
      'R02: condition documents [t-receipt@v1] differ from quarantinedDocuments [t-note@v1]',
    );
  });

  it('refuses two R09 conditions naming the same version', () => {
    const r09 = (keys: string[]) => (oracle: LooseOracle) => {
      const target = finding(oracle, 'R09');
      target.status = 'conflict';
      target.conditions = keys.map((conditionKey) => ({ conditionKey, field: null, documents: [{ documentId: 't-receipt', version: 1 }] }));
      target.affectedDocuments = [{ documentId: 't-receipt', version: 1 }];
      finding(oracle, 'R05').citations = [];
    };
    expect(check(r09(['R09.hash_mismatch']))).toEqual([]);
    fails(check(r09(['R09.hash_mismatch', 'R09.kind_mismatch'])), 'R09: t-receipt@v1 is named by more than one condition');
  });

  it('sets a document_metadata_invalid reference exactly when the written identity parses', () => {
    const invalid = (slot: string, documentRef: Ref | null) => (oracle: LooseOracle) =>
      (oracle.expectation = { outcome: 'rejected', stage: 'schema', reasons: [{ code: 'document_metadata_invalid', documentRef, path: `/documents/${slot}/metadata` }] } as unknown as LooseOracle['expectation']);
    expect(check(invalid('t-badkind.v1', { documentId: 't-badkind', version: 1 }), {}, 'F16t')).toEqual([]);
    fails(check(invalid('t-badkind.v1', null), {}, 'F16t'), "documentRef is not the identity written in the slot's metadata");
    expect(check(invalid('t-badversion.v1', null), {}, 'F16t')).toEqual([]);
    fails(check(invalid('t-badversion.v1', { documentId: 't-badversion', version: 1 }), {}, 'F16t'), "documentRef is not the identity written in the slot's metadata");
    expect(check(invalid('t-notjson.v1', null), {}, 'F16t')).toEqual([]);
  });
});
