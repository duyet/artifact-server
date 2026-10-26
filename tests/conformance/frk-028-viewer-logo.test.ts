import {spawn, type ChildProcessWithoutNullStreams} from "node:child_process";
import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {Effect} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {initializeCompactInstallation} from "../../src/lifecycle/compact-installation.js";
import {
  parseCompactRuntimeConfiguration,
  parseExternalStorageRuntimeConfiguration,
  summarizeRuntimeConfiguration,
} from "../../src/lifecycle/runtime-configuration.js";
import type {ViewerLogo} from "../../src/core/viewer-logo.js";
import {
  createTestInstallation,
  removeTestInstallation,
  reserveLoopbackPort,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const testSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" rx="4"/></svg>';
const testPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const externalEnvironment: NodeJS.ProcessEnv = {
  ARTIFACT_SERVER_API_TOKEN:
    `as_key_key_00000000-0000-4000-8000-000000000000_${"a".repeat(40)}`,
  ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: "admin@example.test",
  ARTIFACT_SERVER_DATABASE_URL: "postgres://user:secret@localhost/artifacts",
  ARTIFACT_SERVER_INSTALLATION_ID: "test-installation",
  ARTIFACT_SERVER_ORIGIN: "https://artifacts.example.com",
  ARTIFACT_SERVER_S3_ACCESS_KEY_ID: "access-key",
  ARTIFACT_SERVER_S3_BUCKET: "artifact-test-bucket",
  ARTIFACT_SERVER_S3_REGION: "us-east-1",
  ARTIFACT_SERVER_S3_SECRET_ACCESS_KEY: "secret-access-key",
};
const baseShellPolicy =
  "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'";
const brandingSchema = z.object({
  logo: z.object({
    alt: z.string(),
    href: z.string().nullable(),
    src: z.string(),
  }).strict().nullable(),
}).strict();

function parseExternal(environment: NodeJS.ProcessEnv) {
  return Effect.runPromise(parseExternalStorageRuntimeConfiguration({
    environment: {...externalEnvironment, ...environment},
    hostname: "127.0.0.1",
    port: "8787",
  }));
}

async function parsedLogo(environment: NodeJS.ProcessEnv): Promise<ViewerLogo> {
  const logo = (await parseExternal(environment)).logo;
  if (logo === null) throw new Error("The environment configured no logo.");
  return logo;
}

describe("viewer logo configuration", () => {
  let files: string;
  let svgPath: string;
  let pngPath: string;
  let installation: TestInstallation;
  const servers: RunningTestServer[] = [];
  const processes: ChildProcessWithoutNullStreams[] = [];

  beforeEach(async () => {
    files = await mkdtemp(path.join(tmpdir(), "frk-028-logo-"));
    svgPath = path.join(files, "logo.svg");
    pngPath = path.join(files, "Logo.PNG");
    await writeFile(svgPath, testSvg);
    await writeFile(pngPath, testPng);
    installation = await createTestInstallation();
  });

  afterEach(async () => {
    await Promise.all(processes.splice(0).map((child) => new Promise<void>((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
    })));
    await Promise.all(servers.splice(0).map((server) => server.stop()));
    await removeTestInstallation(installation);
    await rm(files, {force: true, recursive: true});
  });

  async function start(options: Parameters<typeof startTestServer>[1]) {
    const server = await startTestServer(installation, options);
    servers.push(server);
    return server;
  }

  async function branding(server: RunningTestServer) {
    const response = await fetch(`${server.baseUrl}/api/v1/public/branding`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    return brandingSchema.parse(await response.json());
  }

  test("FRK-028-B: each valid logo form parses into config check, a file logo serves anonymously with its type, sandbox policy, and ETag, and a URL logo adds only its origin to img-src", async () => {
    const urlLogo = await parseExternal({
      ARTIFACT_SERVER_LOGO: "https://cdn.example.com/brand/logo.svg",
      ARTIFACT_SERVER_LOGO_ALT: "  Example Org  ",
    });
    expect(summarizeRuntimeConfiguration(urlLogo).logo).toEqual({
      alt: "Example Org",
      link: null,
      location: "https://cdn.example.com/brand/logo.svg",
      source: "url",
    });
    const svgLogo = await parseExternal({
      ARTIFACT_SERVER_LOGO: svgPath,
      ARTIFACT_SERVER_LOGO_ALT: "Example Org",
      ARTIFACT_SERVER_LOGO_LINK: "/",
    });
    expect(summarizeRuntimeConfiguration(svgLogo).logo).toEqual({
      alt: "Example Org",
      link: "/",
      location: svgPath,
      source: "file",
    });
    const pngLogo = await parsedLogo({
      ARTIFACT_SERVER_LOGO: pngPath,
      ARTIFACT_SERVER_LOGO_ALT: "Example Org",
      ARTIFACT_SERVER_LOGO_LINK: "https://www.example.com/about",
    });
    expect(pngLogo.link).toBe("https://www.example.com/about");
    expect(pngLogo.source).toMatchObject({kind: "file", mediaType: "image/png"});
    // The cap is inclusive.
    const largest = path.join(files, "largest.webp");
    await writeFile(largest, Buffer.alloc(256 * 1024));
    expect((await parsedLogo({
      ARTIFACT_SERVER_LOGO: largest,
      ARTIFACT_SERVER_LOGO_ALT: "Example Org",
    })).source).toMatchObject({kind: "file", mediaType: "image/webp"});
    expect(summarizeRuntimeConfiguration(await parseExternal({})).logo).toBeNull();

    const compactData = path.join(files, "compact");
    await Effect.runPromise(initializeCompactInstallation({
      bootstrapAdministratorEmail: "admin@example.test",
      dataDirectory: compactData,
    }));
    const compactEnvironment = {
      ARTIFACT_SERVER_LOGO: svgPath,
      ARTIFACT_SERVER_LOGO_ALT: "Example Org",
      ARTIFACT_SERVER_ORIGIN: "https://artifacts.example.com",
      ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE: "0",
    };
    expect(summarizeRuntimeConfiguration(await Effect.runPromise(
      parseCompactRuntimeConfiguration({
        dataDirectory: compactData,
        environment: compactEnvironment,
        hostname: "127.0.0.1",
        port: "8787",
      }),
    )).logo).toEqual({alt: "Example Org", link: null, location: svgPath, source: "file"});

    const fileServer = await start({
      contentDomain: null,
      logo: await parsedLogo({
        ARTIFACT_SERVER_LOGO: svgPath,
        ARTIFACT_SERVER_LOGO_ALT: "Example Org",
        ARTIFACT_SERVER_LOGO_LINK: "/",
      }),
    });
    expect(await branding(fileServer)).toEqual({
      logo: {alt: "Example Org", href: "/", src: "/api/v1/public/logo"},
    });
    const logoUrl = `${fileServer.baseUrl}/api/v1/public/logo`;
    const served = await fetch(logoUrl);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/svg+xml");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(served.headers.get("content-security-policy"))
      .toBe("sandbox; default-src 'none'; style-src 'unsafe-inline'");
    expect(await served.text()).toBe(testSvg);
    const etag = served.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/u);
    const revalidated = await fetch(logoUrl, {headers: {"If-None-Match": etag ?? ""}});
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get("content-security-policy"))
      .toBe("sandbox; default-src 'none'; style-src 'unsafe-inline'");
    const head = await fetch(logoUrl, {method: "HEAD"});
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(testSvg.length));
    expect(await head.text()).toBe("");

    const webAssetsRoot = path.join(files, "web");
    await mkdir(webAssetsRoot);
    await writeFile(path.join(webAssetsRoot, "review.html"), "<!doctype html>");
    const urlServer = await start({
      contentDomain: null,
      logo: await parsedLogo({
        ARTIFACT_SERVER_LOGO: "https://cdn.example.com:8443/brand/logo.svg?v=2",
        ARTIFACT_SERVER_LOGO_ALT: "Example Org",
      }),
      webAssetsRoot,
    });
    expect(await branding(urlServer)).toEqual({
      logo: {
        alt: "Example Org",
        href: null,
        src: "https://cdn.example.com:8443/brand/logo.svg?v=2",
      },
    });
    const shell = await fetch(`${urlServer.baseUrl}/review`);
    expect(shell.status).toBe(200);
    expect(shell.headers.get("content-security-policy")).toBe(baseShellPolicy.replace(
      "img-src 'self' data:",
      "img-src 'self' data: https://cdn.example.com:8443",
    ));
    expect((await fetch(`${urlServer.baseUrl}/api/v1/public/logo`)).status).toBe(404);

    const plainServer = await start({contentDomain: null, webAssetsRoot});
    expect(await branding(plainServer)).toEqual({logo: null});
    const missing = await fetch(`${plainServer.baseUrl}/api/v1/public/logo`);
    expect(missing.status).toBe(404);
    expect(z.object({error: z.object({code: z.string()}).loose()})
      .parse(await missing.json()).error.code).toBe("NOT_FOUND");
    expect((await fetch(`${plainServer.baseUrl}/review`)).headers
      .get("content-security-policy")).toBe(baseShellPolicy);

    // The compact server command reads the same variables at startup.
    const port = await reserveLoopbackPort();
    const compact = spawn(
      path.join(repositoryRoot, "node_modules/.bin/tsx"),
      [
        path.join(repositoryRoot, "src/cli/main.ts"),
        "start-compact",
        "--data",
        compactData,
        "--port",
        String(port),
      ],
      {cwd: repositoryRoot, env: {...process.env, ...compactEnvironment}},
    );
    processes.push(compact);
    await waitForOutput(compact, '"status":"ready"');
    const compactBranding = await fetch(`http://127.0.0.1:${port}/api/v1/public/branding`);
    expect(brandingSchema.parse(await compactBranding.json())).toEqual({
      logo: {alt: "Example Org", href: null, src: "/api/v1/public/logo"},
    });
    const compactLogo = await fetch(`http://127.0.0.1:${port}/api/v1/public/logo`);
    expect(Buffer.from(await compactLogo.arrayBuffer()))
      .toEqual(await readFile(svgPath));
  }, 60_000);

  test("FRK-028-F: an insecure, credentialed, or relative logo, a missing, unsupported, or oversized file, a missing or long alt, an unsafe link, and an alt or link without a logo each stop startup with their field and reason", async () => {
    const gif = path.join(files, "logo.gif");
    const oversized = path.join(files, "oversized.png");
    await writeFile(gif, "GIF89a");
    await writeFile(oversized, Buffer.alloc(256 * 1024 + 1));
    const withLogo = {ARTIFACT_SERVER_LOGO: svgPath, ARTIFACT_SERVER_LOGO_ALT: "Example Org"};
    const cases: readonly (readonly [NodeJS.ProcessEnv, string, string])[] = [
      [{...withLogo, ARTIFACT_SERVER_LOGO: "http://cdn.example.com/logo.svg"}, "ARTIFACT_SERVER_LOGO", "invalid_value"],
      [{...withLogo, ARTIFACT_SERVER_LOGO: "https://user:secret@cdn.example.com/logo.svg"}, "ARTIFACT_SERVER_LOGO", "invalid_value"],
      [{...withLogo, ARTIFACT_SERVER_LOGO: "logo.svg"}, "ARTIFACT_SERVER_LOGO", "invalid_value"],
      [{...withLogo, ARTIFACT_SERVER_LOGO: "javascript:alert(1)"}, "ARTIFACT_SERVER_LOGO", "invalid_value"],
      [{...withLogo, ARTIFACT_SERVER_LOGO: path.join(files, "absent.svg")}, "ARTIFACT_SERVER_LOGO", "path_unavailable"],
      [{...withLogo, ARTIFACT_SERVER_LOGO: path.join(files, "folder.svg")}, "ARTIFACT_SERVER_LOGO", "path_unavailable"],
      [{...withLogo, ARTIFACT_SERVER_LOGO: gif}, "ARTIFACT_SERVER_LOGO", "invalid_value"],
      [{...withLogo, ARTIFACT_SERVER_LOGO: oversized}, "ARTIFACT_SERVER_LOGO", "invalid_value"],
      [{ARTIFACT_SERVER_LOGO: svgPath}, "ARTIFACT_SERVER_LOGO_ALT", "missing_value"],
      [{...withLogo, ARTIFACT_SERVER_LOGO_ALT: "   "}, "ARTIFACT_SERVER_LOGO_ALT", "missing_value"],
      [{...withLogo, ARTIFACT_SERVER_LOGO_ALT: "a".repeat(101)}, "ARTIFACT_SERVER_LOGO_ALT", "invalid_value"],
      [{...withLogo, ARTIFACT_SERVER_LOGO_LINK: "//evil.example.com/"}, "ARTIFACT_SERVER_LOGO_LINK", "invalid_value"],
      [{...withLogo, ARTIFACT_SERVER_LOGO_LINK: "/\\evil.example.com/"}, "ARTIFACT_SERVER_LOGO_LINK", "invalid_value"],
      [{...withLogo, ARTIFACT_SERVER_LOGO_LINK: "javascript:alert(1)"}, "ARTIFACT_SERVER_LOGO_LINK", "invalid_value"],
      [{...withLogo, ARTIFACT_SERVER_LOGO_LINK: "http://www.example.com/"}, "ARTIFACT_SERVER_LOGO_LINK", "invalid_value"],
      [{ARTIFACT_SERVER_LOGO_ALT: "Example Org"}, "ARTIFACT_SERVER_LOGO_ALT", "incomplete_configuration"],
      [{ARTIFACT_SERVER_LOGO_LINK: "/"}, "ARTIFACT_SERVER_LOGO_LINK", "incomplete_configuration"],
    ];
    await mkdir(path.join(files, "folder.svg"));
    const outcomes = await Promise.all(cases.map(async ([environment]) => {
      try {
        await parseExternal(environment);
        return {field: "accepted", reason: "accepted"};
      } catch (caught) {
        return z.object({field: z.string(), reason: z.string()}).loose().parse(caught);
      }
    }));
    expect(outcomes.map(({field, reason}) => [field, reason]))
      .toEqual(cases.map(([, field, reason]) => [field, reason]));
    // An alt of exactly 100 characters is the longest accepted.
    expect((await parsedLogo({...withLogo, ARTIFACT_SERVER_LOGO_ALT: "a".repeat(100)})).alt)
      .toHaveLength(100);
  });
});

function waitForOutput(
  child: ChildProcessWithoutNullStreams,
  expected: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Process did not emit ${expected}: ${output}`));
    }, 20_000);
    const receive = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (!output.includes(expected)) return;
      cleanup();
      resolve();
    };
    const exit = () => {
      cleanup();
      reject(new Error(`Process exited before ${expected}: ${output}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", receive);
      child.stderr.off("data", receive);
      child.off("exit", exit);
    };
    child.stdout.on("data", receive);
    child.stderr.on("data", receive);
    child.once("exit", exit);
  });
}
