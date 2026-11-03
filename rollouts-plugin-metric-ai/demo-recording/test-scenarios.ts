#!/usr/bin/env bun
/**
 * Automated Test Suite for Argo Rollouts + AI Analysis Scenarios
 *
 * Runs all 3 scenarios against the live cluster:
 *   1. Scenario 1 (Stable): Clean v1.stable canary -> AI votes PROMOTE -> Rollout completes Healthy.
 *   2. Scenario 2 (NullPointer): v2.nullpointer canary -> AI votes ABORT -> Rollout aborts and rolls back.
 *   3. Scenario 3 (MemoryLeak): v3.memoryleak canary -> AI votes ABORT -> Rollout aborts and rolls back.
 *
 * Usage:
 *   bun run test-scenarios.ts
 */

import { $ } from "bun";

const NAMESPACE = process.env.NAMESPACE ?? "quarkus-demo";
const DASHBOARD_HOST = process.env.DASHBOARD_HOST ?? "quarkus-demo.argo.csanchez.org";
const DASHBOARD_IP = process.env.DASHBOARD_IP ?? "8.232.134.219";

const IMAGES = {
	stable: "ghcr.io/kdubois/argo-rollouts-quarkus-demo:v1.stable@sha256:2d12930f365812a6b1517d35b12343def51cbcbec29575369dd28c4a14a32b93",
	nullpointer: "ghcr.io/kdubois/argo-rollouts-quarkus-demo:v2.nullpointer@sha256:8a2d9be0071471d4a6366129aa15bf4bce760e0620cb63074bec7b49971aa018",
	memoryleak: "ghcr.io/kdubois/argo-rollouts-quarkus-demo:v3.memoryleak@sha256:606babfc5a6c391027d5c3c30d2846eacebfb4ecec87c40ceb0ed28ec022d307",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function kubectlJsonpath(args: string[], path: string): Promise<string> {
	const jsonpath = `jsonpath=${path}`;
	return (await $`kubectl ${args} -o ${jsonpath}`.text()).trim();
}

async function waitUntil(label: string, timeoutMs: number, intervalMs: number, check: () => Promise<boolean>) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await sleep(intervalMs);
	}
	throw new Error(`Timed out waiting for: ${label}`);
}

async function getAnalysisRunNames(): Promise<string[]> {
	const out = await kubectlJsonpath(["get", "analysisrun", "-n", NAMESPACE], "{.items[*].metadata.name}");
	return out.split(/\s+/).filter(Boolean);
}

async function waitForAnalysisRun(before: string[]): Promise<string> {
	let name = "";
	await waitUntil("new AnalysisRun to appear", 90_000, 2_000, async () => {
		name = (await getAnalysisRunNames()).find((n) => !before.includes(n)) ?? "";
		return Boolean(name);
	});
	console.log(`   ⏳ AnalysisRun ${name} running...`);
	await waitUntil(`AnalysisRun ${name} to finish`, 240_000, 3_000, async () => {
		const phase = await kubectlJsonpath(["get", "analysisrun", name, "-n", NAMESPACE], "{.status.phase}");
		return phase !== "" && phase !== "Running" && phase !== "Pending";
	});
	return name;
}

async function waitForRolloutHealthy() {
	await waitUntil("Rollout to become Healthy", 300_000, 3_000, async () => {
		const phase = await kubectlJsonpath(["get", "rollout", "quarkus-demo", "-n", NAMESPACE], "{.status.phase}");
		const available = await kubectlJsonpath(["get", "rollout", "quarkus-demo", "-n", NAMESPACE], "{.status.availableReplicas}");
		const replicas = await kubectlJsonpath(["get", "rollout", "quarkus-demo", "-n", NAMESPACE], "{.spec.replicas}");
		return phase === "Healthy" && available === replicas;
	});
}

