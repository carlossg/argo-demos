#!/bin/bash -eu

PROJECT="${1:-}"
INSTALL_GEMMA="${INSTALL_GEMMA:-false}" # Set to 'true' to install Gemma server
AGENT_TYPE="${AGENT_TYPE:-antigravity}" # Set to 'antigravity' or 'kdubois' to select the Kubernetes Agent implementation

if [ -z "${PROJECT}" ]; then
	PROJECT=$(gcloud config get-value project)
fi

CLUSTER_NAME="autopilot-cluster-1"
DEMO_LABEL="demo=argo-rollouts"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${script_dir}/demo-functions.sh"

create_cluster

cloud_build_setup "${PROJECT}"

install_argo_rollouts

echo "Creating the rollout"
kubectl apply -k examples/analysis
# skaffold apply

# Kevin's quarkus-rollouts-demo, pointed at the selected Kubernetes Agent
echo "Creating the quarkus-rollouts-demo rollout"
kubectl apply -k "${script_dir}/k8s-kevin-quarkus-demo"

# scale down for now
kubectl scale rollout.argoproj.io/canary-demo --replicas=1

# Create ingress after service is ready
create_ingress

# quarkus-demo's ingress was already applied above with its rollout
wait_for_ingress_ip quarkus-demo quarkus-demo

# Point the demo hostnames at the new load balancer IPs
update_cloudflare_dns canary-csanchez default
update_cloudflare_dns quarkus-demo quarkus-demo

# Install Gemma if requested
if [ "${INSTALL_GEMMA}" = "true" ]; then
	install_gemma
fi

# Install the kubernetes agent
install_kubernetes_agent

kubectl argo rollouts get rollout canary-demo

kubectl argo rollouts dashboard

# kubectl argo rollouts set image canary-demo "*=argoproj/rollouts-demo:green"
# kubectl argo rollouts set image canary-demo "*=argoproj/rollouts-demo:bad-red"
# kubectl argo rollouts set image canary-demo "*=argoproj/rollouts-demo:slow-yellow"

# kubectl argo rollouts set image quarkus-demo "*=ghcr.io/kdubois/argo-rollouts-quarkus-demo:main"
# kubectl argo rollouts set image quarkus-demo "*=ghcr.io/kdubois/argo-rollouts-quarkus-demo:v1.stable"
# kubectl argo rollouts set image quarkus-demo "*=ghcr.io/kdubois/argo-rollouts-quarkus-demo:v2.nullpointer"
# kubectl argo rollouts set image quarkus-demo "*=ghcr.io/kdubois/argo-rollouts-quarkus-demo:v3.memoryleak


# Scale down all components (useful for saving costs when not in use)
# scale_down

# Scale back up all components
# scale_up

# tear_down
