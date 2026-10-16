#!/bin/bash -eu

usage() {
	cat <<-EOF
		Usage: $(basename "$0") <command> [options]

		Commands:
		  create       Create the cluster (if needed) and install the whole demo
		  delete       Delete the ingresses, then the cluster
		  scaledown    Scale every demo component to 0 (saves cost, keeps the cluster)
		  scaleup      Scale the demo components back up
		  starship-toggle  Toggle the starship prompt modules used while demoing

		Options (defaults can also come from the environment):
		  --agent-type <antigravity|kdubois>  Kubernetes agent to install      [\$AGENT_TYPE, antigravity]
		  --gemma                             Also install the Gemma server    [\$INSTALL_GEMMA=true]
		  --project <id>                      GCP project                      [gcloud config project]
		  --cluster-name <name>               GKE cluster name                 [\$CLUSTER_NAME, autopilot-cluster-1]
		  --no-dns                            create: skip the Cloudflare DNS update
		  --no-dashboard                      create: don't start the rollouts dashboard
		  -y, --yes                           delete: don't ask for confirmation
		  -h, --help                          Show this help

		Examples:
		  $(basename "$0") create --agent-type kdubois --gemma
		  $(basename "$0") scaledown
		  $(basename "$0") delete --yes
		  $(basename "$0") starship-toggle
	EOF
}

COMMAND="${1:-}"
case "${COMMAND}" in
	-h | --help | help) usage; exit 0 ;;
	create | delete | scaledown | scaleup | starship-toggle) shift ;;
	"") usage; exit 1 ;;
	*) echo "Unknown command '${COMMAND}'" >&2; usage >&2; exit 1 ;;
esac

PROJECT="${PROJECT:-}"
INSTALL_GEMMA="${INSTALL_GEMMA:-false}"
AGENT_TYPE="${AGENT_TYPE:-antigravity}"
CLUSTER_NAME="${CLUSTER_NAME:-autopilot-cluster-1}"
UPDATE_DNS=true
START_DASHBOARD=true
ASSUME_YES=false

while [ $# -gt 0 ]; do
	case "$1" in
		--agent-type) AGENT_TYPE="${2:?--agent-type needs a value}"; shift 2 ;;
		--agent-type=*) AGENT_TYPE="${1#*=}"; shift ;;
		--gemma) INSTALL_GEMMA=true; shift ;;
		--project) PROJECT="${2:?--project needs a value}"; shift 2 ;;
		--project=*) PROJECT="${1#*=}"; shift ;;
		--cluster-name) CLUSTER_NAME="${2:?--cluster-name needs a value}"; shift 2 ;;
		--cluster-name=*) CLUSTER_NAME="${1#*=}"; shift ;;
		--no-dns) UPDATE_DNS=false; shift ;;
		--no-dashboard) START_DASHBOARD=false; shift ;;
		-y | --yes) ASSUME_YES=true; shift ;;
		-h | --help) usage; exit 0 ;;
		*) echo "Unknown option '$1'" >&2; usage >&2; exit 1 ;;
	esac
done

case "${AGENT_TYPE}" in
	antigravity | kdubois) ;;
	*) echo "Invalid --agent-type '${AGENT_TYPE}' (expected 'antigravity' or 'kdubois')" >&2; exit 1 ;;
esac

export AGENT_TYPE INSTALL_GEMMA CLUSTER_NAME ASSUME_YES
DEMO_LABEL="demo=argo-rollouts"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${script_dir}/demo-functions.sh"

if [ "${COMMAND}" = "starship-toggle" ]; then
	starship_toggle
	exit 0
fi

if [ "${COMMAND}" != "create" ]; then
	gcloud container clusters get-credentials "${CLUSTER_NAME}" --region us-central1
fi

case "${COMMAND}" in
	delete) tear_down; exit $? ;;
	scaledown) scale_down; exit 0 ;;
	scaleup) scale_up; exit 0 ;;
esac

# --- create ---
if [ -z "${PROJECT}" ]; then
	PROJECT=$(gcloud config get-value project)
fi

create_cluster

cloud_build_setup "${PROJECT}"

install_argo_rollouts

echo "Creating the rollout"
kubectl apply -k "${script_dir}/examples/analysis"
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
if [ "${UPDATE_DNS}" = "true" ]; then
	update_cloudflare_dns canary-csanchez default
	update_cloudflare_dns quarkus-demo quarkus-demo
fi

# Install Gemma if requested
if [ "${INSTALL_GEMMA}" = "true" ]; then
	install_gemma
fi

# Install the kubernetes agent
install_kubernetes_agent

kubectl argo rollouts get rollout canary-demo

if [ "${START_DASHBOARD}" = "true" ]; then
	kubectl argo rollouts dashboard
fi

# kubectl argo rollouts set image canary-demo "*=argoproj/rollouts-demo:green"
# kubectl argo rollouts set image canary-demo "*=argoproj/rollouts-demo:bad-red"
# kubectl argo rollouts set image canary-demo "*=argoproj/rollouts-demo:slow-yellow"

# kubectl argo rollouts set image quarkus-demo "*=ghcr.io/kdubois/argo-rollouts-quarkus-demo:main"
# kubectl argo rollouts set image quarkus-demo "*=ghcr.io/kdubois/argo-rollouts-quarkus-demo:v1.stable"
# kubectl argo rollouts set image quarkus-demo "*=ghcr.io/kdubois/argo-rollouts-quarkus-demo:v2.nullpointer"
# kubectl argo rollouts set image quarkus-demo "*=ghcr.io/kdubois/argo-rollouts-quarkus-demo:v3.memoryleak

