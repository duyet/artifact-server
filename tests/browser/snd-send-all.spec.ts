import {expect, test, type Browser} from "@playwright/test";

import {
  ApiClient,
  dispatchEnvelopeSchema,
  dispatchPageSchema,
  issueApiKey,
  MutableClock,
  signInAdministrator,
} from "../support/agent-dispatch.js";
import {publishNew, publishVersion} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
} from "../support/runtime-harness.js";
import {
  artifactPreview,
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
  type BrowserFixture,
} from "./browser-fixture.js";
import {createThreadOverApi} from "./comment-api.js";

const fixtureHtml = "<!doctype html><html lang=\"en\"><head><title>Send all fixture</title></head>"
  + "<body><main><p id=\"target\">Review target</p></main></body></html>";

type SendFixture = BrowserFixture & {readonly clock: MutableClock};

async function startSendFixture(browser: Browser): Promise<SendFixture> {
  const installation = await createTestInstallation();
  const clock = new MutableClock();
  const server = await startTestServer(installation, {clock});
  const context = await browser.newContext();
  const page = await context.newPage();
  return {clock, context, installation, page, server};
}

async function stopSendFixture(fixture: SendFixture): Promise<void> {
  await fixture.context.close();
  await fixture.server.stop();
  await removeTestInstallation(fixture.installation);
}

async function connectAgent(
  fixture: BrowserFixture,
  input: {
    readonly evidence?: "channel" | "mailbox" | "native";
    readonly key: string;
    readonly name: string;
  },
): Promise<{readonly agentId: string; readonly client: ApiClient}> {
  const cookies = await signInAdministrator(fixture.server, fixture.installation);
  const token = await issueApiKey(
    fixture.server,
    cookies,
    ["agent:connect"],
    `${input.name} key`,
  );
  const client = new ApiClient(fixture.server, token);
  const registration = {
    agentSessionId: `session-${input.name}`,
    connectionKey: input.key,
    displayName: input.name,
    workingDirectory: `/work/${input.name}`,
  };
  const agent = await client.registerAgent(input.evidence === undefined
    ? registration
    : {
      ...registration,
      capabilities: {beacon: false, evidence: input.evidence},
    });
  return {agentId: agent.id, client};
}

