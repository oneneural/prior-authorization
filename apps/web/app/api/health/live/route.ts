import { forwardToApi } from '../../../../lib/upstream';

/** Liveness of the web server and the API; neither checks the database. */
export function GET(request: Request): Promise<Response> {
  return forwardToApi(request, '/api/health/live');
}
