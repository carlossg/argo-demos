// Uploads the finished recording to Google Cloud Storage using GKE Workload Identity
// (or GCE metadata server token / GCS_ACCESS_TOKEN override).

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

export async function getAccessToken(): Promise<string> {
	if (process.env.GCS_ACCESS_TOKEN) return process.env.GCS_ACCESS_TOKEN;
	const res = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", {
		headers: { "Metadata-Flavor": "Google" },
		signal: AbortSignal.timeout(5_000),
	});
	if (!res.ok) {
		throw new Error(`Failed to fetch GCP metadata token (${res.status}): ${await res.text()}`);
	}
	const data = (await res.json()) as { access_token?: string };
	if (!data.access_token) throw new Error("Metadata token response missing access_token");
	return data.access_token;
}

export async function uploadToGcs(filePath: string, bucket: string, prefix = process.env.GCS_PREFIX ?? "demo-recordings"): Promise<string> {
	const token = await getAccessToken();
	const cleanPrefix = prefix.replace(/^\/+|\/+$/g, "");
	const fileName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${basename(filePath)}`;
	const objectName = cleanPrefix ? `${cleanPrefix}/${fileName}` : fileName;
	const body = await readFile(filePath);
	const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;

	const maxAttempts = 4;
	let res: Response | undefined;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			res = await fetch(url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "video/mp4",
				},
				body,
			});
			if (res.ok || (res.status !== 429 && res.status < 500) || attempt === maxAttempts) {
				break;
			}
			const delayMs = 1000 * 2 ** (attempt - 1);
			console.warn(`  GCS upload returned ${res.status}, retrying in ${delayMs}ms (attempt ${attempt}/${maxAttempts})`);
			await Bun.sleep(delayMs);
		} catch (err) {
			if (attempt === maxAttempts) throw err;
			const delayMs = 1000 * 2 ** (attempt - 1);
			console.warn(`  GCS upload error, retrying in ${delayMs}ms (attempt ${attempt}/${maxAttempts}): ${err}`);
			await Bun.sleep(delayMs);
		}
	}
	if (!res || !res.ok) {
		throw new Error(`GCS upload failed (${res?.status ?? "unknown"}): ${res ? await res.text() : "no response"}`);
	}
	const uri = `gs://${bucket}/${objectName}`;
	console.log(`  uploaded recording to ${uri}`);
	return uri;
}
