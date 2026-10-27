import {createHash} from "node:crypto";
import {readdir} from "node:fs/promises";

import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  commitStagedUpload,
  createStagedUpload,
  uploadEveryStagedFile,
  type PublishResponse,
  type TestSiteFile,
} from "../support/publishing.js";

const html = "text/html; charset=utf-8";
const javascript = "text/javascript; charset=utf-8";
const css = "text/css; charset=utf-8";

/**
 * A published output directory and the references its files make. Each
 * reference is resolved against the URL of the file that makes it, the way a
 * browser resolves it.
 */
interface OutputFixture {
  readonly entryPath: string;
  readonly files: readonly TestSiteFile[];
  readonly name: string;
  readonly references: readonly (readonly [from: string, reference: string, target: string])[];
}

describe("CNT-001 client-side output opens without a rebuild", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("CNT-001-B: plain HTML, a multi-page site, and React, Vue, and Svelte build output open from their entry files", async () => {
    expect.hasAssertions();
    for (const fixture of outputFixtures()) {
      // Fixtures publish one at a time so a failure names one output directory.
      // eslint-disable-next-line no-await-in-loop
      const published = await publishFixture(fixture);
      const versionUrl = published.links.version;

      // eslint-disable-next-line no-await-in-loop
      const entry = await fetchVersion(server, versionUrl);
      // eslint-disable-next-line no-await-in-loop
      const entryBytes = new Uint8Array(await entry.arrayBuffer());
      expect({fixture: fixture.name, status: entry.status}).toEqual({
        fixture: fixture.name,
        status: 200,
      });
      expect(entry.headers.get("content-type")).toBe(html);
      expect(entryBytes).toEqual(fileAt(fixture, fixture.entryPath).bytes);

      for (const file of fixture.files) {
        // eslint-disable-next-line no-await-in-loop
        const response = await fetchVersion(server, new URL(file.path, versionUrl).toString());
        // eslint-disable-next-line no-await-in-loop
        const bytes = new Uint8Array(await response.arrayBuffer());
        expect({file: `${fixture.name}/${file.path}`, status: response.status}).toEqual({
          file: `${fixture.name}/${file.path}`,
          status: 200,
        });
        expect(response.headers.get("content-type")).toBe(file.mediaType);
        expect(bytes).toEqual(file.bytes);
      }

      for (const [from, reference, target] of fixture.references) {
        expect(new TextDecoder().decode(fileAt(fixture, from).bytes)).toContain(reference);
        const resolved = new URL(reference, new URL(from, versionUrl));
        expect(resolved.origin).toBe(new URL(versionUrl).origin);
        // eslint-disable-next-line no-await-in-loop
        const response = await fetchVersion(server, resolved.toString());
        // eslint-disable-next-line no-await-in-loop
        const bytes = new Uint8Array(await response.arrayBuffer());
        expect({reference: `${fixture.name}/${from} -> ${reference}`, status: response.status})
          .toEqual({reference: `${fixture.name}/${from} -> ${reference}`, status: 200});
        expect(bytes).toEqual(fileAt(fixture, target).bytes);
      }
    }
  });

  test("CNT-001-F: source files, package manifests, and build configuration are served as stored bytes and never built", async () => {
    expect.hasAssertions();
    const fixture: OutputFixture = {
      entryPath: "index.html",
      files: [
        text("index.html", html, [
          "<!doctype html><html><head><title>Unbuilt app</title></head>",
          "<body><div id=\"root\"></div>",
          "<script type=\"module\" src=\"/src/main.tsx\"></script></body></html>",
        ].join("")),
        text("package.json", "application/json", JSON.stringify({
          dependencies: {react: "19.0.0", svelte: "5.0.0", vue: "3.5.0"},
          name: "unbuilt-app",
          private: true,
          scripts: {
            build: "vite build && node -e \"require('fs').writeFileSync('built.marker','')\"",
            postinstall: "node -e \"require('fs').writeFileSync('installed.marker','')\"",
            prepare: "node -e \"require('fs').writeFileSync('prepared.marker','')\"",
          },
          type: "module",
        }, null, 2)),
        text("package-lock.json", "application/json", "{\"lockfileVersion\":3,\"packages\":{}}"),
        text("vite.config.ts", javascript, [
          "import {defineConfig} from 'vite';",
          "export default defineConfig({build: {outDir: 'dist'}});",
        ].join("\n")),
        text("src/main.tsx", javascript, [
          "import {createRoot} from 'react-dom/client';",
          "import App from './App.tsx';",
          "createRoot(document.getElementById('root')!).render(<App />);",
        ].join("\n")),
        text("src/App.tsx", javascript, [
          "export default function App(): JSX.Element {",
          "  return <main>Hello</main>;",
          "}",
        ].join("\n")),
        text("src/Widget.vue", "text/plain; charset=utf-8", [
          "<script setup lang=\"ts\">const count: number = 1;</script>",
          "<template><button>{{ count }}</button></template>",
        ].join("\n")),
        text("src/Card.svelte", "text/plain; charset=utf-8", [
          "<script lang=\"ts\">let title: string = 'Card';</script>",
          "<h2>{title}</h2>",
        ].join("\n")),
        text("src/styles.scss", "text/plain; charset=utf-8", "$accent: #c00;\nmain { color: $accent; }\n"),
      ],
      name: "unbuilt",
      references: [],
    };
    const published = await publishFixture(fixture);
    const versionUrl = published.links.version;

    for (const file of fixture.files) {
      // eslint-disable-next-line no-await-in-loop
      const response = await fetchVersion(server, new URL(file.path, versionUrl).toString());
      // eslint-disable-next-line no-await-in-loop
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect({file: file.path, status: response.status}).toEqual({file: file.path, status: 200});
      expect(response.headers.get("content-type")).toBe(file.mediaType);
      expect(response.headers.get("etag")).toBe(`"${sha256(file.bytes)}"`);
      expect(bytes).toEqual(file.bytes);
    }

    for (const missing of [
      "dist/index.html",
      "dist/assets/index.js",
      "node_modules/react/package.json",
      "src/main.js",
      "src/App.js",
      "built.marker",
      "installed.marker",
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const response = await fetchVersion(server, new URL(missing, versionUrl).toString());
      expect({path: missing, status: response.status}).toEqual({path: missing, status: 404});
      // eslint-disable-next-line no-await-in-loop
      await response.arrayBuffer();
    }

    const stored = await readdir(installation.dataDirectory, {recursive: true});
    expect(stored.filter((entry) =>
      /(?:^|[\\/])(?:node_modules|dist|\.vite)(?:[\\/]|$)|\.marker$/u.test(entry)
    )).toEqual([]);
  });

  async function publishFixture(fixture: OutputFixture): Promise<PublishResponse> {
    const upload = await createStagedUpload(
      server,
      installation,
      fixture.entryPath,
      fixture.files,
    );
    expect(upload.response.status).toBe(201);
    const uploads = await uploadEveryStagedFile(installation, upload.body, fixture.files);
    expect(uploads.map((response) => response.status)).toEqual(uploads.map(() => 200));
    await Promise.all(uploads.map((response) => response.arrayBuffer()));
    const committed = await commitStagedUpload(
      installation,
      upload.body,
      `cnt-001-${fixture.name}-publish`,
      {accessSetting: "public_link", kind: "new_artifact", name: fixture.name},
    );
    expect(committed.response.status).toBe(201);
    return committed.body;
  }
});

