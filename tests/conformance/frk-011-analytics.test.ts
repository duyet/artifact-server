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
  publishNew,
  publishVersion,
  type PublishResponse,
} from "../support/publishing.js";
import {
  issueApiKey,
  MutableClock,
  signInAdministrator,
} from "../support/agent-dispatch.js";

const requestFrk011AtlasSecond = "frk-011-atlas-second";

const dayPattern = /^\d{4}-\d{2}-\d{2}$/u;
const projectReportSchema = z.object({
  daily: z.array(z.object({
    day: z.string().regex(dayPattern),
    uploads: z.number().int().nonnegative(),
    views: z.number().int().nonnegative(),
  }).strict()),
  generatedAt: z.iso.datetime(),
  today: z.string().regex(dayPattern),
  topArtifacts: z.array(z.object({
    artifactId: z.string(),
    name: z.string(),
    total: z.number().int().nonnegative(),
    views30d: z.number().int().nonnegative(),
  }).strict()),
  totals: z.object({
    artifacts: z.number().int().nonnegative(),
    artifactsViewedToday: z.number().int().nonnegative(),
    averageViewsPerArtifact: z.number().nonnegative(),
    pageViews: z.number().int().nonnegative(),
    publicArtifacts: z.number().int().nonnegative(),
    uploadedToday: z.number().int().nonnegative(),
    uploads: z.number().int().nonnegative(),
  }).strict(),
  windowDays: z.literal(365),
}).strict();
const artifactReportSchema = z.object({
  artifactId: z.string(),
  daily: z.array(z.object({
    day: z.string().regex(dayPattern),
    views: z.number().int().positive(),
  }).strict()),
  today: z.string().regex(dayPattern),
  views: z.object({
    last7Days: z.number().int().nonnegative(),
    last30Days: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }).strict(),
  windowDays: z.literal(30),
}).strict();

const day = 24 * 60 * 60 * 1_000;

