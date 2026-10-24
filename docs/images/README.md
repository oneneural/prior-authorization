# README screenshots

The [project README](../../README.md) shows four screens of the packaged
workbench. `raw/` holds the unedited browser captures. The files in this
directory add a neutral window frame with the loopback URL bar, drawn in CSS by
[frame.py](frame.py) because no imaging library is assumed.

| Image | Route | State shown |
| --- | --- | --- |
| [01-operator-queue.png](01-operator-queue.png) | `/` | Fixture operator signed in; the seven seeded synthetic cases after their first assessment, each at revision 1 |
| [02-case-evidence.png](02-case-evidence.png) | `/cases/case-f02-loop` | Revision 1, scrolled to the source documents and requirement matrix; R03 reports the finalized order as not supplied |
| [03-source-view.png](03-source-view.png) | `/cases/case-f02-loop/sources/f01-encounter/1?locator=%2FencounterDate` | The encounter source at the cited locator, with its cited value and content hash |
| [04-reviewer-packet.png](04-reviewer-packet.png) | `/cases/case-f02-loop/packet` | Fixture administrative reviewer signed in; revision 2 packet ready for administrative review, before any decision |

## Capture environment

| Item | Value |
| --- | --- |
| Date | 2026-10-24 |
| Deployment | Packaged Compose deployment with fresh volumes and throwaway secrets, on `http://127.0.0.1:3105` |
| Modes | `DATA_MODE=fixture`, `AUTH_MODE=fixture`, `AGENT_MODE=rules`, `AGENT_GRAPH_PROVIDER=off`; no model key, zero live budgets |
| Browser | Google Chrome 155.0.8059.86 on macOS 27.0.1 (arm64), driven by Playwright |
| Viewport | 1440 x 900 CSS pixels, device scale factor 1 |
| Captures | Viewport captures, except `04-reviewer-packet.png`, a full-page capture at the same viewport so the packet and its reviewer controls appear together |
| Color scheme | The workbench's own dark theme |

## Steps

1. From a clean checkout with Docker, start a disposable deployment with its own
   project name, image tag and secrets directory, and no `.env`:

   ```sh
   export PA_SECRETS_DIR="$(mktemp -d)/secrets" APP_HOST_PORT=3105 \
     PA_PUBLIC_ORIGIN=http://127.0.0.1:3105 PA_IMAGE_TAG=docs \
     PA_BUILD_REVISION="$(git rev-parse HEAD)"
   scripts/init-secrets.sh --dir "$PA_SECRETS_DIR"
   docker compose -p prior-authorization-docs up --build -d --wait
   curl -fsS http://127.0.0.1:3105/api/status
   ```

2. Set the browser viewport to 1440 x 900, open `http://127.0.0.1:3105/` and
   choose **Sign in as fixture operator**. Capture the queue as
   `raw/01-operator-queue.png`.
3. Open `/cases/case-f02-loop`, scroll so the **Source documents** heading is
   near the top of the viewport (562 CSS pixels from the top), and capture
   `raw/02-case-evidence.png`.
4. Open the R04 `encounter.date` citation,
   `/cases/case-f02-loop/sources/f01-encounter/1?locator=%2FencounterDate`, and
   capture `raw/03-source-view.png`.
5. Open **Request review**, choose **Prepare neutral draft request for R03**,
   then **Approve local simulated request**. Reload and choose **Record fixture
   response (archived finalized order)**. The case reassesses to revision 2.
6. Choose **Sign out**, then **Sign in as fixture administrative reviewer**. Open
   `/cases/case-f02-loop/packet` and take a full-page capture as
   `raw/04-reviewer-packet.png`. Do not accept or return the packet.
7. Write the framed wrappers outside the repository and serve them on loopback:

   ```sh
   frames="$(mktemp -d)/frames"
   python3 docs/images/frame.py --out "$frames"
   python3 -m http.server 8765 --bind 127.0.0.1 --directory "$frames"
   ```

8. At a 1600 x 1000 viewport, open each `http://127.0.0.1:8765/<name>.html` and
   capture the `#frame` element as `docs/images/<name>.png`.
9. Stop the server and remove the deployment, its network and volumes, and the
   image:

   ```sh
   docker compose -p prior-authorization-docs down -v --remove-orphans
   docker image rm prior-authorization-app:docs
   ```

The captures contain only synthetic case data, fixture role names and the
loopback URL. No secret, session token or local path appears in them.
