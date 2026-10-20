import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import type {IssueOperatorKeyCommand} from
  "../../src/application/installation-access.js";
import {localOwnerBrowserAccess} from "../../src/core/browser-access.js";
import {createLocalRuntime} from "../../src/local/create-local-runtime.js";
import {
  apiHeaders,
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
  uploadEveryStagedFile,
} from "../support/publishing.js";

const requestFrk015Theirs = "frk-015-theirs-v1";
const bootstrapAdministratorEmail = "administrator@example.test";
const laptop = "Duyet Le @ duet-mbp";
const desktop = "Duyet Le @ duet-linux";

const detailSchema = z.object({
  artifact: z.object({
    owner: z.object({displayName: z.string().nullable(), principalId: z.string()}),
  }),
  current: z.object({
    version: z.object({
      publisherDisplayName: z.string().nullable(),
      publisherPrincipalId: z.string(),
    }),
  }),
});

describe("operator member keys", () => {
  let installation: TestInstallation;
  let server: RunningTestServer | null = null;

  beforeEach(async () => {
    installation = await createTestInstallation();
  });

  afterEach(async () => {
    await server?.stop();
    server = null;
    await removeTestInstallation(installation);
  });

  async function issueKey(command: Partial<IssueOperatorKeyCommand>) {
    const runtime = await createLocalRuntime({
      apiToken: installation.apiToken,
      bootstrapAdministratorEmail,
      browserAccess: localOwnerBrowserAccess,
      contentDomain: null,
      dataDirectory: installation.dataDirectory,
    });
    try {
      return await runtime.issueOperatorKey({
        displayName: "Duyet Le",
        email: "duyet@example.test",
        expiresAt: "2099-01-01T00:00:00.000Z",
        keyName: laptop,
        role: "member",
        ...command,
      });
    } finally {
      await runtime.close();
    }
  }

  async function start(): Promise<RunningTestServer> {
    server = await startTestServer(installation, {
      bootstrapAdministratorEmail,
      contentDomain: null,
    });
    return server;
  }

  async function restart(): Promise<RunningTestServer> {
    await server?.stop();
    server = null;
    return start();
  }

  function as(token: string): TestInstallation {
    return {...installation, apiToken: token};
  }

  async function details(running: RunningTestServer, artifactId: string) {
    const response = await fetch(
      `${running.baseUrl}/api/v1/artifacts/${artifactId}`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
    expect(response.status).toBe(200);
    return detailSchema.parse(await response.json());
  }

  test("FRK-015-B: one member's keys on two machines publish under each key's name and both republish that member's artifact", async () => {
    const onLaptop = await issueKey({keyName: laptop});
    const onDesktop = await issueKey({keyName: desktop});
    expect(onLaptop.member.role).toBe("member");
    expect(onDesktop.member.id).toBe(onLaptop.member.id);
    expect(onLaptop.issued.apiKey.name).toBe(laptop);
    expect(onLaptop.issued.apiKey.capabilities).not.toContain("artifact:publish:any");
    expect(onLaptop.issued.apiKey.capabilities).not.toContain("artifact:manage:any");
    expect(onLaptop.issued.apiKey.capabilities).not.toContain("project:manage");
    const running = await start();

    const created = await publishNew(running, as(onLaptop.issued.token), {
      accessSetting: "account_required",
      content: "<!doctype html><title>Report</title>",
      idempotencyKey: "frk-015-report-v1",
      name: "Report",
    });
    expect(created.response.status).toBe(201);
    expect(created.body.version).toMatchObject({
      publisherDisplayName: laptop,
      publisherPrincipalId: onLaptop.member.id,
    });

    const fromDesktop = await publishVersion(running, as(onDesktop.issued.token), {
      artifactId: created.body.artifact.id,
      content: "<!doctype html><title>Report, desktop edit</title>",
      expectedCurrentVersionId: created.body.version.id,
      idempotencyKey: "frk-015-report-v2",
    });
    expect(fromDesktop.response.status).toBe(201);
    const fromLaptop = await publishVersion(running, as(onLaptop.issued.token), {
      artifactId: created.body.artifact.id,
      content: "<!doctype html><title>Report, laptop edit</title>",
      expectedCurrentVersionId: fromDesktop.body.version.id,
      idempotencyKey: "frk-015-report-v3",
    });
    expect(fromLaptop.response.status).toBe(201);

    const report = await details(running, created.body.artifact.id);
    expect(report.artifact.owner).toEqual({
      displayName: laptop,
      principalId: onLaptop.member.id,
    });
    expect(report.current.version).toEqual({
      publisherDisplayName: laptop,
      publisherPrincipalId: onLaptop.member.id,
    });
    expect(fromDesktop.body.version.publisherDisplayName).toBe(desktop);
  }, 60_000);

  test("FRK-015-F: a member key cannot publish over or manage another principal's artifact, re-issuing a key name revokes only that key, and a role mismatch issues nothing", async () => {
    const first = await issueKey({keyName: laptop});
    const other = await issueKey({keyName: desktop});
    let running = await start();

    const theirs = await publishNew(running, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Theirs</title>",
      idempotencyKey: requestFrk015Theirs,
      name: "Theirs",
    });
    const member = as(first.issued.token);
    const upload = await createStagedUpload(running, member, "index.html", [{
      bytes: new TextEncoder().encode("<!doctype html><title>Taken</title>"),
      mediaType: "text/html",
      path: "index.html",
    }]);
    expect(upload.response.status).toBe(201);
    await uploadEveryStagedFile(member, upload.body, [{
      bytes: new TextEncoder().encode("<!doctype html><title>Taken</title>"),
      mediaType: "text/html",
      path: "index.html",
    }]);
    const overwrite = await fetch(upload.body.commitUrl, {
      body: JSON.stringify({
        target: {
          artifactId: theirs.body.artifact.id,
          expectedCurrentVersionId: theirs.body.version.id,
          kind: "new_version",
        },
      }),
      headers: apiHeaders(member, "frk-015-overwrite"),
      method: "POST",
    });
    expect(overwrite.status).toBe(403);
    const renamed = await fetch(
      `${running.baseUrl}/api/v1/artifacts/${theirs.body.artifact.id}/name`,
      {
        body: JSON.stringify({
          expectedCurrentVersionId: theirs.body.version.id,
          name: "Taken",
        }),
        headers: apiHeaders(member, "frk-015-rename-theirs"),
        method: "PATCH",
      },
    );
    expect(renamed.status).toBe(403);
    expect((await details(running, theirs.body.artifact.id)).current.version
      .publisherPrincipalId).not.toBe(first.member.id);

    const reissued = await issueKey({keyName: laptop});
    expect(reissued.issued.apiKey.id).not.toBe(first.issued.apiKey.id);
    running = await restart();
    expect(await sessionStatus(running, first.issued.token)).toBe(401);
    expect(await sessionStatus(running, reissued.issued.token)).toBe(200);
    expect(await sessionStatus(running, other.issued.token)).toBe(200);

    await expect(issueKey({keyName: "Promoted", role: "administrator"}))
      .rejects.toMatchObject({
        _tag: "IdentityConflict",
        message: expect.stringContaining("role is member, not administrator"),
      });
  }, 60_000);
});

async function sessionStatus(
  running: RunningTestServer,
  token: string,
): Promise<number> {
  const response = await fetch(`${running.baseUrl}/api/v1/session`, {
    headers: {Authorization: `Bearer ${token}`},
  });
  await response.body?.cancel();
  return response.status;
}
