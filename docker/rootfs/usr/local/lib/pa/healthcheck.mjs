// Docker healthcheck: the unit is healthy only when readiness passes through the
// web server (web, API, database with the expected schema and a fresh worker
// heartbeat from this boot). Docker keeps the printed reasons in its health log.
const READY_URL = 'http://127.0.0.1:3105/api/health/ready';

try {
  const response = await fetch(READY_URL, { signal: AbortSignal.timeout(4_000) });
  const body = await response.text();
  if (response.status !== 200) {
    console.log(`not ready: ${response.status} ${body.slice(0, 200)}`);
    process.exit(1);
  }
  console.log('ready');
} catch (error) {
  console.log(`not ready: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