describe("project and artifact analytics", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let clock: MutableClock;

  beforeEach(async () => {
    installation = await createTestInstallation();
    // 400 days before 2026-10-17, so the first upload and view fall outside
    // the 365-day series but inside the all-time totals.
    clock = new MutableClock("2025-09-12T10:00:00.000Z");
    server = await startTestServer(installation, {clock, contentDomain: null});
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  async function view(published: PublishResponse, times: number) {
    const responses = await Promise.all(Array.from(
      {length: times},
      () => fetch(`${published.links.version}index.html`),
    ));
    expect(responses.map((response) => response.status))
      .toEqual(responses.map(() => 200));
    // Views land on the clock's day when they drain, so drain before moving
    // the clock.
    await server.flushArtifactViews();
  }

  test("FRK-011-B: project totals, the sparse yearly series, the most viewed artifacts, and one artifact's windows come from versions and stored views", async () => {
    const atlas = await publishNew(server, installation, {
      accessSetting: "public_link",
      content: "<!doctype html><title>Atlas</title>",
      idempotencyKey: "frk-011-atlas-first",
      name: "Atlas",
    });
    await view(atlas.body, 3);

    clock.advance(398 * day); // 2026-10-15
    const atlasTwo = await publishVersion(server, installation, {
      artifactId: atlas.body.artifact.id,
      content: "<!doctype html><title>Atlas two</title>",
      expectedCurrentVersionId: atlas.body.version.id,
      idempotencyKey: requestFrk011AtlasSecond,
    });
    const ledger = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Ledger</title>",
      idempotencyKey: "frk-011-ledger-first",
      name: "Ledger",
    });
    await view(atlasTwo.body, 2);

    clock.advance(2 * day); // 2026-10-17
    const notes = await publishNew(server, installation, {
      accessSetting: "public_link",
      content: "<!doctype html><title>Notes</title>",
      idempotencyKey: "frk-011-notes-first",
      name: "Notes",
    });
    await view(atlasTwo.body, 1);
    await view(notes.body, 4);

    const report = await readProjectReport(server, installation.apiToken);
    expect(report).toMatchObject({
      daily: [
        {day: "2026-10-15", uploads: 2, views: 2},
        {day: "2026-10-17", uploads: 1, views: 5},
      ],
      today: "2026-10-17",
      topArtifacts: [
        {artifactId: notes.body.artifact.id, name: "Notes", total: 4, views30d: 4},
        {artifactId: atlas.body.artifact.id, name: "Atlas", total: 6, views30d: 3},
      ],
      totals: {
        artifacts: 3,
        artifactsViewedToday: 2,
        // (3 + 2 + 1 + 4) views over three artifacts.
        averageViewsPerArtifact: 3.3,
        pageViews: 10,
        publicArtifacts: 2,
        uploadedToday: 1,
        uploads: 4,
      },
      windowDays: 365,
    });
    expect(report.generatedAt).toBe("2026-10-17T10:00:00.000Z");
    expect(report.topArtifacts.map((item) => item.name)).not.toContain(
      ledger.body.artifact.name,
    );

    expect(await readArtifactReport(
      server,
      installation.apiToken,
      atlas.body.artifact.id,
    ))
      .toEqual({
        artifactId: atlas.body.artifact.id,
        daily: [
          {day: "2026-10-15", views: 2},
          {day: "2026-10-17", views: 1},
        ],
        today: "2026-10-17",
        views: {last7Days: 3, last30Days: 3, total: 6},
        windowDays: 30,
      });
  }, 60_000);

  test("FRK-011-F: deleted artifacts leave every count, a deleted or foreign artifact is 404, and a caller without read access is refused", async () => {
    const kept = await publishNew(server, installation, {
      accessSetting: "public_link",
      content: "<!doctype html><title>Kept</title>",
      idempotencyKey: "frk-011-kept-first",
      name: "Kept",
    });
    const removed = await publishNew(server, installation, {
      accessSetting: "public_link",
      content: "<!doctype html><title>Removed</title>",
      idempotencyKey: "frk-011-removed-first",
      name: "Removed",
    });
    await view(kept.body, 1);
    await view(removed.body, 5);

    const deletion = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${removed.body.artifact.id}`,
      {
        body: JSON.stringify({expectedCurrentVersionId: removed.body.version.id}),
        headers: {
          Authorization: `Bearer ${installation.apiToken}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "frk-011-removed-delete",
        },
        method: "DELETE",
      },
    );
    expect(deletion.status).toBe(200);

    const report = await readProjectReport(server, installation.apiToken);
    expect(report.totals).toEqual({
      artifacts: 1,
      artifactsViewedToday: 1,
      averageViewsPerArtifact: 1,
      pageViews: 1,
      publicArtifacts: 1,
      uploadedToday: 1,
      uploads: 1,
    });
    expect(report.daily).toEqual([{day: "2025-09-12", uploads: 1, views: 1}]);
    expect(report.topArtifacts.map((item) => item.name)).toEqual(["Kept"]);

    expect(await artifactReportStatus(
      server,
      installation.apiToken,
      removed.body.artifact.id,
      "",
    )).toBe(404);

    const cookies = await signInAdministrator(server, installation);
    const otherProject = await fetch(`${server.baseUrl}/api/v1/projects`, {
      body: JSON.stringify({name: "Elsewhere"}),
      headers: new Headers({
        "Content-Type": "application/json",
        Cookie: cookies.header,
        Origin: server.baseUrl,
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "X-CSRF-Token": cookies.csrf,
      }),
      method: "POST",
    });
    expect(otherProject.status).toBe(201);
    const elsewhere = z.object({project: z.object({id: z.string()})})
      .parse(await otherProject.json()).project.id;
    // The artifact exists, but not in the project the caller names.
    expect(await artifactReportStatus(
      server,
      installation.apiToken,
      kept.body.artifact.id,
      `?projectId=${elsewhere}`,
    )).toBe(404);
    const emptyProject = await fetch(
      `${server.baseUrl}/api/v1/analytics?projectId=${elsewhere}`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
    expect(emptyProject.status).toBe(200);
    expect(projectReportSchema.parse(await emptyProject.json())).toMatchObject({
      daily: [],
      topArtifacts: [],
      totals: {artifacts: 0, averageViewsPerArtifact: 0, pageViews: 0, uploads: 0},
    });

    const agentOnly = await issueApiKey(server, cookies, ["agent:connect"], "Agent only");
    const refused = await fetch(
      `${server.baseUrl}/api/v1/analytics?projectId=prj_default`,
      {headers: {Authorization: `Bearer ${agentOnly}`}},
    );
    expect(refused.status).toBe(403);
    expect(await artifactReportStatus(
      server,
      agentOnly,
      kept.body.artifact.id,
      "?projectId=prj_default",
    )).toBe(403);
  }, 60_000);
});

async function readProjectReport(
  server: RunningTestServer,
  token: string,
): Promise<z.infer<typeof projectReportSchema>> {
  const response = await fetch(`${server.baseUrl}/api/v1/analytics`, {
    headers: {Authorization: `Bearer ${token}`},
  });
  expect(response.status).toBe(200);
  return projectReportSchema.parse(await response.json());
}

async function readArtifactReport(
  server: RunningTestServer,
  token: string,
  artifactId: string,
): Promise<z.infer<typeof artifactReportSchema>> {
  const response = await fetch(
    `${server.baseUrl}/api/v1/artifacts/${artifactId}/analytics`,
    {headers: {Authorization: `Bearer ${token}`}},
  );
  expect(response.status).toBe(200);
  return artifactReportSchema.parse(await response.json());
}

async function artifactReportStatus(
  server: RunningTestServer,
  token: string,
  artifactId: string,
  query: string,
): Promise<number> {
  const response = await fetch(
    `${server.baseUrl}/api/v1/artifacts/${artifactId}/analytics${query}`,
    {headers: {Authorization: `Bearer ${token}`}},
  );
  return response.status;
}
