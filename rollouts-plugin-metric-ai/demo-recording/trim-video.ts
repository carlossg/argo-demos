#!/usr/bin/env bun
// Removes time ranges from a video (server-error pages, long waits).
//
// CLI: bun run trim-video.ts <in> <out> <start-end>...   (seconds, e.g. 76-92 256-487)
// Also imported by record-demo.ts.

import { $ } from "bun";

export type Cut = [start: number, end: number];

/** Sorts, drops empty ranges and merges overlapping ones. */
export function mergeCuts(cuts: Cut[]): Cut[] {
	const sorted = cuts.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
	const merged: Cut[] = [];
	for (const [a, b] of sorted) {
		const last = merged[merged.length - 1];
		if (last && a <= last[1]) last[1] = Math.max(last[1], b);
		else merged.push([a, b]);
	}
	return merged;
}

export async function cutVideo(input: string, output: string, cuts: Cut[]) {
	const merged = mergeCuts(cuts);
	const scale = "scale=trunc(iw/2)*2:trunc(ih/2)*2";
	const fps = 25;
	const select = merged.length
		? `select='${merged.map(([a, b]) => `not(between(t,${a.toFixed(3)},${b.toFixed(3)}))`).join("*")}',`
		: "";
	const vf = `fps=${fps},${select}setpts=N/(${fps}*TB),${scale}`;
	await $`ffmpeg -loglevel error -y -i ${input} -movflags faststart -pix_fmt yuv420p -vf ${vf} ${output}`.quiet();
	const removed = merged.reduce((s, [a, b]) => s + (b - a), 0);
	console.log(`  cut ${merged.length} range(s), ${removed.toFixed(1)}s removed: ${merged.map(([a, b]) => `${a.toFixed(1)}-${b.toFixed(1)}`).join(" ")}`);
}

if (import.meta.main) {
	const [input, output, ...ranges] = process.argv.slice(2);
	if (!input || !output || ranges.length === 0) {
		console.error("usage: bun run trim-video.ts <in> <out> <start-end>...");
		process.exit(1);
	}
	const cuts = ranges.map((r) => r.split("-").map(Number) as Cut);
	await cutVideo(input, output, cuts);
}
