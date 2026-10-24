import { afterEach, describe, expect, it, vi } from 'vitest';

import { ErrorResponse } from '@pa/contracts';

import { forwardToApi, MAX_REQUEST_BODY_BYTES } from '../lib/upstream';

// Calls the forwarding function directly, because a client that breaks its own
// upload never reads the response through a real server.

const encoder = new TextEncoder();

/** A POST whose body yields the given chunks and then, optionally, fails. */
function postWithBody(chunks: string[], failure?: Error): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      if (failure === undefined) {
        controller.close();
      } else {
        controller.error(failure);
      }
    },
  });
  return new Request('http://127.0.0.1/api/pilot/probes', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'unit-key' },
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
}

async function errorCode(response: Response): Promise<string> {
  return ErrorResponse.parse(await response.json()).error.code;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('forwardToApi request bodies', () => {
  it.each([
    ['the client aborts mid-body', new DOMException('The operation was aborted', 'AbortError')],
    ['the client connection breaks mid-body', Object.assign(new Error('aborted'), { code: 'ECONNRESET' })],
  ])('answers 400 and never contacts the API when %s', async (_label, failure) => {
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', upstream);
    const response = await forwardToApi(postWithBody(['{"label":'], failure), '/api/pilot/probes');
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('invalid_request');
    expect(upstream).not.toHaveBeenCalled();
  });

  it('answers 413 for a streamed body over the limit and never contacts the API', async () => {
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', upstream);
    const half = 'x'.repeat(MAX_REQUEST_BODY_BYTES / 2 + 1);
    const response = await forwardToApi(postWithBody([half, half]), '/api/pilot/probes');
    expect(response.status).toBe(413);
    expect(await errorCode(response)).toBe('payload_too_large');
    expect(upstream).not.toHaveBeenCalled();
  });

  it('answers 502 only when the API itself cannot be reached (positive control)', async () => {
    const upstream = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', upstream);
    const response = await forwardToApi(postWithBody(['{"label":"ok"}']), '/api/pilot/probes');
    expect(response.status).toBe(502);
    expect(await errorCode(response)).toBe('upstream_unavailable');
    expect(upstream).toHaveBeenCalledTimes(1);
    const [, init] = upstream.mock.calls[0]!;
    expect(new TextDecoder().decode(init?.body as Uint8Array)).toBe('{"label":"ok"}');
  });
});
