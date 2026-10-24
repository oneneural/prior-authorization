import {
  arityAllows,
  compareConditions,
  conditionIdentity,
  DocumentExact,
  type DocumentRef,
  DocumentVersion,
  EVIDENCE_FIELD_SOURCES,
  type EvidenceCitation,
  fieldMatchesQualifier,
  FindingCondition,
  Identifier,
  type PolicyPackV2,
  PolicyPackV2 as PolicyPackV2Schema,
  REJECTION_REASON_SHAPES,
  SourceDocumentBodyExact,
  type StateEffect,
} from '@pa/contracts';

import { decodeUtf8, describeIssues, sha256 } from './files.js';
import { type JsonScan, scanJson } from './json-scan.js';
import { type LoadedFixture, type LoadOutcome } from './loader.js';
import { type AssessedExpectation, type FixtureManifestV2, type OracleV3, OracleV3 as OracleV3Schema, type PolicyPin, type RejectedExpectation } from './schemas.js';

// Structural checks of a `pa.oracle.v3` against its fixture and policy input.
// They check identity, pins, declared condition ownership,
// vocabulary, arity, kinds, ordering, duplicates and the routing the pack
// declares, and they bind every citation to exact source bytes. They never
// derive a condition, usability, binding, chronology or completeness from
// source content: held conditions, quarantine and supersession are taken as
// declared by the oracle. Completeness is independent oracle review.

const refKey = (ref: DocumentRef) => `${ref.documentId}@v${ref.version}`;
const citationRef = (citation: EvidenceCitation): DocumentRef => ({ documentId: citation.documentId, version: citation.documentVersion });
const STATE_EFFECT_RANK: Record<StateEffect, number> = { none: 0, needs_information: 1, needs_human_review: 2, scope_hold: 3 };
const STATE_FOR_EFFECT = ['ready_for_review', 'needs_information', 'needs_human_review', 'scope_hold'] as const;
/** C07 as amended: these rules name the documents of their held restricted, unreadable and failed-provenance conditions. */
const CANDIDATE_RULES = new Set(['R01', 'R03', 'R04', 'R05']);

export interface OracleContext {
  fixtureId: string;
  pin: { manifestSha256: string; oracleSha256: string };
  oracleBytes: Uint8Array;
  manifest: FixtureManifestV2;
  manifestBytes: Uint8Array;
  load: LoadOutcome;
  /** The batch pin selected by the manifest's `policyInput.path`, if any. */
  policyPin: PolicyPin | undefined;
  policyBytes: Uint8Array | null;
  /** The batch's reviewed pack, whose `sourceRefs` oracle sources must name. */
  reviewedPack: PolicyPackV2;
}

interface Supplied {
  slot: string;
  meta: DocumentExact;
  payload: Uint8Array | null;
}

const parseJson = (bytes: Uint8Array): JsonScan | null => {
  const text = decodeUtf8(bytes);
  return text === null ? null : scanJson(text);
};

/** Supplied versions by reference, from metadata that parses exactly; a reference shared by slots is ambiguous. */
function indexDocuments(fixture: LoadedFixture) {
  const byRef = new Map<string, Supplied | 'ambiguous'>();
  const bySlot = new Map<string, Supplied | null>();
  for (const document of fixture.documents) {
    const meta = DocumentExact.safeParse(parseJson(document.metadata)?.value);
    if (!meta.success) {
      bySlot.set(document.slot, null);
      continue;
    }
    const supplied = { slot: document.slot, meta: meta.data, payload: document.payload };
    const key = refKey(meta.data);
    byRef.set(key, byRef.has(key) ? 'ambiguous' : supplied);
    bySlot.set(document.slot, supplied);
  }
  return { byRef, bySlot };
}

