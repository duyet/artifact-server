import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  createStagedUpload,
  publishNew,
  publishVersion,
  type PublishResponse,
  uploadEveryStagedFile,
} from "../support/publishing.js";
import {issueApiKey, signInAdministrator} from "../support/agent-dispatch.js";
import {
  addAsset,
  assetPlanSchema,
  commitAsset,
  committedAssetSchema,
  deleteAsset,
  listAssets,
  planAsset,
  putAssetBytes,
  sha256,
  type TestAsset,
} from "../support/assets.js";

const sandboxPolicy =
  "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";
const errorSchema = z.object({error: z.object({code: z.string()})});

const chart: TestAsset = {
  bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]),
  mediaType: "image/png",
  name: "chart.png",
};
const report: TestAsset = {
  bytes: new TextEncoder().encode("%PDF-1.7 report"),
  mediaType: "application/pdf",
  name: "report.pdf",
};
const logo: TestAsset = {
  bytes: new TextEncoder().encode(
    "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>",
  ),
  mediaType: "image/svg+xml",
  name: "logo.svg",
};
const data: TestAsset = {
  bytes: new TextEncoder().encode("{\"rows\":[1,2,3]}"),
  mediaType: "application/json; charset=utf-8",
  name: "data.json",
};

async function errorCode(response: Response): Promise<string> {
  return errorSchema.parse(await response.json()).error.code;
}

