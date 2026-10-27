import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {issueApiKey, signInAdministrator} from "../support/agent-dispatch.js";
import {publishSite} from "../support/same-host-site.js";

const today = "2026-10-17";
const publicInfoSchema = z.object({
  artifactId: z.string(),
  canManage: z.literal(false),
  name: z.string(),
  owner: z.object({displayName: z.string().nullable()}).strict(),
  projectId: z.string(),
  updatedAt: z.iso.datetime(),
  version: z.object({id: z.string(), number: z.number().int().positive()}).strict(),
  views: z.object({
    daily: z.array(z.object({day: z.string(), views: z.number().int().positive()}).strict()),
    last30Days: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }).strict(),
  visibility: z.enum(["public", "unlisted"]),
  windowDays: z.literal(30),
}).strict();
const ownerSchema = z.object({
  artifact: z.object({owner: z.object({principalId: z.string()}).loose()}).loose(),
}).loose();
const errorSchema = z.object({error: z.object({code: z.string()}).loose()});

describe("public info of the artifact a readable URL serves", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation, {
      clock: {now: () => new Date(`${today}T09:00:00.000Z`)},
      contentDomain: null,
    });
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  function readInfo(pathname: string | null): Promise<Response> {
    const query = pathname === null ? "" : `?${new URLSearchParams({path: pathname})}`;
    return fetch(`${server.baseUrl}/api/v1/public/artifact-info${query}`);
  }

  async function notFound(pathname: string): Promise<string> {
    const response = await readInfo(pathname);
    expect(response.status).toBe(404);
    return errorSchema.parse(await response.json()).error.code;
  }

  test("FRK-030-B: with no credential, any page path or folder of a public artifact reads its name, author name, version, update time, visibility, and exact views, with canManage false", async () => {
    const site = await publishSite(server, installation, {
      accessSetting: "public_link",
      name: "Agent console",
      path: "2026/10/agent-console",
    });
    const views = await Promise.all([1, 2].map(() =>
      fetch(`${server.baseUrl}/2026/10/agent-console/`)));
    expect(views.map((response) => response.status)).toEqual([200, 200]);
    await server.flushArtifactViews();

    const response = await readInfo("/2026/10/agent-console/docs/nested/page.html");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    const info = publicInfoSchema.parse(await response.json());
    expect(info).toEqual({
      artifactId: site.artifact.id,
      canManage: false,
      name: "Agent console",
      owner: {displayName: site.artifact.owner.displayName},
      projectId: site.artifact.projectId,
      updatedAt: site.version.createdAt,
      version: {id: site.version.id, number: 1},
      views: {daily: [{day: today, views: 2}], last30Days: 2, total: 2},
      visibility: "public",
      windowDays: 30,
    });

    const folder = `/agent-console-${site.artifact.id.slice("art_".length)}/`;
    const byFolder = publicInfoSchema.parse(await (await readInfo(folder)).json());
    expect(byFolder).toEqual(info);

    const tagged = await fetch(`${server.baseUrl}/api/v1/artifacts/${site.artifact.id}/tags`, {
      body: JSON.stringify({expectedCurrentVersionId: site.version.id, tags: ["unlisted"]}),
      headers: {
        Authorization: `Bearer ${installation.apiToken}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "frk-030-unlisted",
      },
      method: "PATCH",
    });
    expect(tagged.status).toBe(200);
    const unlisted = publicInfoSchema.parse(await (await readInfo("/2026/10/agent-console/")).json());
    expect(unlisted.visibility).toBe("unlisted");
  });

  test("FRK-030-F: a private artifact reads exactly like a missing one, application and malformed paths are refused, a content-domain server has no readable info, and no answer carries an email or a principal ID", async () => {
    const site = await publishSite(server, installation, {
      accessSetting: "public_link",
      name: "Agent console",
      path: "2026/10/agent-console",
    });
    const priv = await publishSite(server, installation, {
      accessSetting: "account_required",
      name: "Internal ledger",
      path: "2026/10/internal-ledger",
    });

    const privateCode = await notFound("/2026/10/internal-ledger/");
    expect(privateCode).toBe(await notFound("/2026/10/absent/"));
    expect(privateCode).toBe("ARTIFACT_NOT_FOUND");
    expect(await notFound(`/internal-ledger-${priv.artifact.id.slice("art_".length)}/`))
      .toBe(privateCode);
    expect(await notFound("/")).toBe(privateCode);
    expect(await notFound("/api/v1/artifacts")).toBe(privateCode);
    expect(await notFound(`/v/${site.version.id}/`)).toBe(privateCode);
    expect((await readInfo(null)).status).toBe(422);
    expect((await readInfo("2026/10/agent-console/")).status).toBe(422);
    expect((await readInfo(`/${"a".repeat(1_024)}`)).status).toBe(422);

    const details = await fetch(`${server.baseUrl}/api/v1/artifacts/${site.artifact.id}`, {
      headers: {Authorization: `Bearer ${installation.apiToken}`},
    });
    const ownerId = ownerSchema.parse(await details.json()).artifact.owner.principalId;
    const text = await (await readInfo("/2026/10/agent-console/")).text();
    expect(text).not.toContain(ownerId);
    expect(text).not.toContain("@");

    // An OIDC member admitted without name claims is named by their email.
    const administrator = await signInAdministrator(server, installation);
    const emailNamedKey = await issueApiKey(
      server,
      administrator,
      ["artifact:create", "artifact:read"],
      "ada@example.test",
    );
    const emailNamed = await publishSite(server, {...installation, apiToken: emailNamedKey}, {
      accessSetting: "public_link",
      name: "Email named owner",
      path: "2026/10/email-named-owner",
    });
    expect(emailNamed.artifact.owner.displayName).toBe("ada@example.test");
    const emailNamedInfo = await readInfo("/2026/10/email-named-owner/");
    expect(emailNamedInfo.status).toBe(200);
    const emailNamedText = await emailNamedInfo.text();
    expect(publicInfoSchema.parse(JSON.parse(emailNamedText)).owner).toEqual({displayName: null});
    expect(emailNamedText).not.toContain("@");

    await server.stop();
    server = await startTestServer(installation, {contentDomain: "localhost"});
    expect(await notFound("/2026/10/agent-console/")).toBe(privateCode);
  });
});
