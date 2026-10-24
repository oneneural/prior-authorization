import { forwardToApi } from '../../../../lib/upstream';

export function POST(request: Request): Promise<Response> {
  return forwardToApi(request, '/api/pilot/probes');
}
