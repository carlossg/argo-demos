#!/usr/bin/env bun
// Records the quarkus-demo dashboard in a browser while driving the
// v2.nullpointer scenario (AI analysis aborts the rollout, the antigravity
// agent opens a remediation PR), then navigates the same browser to the PR
// on GitHub. Optionally finishes with v3.memoryleak (aborted, no PR).
//
// Usage: bun run record-demo.ts
// Env: DASHBOARD_IP (ingress IP, avoids DNS), DASHBOARD_HOST, DEMO_REPO,
//      MEMORYLEAK=0 to skip the second scenario.
// Requires: bunx playwright install chromium, ffmpeg, kubectl,
// kubectl-argo-rollouts, gh.

import { $ } from "bun";
import { chromium } from "playwright";
import { type Cut, cutVideo } from "./trim-video";

const NAMESPACE = process.env.NAMESPACE ?? "quarkus-demo";
const DASHBOARD_HOST = process.env.DASHBOARD_HOST ?? "quarkus-demo.argo.csanchez.org";
const DASHBOARD_URL = process.env.DASHBOARD_URL ?? `http://${DASHBOARD_HOST}/`;
const DASHBOARD_IP = process.env.DASHBOARD_IP;
const DEMO_REPO = process.env.DEMO_REPO ?? "carlossg/argo-rollouts-quarkus-demo";
const IMAGE = "ghcr.io/kdubois/argo-rollouts-quarkus-demo";
const OUT_DIR = `${import.meta.dir}/recording`;
const WIDTH = Number(process.env.WIDTH ?? 1600);
const HEIGHT = Number(process.env.HEIGHT ?? 1000);
const MEMORYLEAK = process.env.MEMORYLEAK !== "0";

// Every issue/PR page stays on screen at least this long.
const SHOW_MS = Number(process.env.SHOW_MS ?? 20_000);
// How much of the (slow) Jules wait is kept in the final video; the rest is cut.
const JULES_WAIT_KEEP_S = Number(process.env.JULES_WAIT_KEEP_S ?? 30);

const t0 = Date.now();
let videoT0 = Date.now();
/** Seconds since the browser video started, used to cut ranges out in post. */
const videoNow = () => (Date.now() - videoT0) / 1000;
const cuts: Cut[] = [];
const acts: { name: string; t: number }[] = [];

function markAct(name: string) {
	const t = (Date.now() - t0) / 1000;
	acts.push({ name, t });
	console.log(`\n### ACT_MARKER: ${name} (${t.toFixed(2)}s) ###`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(label: string, timeoutMs: number, intervalMs: number, check: () => Promise<boolean>) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await sleep(intervalMs);
	}
	throw new Error(`Timed out waiting for: ${label}`);
}

async function kubectlJsonpath(args: string[], path: string): Promise<string> {
	const jsonpath = `jsonpath=${path}`;
	return (await $`kubectl ${args} -o ${jsonpath}`.text()).trim();
}

async function analysisRunNames(): Promise<string[]> {
	const out = await kubectlJsonpath(["get", "analysisrun", "-n", NAMESPACE], "{.items[*].metadata.name}");
	return out.split(/\s+/).filter(Boolean);
}

async function waitForAnalysisRun(before: string[]): Promise<string> {
	let name = "";
	await waitUntil("new AnalysisRun", 90_000, 2_000, async () => {
		name = (await analysisRunNames()).find((n) => !before.includes(n)) ?? "";
		return Boolean(name);
	});
	await waitUntil(`AnalysisRun ${name} to finish`, 240_000, 3_000, async () => {
		const phase = await kubectlJsonpath(["get", "analysisrun", name, "-n", NAMESPACE], "{.status.phase}");
		return phase !== "" && phase !== "Running" && phase !== "Pending";
	});
	return name;
}

/** The abort message is transient (cleared once the rollback finishes), so also accept abort=true or a failed AnalysisRun. */
async function waitForRolloutAborted(analysisRun: string) {
	await waitUntil("rollout to abort", 120_000, 2_000, async () => {
		const msg = await kubectlJsonpath(["get", "rollout", "quarkus-demo", "-n", NAMESPACE], "{.status.message}");
		const abort = await kubectlJsonpath(["get", "rollout", "quarkus-demo", "-n", NAMESPACE], "{.status.abort}");
		const phase = await kubectlJsonpath(["get", "analysisrun", analysisRun, "-n", NAMESPACE], "{.status.phase}");
		return msg.includes("RolloutAborted") || abort === "true" || phase === "Failed";
	});
}

