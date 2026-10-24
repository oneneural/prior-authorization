import { type AssessmentOutcomeV3, type AssessmentResultV3 } from '@pa/contracts';

import { type Sha256Hasher, webCryptoSha256 } from '../hash.js';
import { assembleResultV3 } from './assemble.js';
import { type HeldConditionsByRule } from './backstop.js';
import { evaluateRulesV2 } from './evaluate.js';
import { assertAdapterContract, type AssessmentInputV2 } from './input.js';
import { evaluateWithBackstop, type PreflightSnapshot, type PreflightStage } from './preflight.js';
import { resultIssuesV3 } from './validate.js';

// The version 2 assessment entry point. It runs part A's stages
// (schema, snapshot integrity, classification), the rule predicates, the
// representability backstop, result assembly and final validation,
// and returns one `pa.assessment-outcome.v3`.

export interface AssessV2Options {
  /** SHA-256 implementation; the Web Crypto global by default. */
  sha256?: Sha256Hasher;
}

export type AssessV2Stage = PreflightStage | 'assembly' | 'validation';

/**
 * Internal test seam, reached only through `assessV2` with an options key that
 * the package never exports. It can replace the evaluator's held conditions
 * before the backstop, alter the assembled result before final validation and
 * observe each stage. There is no module state, so nothing outside a call can
 * change how it runs.
 */
export interface ForcingSeam {
  evaluate?: (snapshot: PreflightSnapshot, held: HeldConditionsByRule) => HeldConditionsByRule;
  tamper?: (result: AssessmentResultV3) => unknown;
  trace?: (stage: AssessV2Stage) => void;
}

export const FORCING_SEAM: unique symbol = Symbol('pa.domain.assessV2.forcingSeam');

type InternalOptions = AssessV2Options & { [FORCING_SEAM]?: ForcingSeam };

/** The only message of an internal invariant violation; it names no input content. */
export const INVARIANT_VIOLATION = 'the version 2 assessment assembled a result that breaks its own invariants';

const copyOf = (bytes: Uint8Array) => bytes.slice();

/**
 * Assesses one raw input against the version 2 pack it supplies. Pure: no
 * clock, file system, network or environment; the caller supplies every byte
 * and the explicit assessment date, and SHA-256 comes from the Web Crypto
 * global or `options.sha256`.
 *
 * Returns an assessed `AssessmentResultV3`, or a rejection holding the
 * complete canonical reason set of the first failing stage (schema, then
 * snapshot integrity), including the content-free `policy_pack_invalid`
 * backstop when the pack cannot represent the evaluation. It never
 * returns an `input_boundary` rejection, which only the loader reports.
 *
 * Throws, as caller or module defects rather than input properties:
 * - a content-free `RangeError` or `TypeError` before parsing anything when
 *   the input breaks the adapter contract: more than `MAX_DOCUMENTS_V2`
 *   versions, a payload over `MAX_SOURCE_BYTES_V2` bytes, or a slot label that
 *   is unsafe or not unique (`assertAdapterContract`);
 * - a content-free `Error` when the assembled result fails final schema or
 *   semantic validation, such as a duplicate condition identity or a dangling
 *   reference. That is an internal invariant violation: it is never
 *   returned as a rejection or as an assessed result.
 */
export async function assessV2(input: AssessmentInputV2, options: AssessV2Options = {}): Promise<AssessmentOutcomeV3> {
  assertAdapterContract(input);
  // Parse, hash and cite one private copy, so the pack hash and every
  // document hash cover exactly the bytes that are parsed.
  const exact: AssessmentInputV2 = {
    caseBytes: copyOf(input.caseBytes),
    policyPackBytes: copyOf(input.policyPackBytes),
    assessmentDate: input.assessmentDate,
    documents: input.documents.map((document) => ({ slot: document.slot, metadata: copyOf(document.metadata), payload: document.payload === null ? null : copyOf(document.payload) })),
  };
  const seam = (options as InternalOptions)[FORCING_SEAM];
  const sha256 = options.sha256 ?? webCryptoSha256;

  let held: HeldConditionsByRule | undefined;
  const evaluated = await evaluateWithBackstop(
    exact,
    (snapshot) => {
      const found = evaluateRulesV2(snapshot);
      held = seam?.evaluate === undefined ? found : seam.evaluate(snapshot, found);
      return held;
    },
    { sha256, ...(seam?.trace === undefined ? {} : { trace: seam.trace }) },
  );
  if (evaluated.outcome === 'rejected') {
    return evaluated;
  }
  if (held === undefined) {
    throw new Error(INVARIANT_VIOLATION);
  }

  seam?.trace?.('assembly');
  const policyPackSha256 = await sha256(exact.policyPackBytes);
  const assembled = assembleResultV3(evaluated.snapshot, evaluated.selections, held, policyPackSha256);
  const result = seam?.tamper === undefined ? assembled : seam.tamper(assembled);

  seam?.trace?.('validation');
  if (resultIssuesV3(result, evaluated.snapshot, policyPackSha256).length > 0) {
    throw new Error(INVARIANT_VIOLATION);
  }
  return { schemaVersion: 'pa.assessment-outcome.v3', outcome: 'assessed', result: result as AssessmentResultV3 };
}
