import {createHash} from "node:crypto";

import {z} from "zod";

import type {RunningTestServer} from "./runtime-harness.js";

export const assetSchema = z.object({
  createdAt: z.string(),
  createdBy: z.object({displayName: z.string(), principalId: z.string()}),
  id: z.string().regex(/^ast_[0-9a-f-]{36}$/u),
  mediaType: z.string(),
  name: z.string(),
  sha256: z.string(),
  size: z.number().int().nonnegative(),
  url: z.url(),
});

export const committedAssetSchema = z.object({
  asset: assetSchema,
  replayed: z.boolean(),
});

export const assetListingSchema = z.object({
  assets: z.array(assetSchema),
  quota: z.object({maximumAssets: z.number(), maximumBytes: z.number()}),
  usage: z.object({assetCount: z.number(), byteCount: z.number()}),
});

export const assetPlanSchema = z.object({
  commitUrl: z.url(),
  expiresAt: z.string(),
  file: z.object({
    method: z.literal("PUT"),
    size: z.number().int().nonnegative(),
    uploadUrl: z.url(),
  }),
  projectId: z.string(),
  uploadId: z.string(),
});

export type AssetPlan = z.infer<typeof assetPlanSchema>;

/** One file a test adds to an asset store. */
export interface TestAsset {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly name: string;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Ask for an asset upload plan; the declaration defaults to the file's real metadata. */
export function planAsset(
  server: RunningTestServer,
  token: string,
  artifactId: string,
  file: TestAsset,
  declared: {readonly sha256?: string; readonly size?: number} = {},
): Promise<Response> {
  return fetch(`${server.baseUrl}/api/v1/artifacts/${artifactId}/assets/uploads`, {
    body: JSON.stringify({
      mediaType: file.mediaType,
      name: file.name,
      sha256: declared.sha256 ?? sha256(file.bytes),
      size: declared.size ?? file.bytes.byteLength,
    }),
    headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json"},
    method: "POST",
  });
}

export function putAssetBytes(
  uploadUrl: string,
  token: string,
  bytes: Uint8Array,
): Promise<Response> {
  const body = new Uint8Array(bytes.byteLength);
  body.set(bytes);
  return fetch(uploadUrl, {
    body: body.buffer,
    headers: {Authorization: `Bearer ${token}`},
    method: "PUT",
  });
}

export function commitAsset(
  plan: AssetPlan,
  token: string,
  idempotencyKey: string,
  uploadId = plan.uploadId,
): Promise<Response> {
  return fetch(plan.commitUrl, {
    body: JSON.stringify({uploadId}),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    method: "POST",
  });
}

/** Plan, upload, and commit one asset, failing the test on any refusal. */
export async function addAsset(
  server: RunningTestServer,
  token: string,
  artifactId: string,
  file: TestAsset,
  idempotencyKey: string,
): Promise<z.infer<typeof assetSchema>> {
  const planned = await planAsset(server, token, artifactId, file);
  if (planned.status !== 201) {
    throw new Error(`The asset plan answered ${planned.status}: ${await planned.text()}`);
  }
  const plan = assetPlanSchema.parse(await planned.json());
  const put = await putAssetBytes(plan.file.uploadUrl, token, file.bytes);
  if (put.status !== 200) {
    throw new Error(`The asset PUT answered ${put.status}: ${await put.text()}`);
  }
  const committed = await commitAsset(plan, token, idempotencyKey);
  if (committed.status !== 201) {
    throw new Error(`The asset commit answered ${committed.status}: ${await committed.text()}`);
  }
  return committedAssetSchema.parse(await committed.json()).asset;
}

export async function listAssets(
  server: RunningTestServer,
  token: string,
  artifactId: string,
): Promise<z.infer<typeof assetListingSchema>> {
  const response = await fetch(`${server.baseUrl}/api/v1/artifacts/${artifactId}/assets`, {
    headers: {Authorization: `Bearer ${token}`},
  });
  if (response.status !== 200) {
    throw new Error(`The asset list answered ${response.status}: ${await response.text()}`);
  }
  return assetListingSchema.parse(await response.json());
}

export function deleteAsset(
  server: RunningTestServer,
  token: string,
  artifactId: string,
  assetId: string,
): Promise<Response> {
  return fetch(`${server.baseUrl}/api/v1/artifacts/${artifactId}/assets/${assetId}`, {
    headers: {Authorization: `Bearer ${token}`},
    method: "DELETE",
  });
}
