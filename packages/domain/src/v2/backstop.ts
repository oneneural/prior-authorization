import {
  arityAllows,
  type ConditionField,
  type DocumentKind,
  type DocumentRef,
  fieldMatchesQualifier,
  type FindingStatus,
  type PolicyPackV2,
  RuleId,
  type RuleOutcomeV2,
} from '@pa/contracts';

import { EVALUATOR_INVENTORY_V2, type EvaluatorInventoryV2 } from './inventory.js';
import { refKey } from './lineage.js';

// The held-condition backstop (D6 clarification). Preflight coverage
// should make it unreachable; if evaluation still emits a status or key that
// the inventory does not support or the pack does not declare, a condition the
// declaration cannot represent, or no selectable outcome, the caller discards
// every partial result and returns the content-free `policy_pack_invalid`
// rejection. A condition is never dropped and never becomes a pass.

/** A document a held condition names, with the kind its validated metadata states. */
export interface HeldDocument {
  ref: DocumentRef;
  kind: DocumentKind;
}

/** One non-pass condition an evaluator found to hold, with the status that owns it. */
export interface HeldConditionV2 {
  status: FindingStatus;
  conditionKey: string;
  field: ConditionField | null;
  documents: readonly HeldDocument[];
}

export type HeldConditionsByRule = Readonly<Record<RuleId, readonly HeldConditionV2[]>>;

/** The outcome each rule selects: the first in pack order owning a held condition, or `pass` when none holds. */
export type RuleSelections = Readonly<Record<RuleId, RuleOutcomeV2>>;

function representable(pack: PolicyPackV2, inventory: EvaluatorInventoryV2, ruleId: RuleId, held: HeldConditionV2): boolean {
  const supported = inventory[ruleId];
  const status = supported.statuses.find((candidate) => candidate.status === held.status);
  if (status === undefined || !supported.conditions.some((entry) => entry.conditionKey === held.conditionKey && entry.status === held.status)) {
    return false;
  }
  const outcome = pack.rules.find((rule) => rule.ruleId === ruleId)?.outcomes.find((candidate) => candidate.status === held.status);
  const declaration = outcome?.conditions.find((candidate) => candidate.conditionKey === held.conditionKey);
  if (outcome === undefined || declaration === undefined) {
    return false;
  }
  if ((status.responsibleRole ?? outcome.responsibleRole) !== outcome.responsibleRole || (status.stateEffect ?? outcome.stateEffect) !== outcome.stateEffect) {
    return false;
  }
  const refs = new Set(held.documents.map((document) => refKey(document.ref)));
  return (
    fieldMatchesQualifier(declaration.qualifier, held.field) &&
    (held.field === null || declaration.fields.includes(held.field)) &&
    arityAllows(declaration.documentArity, held.documents.length) &&
    refs.size === held.documents.length &&
    held.documents.every((document) => declaration.documentKinds.includes(document.kind))
  );
}

/**
 * Selects each rule's outcome when every held condition is representable by
 * the pack and the inventory; otherwise `undefined`, which the caller turns
 * into the backstop rejection.
 */
export function selectRepresentable(pack: PolicyPackV2, held: HeldConditionsByRule, inventory: EvaluatorInventoryV2 = EVALUATOR_INVENTORY_V2): RuleSelections | undefined {
  const selections: Partial<Record<RuleId, RuleOutcomeV2>> = {};
  for (const ruleId of RuleId.options) {
    const rule = pack.rules.find((candidate) => candidate.ruleId === ruleId);
    const conditions = held[ruleId];
    if (rule === undefined || !conditions.every((condition) => representable(pack, inventory, ruleId, condition))) {
      return undefined;
    }
    const passSupported = inventory[ruleId].statuses.some((candidate) => candidate.status === 'pass');
    const outcome =
      conditions.length === 0
        ? passSupported
          ? rule.outcomes.find((candidate) => candidate.status === 'pass')
          : undefined
        : rule.outcomes.find((candidate) => conditions.some((condition) => condition.status === candidate.status));
    if (outcome === undefined) {
      return undefined;
    }
    selections[ruleId] = outcome;
  }
  return selections as RuleSelections;
}
