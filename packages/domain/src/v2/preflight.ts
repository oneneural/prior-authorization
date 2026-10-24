import { type CaseV2, compareDocumentRefs, type DocumentRef, type PolicyPackV2 } from '@pa/contracts';

import { type Sha256Hasher, webCryptoSha256 } from '../hash.js';
import { type HeldConditionsByRule, type RuleSelections, selectRepresentable } from './backstop.js';
import { type ClassifiedVersion, classifySnapshot } from './classify.js';
import { assertAdapterContract, type AssessmentInputV2 } from './input.js';
import { EVALUATOR_INVENTORY_V2, type EvaluatorInventoryV2 } from './inventory.js';
import { snapshotIntegrityReasons, supersededKeys } from './lineage.js';
import { backstopRejection, type RejectedOutcomeV3, rejectedOutcome } from './reasons.js';
import { validateSchemaV2 } from './schema.js';

// Internal seam for the version 2 path. It runs the stages in
// order: schema, then snapshot integrity, then lineage and classification, and
// reports only the first failing stage. It is deliberately not exported from
// the package: it returns no assessed outcome, state, finding or fact, and
// `evaluateWithBackstop` exists so tests can force evaluator output against
// the backstop before the complete `assessV2` exists.

export type PreflightStage = 'schema' | 'snapshot_integrity' | 'classification' | 'evaluation' | 'backstop';

export interface PreflightOptions {
  /** SHA-256 implementation; the Web Crypto global by default. */
  sha256?: Sha256Hasher;
  inventory?: EvaluatorInventoryV2;
  /** Observes each stage as it starts. */
  trace?: (stage: PreflightStage) => void;
}

/** A validated, integrity-checked and classified snapshot. */
export interface PreflightSnapshot {
  caseRecord: CaseV2;
  pack: PolicyPackV2;
  assessmentDate: string;
  /** Every supplied version, in canonical reference order. */
  versions: readonly ClassifiedVersion[];
  /** Exact quarantined versions, in canonical order (D3). */
  quarantinedDocuments: readonly DocumentRef[];
  /** Every supplied target of a supersession edge, quarantined or not, in canonical order (C08). */
  supersededDocuments: readonly DocumentRef[];
}

export type PreflightResult = RejectedOutcomeV3 | { outcome: 'preflighted'; snapshot: PreflightSnapshot };

export async function preflightV2(input: AssessmentInputV2, options: PreflightOptions = {}): Promise<PreflightResult> {
  assertAdapterContract(input);
  const trace = options.trace ?? (() => undefined);

  trace('schema');
  const schema = validateSchemaV2(input, options.inventory ?? EVALUATOR_INVENTORY_V2);
  if (!schema.ok) {
    return rejectedOutcome('schema', schema.reasons);
  }

  trace('snapshot_integrity');
  const integrity = snapshotIntegrityReasons(schema.value);
  if (integrity.length > 0) {
    return rejectedOutcome('snapshot_integrity', integrity);
  }

  trace('classification');
  const { caseRecord, pack, assessmentDate, documents } = schema.value;
  const superseded = supersededKeys(schema.value);
  const versions = await classifySnapshot(documents, { caseRecord, pack, superseded }, options.sha256 ?? webCryptoSha256);
  return {
    outcome: 'preflighted',
    snapshot: {
      caseRecord,
      pack,
      assessmentDate,
      versions,
      quarantinedDocuments: versions.filter((version) => version.classification.status === 'quarantined').map((version) => version.ref),
      supersededDocuments: versions.filter((version) => !version.current).map((version) => version.ref).sort(compareDocumentRefs),
    },
  };
}

/**
 * Runs an evaluator on a preflighted snapshot and applies the backstop. An
 * earlier schema or snapshot rejection returns first and the evaluator never
 * runs. An unrepresentable evaluation discards everything and returns the
 * content-free `policy_pack_invalid` rejection; it never throws, drops a
 * condition or converts one to a pass.
 */
export async function evaluateWithBackstop(
  input: AssessmentInputV2,
  evaluate: (snapshot: PreflightSnapshot) => HeldConditionsByRule,
  options: PreflightOptions = {},
): Promise<RejectedOutcomeV3 | { outcome: 'representable'; snapshot: PreflightSnapshot; selections: RuleSelections }> {
  const preflight = await preflightV2(input, options);
  if (preflight.outcome === 'rejected') {
    return preflight;
  }
  const trace = options.trace ?? (() => undefined);
  trace('evaluation');
  const held = evaluate(preflight.snapshot);
  trace('backstop');
  const selections = selectRepresentable(preflight.snapshot.pack, held, options.inventory ?? EVALUATOR_INVENTORY_V2);
  return selections === undefined ? backstopRejection() : { outcome: 'representable', snapshot: preflight.snapshot, selections };
}
