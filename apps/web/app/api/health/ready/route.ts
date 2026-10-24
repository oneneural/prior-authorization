import { forwardToApi } from '../../../../lib/upstream';

/** Container readiness: answering here proves the web server, and the API adds its own checks. */
export function GET(request: Request): Promise<Response> {
  return forwardToApi(request, '/api/health/ready');
}
