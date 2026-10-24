import { forwardToApi } from '../../../lib/upstream';

export function GET(request: Request): Promise<Response> {
  return forwardToApi(request, '/api/status');
}
