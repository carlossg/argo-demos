#!/usr/bin/env bun
// Adds cross-platform voice-over narration synced to post-cut act timestamps.
// Providers (TTS_PROVIDER=auto|say|gemini|espeak):
//   - darwin (macOS): `say` (SAY_VOICE, default "Samantha")
//   - linux / container: Gemini TTS (if GEMINI_API_KEY is set), else `espeak-ng`

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { type Cut, mergeCuts } from "./trim-video";

export interface ActMarker {
	name: string;
	/** Video-relative seconds (from videoT0) captured at markAct(). */
	t: number;
}

export type TtsProvider = "say" | "gemini" | "espeak";

const NARRATIONS: Record<string, string> = {
	intro:
		"Welcome to the Kubernetes AI Ops progressive delivery demo, powered by Argo Rollouts, Gemini 4 Hydrogen, Decision 1, and Gemini 4 Neon.",
	stable_start:
		"First, we trigger a clean canary deployment on v1 stable.",
	stable_analysis_running:
		"The orchestrator collects pod logs, events, and Prometheus metrics in parallel, then grades the analysis with Gemini Decision 1.",
	stable_healthy:
		"All checks look healthy. The rollout promotes cleanly to one hundred percent.",
	nullpointer_start:
		"Next, we deploy v2 with a NullPointerException regression.",
	nullpointer_analysis_running:
		"Wait and watch as the collector spots errors and Gemini Decision 1 grades the rollback.",
	nullpointer_aborted:
		"The AI aborts the rollout immediately and rolls traffic back to stable, while delegating a fix to the gVisor remediation agent.",
	github_pr:
		"Using Gemini 4 Neon inside a gVisor sandbox, the remediation agent reproduced the bug, verified the fix, and opened a pull request.",
	memoryleak_start:
		"Finally, we deploy v3, which introduces a memory leak regression.",
	memoryleak_aborted:
		"Prometheus metrics and pod diagnostics catch the anomaly, abort the canary, and trigger another automated remediation.",
	remediation_artifact:
		"Here is the resulting remediation pull request or issue created automatically on GitHub.",
	outro:
		"That completes all three progressive delivery scenarios, from detection to automated remediation.",
};

/** Maps a pre-cut video timestamp (seconds) to its post-cut timestamp (seconds). */
export function toPostCutTime(preCutSec: number, cuts: Cut[]): number {
	const sanitized = cuts.map(([start, end]) => [Math.max(0, start), Math.max(0, end)] as Cut);
	const merged = mergeCuts(sanitized);
	let removed = 0;
	for (const [start, end] of merged) {
		if (end <= start) continue;
		if (preCutSec <= start) break;
		if (preCutSec >= end) {
			removed += end - start;
		} else {
			removed += preCutSec - start;
			break;
		}
	}
	return Math.max(0, preCutSec - removed);
}

export function resolveTtsProvider(env = process.env, platform = process.platform): TtsProvider {
	const requested = (env.TTS_PROVIDER ?? "auto").toLowerCase();
	if (requested === "say" || requested === "gemini" || requested === "espeak") {
		return requested;
	}
	if (requested !== "auto") {
		throw new Error(`Unsupported TTS_PROVIDER '${requested}' (expected auto, say, gemini, or espeak)`);
	}
	if (platform === "darwin") return "say";
	if (env.GEMINI_API_KEY) return "gemini";
	return "espeak";
}

function pcmToWav(pcm: Uint8Array, sampleRate = 24000, channels = 1, bitsPerSample = 16): Uint8Array {
	const header = new ArrayBuffer(44);
	const view = new DataView(header);
	const writeStr = (offset: number, s: string) => {
		for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
	};
	writeStr(0, "RIFF");
	view.setUint32(4, 36 + pcm.byteLength, true);
	writeStr(8, "WAVE");
	writeStr(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, channels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * channels * (bitsPerSample / 8), true);
	view.setUint16(32, channels * (bitsPerSample / 8), true);
	view.setUint16(34, bitsPerSample, true);
	writeStr(36, "data");
	view.setUint32(40, pcm.byteLength, true);

	const out = new Uint8Array(44 + pcm.byteLength);
	out.set(new Uint8Array(header), 0);
	out.set(pcm, 44);
	return out;
}

