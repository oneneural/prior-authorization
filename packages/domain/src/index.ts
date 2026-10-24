// Deterministic, rules-only assessment for the first policy slice.
// Pure TypeScript: no file system, network, database, clock or environment
// access. Callers supply contract-valid records, exact source and policy pack
// bytes and an explicit assessment date.

export * from './assess.js';
export * from './calendar.js';
export * from './documents.js';
export * from './hash.js';
export * from './json-source.js';
export { ENCOUNTER_TO_ORDER_MONTHS, EVALUATOR_STATUSES, orderDateSpan, RULE_EVALUATORS, type HeldCondition, type RuleContext, type RuleEvaluation } from './rules.js';
// Version 2: the raw-input adapter shape, its bounds,
// the pack coverage check and the explicit `assessV2` entry point. The
// preflight, backstop, evaluator, assembly, validation and forcing seam stay
// internal.
export { assessV2, type AssessV2Options } from './v2/assess.js';
export { assertAdapterContract, MAX_DOCUMENTS_V2, MAX_SOURCE_BYTES_V2, type AssessmentInputV2, type DocumentInputV2 } from './v2/input.js';
export { EVALUATOR_INVENTORY_V2, packCoverageGaps, type EvaluatorInventoryV2, type InventoryCondition, type InventoryStatus, type RuleInventory } from './v2/inventory.js';
export { checkPolicyPackV2 } from './v2/schema.js';
