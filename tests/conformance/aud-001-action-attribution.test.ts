import {createHash} from "node:crypto";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {parsePublishResponse, type PublishResponse} from "../support/publishing.js";
import {signInAdministrator} from "../support/agent-dispatch.js";

const actionRecordSchema = z.object({
  action: z.string(),
  artifactId: z.string(),
  authorizedByPrincipalId: z.string().nullable(),
  createdAt: z.iso.datetime(),
  id: z.string(),
  idempotencyKey: z.string(),
  principalId: z.string(),
  projectId: z.string(),
  versionId: z.string(),
}).strict();
type ActionRecord = z.infer<typeof actionRecordSchema>;
const actionPageSchema = z.object({
  actions: z.array(actionRecordSchema),
  nextCursor: z.string().nullable(),
}).strict();
const uploadPlanSchema = z.object({
  commitUrl: z.url(),
  files: z.array(z.object({path: z.string(), uploadUrl: z.url()}).loose()),
}).loose();
const artifactStateSchema = z.object({
  artifact: z.object({
    accessSetting: z.string(),
    currentVersionId: z.string(),
    deletedAt: z.string().nullable(),
    name: z.string(),
    tags: z.array(z.string()),
  }).loose(),
}).loose();
const threadCreationSchema = z.object({
  thread: z.object({id: z.string()}).loose(),
}).loose();
const replyCreationSchema = z.object({
  reply: z.object({id: z.string()}).loose(),
}).loose();
const issuedKeySchema = z.object({
  apiKey: z.object({id: z.string(), principalId: z.string()}).loose(),
  token: z.string().startsWith("as_key_"),
}).loose();
type IssuedKey = z.infer<typeof issuedKeySchema>;
const installationActionSchema = z.object({
  authorizedByPrincipalId: z.string().nullable(),
  createdAt: z.iso.datetime(),
  id: z.string(),
  kind: z.string(),
  principalDisplayName: z.string(),
  principalId: z.string(),
  subjectId: z.string(),
}).strict();
type InstallationAction = z.infer<typeof installationActionSchema>;
const installationActionPageSchema = z.object({
  actions: z.array(installationActionSchema),
  nextCursor: z.string().nullable(),
}).strict();
const projectRecordSchema = z.object({
  archivedAt: z.string().nullable(),
  id: z.string(),
  name: z.string(),
}).loose();
const projectSchema = z.object({project: projectRecordSchema}).loose();
const projectListSchema = z.object({projects: z.array(projectRecordSchema)}).loose();
const memberRecordSchema = z.object({id: z.string(), status: z.string()}).loose();
const memberSchema = z.object({member: memberRecordSchema}).loose();
const memberListSchema = z.object({members: z.array(memberRecordSchema)}).loose();
const apiKeyListSchema = z.object({
  apiKeys: z.array(z.object({id: z.string(), revokedAt: z.string().nullable()}).loose()),
}).loose();
const assetPlanSchema = z.object({
  commitUrl: z.url(),
  file: z.object({uploadUrl: z.url()}).loose(),
  uploadId: z.string(),
}).loose();
const committedAssetSchema = z.object({
  asset: z.object({id: z.string()}).loose(),
  replayed: z.boolean(),
}).strict();
const assetListingSchema = z.object({
  assets: z.array(z.object({id: z.string()}).loose()),
}).loose();
const assetBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const anyJson = z.object({}).loose();
const sessionSchema = z.object({principal: z.object({id: z.string()}).loose()})
  .loose();

/** The mutations one run performs, in order, as their recorded action kinds. */
const mutationSequence = [
  "publish",
  "publish",
  "edited",
  "restore",
  "change_access",
  "change_tags",
  "renamed",
  "comment_create",
  "comment_reply",
  "comment_update",
  "comment_resolve",
  "comment_reopen",
  "comment_delete",
  "comment_delete",
  "asset_added",
  "asset_added",
  "asset_deleted",
  "delete",
] as const;

interface Actor {
  readonly authorizedByPrincipalId: string | null;
  readonly headers: (idempotencyKey?: string) => Headers;
  readonly principalId: string;
}

