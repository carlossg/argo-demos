#!/usr/bin/env bash
# Run BEFORE recording: resets quarkus-demo to v1.stable (fully promoted).
set -euo pipefail

NAMESPACE="${NAMESPACE:-quarkus-demo}"
AGENT_NAMESPACE="${AGENT_NAMESPACE:-argo-rollouts}"

kubectl argo rollouts set image quarkus-demo "*=ghcr.io/kdubois/argo-rollouts-quarkus-demo:v1.stable" -n "${NAMESPACE}"
kubectl argo rollouts status quarkus-demo -n "${NAMESPACE}" --timeout 240s
# canary-demo analyses (from demo.sh) would otherwise add events after the feed is cleared.
kubectl argo rollouts status canary-demo -n default --timeout 300s || true

# Clear the activity feed: restart the agent (empties its feed), then recreate the dashboard
# pods (which cache events and only reset on a non-empty feed).
kubectl rollout restart deploy/kubernetes-agent-orchestrator -n "${AGENT_NAMESPACE}"
kubectl rollout status deploy/kubernetes-agent-orchestrator -n "${AGENT_NAMESPACE}" --timeout 180s
kubectl delete pods -n "${NAMESPACE}" --all --wait=false
sleep 10
kubectl argo rollouts status quarkus-demo -n "${NAMESPACE}" --timeout 400s
kubectl get pods -n "${AGENT_NAMESPACE}"
echo "Baseline ready. Run: bun install && bunx playwright install chromium && bun run record-demo.ts"