function checkAssessed(expectation: AssessedExpectation, pack: PolicyPackV2, fixture: LoadedFixture, problems: string[]) {
  const { byRef } = indexDocuments(fixture);
  const supplied = (ref: DocumentRef, where: string): Supplied | undefined => {
    const found = byRef.get(refKey(ref));
    if (found === undefined) {
      problems.push(`${where}: ${refKey(ref)} is not a supplied version with valid metadata`);
    } else if (found === 'ambiguous') {
      problems.push(`${where}: ${refKey(ref)} is supplied by more than one slot`);
    }
    return typeof found === 'object' ? found : undefined;
  };

  const declarations = new Map(
    pack.rules.flatMap((rule) =>
      rule.outcomes.flatMap((outcome, outcomeIndex) => outcome.conditions.map((declaration) => [declaration.conditionKey, { ruleId: rule.ruleId, outcome, outcomeIndex, declaration }] as const)),
    ),
  );
  for (const rule of pack.rules) {
    const count = expectation.findings.filter((finding) => finding.ruleId === rule.ruleId).length;
    if (count !== 1) {
      problems.push(`${rule.ruleId}: ${count} findings; exactly one per rule is required`);
    }
  }
  for (const finding of expectation.findings) {
    if (!pack.rules.some((rule) => rule.ruleId === finding.ruleId)) {
      problems.push(`${finding.ruleId}: not a rule of the policy input`);
    }
  }

  const quarantined = new Set(expectation.quarantinedDocuments.map(refKey));
  const superseded = new Set(expectation.supersededDocuments.map(refKey));
  expectation.quarantinedDocuments.forEach((ref) => supplied(ref, 'quarantinedDocuments'));
  expectation.supersededDocuments.forEach((ref) => supplied(ref, 'supersededDocuments'));
  const withR09 = new Set(expectation.findings.filter((finding) => finding.ruleId === 'R09').flatMap((finding) => finding.conditions.flatMap((condition) => condition.documents.map(refKey))));
  const cited = new Set<string>();
  const scans = new Map<Supplied, JsonScan | null>();
  const scanOf = (document: Supplied) => {
    if (!scans.has(document)) {
      scans.set(document, document.payload === null ? null : parseJson(document.payload));
    }
    return scans.get(document) ?? null;
  };

  let highest = 0;
  for (const finding of expectation.findings) {
    const rule = pack.rules.find((candidate) => candidate.ruleId === finding.ruleId);
    if (rule === undefined) {
      continue;
    }
    const where = finding.ruleId;
    const held: { outcome: (typeof rule.outcomes)[number]; outcomeIndex: number; conditionKey: string; documents: DocumentRef[] }[] = [];
    finding.conditions.forEach((condition, index) => {
      const at = `${where} condition ${index} (${condition.conditionKey})`;
      const declared = declarations.get(condition.conditionKey);
      if (declared === undefined) {
        problems.push(`${at}: not declared by the policy input`);
        return;
      }
      if (declared.ruleId !== finding.ruleId) {
        problems.push(`${at}: declared under ${declared.ruleId}`);
        return;
      }
      const { declaration } = declared;
      if (!fieldMatchesQualifier(declaration.qualifier, condition.field) || (condition.field !== null && !declaration.fields.includes(condition.field))) {
        problems.push(`${at}: field is not one of the key's declared ${declaration.qualifier} values`);
      }
      const shape = FindingCondition.safeParse({ conditionKey: condition.conditionKey, field: condition.field, documentRefs: condition.documents });
      if (!shape.success) {
        problems.push(`${at}: ${describeIssues(shape.error)}`);
      }
      if (!arityAllows(declaration.documentArity, condition.documents.length)) {
        problems.push(`${at}: names ${condition.documents.length} documents; the key's arity is ${declaration.documentArity}`);
      }
      const kinds: string[] = [];
      for (const ref of condition.documents) {
        const document = supplied(ref, at);
        if (document !== undefined && !declaration.documentKinds.includes(document.meta.kind)) {
          problems.push(`${at}: ${refKey(ref)} is a ${document.meta.kind}, not one of the key's document kinds`);
        }
        kinds.push(document?.meta.kind ?? '');
      }
      // A `two` key names a pair: one document of each declared kind. Which order a receipt references is content.
      if (declaration.documentArity === 'two' && kinds.length === 2 && !kinds.includes('') && [...kinds].sort().join() !== [...declaration.documentKinds].sort().join()) {
        problems.push(`${at}: the key's arity two needs one document of each declared kind`);
      }
      held.push({ outcome: declared.outcome, outcomeIndex: declared.outcomeIndex, conditionKey: condition.conditionKey, documents: condition.documents });
    });
    const asRefs = finding.conditions.map((condition) => ({ conditionKey: condition.conditionKey, field: condition.field, documentRefs: condition.documents }));
    asRefs.forEach((condition, index) => {
      const previous = asRefs[index - 1];
      if (previous !== undefined && compareConditions(previous, condition) > 0) {
        problems.push(`${where}: conditions are not in canonical order at ${index}`);
      }
    });
    if (new Set(asRefs.map(conditionIdentity)).size !== asRefs.length) {
      problems.push(`${where}: duplicate condition identity`);
    }

    // The status is that of the first outcome owning a held condition; a pass holds none.
    const selected = held.reduce<(typeof held)[number] | undefined>((best, entry) => (best === undefined || entry.outcomeIndex < best.outcomeIndex ? entry : best), undefined);
    const outcome = selected?.outcome ?? (finding.conditions.length === 0 ? rule.outcomes.find((candidate) => candidate.status === 'pass') : undefined);
    if (finding.conditions.length === 0 && outcome === undefined) {
      problems.push(`${where}: the rule has no pass outcome, so at least one condition must hold`);
    }
    if (outcome !== undefined && finding.status !== outcome.status) {
      problems.push(`${where}: status ${finding.status}, but the first outcome owning a held condition is ${outcome.status}`);
    }
    if (outcome !== undefined && finding.responsibleRole !== outcome.responsibleRole) {
      problems.push(`${where}: role ${finding.responsibleRole}, but the pack routes ${outcome.status} to ${outcome.responsibleRole}`);
    }
    for (const entry of held) {
      highest = Math.max(highest, STATE_EFFECT_RANK[entry.outcome.stateEffect]);
    }

    // C07 as amended: the finding's own document references follow from its declared conditions.
    const expected = new Set(
      finding.ruleId === 'R02'
        ? quarantined
        : finding.ruleId === 'R09'
          ? held.flatMap((entry) => entry.documents.map(refKey))
          : CANDIDATE_RULES.has(finding.ruleId)
            ? held
                .filter(
                  (entry) =>
                    entry.outcome.status === finding.status &&
                    (entry.outcome.status === 'restricted' || entry.outcome.status === 'unreadable' || entry.conditionKey.endsWith('_failed_provenance')),
                )
                .flatMap((entry) => entry.documents.map(refKey))
            : [],
    );
    const affected = finding.affectedDocuments.map(refKey);
    finding.affectedDocuments.forEach((ref) => supplied(ref, `${where} affectedDocuments`));
    if (new Set(affected).size !== affected.length) {
      problems.push(`${where}: duplicate affected document`);
    }
    if (new Set(affected).size !== expected.size || affected.some((key) => !expected.has(key))) {
      problems.push(`${where}: affectedDocuments [${[...new Set(affected)].sort().join(', ')}] differ from C07 [${[...expected].sort().join(', ')}]`);
    }

    // D3 and C07: R02's condition documents are exactly the quarantine list. R09 gives each version
    // at most one condition; which one applies is not decided here.
    if (finding.ruleId === 'R02') {
      const conditionDocuments = new Set(finding.conditions.flatMap((condition) => condition.documents.map(refKey)));
      if (conditionDocuments.size !== quarantined.size || [...conditionDocuments].some((key) => !quarantined.has(key))) {
        problems.push(`${where}: condition documents [${[...conditionDocuments].sort().join(', ')}] differ from quarantinedDocuments [${[...quarantined].sort().join(', ')}]`);
      }
    }
    if (finding.ruleId === 'R09') {
      const conditionDocuments = finding.conditions.flatMap((condition) => condition.documents.map(refKey));
      for (const key of new Set(conditionDocuments.filter((candidate, index) => conditionDocuments.indexOf(candidate) !== index))) {
        problems.push(`${where}: ${key} is named by more than one condition`);
      }
    }

    // A quarantined version appears only in R02; a superseded one only in R02 and R09 (D3, C08).
    const named = [...affected, ...finding.conditions.flatMap((condition) => condition.documents.map(refKey)), ...finding.citations.map((citation) => refKey(citationRef(citation)))];
    for (const key of new Set(named)) {
      if (finding.ruleId !== 'R02' && quarantined.has(key)) {
        problems.push(`${where}: names quarantined version ${key}; only R02 does`);
      }
      if (finding.ruleId !== 'R02' && finding.ruleId !== 'R09' && superseded.has(key)) {
        problems.push(`${where}: names superseded version ${key}; only R02 and R09 do`);
      }
    }

    const keys = new Set<string>();
    for (const citation of finding.citations) {
      const ref = citationRef(citation);
      const key = `${refKey(ref)}${citation.locator}`;
      const at = `${where} citation ${key}`;
      if (keys.has(key)) {
        problems.push(`${at}: duplicate citation`);
      }
      keys.add(key);
      cited.add(key);
      if (quarantined.has(refKey(ref)) || superseded.has(refKey(ref)) || withR09.has(refKey(ref))) {
        problems.push(`${at}: cites a quarantined, superseded or R09-condition version`);
      }
      const document = supplied(ref, at);
      if (document === undefined) {
        continue;
      }
      const { meta } = document;
      if (meta.accessStatus !== 'available' || document.payload === null) {
        problems.push(`${at}: cites a version without available payload bytes`);
        continue;
      }
      if (sha256(document.payload) !== meta.contentHash) {
        problems.push(`${at}: cited bytes differ from the metadata contentHash`);
        continue;
      }
      if (!pack.scope.documentMimeTypes.includes(meta.mimeType)) {
        problems.push(`${at}: cites an unsupported MIME type`);
        continue;
      }
      const scan = scanOf(document);
      const body = SourceDocumentBodyExact.safeParse(scan?.value);
      if (scan === null || !body.success || body.data.documentKind !== meta.kind) {
        problems.push(`${at}: cites a body that is not a valid source body of its metadata kind`);
        continue;
      }
      const pointers = rule.evidenceFields.filter((field) => EVIDENCE_FIELD_SOURCES[field].documentKind === meta.kind).map((field) => EVIDENCE_FIELD_SOURCES[field].pointer);
      if (!pointers.includes(citation.locator)) {
        problems.push(`${at}: locator is not one of the rule's evidence fields for a ${meta.kind}`);
      }
      const scalar = scan.scalars.get(citation.locator);
      if (scalar === undefined || scalar.kind === 'null') {
        problems.push(`${at}: locator does not resolve to a non-null value`);
      }
    }
  }

  const state = STATE_FOR_EFFECT[highest];
  if (expectation.state !== state) {
    problems.push(`state ${expectation.state}, but the highest state effect of the held conditions selects ${state}`);
  }
  const clinical = expectation.findings.find((finding) => finding.ruleId === 'R06')?.status === 'manual_review';
  if (expectation.clinicalReviewRequired !== clinical) {
    problems.push('clinicalReviewRequired must be true exactly when R06 is manual_review');
  }
  (expectation.exactText ?? []).forEach((entry, index) => {
    const ref = { documentId: entry.documentId, version: entry.documentVersion };
    const at = `exactText ${index} (${refKey(ref)}${entry.locator})`;
    if (!cited.has(`${refKey(ref)}${entry.locator}`)) {
      problems.push(`${at}: names no cited fact`);
      return;
    }
    const document = byRef.get(refKey(ref));
    const scalar = typeof document === 'object' ? scanOf(document)?.scalars.get(entry.locator) : undefined;
    const text = scalar === undefined ? undefined : scalar.kind === 'string' ? (JSON.parse(scalar.raw) as string) : scalar.raw;
    if (text !== entry.originalText) {
      problems.push(`${at}: originalText differs from the source text at the locator`);
    }
  });
}

