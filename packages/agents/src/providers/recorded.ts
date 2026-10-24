import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { RecordingId } from '@pa/contracts';

import type { AgentProvider } from './types.js';

// Resolved from src/providers or dist/providers; both sit two levels below the package.
export const RECORDINGS_DIR = fileURLToPath(new URL('../../recordings/', import.meta.url));

/**
 * `pa.agent-recording.v1`: authored synthetic provider turns. A recording holds
 * proposals only; it never contains expected outcomes, scores or oracle data.
 * Turn outputs stay unvalidated here so a recording can exercise the graph's
 * own refusal of malformed or prohibited output.
 */
export const Recording = z.strictObject({
  schemaVersion: z.literal('pa.agent-recording.v1'),
  recordingId: RecordingId,
  synthetic: z.literal(true),
  label: z.literal('scripted_fixture'),
  provenance: z.string().min(1).max(1000),
  model: z.string().regex(/^recorded-[a-z0-9-]{1,100}$/),
  turns: z.array(z.strictObject({ output: z.unknown() })).min(1).max(20),
});
export type Recording = z.infer<typeof Recording>;

export class RecordingUnavailable extends Error {
  override name = 'RecordingUnavailable';
}

export interface LoadedRecording { recording: Recording; sha256: string }

/** Reads only `<id>.json` from the fixed recordings directory; the ID pattern excludes paths. */
export async function loadRecording(id: string, dir = RECORDINGS_DIR): Promise<LoadedRecording> {
  if (!RecordingId.safeParse(id).success) throw new RecordingUnavailable('invalid recording reference');
  let bytes: Buffer;
  try {
    bytes = await readFile(join(dir, `${id}.json`));
  } catch {
    throw new RecordingUnavailable('recording unavailable');
  }
  let parsed;
  try {
    parsed = Recording.safeParse(JSON.parse(bytes.toString('utf8')));
  } catch {
    throw new RecordingUnavailable('recording failed validation');
  }
  if (!parsed.success || parsed.data.recordingId !== id) throw new RecordingUnavailable('recording failed validation');
  return { recording: parsed.data, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** Replays turns by index, so a rerun node returns the same output. Past the end it finishes. */
export function createRecordedProvider({ recording, sha256 }: LoadedRecording): AgentProvider {
  return {
    identity: { provider: 'recorded', model: recording.model, label: 'scripted_fixture', recordingSha256: sha256 },
    version: `recorded:${recording.recordingId}@${sha256}`,
    next: ({ turn }) => Promise.resolve(recording.turns[turn]?.output ?? { type: 'finish' }),
  };
}