describe("AUD-001 recorded responsibility for every mutation", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let human: Actor;
  let agent: Actor;
  let agentKey: IssuedKey;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation, {contentDomain: null});
    const cookies = await signInAdministrator(server, installation);
    const browserHeaders = (idempotencyKey?: string): Headers => {
      const headers = new Headers({
        "Content-Type": "application/json",
        Cookie: cookies.header,
        Origin: server.baseUrl,
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "X-CSRF-Token": cookies.csrf,
      });
      if (idempotencyKey !== undefined) headers.set("Idempotency-Key", idempotencyKey);
      return headers;
    };
    const session = await fetch(`${server.baseUrl}/api/v1/session`, {
      headers: {Cookie: cookies.header},
    });
    if (session.status !== 200) throw new Error(`The session read answered ${session.status}.`);
    const humanId = sessionSchema.parse(await session.json()).principal.id;
    human = {authorizedByPrincipalId: null, headers: browserHeaders, principalId: humanId};

    const issued = await fetch(`${server.baseUrl}/api/v1/api-keys`, {
      body: JSON.stringify({
        capabilities: [
          "artifact:create",
          "artifact:manage:any",
          "artifact:publish:any",
          "artifact:read",
          "comment:write",
        ],
        expiresAt: "2099-01-01T00:00:00.000Z",
        name: "Publishing agent",
      }),
      headers: browserHeaders(),
      method: "POST",
    });
    if (issued.status !== 201) throw new Error(`Issuing the agent key answered ${issued.status}.`);
    const key = issuedKeySchema.parse(await issued.json());
    agentKey = key;
    agent = {
      authorizedByPrincipalId: humanId,
      headers: (idempotencyKey?: string) => {
        const headers = new Headers({
          Authorization: `Bearer ${key.token}`,
          "Content-Type": "application/json",
        });
        if (idempotencyKey !== undefined) headers.set("Idempotency-Key", idempotencyKey);
        return headers;
      },
      principalId: key.apiKey.principalId,
    };
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("AUD-001-B: every mutation by a human and an agent leaves one attributed, immutable action record", async () => {
    expect.hasAssertions();
    expect(agent.principalId).not.toBe(human.principalId);

    for (const actor of [human, agent]) {
      const prefix = actor === human ? "aud-001-human-run" : "aud-001-agent-run";
      // Each run reads its ledger only after all of its own mutations finish.
      // eslint-disable-next-line no-await-in-loop
      const published = await performEveryMutation(actor, prefix);
      // eslint-disable-next-line no-await-in-loop
      const ledger = (await readActions(published)).toReversed();
      expect(ledger.map((record) => record.action)).toEqual([...mutationSequence]);
      for (const record of ledger) {
        expect(record).toMatchObject({
          artifactId: published.artifact.id,
          authorizedByPrincipalId: actor.authorizedByPrincipalId,
          principalId: actor.principalId,
          projectId: published.artifact.projectId,
        });
        expect(record.idempotencyKey.length).toBeGreaterThan(0);
      }
      expect(new Set(ledger.map((record) => record.id)).size).toBe(ledger.length);
      expect(ledger.filter((record) => record.action.startsWith("asset_")))
        .toEqual(Array.from({length: 3}, () =>
          expect.objectContaining({versionId: published.version.id})));
    }

    const target = await publish(human, "aud-001-immutable-publish", {
      accessSetting: "account_required",
      content: "<p>before</p>",
      kind: "new_artifact",
      name: "Immutable history",
    });
    const replay = await publish(human, "aud-001-immutable-publish", {
      accessSetting: "account_required",
      content: "<p>before</p>",
      kind: "new_artifact",
      name: "Immutable history",
    }, 200);
    expect(replay.replayed).toBe(true);
    const before = await readActions(target);
    expect(before).toHaveLength(1);

    const agentThread = await expectJson(
      await send(agent, "POST", scoped(target, `/versions/${target.version.id}/comments`), {
        body: {body: "An agent note on the human's artifact."},
        key: "aud-001-immutable-agent-thread",
      }), 201, threadCreationSchema);
    await expectJson(
      await send(human, "PATCH", scoped(target, "/tags"), {
        body: {expectedCurrentVersionId: target.version.id, tags: ["audited"]},
        key: "aud-001-immutable-tags",
      }),
      200,
      anyJson,
    );
    const after = await readActions(target);
    expect(after.slice(-before.length)).toEqual(before);
    expect(after.slice(0, -before.length).toReversed()).toEqual([
      expect.objectContaining({
        action: "comment_create",
        authorizedByPrincipalId: human.principalId,
        principalId: agent.principalId,
      }),
      expect.objectContaining({
        action: "change_tags",
        authorizedByPrincipalId: null,
        principalId: human.principalId,
      }),
    ]);
    expect(agentThread.thread.id.length).toBeGreaterThan(0);

    // Signing in admitted the local administrator, who then issued the agent key.
    const signInActions = await readInstallationActions();
    expect(summarizeActions(signInActions)).toEqual(sortedSummaries([
      {
        authorizedByPrincipalId: null,
        kind: "member_admitted",
        principalDisplayName: "Local administrator",
        principalId: human.principalId,
        subjectId: human.principalId,
      },
      {
        authorizedByPrincipalId: null,
        kind: "api_key_issued",
        principalDisplayName: "Local administrator",
        principalId: human.principalId,
        subjectId: agentKey.apiKey.id,
      },
    ]));

    const stewardKey = await issueKey(["project:manage"], "Project steward");
    const steward = bearerActor(stewardKey, human.principalId);
    const project = (await expectJson(
      await send(human, "POST", "/api/v1/projects", {body: {name: "Audited project"}}),
      201,
      projectSchema,
    )).project;
    await expectJson(await send(steward, "PATCH", `/api/v1/projects/${project.id}`, {
      body: {name: "Audited project, renamed"},
    }), 200, projectSchema);
    await expectJson(
      await send(human, "POST", `/api/v1/projects/${project.id}/archive`),
      200,
      projectSchema,
    );
    await expectJson(
      await send(steward, "POST", `/api/v1/projects/${project.id}/unarchive`),
      200,
      projectSchema,
    );
    const member = (await expectJson(await send(human, "POST", "/api/v1/members", {
      body: {displayName: "Audited member", email: auditedMemberEmail},
    }), 201, memberSchema)).member;
    await expectJson(
      await send(human, "POST", `/api/v1/members/${member.id}/deactivate`),
      200,
      memberSchema,
    );
    const rotatedKey = await issueKey(["artifact:read"], "Rotated reader");
    const replacementKey = await expectJson(
      await send(human, "POST", `/api/v1/api-keys/${rotatedKey.apiKey.id}/rotate`),
      201,
      issuedKeySchema,
    );
    await expectJson(
      await send(human, "POST", `/api/v1/api-keys/${replacementKey.apiKey.id}/revoke`),
      200,
      anyJson,
    );

    const response = await send(human, "GET", "/api/v1/administration/actions?limit=100");
    const body: unknown = await response.json();
    expect(response.status).toBe(200);
    const recorded = installationActionPageSchema.parse(body).actions;
    const serialized = JSON.stringify(body);
    for (const secret of [
      agentKey.token,
      stewardKey.token,
      rotatedKey.token,
      replacementKey.token,
      auditedMemberEmail,
    ]) {
      expect(serialized).not.toContain(secret);
    }
    const createdTimes = recorded.map((action) => action.createdAt);
    expect(createdTimes).toEqual(createdTimes.toSorted().toReversed());
    const byHuman = (kind: string, subjectId: string) => ({
      authorizedByPrincipalId: null,
      kind,
      principalDisplayName: "Local administrator",
      principalId: human.principalId,
      subjectId,
    });
    const bySteward = (kind: string, subjectId: string) => ({
      authorizedByPrincipalId: human.principalId,
      kind,
      principalDisplayName: "Project steward",
      principalId: steward.principalId,
      subjectId,
    });
    expect(summarizeActions(recorded)).toEqual(sortedSummaries([
      ...summarizeActions(signInActions),
      byHuman("api_key_issued", stewardKey.apiKey.id),
      byHuman("project_created", project.id),
      bySteward("project_renamed", project.id),
      byHuman("project_archived", project.id),
      bySteward("project_unarchived", project.id),
      byHuman("member_admitted", member.id),
      byHuman("member_deactivated", member.id),
      byHuman("api_key_issued", rotatedKey.apiKey.id),
      byHuman("api_key_revoked", rotatedKey.apiKey.id),
      byHuman("api_key_issued", replacementKey.apiKey.id),
      byHuman("api_key_revoked", replacementKey.apiKey.id),
    ]));
    const pageOne = await expectJson(
      await send(human, "GET", "/api/v1/administration/actions?limit=5"),
      200,
      installationActionPageSchema,
    );
    const pageTwo = await expectJson(await send(
      human,
      "GET",
      `/api/v1/administration/actions?limit=5&cursor=${pageOne.nextCursor ?? ""}`,
    ), 200, installationActionPageSchema);
    const pageThree = await expectJson(await send(
      human,
      "GET",
      `/api/v1/administration/actions?limit=5&cursor=${pageTwo.nextCursor ?? ""}`,
    ), 200, installationActionPageSchema);
    expect([...pageOne.actions, ...pageTwo.actions, ...pageThree.actions]).toEqual(recorded);
    expect(pageThree.nextCursor).toBeNull();
  });

  test("AUD-001-F: a mutation cannot commit without a valid actor and its action record", async () => {
    expect.hasAssertions();
    const published = await publish(agent, "aud-001-refused-base", {
      accessSetting: "account_required",
      content: "<p>v1</p>",
      kind: "new_artifact",
      name: "Refused ledger",
    });
    const first = published.version.id;
    const second = await publish(agent, "aud-001-refused-second", {
      artifactId: published.artifact.id,
      content: "<p>v2</p>",
      expectedCurrentVersionId: first,
      kind: "new_version",
    });
    const kept = await addAsset(agent, published, "audit-kept-asset");
    const baseline = await readArtifact(published);
    const baselineLedger = await readActions(published);
    const baselineAssets = await readAssetIds(published);

    const unauthenticated = new Headers({
      "Content-Type": "application/json",
      "Idempotency-Key": "audit-anonymous-tags-attempt",
    });
    const anonymous = await fetch(`${server.baseUrl}${scoped(published, "/tags")}`, {
      body: JSON.stringify({expectedCurrentVersionId: second.version.id, tags: ["x"]}),
      headers: unauthenticated,
      method: "PATCH",
    });
    expect(anonymous.status).toBe(401);
    await anonymous.arrayBuffer();
    unauthenticated.set("Authorization", "Bearer as_key_forged_not-a-real-secret");
    unauthenticated.set("Idempotency-Key", "audit-forged-tags-attempt");
    const forged = await fetch(`${server.baseUrl}${scoped(published, "/tags")}`, {
      body: JSON.stringify({expectedCurrentVersionId: second.version.id, tags: ["x"]}),
      headers: unauthenticated,
      method: "PATCH",
    });
    expect(forged.status).toBe(401);
    await forged.arrayBuffer();
    expect(await readArtifact(published)).toEqual(baseline);
    expect(await readActions(published)).toEqual(baselineLedger);

    const refusedAssetPlan = await planAssetUpload(agent, published);
    refuseActionRecords();
    const refusals: readonly (readonly [string, () => Promise<Response>])[] = [
      ["new artifact", () => commitPublish(agent, "aud-001-refused-new", {
        accessSetting: "account_required",
        content: "<p>never</p>",
        kind: "new_artifact",
        name: "Never committed",
      })],
      ["new version", () => commitPublish(agent, "aud-001-refused-version", {
        artifactId: published.artifact.id,
        content: "<p>never</p>",
        expectedCurrentVersionId: second.version.id,
        kind: "new_version",
      })],
      ["edit", () => commitPublish(agent, "aud-001-refused-edit", {
        artifactId: published.artifact.id,
        baseVersionId: second.version.id,
        content: "<p>never</p>",
        expectedCurrentVersionId: second.version.id,
        kind: "edit",
        path: "index.html",
      })],
      ["restore", () => send(agent, "POST", scoped(published, "/restore"), {
        body: {expectedCurrentVersionId: second.version.id, versionId: first},
        key: "aud-001-refused-restore",
      })],
      ["access", () => send(agent, "PATCH", scoped(published, "/access"), {
        body: {accessSetting: "public_link", expectedCurrentVersionId: second.version.id},
        key: "aud-001-refused-access",
      })],
      ["tags", () => send(agent, "PATCH", scoped(published, "/tags"), {
        body: {expectedCurrentVersionId: second.version.id, tags: ["never"]},
        key: "aud-001-refused-tags",
      })],
      ["rename", () => send(agent, "PATCH", scoped(published, "/name"), {
        body: {expectedCurrentVersionId: second.version.id, name: "Never renamed"},
        key: "aud-001-refused-rename",
      })],
      ["delete", () => send(agent, "DELETE", scoped(published, ""), {
        body: {expectedCurrentVersionId: second.version.id},
        key: "aud-001-refused-delete",
      })],
      ["asset commit", () => commitAssetUpload(agent, refusedAssetPlan, "audit-refused-asset-commit")],
      ["asset copy", () => send(agent, "POST", scoped(published, "/assets/copies"), {
        body: {sourceArtifactId: published.artifact.id, sourceAssetId: kept},
        key: "audit-refused-asset-copy",
      })],
      ["asset delete", () => send(agent, "DELETE", scoped(published, `/assets/${kept}`))],
    ];
    for (const [label, attempt] of refusals) {
      // The refusals run in order so each one sees the unchanged artifact.
      // eslint-disable-next-line no-await-in-loop
      const response = await attempt();
      expect({label, status: response.status}).toEqual({label, status: 500});
      // eslint-disable-next-line no-await-in-loop
      await response.arrayBuffer();
    }
    expect(await readArtifact(published)).toEqual(baseline);
    expect(await readActions(published)).toEqual(baselineLedger);
    expect(await readAssetIds(published)).toEqual(baselineAssets);
    expect(countArtifacts()).toBe(1);

    acceptActionRecords();
    const tagged = await send(agent, "PATCH", scoped(published, "/tags"), {
      body: {
        expectedCurrentVersionId: second.version.id,
        principalId: human.principalId,
        tags: ["recorded"],
      },
      headers: {"X-Principal-Id": human.principalId},
      key: "aud-001-refused-tags",
    });
    expect(tagged.status).toBe(200);
    await tagged.arrayBuffer();
    const restored = await send(agent, "POST", scoped(published, "/restore"), {
      body: {expectedCurrentVersionId: second.version.id, versionId: first},
      key: "aud-001-refused-restore",
    });
    expect(restored.status).toBe(200);
    await restored.arrayBuffer();
    // The refused commit left its upload open, so the same key commits it now.
    const retried = await expectJson(
      await commitAssetUpload(agent, refusedAssetPlan, "audit-refused-asset-commit"),
      201,
      committedAssetSchema,
    );
    await expectJson(
      await send(agent, "DELETE", scoped(published, `/assets/${kept}`)),
      200,
      anyJson,
    );
    expect(await readAssetIds(published)).toEqual([retried.asset.id]);
    const recovered = (await readActions(published)).slice(0, 4).toReversed();
    expect(recovered).toEqual([
      expect.objectContaining({
        action: "change_tags",
        authorizedByPrincipalId: human.principalId,
        idempotencyKey: "aud-001-refused-tags",
        principalId: agent.principalId,
      }),
      expect.objectContaining({
        action: "restore",
        idempotencyKey: "aud-001-refused-restore",
        principalId: agent.principalId,
        versionId: first,
      }),
      expect.objectContaining({
        action: "asset_added",
        authorizedByPrincipalId: human.principalId,
        principalId: agent.principalId,
        versionId: first,
      }),
      expect.objectContaining({
        action: "asset_deleted",
        authorizedByPrincipalId: human.principalId,
        principalId: agent.principalId,
        versionId: first,
      }),
    ]);

    const denied = await send(agent, "GET", "/api/v1/administration/actions");
    expect(denied.status).toBe(403);
    await denied.arrayBuffer();

    const project = (await expectJson(
      await send(human, "POST", "/api/v1/projects", {body: {name: "Kept project"}}),
      201,
      projectSchema,
    )).project;
    const archived = (await expectJson(
      await send(human, "POST", "/api/v1/projects", {body: {name: "Archived project"}}),
      201,
      projectSchema,
    )).project;
    await expectJson(
      await send(human, "POST", `/api/v1/projects/${archived.id}/archive`),
      200,
      projectSchema,
    );
    const member = (await expectJson(await send(human, "POST", "/api/v1/members", {
      body: {displayName: "Kept member", email: auditedMemberEmail},
    }), 201, memberSchema)).member;
    const keptKey = await issueKey(["artifact:read"], "Kept reader");
    const keptReader = bearerActor(keptKey, human.principalId);
    const installationBaseline = {
      actions: await readInstallationActions(),
      keys: await readList("/api/v1/api-keys", apiKeyListSchema),
      members: await readList("/api/v1/members", memberListSchema),
      projects: await readList("/api/v1/projects", projectListSchema),
    };

    refuseInstallationActionRecords();
    const installationRefusals: readonly (readonly [string, () => Promise<Response>])[] = [
      ["project create", () => send(human, "POST", "/api/v1/projects", {
        body: {name: "Never created"},
      })],
      ["project rename", () => send(human, "PATCH", `/api/v1/projects/${project.id}`, {
        body: {name: "Never renamed"},
      })],
      ["project archive", () => send(human, "POST", `/api/v1/projects/${project.id}/archive`)],
      ["project unarchive", () =>
        send(human, "POST", `/api/v1/projects/${archived.id}/unarchive`)],
      ["member admit", () => send(human, "POST", "/api/v1/members", {
        body: {displayName: "Never admitted", email: "never-admitted@example.test"},
      })],
      ["member deactivate", () =>
        send(human, "POST", `/api/v1/members/${member.id}/deactivate`)],
      ["key issue", () => send(human, "POST", "/api/v1/api-keys", {
        body: {
          capabilities: ["artifact:read"],
          expiresAt: "2099-01-01T00:00:00.000Z",
          name: "Never issued",
        },
      })],
      ["key revoke", () => send(human, "POST", `/api/v1/api-keys/${keptKey.apiKey.id}/revoke`)],
      ["key rotate", () => send(human, "POST", `/api/v1/api-keys/${keptKey.apiKey.id}/rotate`)],
    ];
    for (const [label, attempt] of installationRefusals) {
      // eslint-disable-next-line no-await-in-loop
      const response = await attempt();
      expect({label, status: response.status}).toEqual({label, status: 500});
      // eslint-disable-next-line no-await-in-loop
      await response.arrayBuffer();
    }
    expect({
      actions: await readInstallationActions(),
      keys: await readList("/api/v1/api-keys", apiKeyListSchema),
      members: await readList("/api/v1/members", memberListSchema),
      projects: await readList("/api/v1/projects", projectListSchema),
    }).toEqual(installationBaseline);
    const stillValid = await send(keptReader, "GET", "/api/v1/projects");
    expect(stillValid.status).toBe(200);
    await stillValid.arrayBuffer();

    acceptInstallationActionRecords();
    const readmitted = await send(human, "POST", "/api/v1/members", {
      body: {displayName: "Kept member", email: auditedMemberEmail},
    });
    expect(readmitted.status).toBe(409);
    await readmitted.arrayBuffer();
    // Each change runs twice in a row; only the first is recorded.
    for (const routePath of [
      `/api/v1/projects/${archived.id}/archive`,
      `/api/v1/projects/${archived.id}/archive`,
      `/api/v1/members/${member.id}/deactivate`,
      `/api/v1/members/${member.id}/deactivate`,
      `/api/v1/api-keys/${keptKey.apiKey.id}/revoke`,
      `/api/v1/api-keys/${keptKey.apiKey.id}/revoke`,
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const response = await send(human, "POST", routePath);
      expect({routePath, status: response.status}).toEqual({routePath, status: 200});
      // eslint-disable-next-line no-await-in-loop
      await response.arrayBuffer();
    }
    const afterReplays = await readInstallationActions();
    expect(afterReplays.slice(afterReplays.length - installationBaseline.actions.length))
      .toEqual(installationBaseline.actions);
    expect(summarizeActions(afterReplays.slice(
      0,
      afterReplays.length - installationBaseline.actions.length,
    ))).toEqual(sortedSummaries([
      {kind: "member_deactivated", subjectId: member.id},
      {kind: "api_key_revoked", subjectId: keptKey.apiKey.id},
    ].map(({kind, subjectId}) => ({
      authorizedByPrincipalId: null,
      kind,
      principalDisplayName: "Local administrator",
      principalId: human.principalId,
      subjectId,
    }))));
  });

  async function readInstallationActions(): Promise<readonly InstallationAction[]> {
    const response = await send(human, "GET", "/api/v1/administration/actions?limit=100");
    return (await expectJson(response, 200, installationActionPageSchema)).actions;
  }

  async function readList<T>(routePath: string, schema: z.ZodType<T>): Promise<T> {
    return expectJson(await send(human, "GET", routePath), 200, schema);
  }

  async function issueKey(
    capabilities: readonly string[],
    name: string,
  ): Promise<IssuedKey> {
    return expectJson(await send(human, "POST", "/api/v1/api-keys", {
      body: {capabilities, expiresAt: "2099-01-01T00:00:00.000Z", name},
    }), 201, issuedKeySchema);
  }

  async function performEveryMutation(
    actor: Actor,
    prefix: string,
  ): Promise<PublishResponse> {
    const published = await publish(actor, `${prefix}-publish`, {
      accessSetting: "account_required",
      content: "<p>first</p>",
      kind: "new_artifact",
      name: `${prefix} artifact`,
    });
    const second = await publish(actor, `${prefix}-version`, {
      artifactId: published.artifact.id,
      content: "<p>second</p>",
      expectedCurrentVersionId: published.version.id,
      kind: "new_version",
    });
    const edited = await publish(actor, `${prefix}-edit`, {
      artifactId: published.artifact.id,
      baseVersionId: second.version.id,
      content: "<p>edited</p>",
      expectedCurrentVersionId: second.version.id,
      kind: "edit",
      path: "index.html",
    });
    let current = edited.version.id;
    await expectJson(await send(actor, "POST", scoped(published, "/restore"), {
      body: {expectedCurrentVersionId: current, versionId: published.version.id},
      key: `${prefix}-restore`,
    }), 200, anyJson);
    current = published.version.id;
    await expectJson(await send(actor, "PATCH", scoped(published, "/access"), {
      body: {accessSetting: "public_link", expectedCurrentVersionId: current},
      key: `${prefix}-access`,
    }), 200, anyJson);
    await expectJson(await send(actor, "PATCH", scoped(published, "/tags"), {
      body: {expectedCurrentVersionId: current, tags: ["audited"]},
      key: `${prefix}-tags`,
    }), 200, anyJson);
    await expectJson(await send(actor, "PATCH", scoped(published, "/name"), {
      body: {expectedCurrentVersionId: current, name: `${prefix} renamed`},
      key: `${prefix}-rename`,
    }), 200, anyJson);

    const {thread} = await expectJson(
      await send(actor, "POST", scoped(published, `/versions/${current}/comments`), {
        body: {body: "The chart axis is wrong."},
        key: `${prefix}-thread`,
      }), 201, threadCreationSchema);
    const {reply} = await expectJson(
      await send(actor, "POST", scoped(published, `/comments/${thread.id}/replies`), {
        body: {body: "Fixed."},
        key: `${prefix}-reply`,
      }), 201, replyCreationSchema);
    await expectJson(await send(actor, "PATCH", scoped(published, `/comments/${thread.id}`), {
      body: {body: "The chart axis label is wrong."},
    }), 200, anyJson);
    await expectJson(await send(actor, "PATCH", scoped(published, `/comments/${thread.id}`), {
      body: {state: "resolved"},
    }), 200, anyJson);
    await expectJson(await send(actor, "PATCH", scoped(published, `/comments/${thread.id}`), {
      body: {state: "open"},
    }), 200, anyJson);
    await expectEmpty(await send(
      actor,
      "DELETE",
      scoped(published, `/comments/${thread.id}/replies/${reply.id}`),
    ));
    await expectEmpty(await send(actor, "DELETE", scoped(published, `/comments/${thread.id}`)));

    const assetPlan = await planAssetUpload(actor, published);
    const added = await expectJson(
      await commitAssetUpload(actor, assetPlan, `${prefix}-asset`),
      201,
      committedAssetSchema,
    );
    const replayed = await expectJson(
      await commitAssetUpload(actor, assetPlan, `${prefix}-asset`),
      200,
      committedAssetSchema,
    );
    expect(replayed).toEqual({asset: added.asset, replayed: true});
    await expectJson(await send(actor, "POST", scoped(published, "/assets/copies"), {
      body: {sourceArtifactId: published.artifact.id, sourceAssetId: added.asset.id},
      key: `${prefix}-asset-copy`,
    }), 201, committedAssetSchema);
    const deleteAsset = () =>
      send(actor, "DELETE", scoped(published, `/assets/${added.asset.id}`));
    await expectJson(await deleteAsset(), 200, anyJson);
    const repeated = await deleteAsset();
    expect(repeated.status).toBe(404);
    await repeated.arrayBuffer();

    await expectJson(await send(actor, "DELETE", scoped(published, ""), {
      body: {expectedCurrentVersionId: current},
      key: `${prefix}-delete`,
    }), 200, anyJson);
    return published;
  }

  async function publish(
    actor: Actor,
    idempotencyKey: string,
    target: PublishTarget,
    status = 201,
  ): Promise<PublishResponse> {
    const response = await commitPublish(actor, idempotencyKey, target);
    const body = await response.text();
    expect({body, status: response.status}).toMatchObject({status});
    return parsePublishResponse(JSON.parse(body));
  }

  async function commitPublish(
    actor: Actor,
    idempotencyKey: string,
    {content, ...target}: PublishTarget,
  ): Promise<Response> {
    const bytes = new TextEncoder().encode(content);
    const plan = await expectJson(
      await send(actor, "POST", "/api/v1/uploads", {
        body: {
          entryPath: "index.html",
          files: [{
            mediaType: "text/html; charset=utf-8",
            path: "index.html",
            sha256: createHash("sha256").update(bytes).digest("hex"),
            size: bytes.byteLength,
          }],
          routingMode: "static",
        },
      }), 201, uploadPlanSchema);
    for (const file of plan.files) {
      // One file per plan; the upload must finish before the commit.
      // eslint-disable-next-line no-await-in-loop
      const uploaded = await fetch(file.uploadUrl, {
        body: bytes,
        headers: actor.headers(),
        method: "PUT",
      });
      expect(uploaded.status).toBe(200);
      // eslint-disable-next-line no-await-in-loop
      await uploaded.arrayBuffer();
    }
    return fetch(plan.commitUrl, {
      body: JSON.stringify({target}),
      headers: actor.headers(idempotencyKey),
      method: "POST",
    });
  }

  async function planAssetUpload(
    actor: Actor,
    published: PublishResponse,
  ): Promise<z.infer<typeof assetPlanSchema>> {
    const plan = await expectJson(
      await send(actor, "POST", scoped(published, "/assets/uploads"), {
        body: {
          mediaType: "image/png",
          name: "chart.png",
          sha256: createHash("sha256").update(assetBytes).digest("hex"),
          size: assetBytes.byteLength,
        },
      }), 201, assetPlanSchema);
    const uploaded = await fetch(plan.file.uploadUrl, {
      body: assetBytes,
      headers: actor.headers(),
      method: "PUT",
    });
    expect(uploaded.status).toBe(200);
    await uploaded.arrayBuffer();
    return plan;
  }

  async function addAsset(
    actor: Actor,
    published: PublishResponse,
    idempotencyKey: string,
  ): Promise<string> {
    const plan = await planAssetUpload(actor, published);
    return (await expectJson(
      await commitAssetUpload(actor, plan, idempotencyKey),
      201,
      committedAssetSchema,
    )).asset.id;
  }

  async function readAssetIds(published: PublishResponse): Promise<readonly string[]> {
    const response = await send(human, "GET", scoped(published, "/assets"));
    return (await expectJson(response, 200, assetListingSchema)).assets
      .map((asset) => asset.id);
  }

  async function readActions(published: PublishResponse): Promise<readonly ActionRecord[]> {
    const response = await send(human, "GET", `${scoped(published, "/actions")}&limit=100`);
    return (await expectJson(response, 200, actionPageSchema)).actions;
  }

  async function readArtifact(
    published: PublishResponse,
  ): Promise<z.infer<typeof artifactStateSchema>["artifact"]> {
    const response = await send(human, "GET", scoped(published, ""));
    return (await expectJson(response, 200, artifactStateSchema)).artifact;
  }

  function send(
    actor: Actor,
    method: string,
    routePath: string,
    options: {
      readonly body?: unknown;
      readonly headers?: Record<string, string>;
      readonly key?: string;
    } = {},
  ): Promise<Response> {
    const headers = actor.headers(options.key);
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      headers.set(name, value);
    }
    return fetch(`${server.baseUrl}${routePath}`, options.body === undefined
      ? {headers, method}
      : {body: JSON.stringify(options.body), headers, method});
  }

  function refuseActionRecords(): void {
    withInstallationDatabase((database) => {
      database.exec(
        `CREATE TRIGGER action_ledger_outage
         BEFORE INSERT ON actions
         BEGIN
           SELECT RAISE(ABORT, 'the action ledger refused the write');
         END;`,
      );
    });
  }

  function refuseInstallationActionRecords(): void {
    withInstallationDatabase((database) => {
      database.exec(
        `CREATE TRIGGER installation_action_outage
         BEFORE INSERT ON installation_actions
         BEGIN
           SELECT RAISE(ABORT, 'the installation action history refused the write');
         END;`,
      );
    });
  }

  function acceptInstallationActionRecords(): void {
    withInstallationDatabase((database) => {
      database.exec("DROP TRIGGER installation_action_outage;");
    });
  }

  function acceptActionRecords(): void {
    withInstallationDatabase((database) => {
      database.exec("DROP TRIGGER action_ledger_outage;");
    });
  }

  function countArtifacts(): number {
    let count = -1;
    withInstallationDatabase((database) => {
      count = z.object({count: z.number()}).parse(
        database.prepare("SELECT count(*) AS count FROM artifacts").get(),
      ).count;
    });
    return count;
  }

  function withInstallationDatabase(operation: (database: DatabaseSync) => void): void {
    const database = new DatabaseSync(
      path.join(installation.dataDirectory, "artifact-server.db"),
      {timeout: 5_000},
    );
    try {
      operation(database);
    } finally {
      database.close();
    }
  }
});

