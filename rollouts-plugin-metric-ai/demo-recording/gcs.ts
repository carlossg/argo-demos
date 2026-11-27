// Uploads the finished recording to Google Cloud Storage using GKE Workload Identity
// (or GCE metadata server token / GCS_ACCESS_TOKEN override).

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

async function getAccessToken(): Promise<string> {
	if (process.env.GCS_ACCESS_TOKEN) return process.env.GCS_ACCESS_TOKEN;
	const res = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", {
		headers: { "Metadata-Flavor": "Google" },
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
	const objectName = `${prefix.replace(/\/+$/, "")}/${new Date().toISOString().replace(/[:.]/g, "-")}-${basename(filePath)}`;
	const body = await readFile(filePath);
	const res = await fetch(
		`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(objectName)}`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "video/mp4",
			},
			body,
		},
	);
	if (!res.ok) {
		throw new Error(`GCS upload failed (${res.status}): ${await res.text()}`);
	}
	const uri = `gs://${bucket}/${objectName}`;
	console.log(`  uploaded recording to ${uri}`);
	return uri;
}