test.describe("Review send-all", () => {
  test("SND-001-B SND-001-F: every comment page feeds one exact send-all action and sent-state recovery", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = (await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: fixtureHtml,
        idempotencyKey: "snd-001-page-publish",
        mediaType: "text/html; charset=utf-8",
        name: "Send all fixture",
        path: "index.html",
      })).body;
      const seeded = await Promise.all(Array.from({length: 101}, async (_, index) => {
        const thread = {
          artifactId: published.artifact.id,
          body: `Send-all comment ${String(index + 1).padStart(3, "0")}`,
          idempotencyKey: `snd-001-thread-${index}`,
          path: "index.html",
          versionId: published.version.id,
        };
        return createThreadOverApi(fixture, index === 0
          ? {
            ...thread,
            anchor: {
              htmlAnchor: {
                point: {x: 0.5, y: 0.5},
                selector: "#target",
                tagName: "P",
                text: "Review target",
              },
              originalText: "Review target",
            },
          }
          : thread);
      }));
      const agent = await connectAgent(fixture, {
        key: "snd-001-agent",
        name: "builder",
      });

      await localLogin(fixture);
      const page = fixture.page;
      await page.goto(
        `${fixture.server.baseUrl}/review?project=prj_default&artifact=${published.artifact.id}&version=${published.version.id}`,
      );
      await page.getByRole("tab", {name: "Comments"}).click();
      await expect(page.getByRole("button", {
        name: "Send all open (101) to builder",
      })).toBeVisible();
      await expect(page.getByRole("article")).toHaveCount(101);
      const preview = artifactPreview(page);
      await expect(preview.locator("button[data-plannotator-marker]")).toHaveCount(1);

      await page.getByRole("button", {name: "Send all open (101) to builder"}).click();
      await expect(page.getByText("Sent 101 threads to builder")).toBeVisible();
      await expect(page.getByRole("article")).toHaveCount(0);
      await expect(preview.locator("button[data-plannotator-marker]")).toHaveCount(0);

      const owner = new ApiClient(fixture.server, fixture.installation.apiToken);
      const dispatches = dispatchPageSchema.parse(
        await (await owner.listDispatches("prj_default")).json(),
      ).items;
      expect(dispatches).toHaveLength(2);
      expect(dispatches.flatMap((dispatch) => dispatch.threadIds)).toHaveLength(101);

      await page.getByRole("button", {name: "Sent (101)"}).click();
      await expect(page.getByRole("article")).toHaveCount(101);
      await expect(page.getByText("Queued", {exact: true})).toHaveCount(101);

      const claimedResponse = await agent.client.claim(agent.agentId, 1);
      expect(claimedResponse.status).toBe(200);
      const claimed = dispatchEnvelopeSchema.parse(await claimedResponse.json()).dispatch;
      expect((await agent.client.reportDelivered(claimed.id, agent.agentId)).status)
        .toBe(200);
      await Promise.all(claimed.threadIds.map((threadId) =>
        owner.setThreadState(published, threadId, "resolved")
      ));
      await page.getByRole("button", {name: "Reload"}).click();
      await expect(page.getByText("Addressed", {exact: true})).toHaveCount(
        claimed.threadIds.length,
      );

      const queued = dispatches.find((dispatch) => dispatch.id !== claimed.id);
      if (queued === undefined) throw new Error("The second dispatch is missing.");
      const queuedThreadId = queued.threadIds[0];
      const queuedThread = seeded.find((thread) => thread.id === queuedThreadId);
      if (queuedThread === undefined) throw new Error("The queued thread is missing.");
      const queuedCard = page.getByRole("article").filter({
        hasText: queuedThread.body,
      });
      await queuedCard.getByRole("button", {name: "Cancel send"}).click();
      await page.getByRole("button", {exact: true, name: "Open"}).click();
      await expect(page.getByRole("article")).toHaveCount(1);
      await expect(page.getByText(queuedThread.body)).toBeVisible();
      await expect(page.getByRole("button", {
        name: "Send all open (1) to builder",
      })).toBeVisible();
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("SND-001-F: a slow Sent load for one version never lands under the version the reader switched to", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const first = (await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: fixtureHtml,
        idempotencyKey: "snd-001-stale-v1",
        mediaType: "text/html; charset=utf-8",
        name: "Stale sent fixture",
        path: "index.html",
      })).body;
      const second = (await publishVersion(fixture.server, fixture.installation, {
        artifactId: first.artifact.id,
        content: fixtureHtml.replace("Review target", "Second target"),
        expectedCurrentVersionId: first.version.id,
        idempotencyKey: "snd-001-stale-v2",
        mediaType: "text/html; charset=utf-8",
        path: "index.html",
      })).body;
      const seed = (versionId: string, body: string) => createThreadOverApi(fixture, {
        artifactId: first.artifact.id,
        body,
        idempotencyKey: `snd-001-stale-${body}`,
        path: "index.html",
        versionId,
      });
      const firstThreads = [
        await seed(first.version.id, "first-version-one"),
        await seed(first.version.id, "first-version-two"),
      ];
      const secondThread = await seed(second.version.id, "second-version-one");
      const agent = await connectAgent(fixture, {key: "snd-001-stale-agent", name: "builder"});
      const owner = new ApiClient(fixture.server, fixture.installation.apiToken);
      const sends = await Promise.all([
        firstThreads.map((thread) => thread.id),
        [secondThread.id],
      ].map((threadIds, index) => owner.sendDispatch({
        agentId: agent.agentId,
        idempotencyKey: `snd-001-stale-send-${index}`,
        projectId: "prj_default",
        threadIds,
      })));
      expect(sends.map((sent) => sent.ok)).toEqual([true, true]);

      await localLogin(fixture);
      const page = fixture.page;
      const isFirstSentListing = (url: URL) =>
        url.pathname === `/api/v1/artifacts/${first.artifact.id}/comments`
        && url.searchParams.get("dispatched") === "only"
        && url.searchParams.get("versionId") === first.version.id;
      const firstRelease = Promise.withResolvers<void>();
      await page.route(isFirstSentListing, async (route) => {
        await firstRelease.promise;
        await route.continue();
      });
      await page.goto(
        `${fixture.server.baseUrl}/review?project=prj_default&artifact=${first.artifact.id}&version=${first.version.id}`,
      );
      await page.getByRole("tab", {name: "Comments"}).click();
      await expect(page.getByRole("button", {name: "Sent (0)"})).toBeVisible();

      // The top bar switches versions while the comments stay open.
      await page.getByRole("button", {name: "Next version"}).click();
      await expect(page.getByRole("button", {name: "Sent (1)"})).toBeVisible();

      const lateListing = page.waitForResponse((response) =>
        isFirstSentListing(new URL(response.url()))
      );
      firstRelease.resolve();
      await lateListing;
      await page.waitForLoadState("networkidle");
      await expect(page.getByRole("button", {name: "Sent (1)"})).toBeVisible();
      await page.getByRole("button", {name: "Sent (1)"}).click();
      await expect(page.getByRole("article")).toHaveCount(1);
      await expect(page.getByText("second-version-one")).toBeVisible();
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("SND-002-B SND-002-F: destination defaults and mailbox copy follow real presence without fallback", async ({browser}) => {
    const fixture = await startSendFixture(browser);
    try {
      const published = (await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: fixtureHtml,
        idempotencyKey: "snd-002-page-publish",
        mediaType: "text/html; charset=utf-8",
        name: "Tier-aware send fixture",
        path: "index.html",
      })).body;
      const first = await createThreadOverApi(fixture, {
        artifactId: published.artifact.id,
        body: "First tier-aware comment",
        idempotencyKey: "snd-002-first-thread",
        path: "index.html",
        versionId: published.version.id,
      });
      await localLogin(fixture);
      const page = fixture.page;
      await page.goto(
        `${fixture.server.baseUrl}/review?project=prj_default&artifact=${published.artifact.id}&version=${published.version.id}`,
      );
      await page.getByRole("tab", {name: "Comments"}).click();
      await expect(page.getByText("No agent connected — connect one to send."))
        .toBeVisible();

      await connectAgent(fixture, {
        evidence: "native",
        key: "snd-002-live",
        name: "live",
      });
      await connectAgent(fixture, {
        evidence: "mailbox",
        key: "snd-002-mailbox",
        name: "mailbox",
      });
      await expect(page.getByRole("button", {name: "Send all open (1)…"}))
        .toBeDisabled();
      await page.getByRole("button", {
        name: "Choose agent or send with a note",
      }).first().click();
      await page.getByRole("button", {name: "mailbox /work/mailbox"}).click();
      await expect(page.getByText(
        "Queued for mailbox — it picks this up when it next checks in.",
      )).toBeVisible();

      await createThreadOverApi(fixture, {
        artifactId: published.artifact.id,
        body: "Second tier-aware comment",
        idempotencyKey: "snd-002-second-thread",
        path: "index.html",
        versionId: published.version.id,
      });
      await page.getByRole("button", {name: "Reload"}).click();
      await expect(page.getByRole("button", {
        name: "Send all open (1) to mailbox",
      })).toBeVisible();
      const rememberedDestination = () => page.evaluate(() =>
        Object.entries(window.localStorage).find(([key]) =>
          key.startsWith("dispatch-default:")
        )?.[1] ?? null
      );
      await expect.poll(rememberedDestination).toContain('"displayName":"mailbox"');

      // A stale heartbeat leaves the remembered row present but disconnected.
      // A newly registered peer stays live, so silent fall-through would be
      // observable if the control chose it.
      fixture.clock.advance(100_000);
      const replacement = await connectAgent(fixture, {
        evidence: "native",
        key: "snd-002-replacement",
        name: "replacement",
      });
      await expect(page.getByText("mailbox disconnected — pick another"))
        .toBeVisible({timeout: 20_000});
      const owner = new ApiClient(fixture.server, fixture.installation.apiToken);
      const before = dispatchPageSchema.parse(
        await (await owner.listDispatches("prj_default")).json(),
      ).items.length;
      await expect(page.getByRole("button", {
        name: "Send all open (1) to mailbox",
      })).toBeDisabled();
      expect(dispatchPageSchema.parse(
        await (await owner.listDispatches("prj_default")).json(),
      ).items).toHaveLength(before);

      await page.getByRole("button", {
        name: "Choose agent or send with a note",
      }).first().click();
      await page.getByRole("button", {name: "replacement /work/replacement"}).click();
      await expect(page.getByText("Sent 1 thread to replacement")).toBeVisible();

      // A clean disconnect deletes the registration. The dead id is not a
      // disconnected default: it is forgotten, so the same bridge name under
      // its new id becomes the ordinary one-connected-agent path.
      await createThreadOverApi(fixture, {
        artifactId: published.artifact.id,
        body: "Third tier-aware comment",
        idempotencyKey: "snd-002-third-thread",
        path: "index.html",
        versionId: published.version.id,
      });
      await page.getByRole("button", {name: "Reload"}).click();
      await expect(page.getByRole("button", {
        name: "Send all open (1) to replacement",
      })).toBeEnabled();
      expect((await replacement.client.fetch(
        `/api/v1/agents/${replacement.agentId}/disconnect`,
        {method: "POST"},
      )).status).toBe(204);
      const restarted = await connectAgent(fixture, {
        evidence: "native",
        key: "snd-002-restarted",
        name: "replacement",
      });
      expect(restarted.agentId).not.toBe(replacement.agentId);
      await expect(page.getByText("replacement disconnected — pick another"))
        .toHaveCount(0, {timeout: 20_000});
      await expect(page.getByRole("button", {
        name: "Send all open (1) to replacement",
      })).toBeEnabled();
      await expect.poll(rememberedDestination).toBeNull();
      expect(first.id).toMatch(/^cmt_/u);
      expect(restarted.agentId).toMatch(/^agt_/u);
    } finally {
      await stopSendFixture(fixture);
    }
  });
});