/** Schema and snapshot rejections are domain predicates; here only their slots and references are bound to the fixture. */
function checkRejected(expectation: RejectedExpectation, fixture: LoadedFixture, problems: string[]) {
  const { bySlot } = indexDocuments(fixture);
  expectation.reasons.forEach((reason, index) => {
    const slot = reason.path === null ? undefined : /^\/documents\/([^/]+)\//.exec(reason.path)?.[1];
    if (slot === undefined) {
      return;
    }
    const at = `reason ${index} (${reason.code})`;
    if (!bySlot.has(slot)) {
      problems.push(`${at}: slot ${slot} is not supplied`);
      return;
    }
    const document = bySlot.get(slot);
    if (REJECTION_REASON_SHAPES[reason.code].documentRef === 'required' && (document == null || reason.documentRef === null || refKey(document.meta) !== refKey(reason.documentRef))) {
      problems.push(`${at}: documentRef is not the slot's metadata reference`);
    }
    // The reference is the identity written in the sidecar exactly when its documentId and version both parse.
    if (reason.code === 'document_metadata_invalid') {
      const raw = fixture.documents.find((candidate) => candidate.slot === slot);
      const value = raw === undefined ? undefined : parseJson(raw.metadata)?.value;
      const fields = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
      const documentId = Identifier.safeParse(fields.documentId);
      const version = DocumentVersion.safeParse(fields.version);
      const written = documentId.success && version.success ? refKey({ documentId: documentId.data, version: version.data }) : null;
      if ((reason.documentRef === null ? null : refKey(reason.documentRef)) !== written) {
        problems.push(`${at}: documentRef is not the identity written in the slot's metadata`);
      }
    }
  });
}

