# AI-powered progressive delivery demo (Argo Rollouts + metric-ai plugin)

Deploys Argo Rollouts, the AI metric plugin, and the Kubernetes agents to GKE, runs
Kevin's `argo-rollouts-quarkus-demo` canary, and records a browser video of the flow:
`v2.nullpointer` is aborted, the agent opens a remediation PR and a `jules` issue, Jules
opens a PR, then `v3.memoryleak` is aborted and the rollout recovers to 100% stable.

Example recording: `recordings/demo-antigravity-quarkus.mp4` (~519s, real time, no audio).

## Layout

| Path | Purpose |
|------|---------|
| `demo.sh`, `demo-functions.sh` | `create`, `delete`, `scaledown` and `scaleup` the demo on GKE |
| `cloudflare-dns.py` | Upserts the demo ingress A records in Cloudflare |
| `examples/` | Canary-demo rollouts and AI analysis templates |
| `k8s-kevin-quarkus-demo/` | Quarkus demo rollout, wired to the selected agent |
| `k8s-kdubois-agent/` | Overlay for the kdubois agent (`AGENT_TYPE=kdubois`) |
| `rolloutmanager.yaml`, `operator-rbac-patch.yaml`, `ingress-csanchez.yaml` | Operator and ingress config |
| `demo-recording/` | Playwright recorder and baseline reset |

## Prerequisites

`kubectl`, `kubectl-argo-rollouts`, `gcloud` (a GKE cluster as current context), `gh`
(logged in), `bun`, `ffmpeg`, `python3`. For the agents, clone
`kubernetes-agents-antigravity` and `argo-rollouts-manager` as siblings of this directory; otherwise they are installed from GitHub.

## Secrets

Read from the environment or `./.env` / `../.env` only:

- `GEMINI_API_KEY`: required, stored in secret `argo-rollouts-secret`.
- `GITHUB_TOKEN`: repo-write token for the demo repo, so the agent can open PRs and issues.
- `CF_API_TOKEN` (or `CLOUDFLARE_API_TOKEN`): Cloudflare DNS edit on `csanchez.org`.

## Setup

```sh
export GEMINI_API_KEY=...
./demo.sh create [--agent-type antigravity|kdubois] [--gemma]   # antigravity is the default
./demo.sh scaledown                                             # save cost, keep the cluster
./demo.sh scaleup
./demo.sh delete [--yes]                                        # deletes ingresses, then the cluster
./demo.sh starship-toggle                                       # toggle starship prompt modules while demoing
./demo.sh --help                                                # all options (--project, --cluster-name, --no-dns, --no-dashboard)
```

Models are pinned in the agent manifests: analysts `gemini-3.8-flash`,
orchestrator and remediation `gemini-4-argon`.

## Record

```sh
cd demo-recording
npm_config_registry=https://registry.npmjs.org bun install
bunx playwright install chromium
./prepare-baseline.sh      # reset to v1.stable, restart agent and dashboard
bun run record-demo.ts     # output in demo-recording/recording/*.mp4
```

Server-error pages (load-balancer hiccups) are detected while recording and cut from the
final video; the long Jules wait is cut down to `JULES_WAIT_KEEP_S` (default 30s) and every
issue/PR page stays on screen at least `SHOW_MS` (default 20s). `trim-video.ts` cuts ranges
from any video: `bun run trim-video.ts in.mp4 out.mp4 76-92 256-487`.

Env: `SHOW_MS`, `JULES_WAIT_KEEP_S`, `DASHBOARD_HOST`, `DASHBOARD_IP`, `DEMO_REPO`, `NAMESPACE`, `MEMORYLEAK=0`.
The Jules segment waits in real time (up to 15 minutes) for Jules to open its PR.
