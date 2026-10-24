// Raw input adapter for the version 2 assessment. This is an adapter
// shape, not a persisted wire format: the caller passes exact bytes and the
// pure domain parses them with the exact v2 contracts. Document identity comes
// only from each metadata sidecar; the slot is an opaque label used in
// rejection paths.

/** One supplied document version: its logical slot, exact metadata bytes and exact payload bytes. */
export interface DocumentInputV2 {
  /** Caller-assigned label, unique within the input and safe in a logical input pointer. */
  slot: string;
  /** The exact `pa.document.v1` metadata bytes. */
  metadata: Uint8Array;
  /** The exact source payload bytes, or `null` when the caller holds none. */
  payload: Uint8Array | null;
}

/** Everything one version 2 assessment reads: raw case, pack and document bytes and the explicit date. */
export interface AssessmentInputV2 {
  /** The exact `pa.case.v2` bytes. */
  caseBytes: Uint8Array;
  /** The exact policy pack bytes; only `pa.policy-pack.v2` is accepted. */
  policyPackBytes: Uint8Array;
  /** The explicit assessment argument, verbatim; there is no clock. Its validity is a schema check. */
  assessmentDate: string;
  documents: readonly DocumentInputV2[];
}

// Loader-approved bounds (D6 F26 conventions). Only the loader reports
// `input_boundary` reasons; an assessment called with unbounded input violates
// its adapter contract and is refused before any byte is parsed.

/** Every supplied version counts, current or superseded: 50 pass, 51 do not. */
export const MAX_DOCUMENTS_V2 = 50;
/** Raw payload bytes per version, excluding metadata: 1,048,576 pass, 1,048,577 do not. */
export const MAX_SOURCE_BYTES_V2 = 1_048_576;

const SLOT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Checks the adapter contract: unique safe slot labels, at most
 * `MAX_DOCUMENTS_V2` versions and payloads of at most `MAX_SOURCE_BYTES_V2`
 * bytes. A violation is a caller defect, not an input rejection, so it throws
 * a content-free error. There is no aggregate byte limit.
 */
export function assertAdapterContract(input: AssessmentInputV2): void {
  if (input.documents.length > MAX_DOCUMENTS_V2) {
    throw new RangeError(`the adapter accepts at most ${MAX_DOCUMENTS_V2} document versions; the loader rejects larger inputs`);
  }
  const slots = new Set<string>();
  for (const document of input.documents) {
    if (!SLOT.test(document.slot) || slots.has(document.slot)) {
      throw new TypeError('every document needs a unique slot label of A-Z, a-z, 0-9, ., _ or -, starting alphanumeric');
    }
    slots.add(document.slot);
    if (document.payload !== null && document.payload.byteLength > MAX_SOURCE_BYTES_V2) {
      throw new RangeError(`the adapter accepts payloads of at most ${MAX_SOURCE_BYTES_V2} bytes; the loader rejects larger inputs`);
    }
  }
}