type PublishTarget =
  | {
    readonly accessSetting: "account_required" | "public_link";
    readonly content: string;
    readonly kind: "new_artifact";
    readonly name: string;
  }
  | {
    readonly artifactId: string;
    readonly content: string;
    readonly expectedCurrentVersionId: string;
    readonly kind: "new_version";
  }
  | {
    readonly artifactId: string;
    readonly baseVersionId: string;
    readonly content: string;
    readonly expectedCurrentVersionId: string;
    readonly kind: "edit";
    readonly path: string;
  };

const auditedMemberEmail = "audited-member@example.test";

function bearerActor(key: IssuedKey, authorizedByPrincipalId: string): Actor {
  return {
    authorizedByPrincipalId,
    headers: (idempotencyKey?: string) => {
      const headers = new Headers({
        Authorization: `Bearer ${key.token}`,
        "Content-Type": "application/json",
      });
      if (idempotencyKey !== undefined) headers.set("Idempotency-Key", idempotencyKey);
      return headers;
    },
    principalId: key.apiKey.principalId,
  };
}

type ActionSummary = Omit<InstallationAction, "createdAt" | "id">;

function summarizeActions(actions: readonly ActionSummary[]): readonly ActionSummary[] {
  return sortedSummaries(actions.map((action) => ({
    authorizedByPrincipalId: action.authorizedByPrincipalId,
    kind: action.kind,
    principalDisplayName: action.principalDisplayName,
    principalId: action.principalId,
    subjectId: action.subjectId,
  })));
}

// Actions written in the same millisecond have no defined order, so
// comparisons sort by what each action changed.
function sortedSummaries(actions: readonly ActionSummary[]): readonly ActionSummary[] {
  return actions.toSorted((left, right) =>
    `${left.kind}:${left.subjectId}`.localeCompare(`${right.kind}:${right.subjectId}`)
  );
}

function commitAssetUpload(
  actor: Actor,
  plan: z.infer<typeof assetPlanSchema>,
  idempotencyKey: string,
): Promise<Response> {
  return fetch(plan.commitUrl, {
    body: JSON.stringify({uploadId: plan.uploadId}),
    headers: actor.headers(idempotencyKey),
    method: "POST",
  });
}

function scoped(published: PublishResponse, suffix: string): string {
  return `/api/v1/artifacts/${published.artifact.id}${suffix}?projectId=${published.artifact.projectId}`;
}

async function expectJson<T>(
  response: Response,
  status: number,
  schema: z.ZodType<T>,
): Promise<T> {
  const body: unknown = await response.json();
  expect({body, status: response.status}).toMatchObject({status});
  return schema.parse(body);
}

async function expectEmpty(response: Response): Promise<void> {
  expect(response.status).toBe(204);
  await response.arrayBuffer();
}
