import { CORE_BATCH } from './frozen-v2.js';
import { MIGRATED_DECISIONS_BATCH } from './frozen-v2-migrated.js';
import { CORE_ROWS_BATCH } from './frozen-v2-core-rows.js';
import { VERSION_DECISIONS_BATCH } from './frozen-v2-versions.js';
import { SCOPE_BATCH } from './frozen-v2-scope.js';
import { BOUNDARY_BATCH } from './frozen-v2-boundaries.js';

// The registered v2 batches: one ordered, data-only array of
// FrozenBatch tables that `pnpm test:oracles:v2` and later consumers validate as
// one union. A later reviewed data task may only append an import of its own new
// hash-only table and its entry here. Nothing discovers batches from directories.

export const V2_BATCHES = [CORE_BATCH, MIGRATED_DECISIONS_BATCH, CORE_ROWS_BATCH, VERSION_DECISIONS_BATCH, SCOPE_BATCH, BOUNDARY_BATCH] as const;
