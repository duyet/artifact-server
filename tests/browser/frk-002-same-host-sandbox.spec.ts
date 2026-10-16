import {expect, test} from "@playwright/test";

import {
  commitStagedUpload,
  createStagedUpload,
  uploadEveryStagedFile,
  type TestSiteFile,
} from "../support/publishing.js";
import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
} from "./browser-fixture.js";

const probeIds = [
  "origin",
  "cookie",
  "storage",
  "read",
  "write",
  "worker",
] as const;

const hostileArtifact = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Same-host sandbox probe</title></head>
  <body>
${probeIds.map((id) => `    <p id="probe-${id}">${id}:pending</p>`).join("\n")}
    <script>
      (function () {
        var report = function (id, value) {
          document.getElementById("probe-" + id).textContent = id + ":" + value;
        };
        report("origin", String(window.origin));
        try {
          report("cookie", "readable:[" + document.cookie + "]");
        } catch (error) {
          report("cookie", "blocked");
        }
        try {
          window.localStorage.setItem("probe", "1");
          report("storage", "writable");
        } catch (error) {
          report("storage", "blocked");
        }
        try {
          fetch("/api/v1/session", {credentials: "include"}).then(
            function (response) {
              report("read", "reached:" + response.status);
            },
            function () {
              report("read", "blocked");
            }
          );
        } catch (error) {
          report("read", "blocked");
        }
        try {
          fetch("/api/v1/session/logout", {
            credentials: "include",
            method: "POST"
          }).then(
            function (response) {
              report("write", "reached:" + response.status);
            },
            function () {
              report("write", "blocked");
            }
          );
        } catch (error) {
          report("write", "blocked");
        }
        try {
          navigator.serviceWorker.register("sw.js").then(
            function (registration) {
              report("worker", "registered:" + registration.scope);
            },
            function () {
              report("worker", "blocked");
            }
          );
        } catch (error) {
          report("worker", "blocked");
        }
      })();
    </script>
  </body>
</html>`;

const files: readonly TestSiteFile[] = [
  {
    bytes: new TextEncoder().encode(hostileArtifact),
    mediaType: "text/html; charset=utf-8",
    path: "index.html",
  },
  {
    // A valid worker script, so a blocked registration is the sandbox's doing and not a 404's.
    bytes: new TextEncoder().encode("self.addEventListener('fetch', () => {});"),
    mediaType: "text/javascript; charset=utf-8",
    path: "sw.js",
  },
];

test.describe("Same-host content sandbox", () => {
  test("FRK-002-F: hostile artifact JavaScript opened at top level cannot use the application session", async ({browser}) => {
    const fixture = await startBrowserFixture(browser, {contentDomain: null});
    try {
      const planned = await createStagedUpload(
        fixture.server,
        fixture.installation,
        "index.html",
        files,
      );
      const uploads = await uploadEveryStagedFile(
        fixture.installation,
        planned.body,
        files,
      );
      expect(uploads.map((upload) => upload.status)).toEqual([200, 200]);
      const published = await commitStagedUpload(
        fixture.installation,
        planned.body,
        "frk-002-same-host-sandbox",
        {
          accessSetting: "public_link",
          kind: "new_artifact",
          name: "Same-host sandbox probe",
        },
      );
      await localLogin(fixture);
      const signedIn = await fixture.context.request.get(
        `${fixture.server.baseUrl}/api/v1/session`,
      );
      expect(signedIn.status()).toBe(200);

      await fixture.page.goto(published.body.links.version);
      expect(new URL(fixture.page.url()).pathname).toBe(
        `/v/${published.body.version.contentToken}/`,
      );

      await expect(fixture.page.locator("#probe-origin")).toHaveText("origin:null");
      await expect(fixture.page.locator("#probe-cookie")).toHaveText("cookie:blocked");
      await expect(fixture.page.locator("#probe-storage")).toHaveText("storage:blocked");
      await expect(fixture.page.locator("#probe-read")).toHaveText("read:blocked");
      await expect(fixture.page.locator("#probe-write")).toHaveText("write:blocked");
      await expect(fixture.page.locator("#probe-worker")).toHaveText("worker:blocked");

      const stillSignedIn = await fixture.context.request.get(
        `${fixture.server.baseUrl}/api/v1/session`,
      );
      expect(stillSignedIn.status()).toBe(200);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
