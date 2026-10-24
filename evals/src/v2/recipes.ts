import { DocumentExact } from '@pa/contracts';

import { decodeUtf8, describeIssues, sha256, utf8Length } from './files.js';
import { scanJson } from './json-scan.js';
import { type FixtureManifestV2, isReservedSlot, MAX_GENERATED_BYTES, type PadRecipe, type Recipe, type ReplicateRecipe } from './schemas.js';

// The closed `pad` and `replicate` recipe grammar (docs/policy-slice.md "Recipe
// grammar", with the recipe readings in the structural validation addendum). A recipe is
// data: it reads only listed templates or earlier recipe outputs, writes only
// its pinned outputs, and runs in array order. Outputs are built in memory and
// never written to the suite. Every check that allocates is preceded by a size
// check against the per-recipe and per-fixture bounds.

export interface RecipeOutput {
  recipeIndex: number;
  path: string;
  slot: string;
  role: 'payload' | 'metadata';
}

const slotOfPayload = (path: string) => path.slice('documents/'.length, -'.json'.length);
export const payloadPath = (slot: string) => `documents/${slot}.json`;
export const metadataPath = (slot: string) => `documents/${slot}.meta.json`;
const label = (index: number, recipe: Recipe) => `recipe ${index} (${recipe.recipe})`;

const inputsOf = (recipe: Recipe): [string, string][] =>
  recipe.recipe === 'pad'
    ? [['template', recipe.template]]
    : [
        ['payload', recipe.payload],
        ['metadataTemplate', recipe.metadataTemplate],
      ];

const outputsOf = (index: number, recipe: Recipe): RecipeOutput[] =>
  recipe.recipe === 'pad'
    ? [{ recipeIndex: index, path: recipe.output, slot: slotOfPayload(recipe.output), role: 'payload' }]
    : recipe.outputs.flatMap(({ slot }) => [
        { recipeIndex: index, path: payloadPath(slot), slot, role: 'payload' as const },
        { recipeIndex: index, path: metadataPath(slot), slot, role: 'metadata' as const },
      ]);

/**
 * Static checks that read no bytes: every input is a listed template or an
 * earlier recipe's output (a later or own output is a forward reference, so no
 * cycle can run), outputs are slot files that collide with no committed file
 * and no other output, and replicated payloads are payloads, not generated
 * metadata. That last rule is a ratified exception to the frozen
 * grammar: generated metadata has no size before expansion, so it
 * could not be measured before the count and size gates.
 */
export function checkRecipeGraph(manifest: FixtureManifestV2): { outputs: RecipeOutput[]; problems: string[] } {
  const recipes = manifest.recipes ?? [];
  const committed = new Set(manifest.files.map((file) => file.path));
  const templates = new Set([...committed].filter((path) => path.endsWith('.template.json')));
  const all = recipes.flatMap((recipe, index) => outputsOf(index, recipe));
  const producedBy = new Map<string, RecipeOutput>();
  const problems: string[] = [];
  const outputs: RecipeOutput[] = [];

  recipes.forEach((recipe, index) => {
    for (const [field, path] of inputsOf(recipe)) {
      const earlier = producedBy.get(path);
      if (earlier !== undefined) {
        if (recipe.recipe === 'replicate' && field === 'payload' && earlier.role === 'metadata') {
          problems.push(`${label(index, recipe)}: payload is generated metadata, not a payload`);
        }
        continue;
      }
      const later = all.find((output) => output.path === path);
      if (later !== undefined) {
        problems.push(`${label(index, recipe)}: ${field} is a forward reference to the output of recipe ${later.recipeIndex}`);
      } else if (!templates.has(path)) {
        problems.push(`${label(index, recipe)}: ${field} is neither a listed template nor an earlier recipe output`);
      }
    }
    for (const output of outputsOf(index, recipe)) {
      if (isReservedSlot(output.slot)) {
        problems.push(`${label(index, recipe)}: output slot ${output.slot} ends in .meta or .template (N3)`);
      } else if (committed.has(output.path)) {
        problems.push(`${label(index, recipe)}: output ${output.path} collides with a committed file`);
      } else if (producedBy.has(output.path)) {
        problems.push(`${label(index, recipe)}: output ${output.path} duplicates the output of recipe ${producedBy.get(output.path)?.recipeIndex}`);
      } else {
        producedBy.set(output.path, output);
        outputs.push(output);
      }
    }
  });
  return { outputs, problems };
}

