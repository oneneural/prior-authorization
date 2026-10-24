import { authApiPath, forwardToApi, notFound } from '../../../../lib/upstream';

// Fixture sign-in, sign-out and session reads. Every Set-Cookie from the API is
// returned to the browser.
async function handle(request: Request, context: RouteContext<'/api/auth/[...path]'>): Promise<Response> {
  const path = authApiPath(request.method, (await context.params).path, new URL(request.url).searchParams);
  if (path === null) return notFound();
  return forwardToApi(request, path, { 'cache-control': 'no-store' }, true);
}

export const GET = handle;
export const POST = handle;