/** After an abort, wait until the canary is scaled down and the stable pods serve 100% of traffic. */
async function waitForFullRecovery() {
	const get = (path: string) => kubectlJsonpath(["get", "rollout", "quarkus-demo", "-n", NAMESPACE], path);
	await waitUntil("stable back to 100%", 180_000, 2_000, async () => {
		const weight = await get("{.status.canary.weights.canary.weight}");
		const stableWeight = await get("{.status.canary.weights.stable.weight}");
		const replicas = await get("{.spec.replicas}");
		const available = await get("{.status.availableReplicas}");
		const updated = (await get("{.status.updatedReplicas}")) || "0";
		return (weight === "" || weight === "0") && (stableWeight === "" || stableWeight === "100") && available === replicas && updated === "0";
	});
}

async function waitForRemediationPR(sinceMs: number): Promise<string> {
	let url = "";
	await waitUntil("remediation PR", 240_000, 5_000, async () => {
		const prs = (await $`gh pr list --repo ${DEMO_REPO} --state all --json number,url,createdAt --limit 5`.json()) as {
			url: string;
			createdAt: string;
		}[];
		url = prs.find((pr) => new Date(pr.createdAt).getTime() > sinceMs)?.url ?? "";
		return Boolean(url);
	});
	console.log(`  PR created: ${url}`);
	return url;
}

async function findJulesIssue(sinceMs: number): Promise<string> {
	let url = "";
	await waitUntil("jules issue", 120_000, 5_000, async () => {
		const issues = (await $`gh issue list --repo ${DEMO_REPO} --label jules --state all --json url,createdAt --limit 5`.json()) as {
			url: string;
			createdAt: string;
		}[];
		url = issues.find((i) => new Date(i.createdAt).getTime() > sinceMs)?.url ?? "";
		return Boolean(url);
	});
	return url;
}

/** Jules comments on the issue when it opens its PR; returns that PR URL. */
async function julesPrUrl(issueUrl: string): Promise<string> {
	const num = issueUrl.split("/").pop()!;
	let url = "";
	await waitUntil("Jules PR", 15 * 60_000, 5_000, async () => {
		const res = (await $`gh issue view ${num} --repo ${DEMO_REPO} --json comments`.json()) as {
			comments: { author: { login: string }; body: string }[];
		};
		for (const c of res.comments) {
			if (!c.author.login.includes("jules")) continue;
			const m = c.body.match(/https:\/\/github\.com\/[^)\s]+\/pull\/\d+/);
			if (m) url = m[0];
		}
		return Boolean(url);
	});
	return url;
}

/** Block until the dashboard serves a healthy page, so the video never starts on a load-balancer error. */
async function waitForDashboard(args: string[]) {
	const probe = await chromium.launch({ args });
	const page = await probe.newPage();
	try {
		await waitUntil("healthy dashboard", 300_000, 3_000, async () => {
			const res = await page.goto(DASHBOARD_URL).catch(() => null);
			if (!res || res.status() !== 200) return false;
			const body = (await page.content()).toLowerCase();
			return !body.includes("server error") && (await page.locator("body *").count()) > 10;
		});
	} finally {
		await probe.close();
	}
}