/**
 * Generated payload sizes from the descriptors alone, without expansion: a pad
 * output is `targetBytes`, a replicated copy is its payload input's size.
 * `committedSize` returns `undefined` for an input it could not measure.
 */
export function predictPayloadSizes(manifest: FixtureManifestV2, committedSize: (path: string) => number | undefined): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const recipe of manifest.recipes ?? []) {
    if (recipe.recipe === 'pad') {
      sizes.set(recipe.output, recipe.targetBytes);
    } else {
      const size = sizes.get(recipe.payload) ?? committedSize(recipe.payload);
      if (size !== undefined) {
        recipe.outputs.forEach(({ slot }) => sizes.set(payloadPath(slot), size));
      }
    }
  }
  return sizes;
}

/** Every start offset of `needle` in `text`, overlapping occurrences included. */
function occurrences(text: string, needle: string): number[] {
  const found: number[] = [];
  for (let index = text.indexOf(needle); index !== -1; index = text.indexOf(needle, index + 1)) {
    found.push(index);
  }
  return found;
}

type Step = { bytes: Map<string, Uint8Array>; size: number } | { problem: string };

function pad(index: number, recipe: PadRecipe, template: Uint8Array, budget: number): Step {
  const name = label(index, recipe);
  const placeholderBytes = utf8Length(recipe.placeholder);
  const fillBytes = utf8Length(recipe.fill);
  const text = decodeUtf8(template);
  if (text === null) {
    return { problem: `${name}: template is not valid UTF-8` };
  }
  const found = occurrences(text, recipe.placeholder);
  if (found.length !== 1) {
    return { problem: `${name}: template holds ${found.length} placeholder occurrences, not exactly one` };
  }
  const remaining = recipe.targetBytes - (template.length - placeholderBytes);
  if (remaining < 0) {
    return { problem: `${name}: targetBytes is smaller than the template without its placeholder` };
  }
  if (remaining % fillBytes !== 0) {
    return { problem: `${name}: targetBytes is not reachable by whole repetitions of fill` };
  }
  if (budget + recipe.targetBytes > MAX_GENERATED_BYTES) {
    return { problem: `${name}: the fixture's recipes would generate more than ${MAX_GENERATED_BYTES} bytes` };
  }
  const start = found[0] ?? 0;
  const end = start + recipe.placeholder.length;
  const scan = scanJson(text);
  const inside = scan?.strings.some(
    (string) =>
      string.contentStart <= start &&
      end <= string.contentEnd &&
      string.escapes.every(([from, to]) => !(from < start && start < to) && !(from < end && end < to)),
  );
  if (inside !== true) {
    return { problem: `${name}: the placeholder is not inside one JSON string value` };
  }
  const offset = utf8Length(text.slice(0, start));
  const output = Buffer.concat([template.subarray(0, offset), Buffer.from(recipe.fill.repeat(remaining / fillBytes), 'utf8'), template.subarray(offset + placeholderBytes)]);
  if (sha256(output) !== recipe.sha256) {
    return { problem: `${name}: output ${recipe.output} SHA-256 differs from its pin` };
  }
  return { bytes: new Map([[recipe.output, output]]), size: output.length };
}

