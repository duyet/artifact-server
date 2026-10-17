import { createHash, randomUUID } from "node:crypto";

import {
  BucketAlreadyOwnedByYou,
  CreateBucketCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Redacted } from "effect";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "vitest";

import type { BlobStore } from "../../src/core/ports.js";
import type { ObjectStorageProvider } from "../../src/storage/object-storage-provider.js";
import { createS3ObjectStorageProviderFactory } from "../../src/storage/s3-object-storage.js";

// A bucket of its own: s3-object-storage.test.ts creates its bucket without
// tolerating an existing one, and file order is not fixed.
const bucket = "artifact-server-frk-000";
const region = "us-east-1";
const singlePutBytes = 100 * 1024;

interface GatewayEnvironment {
  readonly accessKey: string;
  readonly endpoint: string;
  readonly secretKey: string;
}

describe.sequential("FRK-000 S3 gateway compatibility", () => {
  let client: S3Client;
  let storage: ObjectStorageProvider;

  beforeAll(async () => {
    const environment = readGatewayEnvironment();
    client = new S3Client({
      credentials: {
        accessKeyId: environment.accessKey,
        secretAccessKey: environment.secretKey,
      },
      endpoint: environment.endpoint,
      forcePathStyle: true,
      region,
    });
    try {
      await client.send(new CreateBucketCommand({Bucket: bucket}));
    } catch (error) {
      if (!(error instanceof BucketAlreadyOwnedByYou)) throw error;
    }
    storage = createS3ObjectStorageProviderFactory({
      accessKeyId: environment.accessKey,
      bucket,
      endpoint: environment.endpoint,
      forcePathStyle: true,
      region,
      secretAccessKey: Redacted.make(environment.secretKey),
    }).create(`installation-frk-000-${randomUUID()}`);
  });

  afterAll(async () => {
    await storage.close();
    client.destroy();
  });

  test("FRK-000-B: a single-PUT blob answers a middle byte range with its metadata", async () => {
    const bytes = patternedBytes(singlePutBytes);
    const fingerprint = await putBlob(storage.blobs, bytes);

    await expect(storage.blobs.inspect(fingerprint)).resolves.toEqual({
      sha256: fingerprint,
      size: bytes.byteLength,
    });

    const range = {endInclusive: 40_999, start: 40_000};
    const opened = await storage.blobs.openRange(fingerprint, range);
    expect(opened).toMatchObject({
      range,
      sha256: fingerprint,
      size: bytes.byteLength,
    });
    await expect(readAll(opened.body)).resolves.toEqual(
      bytes.slice(range.start, range.endInclusive + 1),
    );
  });

  test("FRK-000-F: a range past the stored object fails as InvalidRange and the object stays readable", async () => {
    const bytes = patternedBytes(48 * 1024);
    const fingerprint = await putBlob(storage.blobs, bytes);

    await expect(storage.blobs.openRange(fingerprint, {
      endInclusive: bytes.byteLength + 1_023,
      start: bytes.byteLength,
    })).rejects.toMatchObject({
      $metadata: {httpStatusCode: 416},
      name: "InvalidRange",
    });

    const reopened = await storage.blobs.open(fingerprint);
    expect(reopened).toMatchObject({sha256: fingerprint, size: bytes.byteLength});
    await expect(readAll(reopened.body)).resolves.toEqual(bytes);
  });
});

function readGatewayEnvironment(): GatewayEnvironment {
  const accessKey = process.env["ARTIFACT_SERVER_S3_ACCESS_KEY"];
  const endpoint = process.env["ARTIFACT_SERVER_S3_ENDPOINT"];
  const secretKey = process.env["ARTIFACT_SERVER_S3_SECRET_KEY"];
  if (accessKey === undefined || endpoint === undefined || secretKey === undefined) {
    throw new Error(
      "Run this test through pnpm test:storage-s3 or pnpm test:storage-versity.",
    );
  }
  return {accessKey, endpoint, secretKey};
}

async function putBlob(store: BlobStore, bytes: Uint8Array): Promise<string> {
  const fingerprint = createHash("sha256").update(bytes).digest("hex");
  await expect(store.put({
    body: chunkedBody(bytes, 16 * 1024),
    sha256: fingerprint,
    size: bytes.byteLength,
  })).resolves.toEqual({sha256: fingerprint, size: bytes.byteLength});
  return fingerprint;
}

async function readAll(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(body).arrayBuffer());
}

function patternedBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < bytes.byteLength; index += 1) {
    bytes[index] = index % 251;
  }
  return bytes;
}

function chunkedBody(
  bytes: Uint8Array,
  chunkBytes: number,
): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull: (controller) => {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const next = Math.min(offset + chunkBytes, bytes.byteLength);
      controller.enqueue(bytes.subarray(offset, next));
      offset = next;
    },
  });
}
