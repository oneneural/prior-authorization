import { expect, it, vi } from 'vitest';

import { toolFetch, ToolFailure } from './workflow.js';

const url = new URL('http://127.0.0.1/internal/test');

it('retries transient tool failures at most twice and returns a recovered result', async () => {
  const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('connection reset')).mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(new Response('{}'));
  expect((await toolFetch(url, {}, fetcher)).status).toBe(200);
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it('stops on a permanent failure without retrying', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 403 }));
  await expect(toolFetch(url, {}, fetcher)).rejects.toMatchObject({ permanent: true, status: 403 });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('exhausts transient failures after three attempts', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 503 }));
  await expect(toolFetch(url, {}, fetcher)).rejects.toEqual(new ToolFailure(false));
  expect(fetcher).toHaveBeenCalledTimes(3);
});