function replicate(index: number, recipe: ReplicateRecipe, payload: Uint8Array, metadataTemplate: Uint8Array, budget: number): Step {
  const name = label(index, recipe);
  const text = decodeUtf8(metadataTemplate);
  if (text === null) {
    return { problem: `${name}: metadata template is not valid UTF-8` };
  }
  const pieces = text.split(recipe.placeholder);
  const placeholders = pieces.length - 1;
  const placeholderBytes = utf8Length(recipe.placeholder);
  let size = 0;
  for (let copy = 1; copy <= recipe.count; copy += 1) {
    const indexLength = placeholders === 0 ? 0 : Math.max(recipe.width, String(copy).length);
    size += metadataTemplate.length + placeholders * (indexLength - placeholderBytes) + payload.length;
  }
  if (budget + size > MAX_GENERATED_BYTES) {
    return { problem: `${name}: the fixture's recipes would generate more than ${MAX_GENERATED_BYTES} bytes` };
  }

  const bytes = new Map<string, Uint8Array>();
  const ids = new Set<string>();
  let contentHash: string | null | undefined;
  for (let copy = 1; copy <= recipe.count; copy += 1) {
    const pinned = recipe.outputs[copy - 1];
    const rendered = Buffer.from(placeholders === 0 ? text : pieces.join(String(copy).padStart(recipe.width, '0')), 'utf8');
    const scan = scanJson(rendered.toString('utf8'));
    const metadata = DocumentExact.safeParse(scan?.value);
    if (scan === null || !metadata.success) {
      return { problem: `${name}: copy ${copy} metadata is not valid pa.document.v1${metadata.error === undefined ? '' : ` (${describeIssues(metadata.error)})`}` };
    }
    const slot = `${metadata.data.documentId}.v${metadata.data.version}`;
    if (ids.has(metadata.data.documentId)) {
      return { problem: `${name}: copy ${copy} repeats an earlier copy's document ID` };
    }
    ids.add(metadata.data.documentId);
    if (pinned === undefined || pinned.slot !== slot) {
      return { problem: `${name}: copy ${copy} renders slot ${slot}, which differs from outputs[${copy - 1}]` };
    }
    if (contentHash !== undefined && metadata.data.contentHash !== contentHash) {
      return { problem: `${name}: copy ${copy} changes the literal contentHash` };
    }
    contentHash = metadata.data.contentHash;
    if (sha256(rendered) !== pinned.metadataSha256) {
      return { problem: `${name}: copy ${copy} metadata SHA-256 differs from its pin` };
    }
    bytes.set(metadataPath(slot), rendered);
    bytes.set(payloadPath(slot), payload);
  }
  return { bytes, size };
}

/**
 * Expands every recipe in order and checks every pinned output. Stops at the
 * first refusal; generated bytes stay in memory.
 */
export async function expandRecipes(
  manifest: FixtureManifestV2,
  readCommitted: (path: string) => Promise<Uint8Array>,
): Promise<{ outputs: Map<string, Uint8Array>; verified: number; problems: string[] }> {
  const graph = checkRecipeGraph(manifest);
  const outputs = new Map<string, Uint8Array>();
  if (graph.problems.length > 0) {
    return { outputs, verified: 0, problems: graph.problems };
  }
  const read = (path: string) => {
    const generated = outputs.get(path);
    return generated === undefined ? readCommitted(path) : Promise.resolve(generated);
  };
  let budget = 0;
  let verified = 0;
  for (const [index, recipe] of (manifest.recipes ?? []).entries()) {
    const step =
      recipe.recipe === 'pad'
        ? pad(index, recipe, await read(recipe.template), budget)
        : replicate(index, recipe, await read(recipe.payload), await read(recipe.metadataTemplate), budget);
    if ('problem' in step) {
      return { outputs, verified, problems: [step.problem] };
    }
    budget += step.size;
    verified += recipe.recipe === 'pad' ? 1 : recipe.count;
    step.bytes.forEach((bytes, path) => outputs.set(path, bytes));
  }
  return { outputs, verified, problems: [] };
}
