import {
  commitStagedUpload,
  createStagedUpload,
  uploadEveryStagedFile,
  type PublishResponse,
  type TestSiteFile,
} from "./publishing.js";
import type {RunningTestServer, TestInstallation} from "./runtime-harness.js";

export const indexHtml =
  '<!doctype html><link rel="stylesheet" href="./assets/a.css"><title>Same-host site</title>';
export const stylesheet = "body { color: rebeccapurple; }";
export const nestedHtml = "<!doctype html><title>Nested page</title>";
export const spaShell = "<!doctype html><title>SPA shell</title>";

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function siteFiles(entry: string): readonly TestSiteFile[] {
  return [
    {bytes: utf8(entry), mediaType: "text/html; charset=utf-8", path: "index.html"},
    {
      bytes: utf8(stylesheet),
      mediaType: "text/css; charset=utf-8",
      path: "assets/a.css",
    },
    {
      bytes: utf8(nestedHtml),
      mediaType: "text/html; charset=utf-8",
      path: "docs/nested/page.html",
    },
  ];
}

/** Publish a three-file site (entry, assets/a.css, docs/nested/page.html) as a new artifact. */
export async function publishSite(
  server: RunningTestServer,
  installation: TestInstallation,
  input: {
    readonly accessSetting: "account_required" | "public_link";
    readonly entry?: string;
    readonly name: string;
    readonly routingMode?: "spa" | "static";
  },
): Promise<PublishResponse> {
  const files = siteFiles(input.entry ?? indexHtml);
  const planned = await createStagedUpload(
    server,
    installation,
    "index.html",
    files,
    undefined,
    input.routingMode,
  );
  const uploads = await uploadEveryStagedFile(installation, planned.body, files);
  const failed = uploads.find((upload) => upload.status !== 200);
  if (failed !== undefined) {
    throw new Error(`A same-host site upload failed with HTTP ${failed.status}.`);
  }
  const published = await commitStagedUpload(
    installation,
    planned.body,
    `same-host-${input.name}`,
    {accessSetting: input.accessSetting, kind: "new_artifact", name: input.name},
  );
  if (published.response.status !== 201) {
    throw new Error(`The same-host site commit returned HTTP ${published.response.status}.`);
  }
  return published.body;
}

/** POST with the installation's API credential. */
export function apiPost(
  installation: TestInstallation,
  url: string,
): Promise<Response> {
  return fetch(url, {
    headers: {Authorization: `Bearer ${installation.apiToken}`},
    method: "POST",
  });
}
