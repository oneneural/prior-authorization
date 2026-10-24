import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createRecordedProvider, loadRecording, RECORDINGS_DIR, RecordingUnavailable } from './recorded.js';

describe('recorded provider', () => {
  it('replays turns by index and finishes past the end', async () => {
    const loaded = await loadRecording('missing-order-investigation');
    const provider = createRecordedProvider(loaded);
    expect(provider.identity).toEqual({ provider: 'recorded', model: 'recorded-synthetic-v1', label: 'scripted_fixture', recordingSha256: loaded.sha256 });
    expect(provider.version).toBe(`recorded:missing-order-investigation@${loaded.sha256}`);
    const signal = new AbortController().signal;
    expect(await provider.next({ turn: 0, observations: [], signal })).toEqual({ type: 'call_tool', tool: 'list_documents', input: {} });
    expect(await provider.next({ turn: 99, observations: [], signal })).toEqual({ type: 'finish' });
  });

  it('accepts only plain recording IDs from the fixed directory', async () => {
    for (const id of ['../package', 'missing-order-investigation/../x', '/etc/passwd', 'no-such-recording']) {
      await expect(loadRecording(id)).rejects.toThrow(RecordingUnavailable);
    }
  });

  it('keeps runtime recordings synthetic and free of expected outcomes or scores', async () => {
    for (const file of await readdir(RECORDINGS_DIR)) {
      const text = await readFile(join(RECORDINGS_DIR, file), 'utf8');
      const recording = JSON.parse(text) as { synthetic: boolean; label: string };
      expect(recording).toMatchObject({ synthetic: true, label: 'scripted_fixture' });
      expect(text).not.toMatch(/"(expected[A-Za-z]*|score[A-Za-z]*|oracle[A-Za-z]*|gold)"\s*:/);
    }
  });
});