export function parseOracle(bytes: Uint8Array): { oracle: OracleV3 } | { problems: string[] } {
  const scan = parseJson(bytes);
  if (scan === null) {
    return { problems: ['oracle is not UTF-8 JSON'] };
  }
  const parsed = OracleV3Schema.safeParse(scan.value);
  return parsed.success ? { oracle: parsed.data } : { problems: [`oracle: ${describeIssues(parsed.error)}`] };
}

/** Every structural problem of one oracle, content-free. */
export function checkOracle(context: OracleContext): string[] {
  const parsed = parseOracle(context.oracleBytes);
  if ('problems' in parsed) {
    return parsed.problems;
  }
  const { oracle } = parsed;
  const { manifest } = context;
  const problems: string[] = [];
  const manifestSha256 = sha256(context.manifestBytes);

  if (sha256(context.oracleBytes) !== context.pin.oracleSha256) {
    problems.push('oracle SHA-256 differs from its batch pin');
  }
  if (oracle.fixtureId !== context.fixtureId || manifest.fixtureId !== context.fixtureId) {
    problems.push('the batch key, directory, manifest fixtureId and oracle fixtureId differ');
  }
  if (oracle.fixtureManifestSha256 !== manifestSha256 || context.pin.manifestSha256 !== manifestSha256) {
    problems.push('fixtureManifestSha256, the manifest bytes and the batch pin differ');
  }
  if (oracle.specReferences.fixtureRow !== manifest.specFixtureRow) {
    problems.push('specReferences.fixtureRow differs from the manifest specFixtureRow');
  }
  if (context.policyPin === undefined) {
    problems.push('the manifest policyInput.path is not pinned by its batch');
  } else {
    if (context.policyPin.sha256 !== manifest.policyInput.sha256) {
      problems.push('the manifest policyInput.sha256 differs from its batch pin');
    }
    if (oracle.policyInput.packId !== context.policyPin.packId || oracle.policyInput.sha256 !== context.policyPin.sha256) {
      problems.push('the oracle policyInput differs from the pin the manifest selects');
    }
  }
  const sources = new Set(context.reviewedPack.sourceRefs.map((source) => source.sourceRefId));
  for (const source of oracle.specReferences.sources) {
    if (!sources.has(source)) {
      problems.push(`specReferences.sources: ${source} is not a source of the pack`);
    }
  }

  const { expectation } = oracle;
  const { load } = context;
  if (load.outcome === 'refused') {
    return problems;
  }
  if (load.outcome === 'rejected') {
    if (expectation.outcome !== 'rejected' || expectation.stage !== 'input_boundary') {
      problems.push(`the loader rejects the fixture at input_boundary, but the oracle expects ${expectation.outcome === 'rejected' ? `a ${expectation.stage} rejection` : 'an assessed result'}`);
    } else if (JSON.stringify(expectation.reasons) !== JSON.stringify(load.rejection.reasons)) {
      problems.push("the expected input_boundary reasons differ from the loader's");
    }
    return problems;
  }
  if (expectation.outcome === 'rejected') {
    if (expectation.stage === 'input_boundary') {
      problems.push('the oracle expects an input_boundary rejection that the loader does not produce');
    } else {
      checkRejected(expectation, load.fixture, problems);
    }
    return problems;
  }
  const pack = context.policyBytes === null ? null : PolicyPackV2Schema.safeParse(parseJson(context.policyBytes)?.value);
  if (pack === null || !pack.success) {
    problems.push('an assessed oracle needs a policy input that parses as pa.policy-pack.v2');
    return problems;
  }
  checkAssessed(expectation, pack.data, load.fixture, problems);
  return problems;
}