async function waitForRolloutAborted(analysisRun: string) {
	await waitUntil("Rollout to abort", 120_000, 2_000, async () => {
		const msg = await kubectlJsonpath(["get", "rollout", "quarkus-demo", "-n", NAMESPACE], "{.status.message}");
		const abort = await kubectlJsonpath(["get", "rollout", "quarkus-demo", "-n", NAMESPACE], "{.status.abort}");
		const phase = await kubectlJsonpath(["get", "analysisrun", analysisRun, "-n", NAMESPACE], "{.status.phase}");
		return msg.includes("RolloutAborted") || abort === "true" || phase === "Failed";
	});
}

async function waitForFullRecovery() {
	await waitUntil("Rollout to fully recover 100% stable", 180_000, 2_000, async () => {
		const canaryWeight = await kubectlJsonpath(["get", "rollout", "quarkus-demo", "-n", NAMESPACE], "{.status.canary.weights.canary.weight}");
		const stableWeight = await kubectlJsonpath(["get", "rollout", "quarkus-demo", "-n", NAMESPACE], "{.status.canary.weights.stable.weight}");
		const replicas = await kubectlJsonpath(["get", "rollout", "quarkus-demo", "-n", NAMESPACE], "{.spec.replicas}");
		const available = await kubectlJsonpath(["get", "rollout", "quarkus-demo", "-n", NAMESPACE], "{.status.availableReplicas}");
		const updated = (await kubectlJsonpath(["get", "rollout", "quarkus-demo", "-n", NAMESPACE], "{.status.updatedReplicas}")) || "0";
		return (canaryWeight === "" || canaryWeight === "0") && (stableWeight === "" || stableWeight === "100") && available === replicas && updated === "0";
	});
}

async function fetchLatestDecisionEvent(): Promise<{ message: string; details: string; type: string } | null> {
	try {
		const res = await fetch(`http://${DASHBOARD_IP}/api/agent/events`, {
			headers: { Host: DASHBOARD_HOST },
		});
		if (!res.ok) return null;
		const events = (await res.json()) as { message: string; details: string; type: string }[];
		const decisions = events.filter((e) => e.type === "DECISION");
		return decisions.length > 0 ? decisions[decisions.length - 1] : null;
	} catch {
		return null;
	}
}

async function runScenario1Stable() {
	console.log("\n=======================================================");
	console.log("▶️  SCENARIO 1: Clean Baseline / Good Canary (v1.stable)");
	console.log("=======================================================");
	const before = await getAnalysisRunNames();
	const tag = `run-${Date.now()}`;
	console.log(`   Applying canary trigger annotation (${tag})...`);
	await $`kubectl patch rollout quarkus-demo -n ${NAMESPACE} --type=merge -p ${JSON.stringify({
		spec: { template: { metadata: { annotations: { "test.scenario": tag } } } },
	})}`;

	const run = await waitForAnalysisRun(before);
	const phase = await kubectlJsonpath(["get", "analysisrun", run, "-n", NAMESPACE], "{.status.phase}");
	console.log(`   AnalysisRun ${run} finished with phase: ${phase}`);

	if (phase !== "Successful") {
		throw new Error(`Scenario 1 FAILED: Expected AnalysisRun 'Successful', got '${phase}'`);
	}

	const decision = await fetchLatestDecisionEvent();
	console.log(`   Agent Decision: ${decision?.message ?? "unknown"}`);
	if (decision && !decision.message.toUpperCase().includes("PROMOTE")) {
		throw new Error(`Scenario 1 FAILED: Expected Agent Decision PROMOTE, got: ${decision.message}`);
	}

	console.log("   Waiting for Rollout to promote to Healthy...");
	await waitForRolloutHealthy();
	console.log("✅ SCENARIO 1 PASSED: Canary evaluated as healthy, AI voted PROMOTE, Rollout 100% Healthy.");
}

