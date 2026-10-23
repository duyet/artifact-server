import {request} from "node:http";

import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  commitStagedUpload,
  createStagedUpload,
  type CreateUploadResponse,
  type TestSiteFile,
  uploadStagedFile,
} from "../support/publishing.js";

const declared: TestSiteFile = {
  bytes: new TextEncoder().encode("<!doctype html><title>Capped</title>"),
  mediaType: "text/html",
  path: "index.html",
};

describe("version upload byte cap", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  async function plan(): Promise<CreateUploadResponse> {
    const upload = await createStagedUpload(
      server,
      installation,
      declared.path,
      [declared],
    );
    expect(upload.response.status).toBe(201);
    return upload.body;
  }

  async function commitStatus(upload: CreateUploadResponse): Promise<number> {
    const response = await fetch(upload.commitUrl, {
      body: JSON.stringify({
        target: {accessSetting: "public_link", kind: "new_artifact", name: "Capped"},
      }),
      headers: {
        Authorization: `Bearer ${installation.apiToken}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `frk-018-commit-${upload.uploadId}`,
      },
      method: "POST",
    });
    return response.status;
  }

  // Node sends a body written in pieces as chunked, with no Content-Length.
  function putChunked(
    url: string,
    bytes: Uint8Array,
  ): Promise<{readonly body: string; readonly status: number}> {
    return new Promise((resolve, reject) => {
      const outgoing = request(url, {
        headers: {Authorization: `Bearer ${installation.apiToken}`},
        method: "PUT",
      }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => resolve({body, status: response.statusCode ?? 0}));
      });
      outgoing.on("error", reject);
      outgoing.write(bytes.subarray(0, 1));
      outgoing.end(bytes.subarray(1));
    });
  }

  function oversized(): Uint8Array {
    const bytes = new Uint8Array(declared.bytes.byteLength + 1);
    bytes.set(declared.bytes);
    return bytes;
  }

  test("FRK-018-B: a body of exactly the declared length is verified and commits", async () => {
    const upload = await plan();
    const [slot] = upload.files;
    if (slot === undefined) throw new Error("The plan has no file slot.");

    const put = await uploadStagedFile(installation, slot, declared.bytes);
    expect(put.status).toBe(200);
    const committed = await commitStagedUpload(
      installation,
      upload,
      "frk-018-exact-length",
      {accessSetting: "public_link", kind: "new_artifact", name: "Capped"},
    );
    expect(committed.response.status).toBe(201);
  });

  test("FRK-018-F: a body longer than declared is refused, with or without a Content-Length, and the slot stays unverified", async () => {
    const upload = await plan();
    const [slot] = upload.files;
    if (slot === undefined) throw new Error("The plan has no file slot.");

    // fetch announces the real length, which is one byte over the declaration.
    const announced = await uploadStagedFile(installation, slot, oversized());
    expect(announced.status).toBe(413);
    await expect(announced.json()).resolves.toMatchObject({
      error: {code: "UPLOAD_TOO_LARGE"},
    });

    const streamed = await putChunked(slot.uploadUrl, oversized());
    expect(streamed.status).toBe(422);
    expect(streamed.body).toContain("INVALID_INPUT");

    expect(await commitStatus(upload)).toBe(409);

    const health = await fetch(`${server.baseUrl}/health`);
    expect(health.status).toBe(200);
  });
});