async function main() {
	const args = DASHBOARD_IP ? [`--host-resolver-rules=MAP ${DASHBOARD_HOST} ${DASHBOARD_IP}`] : [];
	await waitForDashboard(args);
	const browser = await chromium.launch({ args });
	videoT0 = Date.now();
	const context = await browser.newContext({
		recordVideo: { dir: OUT_DIR, size: { width: WIDTH, height: HEIGHT } },
		viewport: { width: WIDTH, height: HEIGHT },
	});
	const page = await context.newPage();
	await page.goto(DASHBOARD_URL);

	// Reload if the dashboard serves an error page, and cut the error span out of the final video.
	let errorStart: number | null = null;
	let lastReload = 0;
	const watchdog = setInterval(async () => {
		try {
			if (!page.url().startsWith(DASHBOARD_URL)) return;
			const hasError = /Server Error|Failed to fetch dashboard data/.test(await page.content());
			if (hasError) {
				if (errorStart === null) {
					errorStart = videoNow();
					console.log("  dashboard showed a server error, reloading (will be cut from the video)");
				}
				if (Date.now() - lastReload > 3_000) {
					lastReload = Date.now();
					await page.reload();
				}
			} else if (errorStart !== null) {
				cuts.push([Math.max(0, errorStart - 0.5), videoNow() + 0.3]);
				errorStart = null;
			}
		} catch {}
	}, 500);

	markAct("intro");
	await sleep(5_000);

	markAct("nullpointer_start");
	const before = await analysisRunNames();
	const npImage = `*=${IMAGE}:v2.nullpointer`;
	const startMs = Date.now();
	await $`kubectl argo rollouts set image quarkus-demo ${npImage} -n ${NAMESPACE}`;

	markAct("nullpointer_analysis_running");
	const run1 = await waitForAnalysisRun(before);
	markAct("nullpointer_verdict");
	await waitForRolloutAborted(run1);
	markAct("nullpointer_aborted");

	const prUrl = await waitForRemediationPR(startMs);
	markAct("nullpointer_pr_created");
	await sleep(6_000); // activity feed shows the REMEDIATION event and link

	markAct("github_pr");
	await page.goto(prUrl);
	await sleep(SHOW_MS);
	await page.goto(`${prUrl}/files`);
	await sleep(SHOW_MS / 2);
	await page.mouse.wheel(0, 500);
	await sleep(SHOW_MS / 2);

	if (MEMORYLEAK) {
		await page.goto(DASHBOARD_URL);
		markAct("memoryleak_start");
		const before2 = await analysisRunNames();
		const mlImage = `*=${IMAGE}:v3.memoryleak`;
		await $`kubectl argo rollouts set image quarkus-demo ${mlImage} -n ${NAMESPACE}`;
		markAct("memoryleak_analysis_running");
		const run2 = await waitForAnalysisRun(before2);
		markAct("memoryleak_verdict");
		await waitForRolloutAborted(run2);
		markAct("memoryleak_aborted");
		await waitForFullRecovery();
		markAct("memoryleak_recovered");
		await sleep(10_000); // hold on the fully recovered 100% stable dashboard

		const issueUrl = await findJulesIssue(startMs);
		markAct("jules_issue");
		await page.goto(issueUrl);
		const waitStart = videoNow();
		// Real-time wait for the Jules GitHub app to open its PR; most of it is cut from the video.
		const waiter = julesPrUrl(issueUrl);
		let done = false;
		waiter.finally(() => (done = true));
		while (!done) {
			await sleep(15_000);
			if (!done) await page.reload();
		}
		const julesPr = await waiter;
		await page.reload();
		const waitEnd = videoNow();
		if (waitEnd - waitStart > JULES_WAIT_KEEP_S + 1) cuts.push([waitStart + JULES_WAIT_KEEP_S, waitEnd - 0.3]);
		await sleep(6_000);
		await page.mouse.wheel(0, 600);
		await sleep(5_000);
		markAct("jules_pr");
		await page.goto(julesPr);
		await sleep(SHOW_MS);
		await page.goto(`${julesPr}/files`);
		await sleep(SHOW_MS / 2);
		await page.mouse.wheel(0, 500);
		await sleep(SHOW_MS / 2);
	}

	markAct("outro");
	clearInterval(watchdog);
	if (errorStart !== null) cuts.push([errorStart - 0.5, videoNow()]);
	await context.close();
	await browser.close();

	const webm = await page.video()?.path();
	if (!webm) throw new Error("No video produced");
	const mp4 = webm.replace(/\.webm$/, ".mp4");
	await cutVideo(webm, mp4, cuts);

	console.log("\n==> Act timestamps:");
	console.log("(act timestamps are pre-cut)");
	for (const a of acts) console.log(`${a.name.padEnd(30)} ${a.t.toFixed(2)}s`);
	console.log(`\n==> Done. Video: ${mp4}`);
}

await main();
process.exit(0);