async function synthesizeGeminiClip(text: string, outWavPath: string) {
	const apiKey = process.env.GEMINI_API_KEY;
	if (!apiKey) throw new Error("GEMINI_API_KEY is required for TTS_PROVIDER=gemini");
	const model = process.env.GEMINI_TTS_MODEL ?? "gemini-3.8-flash-tts";
	const voiceName = process.env.GEMINI_TTS_VOICE ?? "Kore";
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
	const payload = JSON.stringify({
		contents: [{ parts: [{ text }] }],
		generationConfig: {
			responseModalities: ["AUDIO"],
			speechConfig: {
				voiceConfig: { prebuiltVoiceConfig: { voiceName } },
			},
		},
	});

	const maxAttempts = 4;
	let res: Response | undefined;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			res = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-goog-api-key": apiKey,
				},
				body: payload,
			});
			if (res.ok || (res.status !== 429 && res.status < 500) || attempt === maxAttempts) {
				break;
			}
			const delayMs = 1000 * 2 ** (attempt - 1);
			console.warn(`  Gemini TTS returned ${res.status}, retrying in ${delayMs}ms (attempt ${attempt}/${maxAttempts})`);
			await Bun.sleep(delayMs);
		} catch (err) {
			if (attempt === maxAttempts) throw err;
			const delayMs = 1000 * 2 ** (attempt - 1);
			console.warn(`  Gemini TTS request error, retrying in ${delayMs}ms (attempt ${attempt}/${maxAttempts}): ${err}`);
			await Bun.sleep(delayMs);
		}
	}
	if (!res || !res.ok) {
		throw new Error(`Gemini TTS failed (${res?.status ?? "unknown"}): ${res ? await res.text() : "no response"}`);
	}
	const body = (await res.json()) as {
		candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[];
	};
	const inline = body.candidates?.[0]?.content?.parts?.[0]?.inlineData;
	if (!inline?.data) throw new Error("Gemini TTS response missing inlineData audio");
	const raw = Buffer.from(inline.data, "base64");
	const wav = inline.mimeType?.includes("wav") ? raw : pcmToWav(raw);
	await writeFile(outWavPath, wav);
}

async function synthesizeCue(text: string, workDir: string, index: number, provider: TtsProvider): Promise<string> {
	if (provider === "say") {
		const voice = process.env.SAY_VOICE ?? "Samantha";
		const clip = join(workDir, `cue-${index}.aiff`);
		await $`say -v ${voice} -o ${clip} -- ${text}`.quiet();
		return clip;
	}
	const clip = join(workDir, `cue-${index}.wav`);
	if (provider === "gemini") {
		await synthesizeGeminiClip(text, clip);
		return clip;
	}
	const voice = process.env.ESPEAK_VOICE ?? "en-us";
	await $`espeak-ng -v ${voice} -w ${clip} -- ${text}`.quiet();
	return clip;
}

async function getDurationMs(mediaPath: string): Promise<number> {
	const out = (await $`ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 ${mediaPath}`.text()).trim();
	const sec = Number.parseFloat(out);
	return Number.isFinite(sec) ? Math.round(sec * 1000) : 0;
}

export async function addVoiceover(videoPath: string, acts: ActMarker[], cuts: Cut[], provider = resolveTtsProvider()) {
	const cues = acts
		.filter((a) => NARRATIONS[a.name])
		.map((a) => ({
			name: a.name,
			text: NARRATIONS[a.name],
			delayMs: Math.round(toPostCutTime(a.t, cuts) * 1000),
		}));

	if (cues.length === 0) return;

	const workDir = await mkdtemp(join(tmpdir(), "demo-voiceover-"));
	const tempOut = videoPath.replace(/\.mp4$/, ".voiced.mp4");
	try {
		const clipPaths: string[] = [];
		const clipDurationsMs: number[] = [];
		for (let i = 0; i < cues.length; i++) {
			const clip = await synthesizeCue(cues[i].text, workDir, i, provider);
			clipPaths.push(clip);
			clipDurationsMs.push(await getDurationMs(clip));
		}

		let prevEndMs = -500;
		const scheduledDelaysMs = cues.map((c, i) => {
			const startMs = Math.max(c.delayMs, prevEndMs + 500);
			prevEndMs = startMs + clipDurationsMs[i];
			return startMs;
		});

		const videoDurMs = await getDurationMs(videoPath);
		const padSec = prevEndMs + 500 > videoDurMs ? Math.ceil((prevEndMs + 500 - videoDurMs) / 1000) : 0;

		const inputs = ["-i", videoPath, ...clipPaths.flatMap((p) => ["-i", p])];
		const filterParts: string[] = [];
		const labels: string[] = [];
		for (let i = 0; i < cues.length; i++) {
			const label = `a${i}`;
			filterParts.push(`[${i + 1}:a]adelay=${scheduledDelaysMs[i]}|${scheduledDelaysMs[i]}[${label}]`);
			labels.push(`[${label}]`);
		}
		filterParts.push(`${labels.join("")}amix=inputs=${cues.length}:normalize=0[aout]`);
		if (padSec > 0) {
			filterParts.push(`[0:v]tpad=stop_mode=clone:stop_duration=${padSec}[vout]`);
		}
		const videoMap = padSec > 0 ? "[vout]" : "0:v";
		const videoArgs =
			padSec > 0
				? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
				: ["-c:v", "copy"];

		await $`ffmpeg -loglevel error -y ${inputs} -filter_complex ${filterParts.join(";")} -map ${videoMap} -map "[aout]" ${videoArgs} -c:a aac ${tempOut}`.quiet();
		await $`mv ${tempOut} ${videoPath}`.quiet();
		console.log(`  added '${provider}' voiceover (${cues.length} non-overlapping cues) to ${videoPath}`);
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
}
