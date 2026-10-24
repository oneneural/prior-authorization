import { caseApiPath, forwardToApi, notFound } from '../../../../lib/upstream';

// Case reads, commands and the scoped event stream. The SSE body is passed
// through unbuffered, and a browser disconnect cancels only the upstream read.
const STREAM_HEADERS = { 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' };

async function handle(request: Request, context: RouteContext<'/api/cases/[[...path]]'>): Promise<Response> {
  const segments = (await context.params).path ?? [];
  const path = caseApiPath(request.method, segments, new URL(request.url).searchParams);
  if (path === null) return notFound();
  return forwardToApi(request, path, segments[1] === 'events' ? STREAM_HEADERS : {}, true);
}

export const GET = handle;
export const POST = handle;
