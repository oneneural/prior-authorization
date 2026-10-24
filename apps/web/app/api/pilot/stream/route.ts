import { forwardToApi } from '../../../../lib/upstream';

/**
 * Dedicated streaming proxy for the SSE fixture. The upstream body is returned
 * unbuffered and a client disconnect aborts `request.signal`, cancelling the
 * upstream. `no-transform` asks Next's compression and any intermediary not to
 * re-encode the stream; the web transport tests check frame timing directly.
 */
export function GET(request: Request): Promise<Response> {
  return forwardToApi(request, '/api/pilot/stream', {
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no',
  });
}