describe("per-artifact asset store", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation, {
      assetQuota: {maximumAssets: 4, maximumBytes: 4_096},
      contentDomain: null,
    });
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  async function publish(
    name: string,
    accessSetting: "account_required" | "public_link" = "public_link",
  ): Promise<PublishResponse> {
    return (await publishNew(server, installation, {
      accessSetting,
      content: `<!doctype html><title>${name}</title>`,
      idempotencyKey: `frk-019-publish-${name.toLowerCase().replaceAll(" ", "-")}`,
      name,
    })).body;
  }

  test("FRK-019-B: an asset is planned, uploaded, committed once, listed, and served from /_blob with the content sandbox, nosniff, and an immutable cache", async () => {
    const page = await publish("Dashboard");
    const publisher = installation.apiToken;

    const planned = await planAsset(server, publisher, page.artifact.id, chart);
    expect(planned.status).toBe(201);
    const plan = assetPlanSchema.parse(await planned.json());
    expect(plan.file.size).toBe(chart.bytes.byteLength);
    expect((await putAssetBytes(plan.file.uploadUrl, publisher, chart.bytes)).status).toBe(200);
    const first = await commitAsset(plan, publisher, "frk-019-commit-chart");
    expect(first.status).toBe(201);
    const committed = committedAssetSchema.parse(await first.json());
    expect(committed).toMatchObject({
      asset: {
        mediaType: "image/png",
        name: "chart.png",
        sha256: sha256(chart.bytes),
        size: chart.bytes.byteLength,
      },
      replayed: false,
    });
    expect(new URL(committed.asset.url).pathname).toBe(`/_blob/${committed.asset.id}`);

    // The same key replays the same asset instead of adding a second one.
    const replay = await commitAsset(plan, publisher, "frk-019-commit-chart");
    expect(replay.status).toBe(200);
    expect(committedAssetSchema.parse(await replay.json())).toMatchObject({
      asset: {id: committed.asset.id},
      replayed: true,
    });

    // Adding an asset saves no version.
    const current = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${page.artifact.id}`,
      {headers: {Authorization: `Bearer ${publisher}`}},
    );
    expect(z.object({artifact: z.object({currentVersionId: z.string()})})
      .parse(await current.json()).artifact.currentVersionId).toBe(page.version.id);

    const served = await fetch(committed.asset.url);
    expect(served.status).toBe(200);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(chart.bytes);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(served.headers.get("cache-control")).toBe("public, no-cache, must-revalidate");
    expect(served.headers.get("etag")).toBe(`"${sha256(chart.bytes)}"`);
    expect(served.headers.get("content-disposition")).toMatch(/^inline;/u);
    expect(served.headers.get("access-control-allow-origin")).toBe("*");
    const policy = served.headers.get("content-security-policy") ?? "";
    expect(policy).toContain(sandboxPolicy);
    // Only a readable URL's page, framed by the viewer, may navigate the tab.
    expect(policy).not.toContain("allow-top-navigation");
    expect(policy).toContain("default-src 'none'");

    const head = await fetch(committed.asset.url, {method: "HEAD"});
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(chart.bytes.byteLength));
    const ranged = await fetch(committed.asset.url, {headers: {Range: "bytes=0-3"}});
    expect(ranged.status).toBe(206);
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(chart.bytes.subarray(0, 4));
    const revalidated = await fetch(committed.asset.url, {
      headers: {"If-None-Match": `"${sha256(chart.bytes)}"`},
    });
    expect(revalidated.status).toBe(304);

    // A PDF downloads; an SVG is an image whose policy runs no script.
    const pdf = await addAsset(server, publisher, page.artifact.id, report, "frk-019-commit-report");
    const pdfResponse = await fetch(pdf.url);
    expect(pdfResponse.headers.get("content-type")).toBe("application/pdf");
    expect(pdfResponse.headers.get("content-disposition")).toMatch(/^attachment;/u);
    const svg = await addAsset(server, publisher, page.artifact.id, logo, "frk-019-commit-logo");
    const svgResponse = await fetch(svg.url);
    expect(svgResponse.headers.get("content-type")).toBe("image/svg+xml");
    const svgPolicies = (svgResponse.headers.get("content-security-policy") ?? "").split(", ");
    expect(svgPolicies).toContain("sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'");
    // Text data keeps its essence and is sent as UTF-8.
    const json = await addAsset(server, publisher, page.artifact.id, data, "frk-019-commit-data");
    expect(json.mediaType).toBe("application/json");
    expect((await fetch(json.url)).headers.get("content-type"))
      .toBe("application/json; charset=utf-8");

    const listing = await listAssets(server, publisher, page.artifact.id);
    expect(listing.assets.map((asset) => asset.name))
      .toEqual(["chart.png", "report.pdf", "logo.svg", "data.json"]);
    expect(listing.usage).toEqual({
      assetCount: 4,
      byteCount: chart.bytes.byteLength + report.bytes.byteLength +
        logo.bytes.byteLength + data.bytes.byteLength,
    });
    expect(listing.quota).toEqual({maximumAssets: 4, maximumBytes: 4_096});
  });

  test("FRK-019-F: the allowlist, caps, and quota refuse before storing, bytes must match their fingerprint, only publishers write, and deleting an asset leaves versions alone", async () => {
    const page = await publish("Report page");
    const publisher = installation.apiToken;

    // HTML, XML, and unknown types are never accepted.
    const refusedTypes = await Promise.all(
      ["text/html", "application/xhtml+xml", "application/xml", "application/x-unknown"]
        .map(async (mediaType) => {
          const refused = await planAsset(server, publisher, page.artifact.id, {...chart, mediaType});
          return [refused.status, await errorCode(refused)];
        }),
    );
    expect(refusedTypes.every(([status, code]) =>
      status === 415 && code === "ASSET_TYPE_UNSUPPORTED")).toBe(true);
    // A type cap and the byte quota refuse at the plan, before any byte is sent.
    const largeSvg = await planAsset(server, publisher, page.artifact.id, logo, {
      size: 2 * 1_048_576 + 1,
    });
    expect(largeSvg.status).toBe(413);
    expect(await errorCode(largeSvg)).toBe("ASSET_LIMIT_EXCEEDED");
    const overQuota = await planAsset(server, publisher, page.artifact.id, chart, {size: 4_097});
    expect(overQuota.status).toBe(413);

    // Bytes that do not match the declared fingerprint never verify.
    const mismatch = assetPlanSchema.parse(await (await planAsset(
      server,
      publisher,
      page.artifact.id,
      chart,
    )).json());
    const wrongBytes = chart.bytes.map((byte) => byte ^ 0xff);
    expect((await putAssetBytes(mismatch.file.uploadUrl, publisher, wrongBytes)).status).toBe(422);
    const unverified = await commitAsset(mismatch, publisher, "frk-019-commit-mismatch");
    expect(unverified.status).toBe(409);
    expect(await errorCode(unverified)).toBe("UPLOAD_INCOMPLETE");

    // A version upload plan skipped the allowlist, so committing it as an
    // asset checks the type again before the bytes reach the blob store.
    const html = {
      bytes: new TextEncoder().encode("<!doctype html>"),
      mediaType: "text/html",
      path: "index.html",
    };
    const versionPlan = await createStagedUpload(server, installation, "index.html", [html]);
    await uploadEveryStagedFile(installation, versionPlan.body, [html]);
    const smuggled = await commitAsset(
      {...mismatch, uploadId: versionPlan.body.uploadId},
      publisher,
      "frk-019-commit-smuggled",
    );
    expect(smuggled.status).toBe(415);

    // The count quota is checked again at commit, so plans made while there
    // was room cannot all land.
    await addAsset(server, publisher, page.artifact.id, chart, "frk-019-quota-fill-1");
    await addAsset(server, publisher, page.artifact.id, report, "frk-019-quota-fill-2");
    const [fourth, fifth] = await Promise.all([logo, data].map(async (file) => {
      const plan = assetPlanSchema.parse(await (await planAsset(
        server,
        publisher,
        page.artifact.id,
        file,
      )).json());
      expect((await putAssetBytes(plan.file.uploadUrl, publisher, file.bytes)).status).toBe(200);
      return plan;
    }));
    if (fourth === undefined || fifth === undefined) throw new Error("Two late plans are missing.");
    await addAsset(server, publisher, page.artifact.id, chart, "frk-019-quota-fill-3");
    expect((await commitAsset(fourth, publisher, "frk-019-quota-fill-4")).status).toBe(201);
    const overCount = await commitAsset(fifth, publisher, "frk-019-quota-fill-5");
    expect(overCount.status).toBe(413);
    expect(await errorCode(overCount)).toBe("ASSET_LIMIT_EXCEEDED");
    expect((await listAssets(server, publisher, page.artifact.id)).usage.assetCount).toBe(4);

    // A key bound to one upload cannot commit another.
    const reused = await commitAsset(fifth, publisher, "frk-019-quota-fill-4");
    expect(reused.status).toBe(409);
    expect(await errorCode(reused)).toBe("IDEMPOTENCY_CONFLICT");

    // A reader may list but not write.
    const cookies = await signInAdministrator(server, installation);
    const reader = await issueApiKey(server, cookies, ["artifact:read"], "Reader");
    expect((await listAssets(server, reader, page.artifact.id)).usage.assetCount).toBe(4);
    const [kept, removed] = (await listAssets(server, publisher, page.artifact.id)).assets;
    if (kept === undefined || removed === undefined) throw new Error("The listing is short.");
    expect((await planAsset(server, reader, page.artifact.id, chart)).status).toBe(403);
    expect((await deleteAsset(server, reader, page.artifact.id, kept.id)).status).toBe(403);
    expect((await commitAsset(fifth, reader, "frk-019-reader-commit")).status).toBe(403);

    // A version file with the same bytes as an asset shares its blob, and
    // deleting the asset leaves the version serving it.
    const shared = await publishVersion(server, installation, {
      artifactId: page.artifact.id,
      content: new TextDecoder().decode(report.bytes),
      expectedCurrentVersionId: page.version.id,
      idempotencyKey: "frk-019-version-sharing-bytes",
      mediaType: "application/pdf",
      path: "report.pdf",
    });
    const deleted = await deleteAsset(server, publisher, page.artifact.id, removed.id);
    expect(deleted.status).toBe(200);
    expect((await fetch(removed.url)).status).toBe(404);
    expect((await deleteAsset(server, publisher, page.artifact.id, removed.id)).status).toBe(404);
    const versionFile = await fetch(new URL("report.pdf", shared.body.links.version));
    expect(versionFile.status).toBe(200);
    expect(new Uint8Array(await versionFile.arrayBuffer())).toEqual(report.bytes);
    expect((await fetch(kept.url)).status).toBe(200);

    // Only a live asset of a live public artifact is served.
    const secret = await publish("Private page", "account_required");
    const hidden = await addAsset(server, publisher, secret.artifact.id, chart, "frk-019-private-asset");
    const unauthorized = await fetch(hidden.url);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("content-security-policy")).toContain(sandboxPolicy);
    const unknown = await fetch(`${server.baseUrl}/_blob/ast_00000000-0000-4000-8000-000000000000`);
    expect(unknown.status).toBe(404);
    expect(await errorCode(unknown)).toBe("ASSET_NOT_FOUND");
    expect((await fetch(`${kept.url}/more`)).status).toBe(404);
    expect((await fetch(kept.url, {method: "POST"})).status).toBe(405);

    const singleUse = await publish("Single use");

    // A staged upload commits at most once, even under concurrent keys.
    const planned = assetPlanSchema.parse(
      await (await planAsset(server, publisher, singleUse.artifact.id, chart)).json(),
    );
    expect((await putAssetBytes(planned.file.uploadUrl, publisher, chart.bytes)).status)
      .toBe(200);
    const raced = await Promise.all([
      commitAsset(planned, publisher, "frk-019-single-use-a"),
      commitAsset(planned, publisher, "frk-019-single-use-b"),
    ]);
    const winner = raced.findIndex((response) => response.status === 201);
    expect(winner).not.toBe(-1);
    // The losing commit either read the upload before the winner ended it
    // and was refused inside the transaction, or read it already ended.
    const loser = raced[1 - winner] ?? new Response();
    expect([[409, "UPLOAD_CLOSED"], [410, "UPLOAD_EXPIRED"]])
      .toContainEqual([loser.status, await errorCode(loser)]);
    const winnerKey = winner === 0 ? "frk-019-single-use-a" : "frk-019-single-use-b";

    const again = await commitAsset(planned, publisher, "frk-019-single-use-c");
    expect(again.status).toBe(410);
    expect(await errorCode(again)).toBe("UPLOAD_EXPIRED");
    const replay = await commitAsset(planned, publisher, winnerKey);
    expect(replay.status).toBe(200);
    expect(committedAssetSchema.parse(await replay.json()).replayed).toBe(true);

    const listing = await listAssets(server, publisher, singleUse.artifact.id);
    expect(listing.assets).toHaveLength(1);
    expect(listing.usage).toEqual({assetCount: 1, byteCount: chart.bytes.byteLength});
    expect(new Uint8Array(await (await fetch(listing.assets[0]?.url ?? "")).arrayBuffer()))
      .toEqual(chart.bytes);
  }, 60_000);

  test("foundation: a server with a content domain refuses to store assets it could not serve", async () => {
    const hostInstallation = await createTestInstallation();
    const hostMode = await startTestServer(hostInstallation);
    try {
      const page = (await publishNew(hostMode, hostInstallation, {
        accessSetting: "public_link",
        content: "<!doctype html>",
        idempotencyKey: "frk-019-host-mode-page",
      })).body;
      const refused = await planAsset(
        hostMode,
        hostInstallation.apiToken,
        page.artifact.id,
        chart,
      );
      expect(refused.status).toBe(501);
      expect(await errorCode(refused)).toBe("CAPABILITY_UNAVAILABLE");
    } finally {
      await hostMode.stop();
      await removeTestInstallation(hostInstallation);
    }
  });
});