/**
 * Output directories in the shape each framework's production build writes.
 * They are written by hand, not produced by running the frameworks' compilers.
 */
function outputFixtures(): readonly OutputFixture[] {
  return [
    {
      entryPath: "index.html",
      files: [
        text("index.html", html, "<!doctype html><title>Plain</title><h1>Plain HTML</h1>"),
      ],
      name: "plain-html",
      references: [],
    },
    {
      entryPath: "index.html",
      files: [
        text("index.html", html, [
          "<!doctype html><title>Home</title><link rel=\"stylesheet\" href=\"site.css\">",
          "<a href=\"guide/getting-started.html\">Guide</a><a href=\"about.html\">About</a>",
          "<img src=\"images/logo.png\" alt=\"\">",
        ].join("")),
        text("about.html", html, "<!doctype html><title>About</title><a href=\"./index.html\">Home</a>"),
        text("guide/getting-started.html", html, [
          "<!doctype html><title>Getting started</title>",
          "<link rel=\"stylesheet\" href=\"../site.css\"><a href=\"../about.html\">About</a>",
        ].join("")),
        text("site.css", css, "body{font-family:system-ui}"),
        {bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]), mediaType: "image/png", path: "images/logo.png"},
      ],
      name: "multi-page",
      references: [
        ["index.html", "site.css", "site.css"],
        ["index.html", "guide/getting-started.html", "guide/getting-started.html"],
        ["index.html", "about.html", "about.html"],
        ["index.html", "images/logo.png", "images/logo.png"],
        ["about.html", "./index.html", "index.html"],
        ["guide/getting-started.html", "../site.css", "site.css"],
        ["guide/getting-started.html", "../about.html", "about.html"],
      ],
    },
    {
      entryPath: "index.html",
      files: [
        text("index.html", html, [
          "<!doctype html><html lang=\"en\"><head><meta charset=\"UTF-8\">",
          "<link rel=\"icon\" type=\"image/svg+xml\" href=\"/vite.svg\">",
          "<title>React app</title>",
          "<script type=\"module\" crossorigin src=\"/assets/index-BnR4kq7Z.js\"></script>",
          "<link rel=\"modulepreload\" crossorigin href=\"/assets/react-vendor-C9xk2LmA.js\">",
          "<link rel=\"stylesheet\" crossorigin href=\"/assets/index-D3fq81Ws.css\">",
          "</head><body><div id=\"root\"></div></body></html>",
        ].join("")),
        text("assets/index-BnR4kq7Z.js", javascript, [
          "import{j as e,c as r}from\"./react-vendor-C9xk2LmA.js\";",
          "r(document.getElementById(\"root\")).render(e.jsx(\"main\",{children:\"Hello\"}));",
        ].join("")),
        text("assets/react-vendor-C9xk2LmA.js", javascript, "export const j={jsx:()=>null},c=()=>({render(){}});"),
        text("assets/index-D3fq81Ws.css", css, "@font-face{font-family:Inter;src:url(./inter-latin-400-Bm2pQx9a.woff2) format(\"woff2\")}"),
        {bytes: new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 1]), mediaType: "font/woff2", path: "assets/inter-latin-400-Bm2pQx9a.woff2"},
        text("vite.svg", "image/svg+xml", "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1\" height=\"1\"/>"),
      ],
      name: "react-vite",
      references: [
        ["index.html", "/vite.svg", "vite.svg"],
        ["index.html", "/assets/index-BnR4kq7Z.js", "assets/index-BnR4kq7Z.js"],
        ["index.html", "/assets/react-vendor-C9xk2LmA.js", "assets/react-vendor-C9xk2LmA.js"],
        ["index.html", "/assets/index-D3fq81Ws.css", "assets/index-D3fq81Ws.css"],
        ["assets/index-BnR4kq7Z.js", "./react-vendor-C9xk2LmA.js", "assets/react-vendor-C9xk2LmA.js"],
        ["assets/index-D3fq81Ws.css", "./inter-latin-400-Bm2pQx9a.woff2", "assets/inter-latin-400-Bm2pQx9a.woff2"],
      ],
    },
    {
      entryPath: "index.html",
      files: [
        text("index.html", html, [
          "<!doctype html><html lang=\"en\"><head><meta charset=\"UTF-8\">",
          "<title>Vue app</title>",
          "<script type=\"module\" crossorigin src=\"./assets/index-Ck81TqLs.js\"></script>",
          "<link rel=\"stylesheet\" crossorigin href=\"./assets/index-B2mXc0aQ.css\">",
          "</head><body><div id=\"app\"></div></body></html>",
        ].join("")),
        text("assets/index-Ck81TqLs.js", javascript, [
          "const e=()=>import(\"./About-DxV91aPq.js\");",
          "document.getElementById(\"app\").textContent=\"Vue\";export{e};",
        ].join("")),
        text("assets/About-DxV91aPq.js", javascript, "export default{name:\"About\"};"),
        text("assets/index-B2mXc0aQ.css", css, "#app{background:url(./hero-Aq2Wm7Lc.webp)}"),
        {bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0]), mediaType: "image/webp", path: "assets/hero-Aq2Wm7Lc.webp"},
      ],
      name: "vue-vite",
      references: [
        ["index.html", "./assets/index-Ck81TqLs.js", "assets/index-Ck81TqLs.js"],
        ["index.html", "./assets/index-B2mXc0aQ.css", "assets/index-B2mXc0aQ.css"],
        ["assets/index-Ck81TqLs.js", "./About-DxV91aPq.js", "assets/About-DxV91aPq.js"],
        ["assets/index-B2mXc0aQ.css", "./hero-Aq2Wm7Lc.webp", "assets/hero-Aq2Wm7Lc.webp"],
      ],
    },
    {
      entryPath: "index.html",
      files: [
        text("index.html", html, [
          "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">",
          "<link href=\"./_app/immutable/assets/0.CxR2s9Lq.css\" rel=\"stylesheet\">",
          "<link rel=\"modulepreload\" href=\"./_app/immutable/entry/start.Dk2Qp1Za.js\">",
          "<title>Svelte app</title></head><body><div style=\"display: contents\">",
          "<a href=\"./about.html\">About</a>",
          "<script>{import(\"./_app/immutable/entry/start.Dk2Qp1Za.js\").then((m)=>m.start())}</script>",
          "</div></body></html>",
        ].join("")),
        text("about.html", html, [
          "<!doctype html><html><head>",
          "<link href=\"./_app/immutable/assets/0.CxR2s9Lq.css\" rel=\"stylesheet\">",
          "<title>About</title></head><body><a href=\"./index.html\">Home</a></body></html>",
        ].join("")),
        text("_app/immutable/entry/start.Dk2Qp1Za.js", javascript, [
          "import{s as t}from\"../chunks/runtime.Bq7Lx3Mn.js\";",
          "export function start(){return fetch(new URL(\"../../version.json\",import.meta.url)).then(t)}",
        ].join("")),
        text("_app/immutable/chunks/runtime.Bq7Lx3Mn.js", javascript, "export const s=()=>undefined;"),
        text("_app/immutable/assets/0.CxR2s9Lq.css", css, "a{color:#ff3e00}"),
        text("_app/version.json", "application/json", "{\"version\":\"1730000000000\"}"),
      ],
      name: "svelte-kit-static",
      references: [
        ["index.html", "./_app/immutable/assets/0.CxR2s9Lq.css", "_app/immutable/assets/0.CxR2s9Lq.css"],
        ["index.html", "./_app/immutable/entry/start.Dk2Qp1Za.js", "_app/immutable/entry/start.Dk2Qp1Za.js"],
        ["index.html", "./about.html", "about.html"],
        ["about.html", "./_app/immutable/assets/0.CxR2s9Lq.css", "_app/immutable/assets/0.CxR2s9Lq.css"],
        ["about.html", "./index.html", "index.html"],
        [
          "_app/immutable/entry/start.Dk2Qp1Za.js",
          "../chunks/runtime.Bq7Lx3Mn.js",
          "_app/immutable/chunks/runtime.Bq7Lx3Mn.js",
        ],
        ["_app/immutable/entry/start.Dk2Qp1Za.js", "../../version.json", "_app/version.json"],
      ],
    },
  ];
}

function fileAt(fixture: OutputFixture, filePath: string): TestSiteFile {
  const file = fixture.files.find((candidate) => candidate.path === filePath);
  if (file === undefined) throw new Error(`${fixture.name} has no ${filePath}.`);
  return file;
}

function text(filePath: string, mediaType: string, content: string): TestSiteFile {
  return {bytes: new TextEncoder().encode(content), mediaType, path: filePath};
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