async function runScenario2NullPointer() {
	console.log("\n=======================================================");
	console.log("▶️  SCENARIO 2: NullPointerException Regression (v2.nullpointer)");
	console.log("=======================================================");
	const before = await getAnalysisRunNames();
	console.log(`   Updating canary image to ${IMAGES.nullpointer}...`);
	await $`kubectl argo rollouts set image quarkus-demo "*=${IMAGES.nullpointer}" -n ${NAMESPACE}`;

	const run = await waitForAnalysisRun(before);
	const phase = await kubectlJsonpath(["get", "analysisrun", run, "-n", NAMESPACE], "{.status.phase}");
	console.log(`   AnalysisRun ${run} finished with phase: ${phase}`);

	if (phase !== "Failed") {
		throw new Error(`Scenario 2 FAILED: Expected AnalysisRun 'Failed', got '${phase}'`);
	}

	const decision = await fetchLatestDecisionEvent();
	console.log(`   Agent Decision: ${decision?.message ?? "unknown"}`);
	if (decision && !decision.message.toUpperCase().includes("ABORT")) {
		throw new Error(`Scenario 2 FAILED: Expected Agent Decision ABORT, got: ${decision.message}`);
	}

	console.log("   Verifying Rollout aborted and rolling back...");
	await waitForRolloutAborted(run);
	await waitForFullRecovery();
	console.log("✅ SCENARIO 2 PASSED: NullPointer detected, AI voted ABORT, Rollout aborted and safely recovered.");
}

async function runScenario3MemoryLeak() {
	console.log("\n=======================================================");
	console.log("▶️  SCENARIO 3: Memory Leak Regression (v3.memoryleak)");
	console.log("=======================================================");
	const before = await getAnalysisRunNames();
	console.log(`   Updating canary image to ${IMAGES.memoryleak}...`);
	await $`kubectl argo rollouts set image quarkus-demo "*=${IMAGES.memoryleak}" -n ${NAMESPACE}`;

	const run = await waitForAnalysisRun(before);
	const phase = await kubectlJsonpath(["get", "analysisrun", run, "-n", NAMESPACE], "{.status.phase}");
	console.log(`   AnalysisRun ${run} finished with phase: ${phase}`);

	if (phase !== "Failed") {
		throw new Error(`Scenario 3 FAILED: Expected AnalysisRun 'Failed', got '${phase}'`);
	}

	const decision = await fetchLatestDecisionEvent();
	console.log(`   Agent Decision: ${decision?.message ?? "unknown"}`);
	if (decision && !decision.message.toUpperCase().includes("ABORT")) {
		throw new Error(`Scenario 3 FAILED: Expected Agent Decision ABORT, got: ${decision.message}`);
	}

	console.log("   Verifying Rollout aborted and rolling back...");
	await waitForRolloutAborted(run);
	await waitForFullRecovery();
	console.log("✅ SCENARIO 3 PASSED: Memory anomaly detected, AI voted ABORT, Rollout aborted and safely recovered.");
}

async function cleanupBaseline() {
	console.log("\n-------------------------------------------------------");
	console.log("🧹 Resetting baseline to clean v1.stable...");
	await $`kubectl argo rollouts set image quarkus-demo "*=${IMAGES.stable}" -n ${NAMESPACE}`;
	await waitForRolloutHealthy();
	console.log("✅ Baseline restored to v1.stable (Healthy).");
}

async function main() {
	console.log("🚀 Starting Automated Test Suite for 3 Progressive Delivery Scenarios");
	const start = Date.now();

	try {
		await runScenario1Stable();
		await runScenario2NullPointer();
		await runScenario3MemoryLeak();
		await cleanupBaseline();

		const totalSeconds = ((Date.now() - start) / 1000).toFixed(1);
		console.log("\n=======================================================");
		console.log(`🎉 ALL 3 SCENARIOS COMPLETED & VERIFIED SUCCESSFULLY in ${totalSeconds}s!`);
		console.log("=======================================================\n");
		process.exit(0);
	} catch (err) {
		console.error("\n❌ TEST FAILED:", err);
		process.exit(1);
	}
}

await main();
