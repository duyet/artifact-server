import {describe, expect, test} from "vitest";

import {
  artifactBrowserUrl,
  contentBootstrapBrowserUrl,
  previewLeaseBrowserUrl,
  versionBrowserUrl,
  versionFileBrowserUrl,
} from "../../src/http/artifact-http-links.js";
import {
  artifactFolder,
  parseArtifactFolder,
} from "../../src/http/same-host-content.js";

const uuid = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const artifactId = `art_${uuid}`;
// Low entropy on purpose: secret scanners flag a random-looking literal named token.
const token = "ab12".repeat(9);
const leaseToken = `review-${"ab".repeat(28)}`;
const applicationUrl = new URL(
  "https://artifacts.example.internal:8443/review?artifact=x#frag",
);

describe("link builders with a content domain", () => {
  test("keep the upstream content-host URL shape", () => {
    expect(versionBrowserUrl(applicationUrl, "content.example.test", token))
      .toBe(`https://${token}.content.example.test:8443/`);
    expect(
      versionFileBrowserUrl(
        applicationUrl,
        "content.example.test",
        token,
        "assets/a b/é.css",
      ),
    ).toBe(
      `https://${token}.content.example.test:8443/assets/a%20b/%C3%A9.css`,
    );
    expect(
      previewLeaseBrowserUrl(applicationUrl, "content.example.test", leaseToken),
    ).toBe(`https://${leaseToken}.content.example.test:8443/`);
    expect(
      contentBootstrapBrowserUrl(
        applicationUrl,
        "content.example.test",
        token,
        "boot",
        "docs/index.html",
      ),
    ).toBe(
      `https://${token}.content.example.test:8443/docs/index.html?__artifact_bootstrap=boot`,
    );
  });

  test("link the artifact through its stable id route", () => {
    expect(
      artifactBrowserUrl(applicationUrl, "content.example.test", {
        id: artifactId,
        name: "Q3 cost report (SG)",
      }),
    ).toBe(`https://artifacts.example.internal:8443/artifacts/${artifactId}`);
  });
});

describe("link builders in path mode", () => {
  test("put version, file, and lease URLs under /v/ on the application origin", () => {
    expect(versionBrowserUrl(applicationUrl, null, token))
      .toBe(`https://artifacts.example.internal:8443/v/${token}/`);
    expect(
      versionFileBrowserUrl(applicationUrl, null, token, "assets/a b/é.css"),
    ).toBe(
      `https://artifacts.example.internal:8443/v/${token}/assets/a%20b/%C3%A9.css`,
    );
    expect(previewLeaseBrowserUrl(applicationUrl, null, leaseToken))
      .toBe(`https://artifacts.example.internal:8443/v/${leaseToken}/`);
  });

  test("link the artifact through its folder", () => {
    expect(
      artifactBrowserUrl(applicationUrl, null, {
        id: artifactId,
        name: "Q3 cost report (SG)",
      }),
    ).toBe(
      `https://artifacts.example.internal:8443/q3-cost-report-sg-${uuid}/`,
    );
  });

  test("fall back to the id route when the id is not art_<uuid>", () => {
    expect(
      artifactBrowserUrl(applicationUrl, null, {id: "artifact-1", name: "Q3"}),
    ).toBe("https://artifacts.example.internal:8443/artifacts/artifact-1");
  });
});

describe("artifact folders", () => {
  test("fold an ASCII name into a lowercase slug", () => {
    expect(artifactFolder({id: artifactId, name: "Q3 cost report (SG)"}))
      .toBe(`q3-cost-report-sg-${uuid}`);
  });

  test("strip diacritics instead of dropping the letter", () => {
    expect(artifactFolder({id: artifactId, name: "Báo cáo chi phí Q3"}))
      .toBe(`bao-cao-chi-phi-q3-${uuid}`);
    expect(artifactFolder({id: artifactId, name: "Đường dây nóng"}))
      .toBe(`duong-day-nong-${uuid}`);
  });

  test("leave the bare uuid when the name has no ASCII letters or digits", () => {
    expect(artifactFolder({id: artifactId, name: "成本报告"})).toBe(uuid);
    expect(artifactFolder({id: artifactId, name: "  --  "})).toBe(uuid);
  });

  test("cut a long name at 60 characters and drop a dangling hyphen", () => {
    const name = `${"x".repeat(59)} ${"y".repeat(140)}`;
    expect(name).toHaveLength(200);
    expect(artifactFolder({id: artifactId, name}))
      .toBe(`${"x".repeat(59)}-${uuid}`);

    const words = artifactFolder({id: artifactId, name: "cost report ".repeat(17)});
    const slug = words?.slice(0, -(uuid.length + 1)) ?? "";
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith("-")).toBe(false);
  });

  test("refuse to invent a folder for an id that is not art_<lowercase uuid>", () => {
    expect(artifactFolder({id: "artifact-1", name: "Q3"})).toBeNull();
    expect(artifactFolder({id: `art_${uuid.toUpperCase()}`, name: "Q3"}))
      .toBeNull();
    expect(artifactFolder({id: uuid, name: "Q3"})).toBeNull();
  });

  test("parse a folder back to the artifact id it came from", () => {
    const artifact = {id: artifactId, name: "Báo cáo chi phí Q3"};
    const folder = artifactFolder(artifact);
    expect(folder).not.toBeNull();
    expect(parseArtifactFolder(folder ?? "")).toEqual({artifactId, folder});
    expect(parseArtifactFolder(uuid)).toEqual({artifactId, folder: uuid});
  });

  test("reject segments that are not folders", () => {
    const segments = [
      "v",
      "health",
      "artifacts",
      `Q3-${uuid}`,
      `-${uuid}`,
      `q3--${uuid}`,
      `q3-${uuid.toUpperCase()}`,
      `q3-${uuid}-extra`,
      `q3${uuid}`,
    ];
    expect(segments.filter((segment) => parseArtifactFolder(segment) !== null))
      .toEqual([]);
  });
});
