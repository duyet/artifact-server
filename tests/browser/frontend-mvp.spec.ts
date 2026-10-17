import {AxeBuilder} from "@axe-core/playwright";
import {expect, test} from "@playwright/test";
import {unzipSync} from "fflate";
import {readFile} from "node:fs/promises";
import {z} from "zod";

import {
  apiHeaders,
  fetchVersion,
} from "../support/runtime-harness.js";
import {
  commitStagedUpload,
  createStagedUpload,
  publishNew,
  publishVersion,
  type TestSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";
import {
  artifactPreview,
  artifactSidebar,
  browserStorage,
  chooseAccountMenuItem,
  galleryRow,
  galleryRows,
  localLogin,
  openArtifactFromGallery,
  reviewFrame,
  reviewFrameSelector,
  selectInspectorFile,
  sidebarState,
  sidebarToggle,
  startBrowserFixture,
  stopBrowserFixture,
  viewerHeader,
  type BrowserFixture,
} from "./browser-fixture.js";
import {listThreadsOverApi} from "./comment-api.js";

const reviewImagePaths = [
  "media/preview.png",
  "media/preview.jpg",
  "media/preview.webp",
  "media/preview.gif",
  "media/preview.svg",
] as const;
const reviewPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z7aEAAAAASUVORK5CYII=";
const reviewJpegBase64 = "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMQD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABMAAEBAAAAAAAAAAAAAAAAAAAABgEBAQAAAAAAAAAAAAAAAAAABAcQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAACAAIDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCaAU4d/9k=";
const reviewWebpBase64 = "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA==";
const reviewGifBase64 = "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
const reviewWebmBase64 = "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAK0EU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggElTbuMU6uEHFO7a1OsggKe7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNjIuMTIuMTAxV0GNTGF2ZjYyLjEyLjEwMUSJiEB5AAAAAAAAFlSua8iuAQAAAAAAAD/XgQFzxYj918nP8i2d+ZyBACK1nIN1bmSIgQCGhVZfVlA5g4EBI+ODhAJiWgDgkLCBILqBGJqBAlWwhFW5gQESVMNnQIBzc6BjwIBnyJpFo4dFTkNPREVSRIeNTGF2ZjYyLjEyLjEwMXNz2mPAi2PFiP3Xyc/yLZ35Z8ilRaOHRU5DT0RFUkSHmExhdmM2Mi4yOC4xMDEgbGlidnB4LXZwOWfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDAuNDAwMDAwMDAwAB9DtnVA7eeBAKOrgQAAgIJJg0IAAfABdgA4JBwYSgAAMGAAABDf//Xtp/////2Ecf//+rwAAKOTgQAoAIYAQJKcAFAAAAMgAABDQKOTgQBQAIYAQJKcAE7gAAMgAABDQKOTgQB4AIYAQJKcAFAAAAMgAABDQKOTgQCgAIYAQJKcAE1AAAMgAABDQKOTgQDIAIYAQJKcAFAAAAMgAABDQKOTgQDwAIYAQJKcAE7gAAMgAABDQKOTgQEYAIYAQJKcAFAAAAMgAABDQKOTgQFAAIYAQJKcAEogAAMgAABDQKOTgQFoAIYAQJKcAFAAAAMgAABDQBxTu2uRu4+zgQC3iveBAfGCAavwgQM=";

test.describe("Artifact Server frontend MVP", () => {
  test("CMT-015-B CMT-015-F: the Artifact Server review application navigates projects and artifacts", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const first = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><html lang=\"en\"><title>Review fixture</title><main><h1 id=\"review-target\">Review preview content</h1><p id=\"review-theme-target\">Theme target</p><button id=\"review-native-action\" onclick=\"this.dataset.clicked = 'true'\">Artifact action</button></main></html>",
        idempotencyKey: "frontend-review-fixture",
        name: "Review fixture",
        tags: ["inspection", "prototype"],
      });
      await publishVersion(fixture.server, fixture.installation, {
        artifactId: first.body.artifact.id,
        content: "<!doctype html><html lang=\"en\"><title>Review fixture</title><main><h1 id=\"review-target\">Review preview content</h1><p id=\"review-theme-target\">Theme target</p><button id=\"review-native-action\" onclick=\"this.dataset.clicked = 'true'\">Artifact action</button></main></html>",
        expectedCurrentVersionId: first.body.version.id,
        idempotencyKey: "frontend-review-fixture-v2",
      });

      const legacyReview = await fixture.page.request.get(
        `${fixture.server.baseUrl}/workbench?project=prj_default`,
        {maxRedirects: 0},
      );
      expect(legacyReview.status()).toBe(308);
      expect(legacyReview.headers()["location"]).toBe("/review?project=prj_default");

      await localLogin(fixture);
      await fixture.page.goto(`${fixture.server.baseUrl}/review`);

      // Review opens on the Artifacts gallery and opens no artifact by itself.
      await expect(
        fixture.page.getByRole("heading", {exact: true, level: 1, name: "Artifacts"}),
      ).toBeVisible();
      expect(new URL(fixture.page.url()).searchParams.has("artifact")).toBe(false);
      const sidebar = artifactSidebar(fixture.page);
      await expect(sidebar.getByRole("link", {exact: true, name: "Review fixture"}))
        .toBeVisible();
      const reviewFixtureRow = galleryRow(fixture.page, "Review fixture");
      await expect(reviewFixtureRow).toBeVisible();
      await expect(reviewFixtureRow).toContainText("2 versions");
      await expect(reviewFixtureRow.getByText("Private", {exact: true})).toBeVisible();
      const galleryRefresh = fixture.page.getByRole("button", {
        name: "Refresh artifacts published by agents, the CLI, or other sessions",
      });
      await galleryRefresh.click();
      await expect(galleryRefresh).toContainText("Refreshed");
      // The sidebar carries its own refresh for the file tree and no paging
      // control while one page holds every artifact.
      await expect(sidebar.getByRole("button", {exact: true, name: "Refresh artifacts"}))
        .toBeVisible();
      await expect(sidebar.getByRole("button", {name: "Load more"})).toHaveCount(0);

      await chooseAccountMenuItem(fixture.page, "Keyboard shortcuts");
      const shortcutMap = fixture.page.getByRole("dialog", {name: "Keyboard shortcuts"});
      await expect(shortcutMap).toBeVisible();
      await expect(shortcutMap).toContainText("Previous artifact");
      await expect(shortcutMap).toContainText("Inspector or comments");
      await expect(shortcutMap.locator('kbd[data-slot="kbd"]')).toHaveText([
        "K",
        "↑",
        "J",
        "↓",
        "[",
        "]",
        "F",
        "Esc",
        "⌘ / Ctrl",
        "\\",
      ]);
      await fixture.page.keyboard.press("Escape");
      await expect(shortcutMap).toBeHidden();

      await openArtifactFromGallery(fixture.page, "Review fixture");
      await expect(sidebar.getByRole("link", {exact: true, name: "Review fixture"}))
        .toHaveAttribute("aria-current", "page");
      await expect(viewerHeader(fixture.page).locator("p")).toHaveCount(0);
      const accessRow = fixture.page.locator("dl").filter({hasText: "access"});
      await expect(accessRow.getByText("Private", {exact: true})).toBeVisible();
      await expect(accessRow.getByText("Account required", {exact: true})).toHaveCount(0);
      const frame = reviewFrame(fixture.page);
      const preview = artifactPreview(fixture.page);
      await expect(preview.getByRole("heading", {name: "Review preview content"}))
        .toBeVisible();

      const annotateMode = fixture.page.getByRole("button", {
        name: /^Annotate mode:/u,
      });
      await expect(annotateMode).toHaveAttribute("aria-pressed", "true");
      await preview.locator("#review-native-action").focus();
      await fixture.page.keyboard.press("Escape");
      const interactMode = fixture.page.getByRole("button", {
        name: /^Interact mode:/u,
      });
      await expect(interactMode).toHaveAttribute("aria-pressed", "false");
      await preview.locator("#review-native-action").click();
      await expect(preview.locator("#review-native-action"))
        .toHaveAttribute("data-clicked", "true");
      await expect(frame.getByPlaceholder("Add a comment...")).toHaveCount(0);
      await interactMode.click();
      await expect(annotateMode).toHaveAttribute("aria-pressed", "true");

      const inspector = fixture.page.getByRole("complementary", {
        name: "Artifact inspector",
      });
      const inspectorResizeHit = fixture.page.locator(
        '.as-panel-assembly[data-side="right"] .as-panel-edge__hit',
      );
      await expect(fixture.page.getByRole("separator", {
        name: "Artifact inspector width",
      })).toHaveAttribute("aria-valuenow", "368");
      const inspectorBeforeResize = await inspector.boundingBox();
      const inspectorHitBeforeResize = await inspectorResizeHit.boundingBox();
      expect(inspectorBeforeResize).not.toBeNull();
      expect(inspectorHitBeforeResize).not.toBeNull();
      if (inspectorBeforeResize === null || inspectorHitBeforeResize === null) {
        throw new Error("Review inspector resize geometry was unavailable.");
      }
      await fixture.page.mouse.move(
        inspectorHitBeforeResize.x + inspectorHitBeforeResize.width / 2,
        inspectorHitBeforeResize.y + 180,
      );
      await expect(fixture.page.getByRole("tooltip", {
        name: "Click to close · Drag to resize",
      })).toBeVisible();
      await fixture.page.mouse.down();
      await fixture.page.mouse.move(
        inspectorHitBeforeResize.x + inspectorHitBeforeResize.width / 2 - 36,
        inspectorHitBeforeResize.y + 180,
        {steps: 4},
      );
      await fixture.page.mouse.up();
      await expect.poll(async () => (await inspector.boundingBox())?.width ?? 0)
        .toBeGreaterThan(inspectorBeforeResize.width + 28);

      const inspectorSeparator = fixture.page.getByRole("separator", {
        name: "Artifact inspector width",
      });
      const keyboardWidth = Number(await inspectorSeparator.getAttribute("aria-valuenow"));
      await inspectorSeparator.focus();
      await fixture.page.keyboard.press("ArrowLeft");
      await expect(inspectorSeparator).toHaveAttribute(
        "aria-valuenow",
        String(keyboardWidth + 10),
      );

      const inspectorHitBeforeCollapse = await inspectorResizeHit.boundingBox();
      expect(inspectorHitBeforeCollapse).not.toBeNull();
      if (inspectorHitBeforeCollapse === null) {
        throw new Error("Review inspector collapse edge was unavailable.");
      }
      await fixture.page.mouse.click(
        inspectorHitBeforeCollapse.x + inspectorHitBeforeCollapse.width / 2,
        inspectorHitBeforeCollapse.y + 180,
      );
      await expect(viewerHeader(fixture.page).getByRole("button", {name: "Open inspector"}))
        .toBeVisible();
      await expect(inspector).toBeHidden();
      await viewerHeader(fixture.page).getByRole("button", {name: "Open inspector"}).click();
      await expect(inspector).toBeVisible();

      await fixture.page.setViewportSize({height: 720, width: 1024});
      await expect(fixture.page.locator('.as-panel-assembly[data-side="right"]'))
        .toHaveCSS("position", "absolute");
      await expect.poll(async () =>
        (await fixture.page.locator(".as-preview-panel").boundingBox())?.width ?? 0
      ).toBeGreaterThan(600);
      // Below the tablet breakpoint the sidebar leaves the layout and opens
      // over the page, as a sheet, only when asked.
      await fixture.page.setViewportSize({height: 720, width: 680});
      await expect(artifactSidebar(fixture.page)).toHaveCount(0);
      await sidebarToggle(fixture.page).click();
      const sidebarSheet = fixture.page.getByRole("dialog", {name: "Sidebar"});
      await expect(sidebarSheet.getByRole("navigation", {name: "Artifact catalog"}))
        .toBeVisible();
      await fixture.page.keyboard.press("Escape");
      await expect(sidebarSheet).toHaveCount(0);
      await fixture.page.setViewportSize({height: 720, width: 1280});

      await preview.locator("#review-target").hover();
      await expect(preview.locator("[data-plannotator-pinpoint-box]"))
        .toBeVisible();
      await preview.locator("#review-target").click();
      const composer = frame.getByPlaceholder("Add a comment...");
      await expect(composer).toBeVisible();
      await composer.fill("Make the release status easier to scan.");
      await frame.getByRole("button", {name: "Save"}).click();

      await expect(fixture.page.getByRole("tab", {name: /Comments.*1/u}))
        .toHaveAttribute("aria-selected", "true");
      const selectedComment = fixture.page.getByRole("article").filter({
        hasText: "Make the release status easier to scan.",
      });
      await expect(selectedComment).toBeVisible();
      await expect(selectedComment).toHaveAttribute("aria-current", "true");
      expect(await selectedComment.evaluate((element) => getComputedStyle(element).boxShadow))
        .not.toContain("inset");
      await expect(fixture.page.getByText(
        "Click any element in the HTML preview to place a comment.",
      )).toHaveCount(0);
      await expect(fixture.page.locator("#review-preview footer").getByRole("button", {
        name: "Reload",
      })).toBeVisible();
      await expect(async () => {
        const stored = await listThreadsOverApi(
          fixture,
          first.body.artifact.id,
        );
        expect(stored).toHaveLength(1);
        expect(stored[0]?.body).toBe("Make the release status easier to scan.");
        expect(stored[0]?.path).toBe("index.html");
      }).toPass();
      const listedArtifacts = z.object({
        artifacts: z.array(z.object({
          artifact: z.object({id: z.string()}),
          commentCount: z.number().int().nonnegative(),
        })),
      }).parse(await (await fixture.page.request.get(
        `${fixture.server.baseUrl}/api/v1/artifacts?projectId=${first.body.artifact.projectId}`,
      )).json());
      expect(listedArtifacts.artifacts.find(({artifact}) => artifact.id === first.body.artifact.id))
        .toMatchObject({commentCount: 1});

      const quietArtifact = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><title>Quiet fixture</title><p>No review notes yet.</p>",
        idempotencyKey: "frontend-review-quiet-fixture",
        name: "Quiet fixture",
        tags: ["quiet"],
      });
      expect(quietArtifact.body.artifact.id).not.toBe(first.body.artifact.id);
      await sidebar.getByRole("button", {exact: true, name: "Refresh artifacts"}).click();
      await expect(sidebar.getByRole("link", {exact: true, name: "Quiet fixture"}))
        .toBeVisible();

      // Single-key shortcuts yield to typing: "j" lands in the comment box
      // and does not move to another artifact.
      const newComment = fixture.page.getByLabel("Add a comment");
      await newComment.focus();
      await fixture.page.keyboard.press("j");
      await expect(newComment).toHaveValue("j");
      await expect(fixture.page.getByRole("heading", {exact: true, level: 1, name: "Review fixture"}))
        .toBeVisible();
      await newComment.fill("");

      await fixture.page.locator(".as-preview-panel").focus();
      await fixture.page.keyboard.press("k");
      await expect(fixture.page.getByRole("heading", {exact: true, level: 1, name: "Quiet fixture"}))
        .toBeVisible();
      await fixture.page.keyboard.press("j");
      await expect(fixture.page.getByRole("heading", {exact: true, level: 1, name: "Review fixture"}))
        .toBeVisible();
      await fixture.page.keyboard.press("ArrowUp");
      await expect(fixture.page.getByRole("heading", {exact: true, level: 1, name: "Quiet fixture"}))
        .toBeVisible();
      await fixture.page.keyboard.press("ArrowDown");
      await expect(fixture.page.getByRole("heading", {exact: true, level: 1, name: "Review fixture"}))
        .toBeVisible();

      // An open menu owns the keyboard, so "k" does not navigate.
      await fixture.page.getByRole("button", {name: "Artifact actions"}).click();
      const artifactMenu = fixture.page.getByRole("menu");
      await expect(artifactMenu).toBeVisible();
      await fixture.page.keyboard.press("k");
      await expect(fixture.page.getByRole("heading", {exact: true, level: 1, name: "Review fixture"}))
        .toBeVisible();
      await fixture.page.keyboard.press("Escape");
      await expect(artifactMenu).toBeHidden();

      await expect(sidebarToggle(fixture.page)).toHaveAttribute("aria-keyshortcuts", "[");
      await expect(sidebarState(fixture.page)).toHaveAttribute("data-state", "expanded");
      await fixture.page.locator(".as-preview-panel").focus();
      await fixture.page.keyboard.press("[");
      await expect(sidebarState(fixture.page)).toHaveAttribute("data-state", "collapsed");
      await fixture.page.keyboard.press("[");
      await expect(sidebarState(fixture.page)).toHaveAttribute("data-state", "expanded");

      const inspectorToggle = inspector.getByRole("button", {name: "Close inspector"});
      await expect(inspectorToggle).toHaveAttribute("aria-keyshortcuts", "]");
      await fixture.page.keyboard.press("]");
      const openInspector = viewerHeader(fixture.page).getByRole("button", {
        name: "Open inspector",
      });
      await expect(openInspector).toBeVisible();
      await expect(openInspector).toHaveAttribute("aria-keyshortcuts", "]");
      await fixture.page.keyboard.press("]");
      await expect(inspector).toBeVisible();

      await expect(fixture.page.getByRole("button", {name: "Previous artifact"}))
        .toHaveAttribute("aria-keyshortcuts", "K ArrowUp");
      await expect(fixture.page.getByRole("button", {name: "Next artifact"}))
        .toHaveAttribute("aria-keyshortcuts", "J ArrowDown");

      await fixture.page.reload();
      await expect(preview.locator("#review-target")).toBeVisible();
      await expect(preview.locator("button[data-plannotator-marker]"))
        .toHaveCount(1);
      await fixture.page.getByRole("tab", {name: "Details"}).click();

      await fixture.page.getByRole("button", {name: "Edit tags"}).click();
      await fixture.page.getByRole("textbox", {name: "Tags"})
        .fill("inspection, polished");
      await fixture.page.getByRole("button", {name: "Save tags"}).click();
      await expect(fixture.page.getByText("polished", {exact: true})).toBeVisible();

      const fullScreen = viewerHeader(fixture.page).getByRole("button", {name: "Full screen"});
      await expect(fullScreen).toHaveAttribute("aria-keyshortcuts", "F");
      await fixture.page.locator(".as-preview-panel").focus();
      await fixture.page.keyboard.press("f");
      await expect(fixture.page.getByRole("button", {name: "Exit full screen"})).toBeVisible();
      await expect(fixture.page.getByRole("button", {name: "Annotate mode", exact: true}))
        .toHaveAttribute("aria-pressed", "true");
      await fixture.page.keyboard.press("Escape");
      const focusInteractMode = fixture.page.getByRole("button", {
        name: "Interact mode",
        exact: true,
      });
      await expect(focusInteractMode).toHaveAttribute("aria-pressed", "false");
      await focusInteractMode.click();
      const focusComments = fixture.page.getByRole("complementary", {name: "Comments"});
      await expect(focusComments).toBeHidden();
      await preview.locator("#review-native-action").click();
      const focusComposer = frame.getByPlaceholder("Add a comment...");
      await expect(focusComposer).toBeVisible();
      await focusComposer.fill("Keep the full-screen canvas uninterrupted.");
      await frame.getByRole("button", {name: "Save"}).click();
      await expect(focusComments).toBeHidden();
      await fixture.page.locator(".as-preview-panel").focus();
      await fixture.page.keyboard.press("]");
      await expect(focusComments).toBeVisible();
      await expect(focusComments.getByRole("article").filter({
        hasText: "Make the release status easier to scan.",
      })).toBeVisible();
      await expect(focusComments.getByRole("article").filter({
        hasText: "Keep the full-screen canvas uninterrupted.",
      })).toBeVisible();
      const focusAccessibility = await new AxeBuilder({page: fixture.page})
        .exclude(reviewFrameSelector)
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      expect(focusAccessibility.violations).toEqual([]);
      const viewerControls = fixture.page.getByRole("toolbar", {
        name: "Artifact viewer controls",
      });
      const viewerControlsElement = fixture.page.locator(".as-focus-controls");
      const viewerControlsDock = fixture.page.locator(".as-focus-controls-dock");
      // The annotate toggle's state shows even while the controls are tucked
      // away and hidden from the accessibility tree.
      const focusAnnotateToggle = fixture.page.locator(
        ".as-focus-controls button[aria-pressed]",
      );
      const restoreViewerControls = fixture.page.getByRole("button", {
        name: "Show viewer controls",
      });
      await viewerControls.hover();
      await fixture.page.getByRole("button", {name: "Hide viewer controls"}).click();
      await expect(restoreViewerControls).toHaveCSS("opacity", "0");
      await expect(restoreViewerControls).toHaveCSS("pointer-events", "none");
      await expect(viewerControlsDock).toHaveCSS("width", "12px");
      await expect(viewerControlsElement).toHaveCSS("pointer-events", "none");
      await expect(viewerControlsElement).toHaveCSS("visibility", "hidden");
      await fixture.page.keyboard.press("Escape");
      await expect(focusComments).toBeHidden();
      await expect(focusAnnotateToggle).toHaveAttribute("aria-pressed", "true");
      await fixture.page.keyboard.press("Escape");
      await expect(focusAnnotateToggle).toHaveAttribute("aria-pressed", "false");
      expect(await fixture.page.evaluate(() => ({x: window.scrollX, y: window.scrollY})))
        .toEqual({x: 0, y: 0});
      // The tucked-away controls leave the whole window to the canvas, which
      // needs the sidebar to have stepped aside for full screen.
      await expect(sidebarState(fixture.page)).toHaveAttribute("data-state", "collapsed");
      await expect.poll(async () => {
        const canvas = await fixture.page.locator(".as-preview-panel__body").boundingBox();
        return {width: canvas?.width, x: canvas?.x};
      }).toEqual({width: fixture.page.viewportSize()?.width, x: 0});
      await viewerControlsDock.hover();
      await expect(restoreViewerControls).toHaveCSS("opacity", "1");
      await restoreViewerControls.click();
      await expect(viewerControls).toBeVisible();
      await viewerControls.hover();
      await fixture.page.getByRole("button", {name: "Hide viewer controls"}).click();
      await fixture.page.mouse.move(100, 100);
      await expect(restoreViewerControls).toHaveCSS("opacity", "0");
      await fixture.page.keyboard.press("Control+Backslash");
      await expect(viewerControlsDock).toHaveAttribute("data-collapsed", "false");
      await expect(viewerControls).toBeVisible();
      await expect(sidebarState(fixture.page)).toHaveAttribute("data-state", "collapsed");
      await expect(fixture.page.getByRole("complementary", {name: "Artifact inspector"}))
        .toBeHidden();
      const focusedCanvas = await fixture.page.locator(".as-preview-panel__body")
        .boundingBox();
      expect(focusedCanvas).not.toBeNull();
      expect(focusedCanvas?.height).toBe(fixture.page.viewportSize()?.height);
      expect(await fixture.page.locator(".as-preview-panel__body")
        .evaluate((node) => getComputedStyle(node).backgroundImage)).toBe("none");
      await expect(preview.getByRole("heading", {name: "Review preview content"}))
        .toBeVisible();
      await fixture.page.keyboard.press("Escape");
      await expect(fixture.page.getByRole("button", {name: "Full screen"})).toBeVisible();
      await expect(sidebarState(fixture.page)).toHaveAttribute("data-state", "expanded");
      await fixture.page.keyboard.press("f");
      await expect(fixture.page.getByRole("button", {name: "Exit full screen"})).toBeVisible();
      await fixture.page.keyboard.press("f");
      await expect(fixture.page.getByRole("button", {name: "Full screen"})).toBeVisible();

      await fixture.page.getByRole("tab", {name: /Files/u}).click();
      await expect(fixture.page.getByText("index.html", {exact: true})).toBeVisible();
      await fixture.page.getByRole("tab", {name: /Versions/u}).click();
      await expect(fixture.page.getByRole("button", {name: /Version 2/u}))
        .toHaveAttribute("aria-current", "true");
      await expect(fixture.page.locator('a[href^="/projects"], a[href^="/workbench"]'))
        .toHaveCount(0);

      await expect(fixture.page.getByRole("complementary", {name: "Review navigation"}))
        .toHaveCount(0);
      const projectPicker = fixture.page.getByRole("button", {
        name: "Current project: Default",
      });
      await expect(projectPicker).toBeVisible();
      await projectPicker.click();
      await expect(fixture.page.getByRole("listbox", {name: "Projects"}))
        .toBeVisible();
      await fixture.page.getByRole("button", {name: "New project"}).click();
      const projectPopover = fixture.page.getByRole("dialog", {name: "Create project"});
      const projectNameInput = projectPopover.getByLabel("Project name");
      await expect(projectNameInput).toBeFocused();
      await expect(projectPopover.getByText("Create a new place for related artifacts."))
        .toHaveCount(0);
      await projectNameInput.fill("Review project");
      await projectPopover.getByRole("button", {name: "Create project"}).click();
      await expect(fixture.page.getByRole("button", {
        name: "Current project: Review project",
      })).toBeVisible();
      await fixture.page.getByRole("button", {
        name: "Current project: Review project",
      }).click();
      await fixture.page.getByRole("option", {name: "Default"}).click();
      // Switching project lands on that project's gallery.
      await expect(fixture.page.getByRole("button", {name: "Current project: Default"}))
        .toBeVisible();
      await expect(
        fixture.page.getByRole("heading", {exact: true, level: 1, name: "Artifacts"}),
      ).toBeVisible();
      const sidebarBox = await fixture.page.locator('[data-slot="sidebar-container"]')
        .boundingBox();
      expect(sidebarBox?.x).toBe(0);
      await sidebarToggle(fixture.page).click();
      await expect(sidebarState(fixture.page)).toHaveAttribute("data-state", "collapsed");
      await sidebarToggle(fixture.page).click();
      await expect(sidebarState(fixture.page)).toHaveAttribute("data-state", "expanded");
      await expect(fixture.page).toHaveURL(/\/review\?project=prj_default/u);

      // Counts and tags come from the refreshed list. A tag that was just
      // replaced shows on its row and becomes a filter.
      await galleryRefresh.click();
      await expect(galleryRefresh).toContainText("Refreshed");
      await expect(reviewFixtureRow).toContainText("2 versions");
      await expect(reviewFixtureRow).toContainText("2 comments");
      await expect(reviewFixtureRow.getByText("polished", {exact: true})).toBeVisible();
      await expect(reviewFixtureRow.getByText("prototype", {exact: true})).toHaveCount(0);

      const catalogFilters = fixture.page.getByRole("button", {name: /^Filter artifacts/u});
      await catalogFilters.click();
      const filterMenu = fixture.page.getByRole("menu", {name: /^Filter artifacts/u});
      const catalogSort = fixture.page.getByRole("combobox", {name: "Sort artifacts"});
      await filterMenu.getByRole("menuitemradio", {name: "With comments"}).click();
      await expect(galleryRow(fixture.page, "Review fixture")).toBeVisible();
      await expect(galleryRow(fixture.page, "Quiet fixture")).toHaveCount(0);
      await filterMenu.getByRole("menuitemradio", {name: "No comments"}).click();
      await expect(galleryRow(fixture.page, "Quiet fixture")).toBeVisible();
      await expect(galleryRow(fixture.page, "Review fixture")).toHaveCount(0);
      await filterMenu.getByRole("menuitemradio", {name: "All artifacts"}).click();
      await filterMenu.getByRole("menuitemcheckbox", {name: "quiet"}).click();
      await expect(galleryRow(fixture.page, "Quiet fixture")).toBeVisible();
      await expect(galleryRow(fixture.page, "Review fixture")).toHaveCount(0);
      await filterMenu.getByRole("menuitemcheckbox", {name: "inspection"}).click();
      await expect(galleryRow(fixture.page, "Quiet fixture")).toBeVisible();
      await expect(galleryRow(fixture.page, "Review fixture")).toBeVisible();
      await filterMenu.getByRole("menuitemcheckbox", {name: "quiet"}).click();
      await expect(galleryRow(fixture.page, "Quiet fixture")).toHaveCount(0);
      await expect(galleryRow(fixture.page, "Review fixture")).toBeVisible();
      await filterMenu.getByRole("menuitemcheckbox", {name: "Any tag"}).click();
      await expect(galleryRow(fixture.page, "Quiet fixture")).toBeVisible();
      await expect(filterMenu.getByRole("menuitemcheckbox", {name: "polished"})).toBeVisible();
      await fixture.page.keyboard.press("Escape");
      await expect(filterMenu).toBeHidden();
      await catalogSort.click();
      await fixture.page.getByRole("option", {name: "Most comments"}).click();
      await expect(galleryRows(fixture.page).first()).toContainText("Review fixture");
      await catalogSort.click();
      await fixture.page.getByRole("option", {name: "Newest first"}).click();
      await expect(galleryRows(fixture.page).first()).toContainText("Quiet fixture");

      // The gallery has no artifact shortcuts, so typing in search is safe
      // and no artifact opens.
      const searchArtifacts = fixture.page.getByRole("searchbox", {
        name: "Search artifacts",
      });
      await searchArtifacts.focus();
      await fixture.page.keyboard.press("j");
      await expect(searchArtifacts).toHaveValue("j");
      expect(new URL(fixture.page.url()).searchParams.has("artifact")).toBe(false);
      await searchArtifacts.fill("");
      await expect(galleryRow(fixture.page, "Quiet fixture")).toBeVisible();

      await openArtifactFromGallery(fixture.page, "Review fixture");

      const accessibility = await new AxeBuilder({page: fixture.page})
        .exclude(reviewFrameSelector)
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      expect(accessibility.violations).toEqual([]);

      // A freshly opened artifact starts in annotate mode.
      await expect(fixture.page.getByRole("button", {name: /^Annotate mode:/u}))
        .toHaveAttribute("aria-pressed", "true");
      await preview.locator("#review-theme-target").click();
      const themedCommentPopover = frame.locator('[data-comment-popover="true"]');
      await expect(themedCommentPopover).toBeVisible();
      const themedCommentSurface = frame.locator([
        '[data-comment-popover="true"] [role="dialog"]',
        '[data-comment-popover="true"].bg-popover',
      ].join(", "));
      await expect(themedCommentSurface).toBeVisible();
      const darkPopoverBackground = await themedCommentSurface.evaluate(
        (node) => getComputedStyle(node).backgroundColor,
      );
      await chooseAccountMenuItem(fixture.page, "Use light theme");
      await expect(fixture.page.locator("html")).toHaveAttribute("data-review-theme", "dawn");
      await expect(frame.locator("html")).toHaveClass(/\blight\b/u);
      await expect(themedCommentPopover).toBeVisible();
      await expect.poll(() => themedCommentSurface.evaluate(
        (node) => getComputedStyle(node).backgroundColor,
      )).not.toBe(darkPopoverBackground);
      // The frame's popover color is the shell's secondary surface.
      const shellPopoverColor = await fixture.page.locator("html").evaluate(
        (node) => getComputedStyle(node).getPropertyValue("--secondary").trim(),
      );
      await expect.poll(() => frame.locator("html").evaluate(
        (node) => getComputedStyle(node).getPropertyValue("--popover").trim(),
      )).toBe(shellPopoverColor);
      await frame.getByPlaceholder("Add a comment...").press("Escape");
      await expect(themedCommentPopover).toBeHidden();
      const lightAccessibility = await new AxeBuilder({page: fixture.page})
        .exclude(reviewFrameSelector)
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      expect(lightAccessibility.violations).toEqual([]);
      await expect(preview.getByRole("heading", {name: "Review preview content"}))
        .toBeVisible();

      const documentIdentity = crypto.randomUUID();
      const review = fixture.page.locator("#review-root");
      await review.evaluate((node, identity) => {
        if (node instanceof HTMLElement) node.dataset["documentIdentity"] = identity;
      }, documentIdentity);
      const reviewHomeLink = fixture.page.getByRole("link", {name: "Artifact Server"});
      await reviewHomeLink.click();
      const homeOverlay = fixture.page.getByRole("dialog", {name: "Artifact Server home"});
      await expect(homeOverlay).toBeVisible();
      // The dialog also shows the agent logos; the animation is the product mark.
      const homeAnimation = homeOverlay.locator('img[src*="artifact-server"]');
      await expect(homeAnimation).toBeVisible();
      const homeAnimationGeometry = await homeAnimation.evaluate((node) => ({
        height: node.getBoundingClientRect().height,
        naturalWidth: node instanceof HTMLImageElement ? node.naturalWidth : 0,
        width: node.getBoundingClientRect().width,
      }));
      expect(homeAnimationGeometry.width).toBeLessThanOrEqual(672);
      expect(homeAnimationGeometry.height).toBeGreaterThan(0);
      expect(homeAnimationGeometry.naturalWidth).toBeGreaterThan(0);
      await expect(homeOverlay.getByRole("link", {name: /^GitHub\s*Source and releases$/u}))
        .toHaveAttribute("href", "https://github.com/plannotator/artifact-server");
      await expect(homeOverlay.getByRole("link", {name: /Homepage/u}))
        .toHaveAttribute("href", "https://artifactserver.com/");
      await expect(homeOverlay.getByRole("link", {name: /Docs/u}))
        .toHaveAttribute("href", "https://artifactserver.com/docs/");
      await expect(homeOverlay.getByRole("link", {name: /Connect agents/u}))
        .toHaveAttribute("href", "https://artifactserver.com/docs/connect-agents/");
      await fixture.page.waitForTimeout(1_200);
      await expect(homeOverlay).toBeVisible();
      await fixture.page.keyboard.press("Escape");
      await expect(homeOverlay).toHaveCount(0);
      await expect(reviewHomeLink).toBeFocused();

      await reviewHomeLink.click();
      await homeOverlay.getByRole("button", {name: "Close"}).click();
      await expect(homeOverlay).toHaveCount(0);
      expect(new URL(fixture.page.url()).pathname).toBe("/review");
      expect(new URL(fixture.page.url()).searchParams.get("artifact")).not.toBeNull();
      expect(new URL(fixture.page.url()).searchParams.get("version")).not.toBeNull();
      expect(await review.evaluate((node) =>
        node instanceof HTMLElement ? node.dataset["documentIdentity"] : undefined
      )).toBe(documentIdentity);
      await expect(fixture.page.getByRole("link", {name: "Artifact Server"}))
        .toBeVisible();
      await expect(
        fixture.page.getByRole("heading", {exact: true, level: 1, name: "Review fixture"}),
      ).toBeVisible();
      await expect(preview.getByRole("heading", {name: "Review preview content"}))
        .toBeVisible();

      await fixture.page.emulateMedia({reducedMotion: "reduce"});
      await fixture.page.goto(
        `${fixture.server.baseUrl}/review?project=prj_default&artifact=${first.body.artifact.id}`,
      );
      await inspector.getByRole("button", {name: "Close inspector"}).click();
      await expect(fixture.page.getByRole("complementary", {name: "Artifact inspector"}))
        .toHaveCount(0);
      await viewerHeader(fixture.page).getByRole("button", {name: "Open inspector"}).click();
      await expect(fixture.page.getByRole("complementary", {name: "Artifact inspector"}))
        .toBeVisible();
      await fixture.page.getByRole("button", {name: "Full screen"}).click();
      await fixture.page.getByRole("button", {name: /Comments/u}).click();
      expect(await fixture.page.locator(".as-focus-comments").evaluate((node) => ({
        transform: getComputedStyle(node).transform,
        transitionProperty: getComputedStyle(node).transitionProperty,
      }))).toEqual({transform: "none", transitionProperty: "opacity"});
      const reducedViewerControls = fixture.page.locator(".as-focus-controls");
      await reducedViewerControls.hover();
      await fixture.page.getByRole("button", {name: "Hide viewer controls"}).click();
      await expect(reducedViewerControls).toHaveCSS("opacity", "0");
      expect(await reducedViewerControls.evaluate((node) =>
        getComputedStyle(node).transform
      )).toBe("none");
      await fixture.page.keyboard.press("Control+Backslash");
      await expect(fixture.page.locator(".as-focus-controls-dock"))
        .toHaveAttribute("data-collapsed", "false");
      await fixture.page.getByRole("button", {name: "Exit full screen"}).click();
      await fixture.page.getByRole("link", {name: "Artifact Server"}).click();
      const reducedHomeOverlay = fixture.page.getByRole("dialog", {name: "Artifact Server home"});
      await expect(reducedHomeOverlay).toBeVisible();
      await fixture.page.keyboard.press("Escape");
      await expect(reducedHomeOverlay).toHaveCount(0);
      expect(new URL(fixture.page.url()).pathname).toBe("/review");

    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("CMT-015-B CMT-015-F: settings names the active project, and going back returns to the same project and artifact", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const project = await createProject(fixture, "Navigation state project");
      const artifact = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><title>Navigation state</title><h1>Preserved review context</h1>",
        idempotencyKey: "frontend-review-settings-return",
        name: "Navigation state artifact",
        projectId: project.id,
      });
      const reviewUrl = `/review?${new URLSearchParams({
        artifact: artifact.body.artifact.id,
        project: project.id,
        version: artifact.body.version.id,
      })}`;

      await localLogin(fixture);
      await fixture.page.goto(`${fixture.server.baseUrl}${reviewUrl}`);
      const activeProject = fixture.page.getByRole("button", {
        name: "Current project: Navigation state project",
      });
      await expect(activeProject).toBeVisible();
      await expect(fixture.page.getByRole("heading", {
        exact: true,
        level: 1,
        name: "Navigation state artifact",
      })).toBeVisible();
      const canonicalReviewLocation = new URL(fixture.page.url());
      const canonicalReviewUrl = `${canonicalReviewLocation.pathname}${canonicalReviewLocation.search}`;

      await activeProject.click();
      await fixture.page.getByRole("link", {name: "Project settings"}).click();
      await expect(fixture.page).toHaveURL(
        new RegExp(`/review/settings/projects/${project.id}$`, "u"),
      );
      await expect(fixture.page.getByRole("heading", {
        exact: true,
        level: 1,
        name: "Navigation state project",
      })).toBeVisible();

      await fixture.page.goBack();
      await expect(fixture.page).toHaveURL(`${fixture.server.baseUrl}${canonicalReviewUrl}`);
      await expect(fixture.page.getByRole("button", {
        name: "Current project: Navigation state project",
      })).toBeVisible();
      await expect(fixture.page.getByRole("heading", {
        exact: true,
        level: 1,
        name: "Navigation state artifact",
      })).toBeVisible();
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("PUB-013-B PUB-013-F: publication review links deep-link the exact version into full-screen commenting", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><html lang=\"en\"><title>Review link fixture</title><main><h1>Exact review handoff</h1></main></html>",
        idempotencyKey: "frontend-review-link-fixture",
        name: "Review link fixture",
      });
      await localLogin(fixture);
      await fixture.page.goto(published.body.links.review);

      await expect(fixture.page.getByRole("button", {name: "Exit full screen"}))
        .toBeVisible();
      await expect(sidebarState(fixture.page)).toHaveAttribute("data-state", "collapsed");
      expect(Object.fromEntries(new URL(fixture.page.url()).searchParams)).toEqual({
        artifact: published.body.artifact.id,
        project: published.body.artifact.projectId,
        version: published.body.version.id,
        view: "focus",
      });
      const focusViewerControls = fixture.page.getByRole("toolbar", {
        name: "Artifact viewer controls",
      });
      const focusViewerDock = fixture.page.locator(".as-focus-controls-dock");
      const restoreFocusViewer = fixture.page.getByRole("button", {
        name: "Show viewer controls",
      });
      await focusViewerControls.hover();
      await fixture.page.getByRole("button", {name: "Hide viewer controls"}).click();
      await expect(focusViewerDock).toHaveAttribute("data-hover-armed", "false");
      await expect(restoreFocusViewer).toHaveCSS("opacity", "0");
      // The tucked-away controls and comments drawer sit past the right edge;
      // hiding the controls must not scroll the viewer sideways to them.
      await expect.poll(() => fixture.page.locator('[data-slot="sidebar-inset"]')
        .evaluate((node) => node.scrollLeft)).toBe(0);
      await fixture.page.mouse.move(100, 160);
      await expect(focusViewerDock).toHaveAttribute("data-hover-armed", "true");
      const reviewViewport = fixture.page.viewportSize();
      expect(reviewViewport).not.toBeNull();
      await fixture.page.mouse.move((reviewViewport?.width ?? 0) - 160, 48);
      await expect(restoreFocusViewer).toHaveCSS("opacity", "1");
      await restoreFocusViewer.click();
      await expect(focusViewerControls).toBeVisible();
      await fixture.page.reload();
      await expect(fixture.page.getByRole("button", {name: "Exit full screen"}))
        .toBeVisible();

      await fixture.page.getByRole("button", {name: "Exit full screen"}).click();
      expect(new URL(fixture.page.url()).searchParams.has("view")).toBe(false);
      await fixture.page.goBack();
      await expect(fixture.page.getByRole("button", {name: "Exit full screen"}))
        .toBeVisible();
      expect(new URL(fixture.page.url()).searchParams.get("version"))
        .toBe(published.body.version.id);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("CMT-021-B CMT-021-F: Review downloads the selected version in standard and full-screen modes without opening comments", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const downloadFixture = await publishReviewDownloadFixture(fixture);
      await localLogin(fixture);
      await fixture.page.goto(
        `${fixture.server.baseUrl}/review?${new URLSearchParams({
          artifact: downloadFixture.artifactId,
          project: downloadFixture.projectId,
          version: downloadFixture.versionId,
        })}`,
      );

      const standardDownload = fixture.page.getByRole("link", {
        exact: true,
        name: "Download",
      });
      await expect(standardDownload).toBeVisible();
      // The control's description is its tooltip.
      await standardDownload.hover();
      await expect(fixture.page.getByText("Download 2 files as a ZIP", {exact: true}))
        .toBeVisible();
      const [standardArchive] = await Promise.all([
        fixture.page.waitForEvent("download"),
        standardDownload.click(),
      ]);
      expect(standardArchive.suggestedFilename()).toBe(
        "Download fixture - version 1.zip",
      );
      expectDownloadArchive(
        await requiredDownloadBytes(standardArchive.path()),
        downloadFixture.files,
      );

      await fixture.page.getByRole("button", {name: "Full screen"}).click();
      const focusControls = fixture.page.getByRole("toolbar", {
        name: "Artifact viewer controls",
      });
      const focusComments = fixture.page.getByRole("complementary", {
        name: "Comments",
      });
      await expect(focusComments).toBeHidden();
      const focusDownload = focusControls.getByRole("link", {
        exact: true,
        name: "Download",
      });
      await focusDownload.hover();
      await expect(fixture.page.getByText("Download 2 files as a ZIP", {exact: true}))
        .toBeVisible();
      const [focusArchive] = await Promise.all([
        fixture.page.waitForEvent("download"),
        focusDownload.click(),
      ]);
      expectDownloadArchive(
        await requiredDownloadBytes(focusArchive.path()),
        downloadFixture.files,
      );
      await expect(focusComments).toBeHidden();
      await expect(
        fixture.page.getByRole("button", {name: "Exit full screen"}),
      ).toBeVisible();
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("CMT-016-B CMT-016-F: an exact Review URL resolves outside the loaded catalog and never substitutes another version", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const target = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><html lang=\"en\"><title>Exact target</title><main><h1>Historical exact target</h1></main></html>",
        idempotencyKey: "frontend-exact-target-v1",
        name: "Exact target beyond catalog page",
      });
      await publishVersion(fixture.server, fixture.installation, {
        artifactId: target.body.artifact.id,
        content: "<!doctype html><html lang=\"en\"><title>Exact target latest</title><main><h1>Newer target content</h1></main></html>",
        expectedCurrentVersionId: target.body.version.id,
        idempotencyKey: "frontend-exact-target-v2",
      });
      const decoy = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><html lang=\"en\"><title>Catalog decoy</title><main><h1>Catalog decoy content</h1></main></html>",
        idempotencyKey: "frontend-exact-target-decoy",
        name: "Catalog decoy",
      });

      await localLogin(fixture);
      await fixture.page.route(/\/api\/v1\/artifacts\?.*/u, async (route) => {
        const response = await route.fetch();
        const body = z.object({
          artifacts: z.array(z.unknown()),
          nextCursor: z.string().nullable(),
        }).passthrough().parse(await response.json());
        const artifacts = body.artifacts.filter((item) => z.object({
          artifact: z.object({id: z.string()}),
        }).parse(item).artifact.id !== target.body.artifact.id);
        await route.fulfill({
          response,
          body: JSON.stringify({...body, artifacts, nextCursor: "next-catalog-page"}),
          contentType: "application/json",
        });
      });

      await fixture.page.goto(target.body.links.review);
      const preview = artifactPreview(fixture.page);
      await expect(preview.getByRole("heading", {name: "Historical exact target"}))
        .toBeVisible();
      await expect(preview.getByRole("heading", {name: "Newer target content"}))
        .toHaveCount(0);
      expect(new URL(fixture.page.url()).searchParams.get("version"))
        .toBe(target.body.version.id);
      await fixture.page.goto(decoy.body.links.review);
      await expect(preview.getByRole("heading", {name: "Catalog decoy content"}))
        .toBeVisible();
      await fixture.page.goBack();
      await expect(preview.getByRole("heading", {name: "Historical exact target"}))
        .toBeVisible();
      await fixture.page.reload();
      await expect(preview.getByRole("heading", {name: "Historical exact target"}))
        .toBeVisible();

      await fixture.page.getByRole("button", {name: "Exit full screen"}).click();
      await expect(fixture.page.getByRole("heading", {
        exact: true,
        level: 1,
        name: "Exact target beyond catalog page",
      })).toBeVisible();
      await expect(artifactSidebar(fixture.page).getByRole("link", {
        exact: true,
        name: "Catalog decoy",
      })).toBeVisible();

      const unavailable = new URL(target.body.links.review);
      unavailable.searchParams.set("version", "ver_missing-review-version");
      await fixture.page.goto(unavailable.toString());
      await expect(fixture.page.getByRole("heading", {name: "Review target unavailable"}))
        .toBeVisible();
      await expect(fixture.page.getByRole("heading", {name: "Catalog decoy content"}))
        .toHaveCount(0);
      expect(new URL(fixture.page.url()).searchParams.get("version"))
        .toBe("ver_missing-review-version");
      expect(decoy.body.artifact.id).not.toBe(target.body.artifact.id);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("CMT-018-B CMT-018-F: private historical HTML loads exact relative CSS, modules, images, fonts, and fetches", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const historical = await publishReviewMultifileFixture(fixture);
      await localLogin(fixture);
      const historicalReview = new URL(historical.body.links.review);
      historicalReview.searchParams.set("path", "site/pages/index.html");
      await fixture.page.goto(historicalReview.toString());

      const preview = artifactPreview(fixture.page);
      const assertMultifilePreview = async (): Promise<void> => {
        const title = preview.getByRole("heading", {name: "Private historical site"});
        await expect(title).toBeVisible();
        await expect(title).toHaveCSS("color", "rgb(12, 34, 56)");
        await expect(preview.locator("html")).toHaveAttribute(
          "data-module",
          "module-ready",
        );
        await expect(preview.locator("html")).toHaveAttribute("data-font", "loaded");
        await expect(preview.locator("#release-status")).toHaveText("historical-data");
        await expect.poll(
          () => preview.locator("#relative-image").evaluate(
            (image: HTMLImageElement) => image.naturalWidth,
          ),
        ).toBeGreaterThan(0);
      };
      // Qualify the same exact multi-file version first while it is current,
      // then again after the artifact's current pointer has moved away.
      await assertMultifilePreview();
      await publishVersion(fixture.server, fixture.installation, {
        artifactId: historical.body.artifact.id,
        content: "<!doctype html><html lang=\"en\"><title>Current replacement</title><main><h1>Current replacement</h1></main></html>",
        expectedCurrentVersionId: historical.body.version.id,
        idempotencyKey: "frontend-private-multifile-v2",
      });
      await fixture.page.reload();
      await assertMultifilePreview();

      const resourceUrls = await preview.locator("html").evaluate(() =>
        performance.getEntriesByType("resource").map((entry) => entry.name)
      );
      const expectedPaths = [
        "/assets/pixel.png",
        "/data/release.json",
        "/site/scripts/app.js",
        "/site/scripts/status.js",
        "/site/styles/site.css",
      ];
      for (const expectedPath of expectedPaths) {
        const resourceUrl = resourceUrls.find((candidate) =>
          new URL(candidate).pathname === expectedPath
        );
        expect(resourceUrl, `missing ${expectedPath}`).toBeDefined();
        if (resourceUrl === undefined) continue;
        expect(new URL(resourceUrl).hostname).toMatch(/^review-[a-z0-9_-]+\.localhost$/u);
        expect(resourceUrl).not.toContain(historical.body.version.contentToken);
      }
      expect(new URL(fixture.page.url()).searchParams.get("version"))
        .toBe(historical.body.version.id);
      expect(new URL(fixture.page.url()).searchParams.get("path"))
        .toBe("site/pages/index.html");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("CMT-017-B CMT-017-F: Review shares the selected exact version and path before moving and raw links", async ({browser, browserName}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><html lang=\"en\"><title>Share fixture</title><main><h1>Share fixture</h1></main></html>",
        idempotencyKey: "frontend-review-share-fixture",
        name: "Share fixture",
        tags: ["sharing"],
      });
      const latest = await publishVersion(fixture.server, fixture.installation, {
        artifactId: published.body.artifact.id,
        content: "<!doctype html><html lang=\"en\"><title>Share fixture latest</title><main><h1>Share fixture latest</h1></main></html>",
        expectedCurrentVersionId: published.body.version.id,
        idempotencyKey: "frontend-review-share-fixture-v2",
      });
      const canInspectClipboard = browserName === "chromium";
      if (canInspectClipboard) {
        await fixture.context.grantPermissions(
          ["clipboard-read", "clipboard-write"],
          {origin: fixture.server.baseUrl},
        );
      }
      await localLogin(fixture);
      const exactReviewLink = new URL(published.body.links.review);
      exactReviewLink.searchParams.set("path", "index.html");
      await fixture.page.goto(
        `${fixture.server.baseUrl}/review?${new URLSearchParams({
          artifact: published.body.artifact.id,
          path: "index.html",
          project: published.body.artifact.projectId,
          version: published.body.version.id,
        })}`,
      );

      const headerActions = viewerHeader(fixture.page);
      const headerShare = headerActions.getByRole("button", {exact: true, name: "Share"});
      await expect(headerShare).toBeVisible();
      await expect(headerActions.getByRole("button", {name: "Full screen"})).toBeVisible();

      await headerShare.click();
      const share = fixture.page.getByRole("dialog", {name: "Share artifact"});
      await expect(share.getByRole("heading", {name: "Share fixture"})).toBeVisible();
      await expect(share.getByText("Exact version · Version 1", {exact: true})).toBeVisible();
      await expect(share.getByRole("textbox", {name: "Review and comment"}))
        .toHaveValue(exactReviewLink.toString());
      await expect(share.getByRole("textbox", {name: "Latest"}))
        .toHaveValue(published.body.links.artifact);
      await expect(share.getByText(
        "People with access to this Artifact Server can review this exact version.",
        {exact: true},
      )).toBeVisible();
      await expect(share.getByRole("textbox", {name: "Raw"}))
        .toHaveValue(published.body.links.version);
      await expect(share.getByText("Moves when a new version is published", {exact: true}))
        .toBeVisible();
      const shareAccessibility = await new AxeBuilder({page: fixture.page})
        .exclude(reviewFrameSelector)
        // Base UI gives its invisible Safari focus guards a button role only
        // in WebKit. They are focus-management sentinels, not user commands.
        .exclude("[data-base-ui-focus-guard]")
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      expect(shareAccessibility.violations).toEqual([]);
      if (canInspectClipboard) {
        await share.getByRole("button", {name: "Copy Review link"}).click();
        await expect(share.getByRole("button", {name: "Copied"})).toBeVisible();
        expect(await fixture.page.evaluate(() => navigator.clipboard.readText())).toBe(
          exactReviewLink.toString(),
        );
        await share.getByRole("button", {name: "Copy latest link"}).click();
        expect(await fixture.page.evaluate(() => navigator.clipboard.readText())).toBe(
          published.body.links.artifact,
        );
        await share.getByRole("button", {name: "Copy raw link"}).click();
        expect(await fixture.page.evaluate(() => navigator.clipboard.readText())).toBe(
          published.body.links.version,
        );
      }

      await expect(share.getByRole("img", {
        name: "Claude, Codex, Cursor, GitHub Copilot, Pi, and OpenCode",
      })).toBeVisible();
      if (canInspectClipboard) {
        await share.getByRole("button", {name: "Copy review prompt"}).click();
        await expect(share.getByRole("button", {name: "Prompt copied"})).toBeVisible();
        const agentPrompt = await fixture.page.evaluate(() => navigator.clipboard.readText());
        expect(agentPrompt).toContain("artifact_get");
        expect(agentPrompt).toContain("artifact_version_list");
        expect(agentPrompt).toContain("comment_create");
        expect(agentPrompt).toContain(published.body.artifact.projectId);
        expect(agentPrompt).toContain(published.body.artifact.id);
        expect(agentPrompt).toContain(published.body.version.id);
        expect(agentPrompt).toContain(exactReviewLink.toString());
        expect(agentPrompt).toContain(published.body.links.version);
        expect(agentPrompt).toContain(`${fixture.server.baseUrl}/mcp`);
        expect(agentPrompt).toContain("Authorization: Bearer <key>");
      }

      await share.getByRole("button", {name: "Connect MCP"}).click();
      await expect(share.getByRole("heading", {name: "Connect MCP"})).toBeVisible();
      await expect(share.getByText("Claude Code", {exact: true})).toBeVisible();
      await expect(share.getByText("Codex, Cursor, and other clients", {exact: true}))
        .toBeVisible();
      await expect(share.getByText("Without MCP", {exact: true})).toBeVisible();
      if (canInspectClipboard) {
        await share.getByRole("button", {name: "Copy Claude Code command"}).click();
        expect(await fixture.page.evaluate(() => navigator.clipboard.readText())).toBe(
          `claude mcp add --transport http artifact-server ${fixture.server.baseUrl}/mcp --header "Authorization: Bearer <key>"`,
        );
        await share.getByRole("button", {name: "Copy MCP server address"}).click();
        expect(await fixture.page.evaluate(() => navigator.clipboard.readText())).toBe(
          `${fixture.server.baseUrl}/mcp`,
        );
      }
      await share.getByRole("button", {name: "Back to Share"}).click();

      await share.getByRole("button", {name: "Manage access"}).click();
      await expect(share.getByRole("heading", {name: "Artifact access"})).toBeVisible();
      await share.getByRole("radio", {name: /Public link/u}).click();
      await share.getByRole("button", {name: "Save"}).click();
      await expect(share.getByText(
        /The latest raw artifact is public/u,
      )).toBeVisible();
      const accessRow = fixture.page.locator("dl").filter({hasText: "access"});
      await expect(accessRow.getByText("Public", {exact: true})).toBeVisible();
      await share.getByRole("button", {name: "Close Share"}).click();

      await fixture.page.getByRole("button", {name: "Full screen"}).click();
      const focusControls = fixture.page.getByRole("toolbar", {
        name: "Artifact viewer controls",
      });
      const focusShare = focusControls.getByRole("button", {exact: true, name: "Share"});
      const exitFullScreen = focusControls.getByRole("button", {name: "Exit full screen"});
      expect((await focusShare.boundingBox())?.x).toBeLessThan(
        (await exitFullScreen.boundingBox())?.x ?? 0,
      );
      await focusShare.click();
      await expect(share.getByRole("heading", {name: "Share fixture"})).toBeVisible();
      await expect(share.getByRole("textbox", {name: "Review and comment"}))
        .toHaveValue(exactReviewLink.toString());
      await expect(share.getByRole("textbox", {name: "Raw"}))
        .not.toHaveValue(latest.body.links.version);
      await share.getByRole("button", {name: "Close Share"}).click();
      await exitFullScreen.click();
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("PRV-001-B PRV-001-F PRV-002-B PRV-002-F PRV-004-B PRV-004-F PRV-005-B PRV-005-F: Artifact Server selects and settles exact image and video previews", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const media = await publishReviewMediaFixture(fixture);
      await localLogin(fixture);
      await fixture.page.goto(
        `${fixture.server.baseUrl}/review?${new URLSearchParams({
          artifact: media.artifactId,
          project: media.projectId,
          version: media.versionId,
        })}`,
      );
      await fixture.page.getByRole("tab", {name: /Files/u}).click();

      const selectImage = async (
        path: (typeof reviewImagePaths)[number],
      ): Promise<void> => {
        await selectInspectorFile(fixture.page, path);
        const image = fixture.page.getByRole("img", {
          name: `Review media fixture — ${path}`,
        });
        await expect(image).toBeVisible();
        await expect.poll(() => image.evaluate((node) =>
          node instanceof HTMLImageElement ? node.naturalWidth : 0
        )).toBeGreaterThan(0);
        expect(new URL(fixture.page.url()).searchParams.get("path")).toBe(path);
      };
      await selectImage(reviewImagePaths[0]);
      await selectImage(reviewImagePaths[1]);
      await selectImage(reviewImagePaths[2]);
      await selectImage(reviewImagePaths[3]);
      await selectImage(reviewImagePaths[4]);
      expect(await fixture.page.evaluate(() =>
        "__artifactSvgExecuted" in window
      )).toBe(false);

      await selectInspectorFile(fixture.page, "media/preview.png");
      await fixture.page.getByRole("button", {name: "Full screen"}).click();
      await expect(fixture.page.getByRole("img", {
        name: "Review media fixture — media/preview.png",
      })).toBeVisible();
      await expect(fixture.page.getByRole("button", {name: "Exit full screen"})).toBeVisible();
      await fixture.page.getByRole("button", {name: "Exit full screen"}).click();

      await selectInspectorFile(fixture.page, "media/clip.webm");
      const video = fixture.page.locator(
        'video[aria-label="Review media fixture — media/clip.webm"]',
      );
      await expect(video).toBeVisible();
      await expect.poll(() => video.evaluate((node) =>
        node instanceof HTMLVideoElement ? node.readyState : 0
      )).toBeGreaterThanOrEqual(1);
      await expect(video).toHaveAttribute("controls", "");
      await expect(video).toHaveAttribute("preload", "metadata");
      expect(await video.evaluate((node) => node instanceof HTMLVideoElement
        ? {autoplay: node.autoplay, paused: node.paused}
        : {autoplay: true, paused: false}
      ))
        .toEqual({autoplay: false, paused: true});

      await fixture.page.goBack();
      await expect(fixture.page).toHaveURL(/path=media%2Fpreview\.png/u);
      await expect(fixture.page.getByRole("img", {
        name: "Review media fixture — media/preview.png",
      })).toBeVisible();
      expect(new URL(fixture.page.url()).searchParams.get("version")).toBe(
        media.versionId,
      );

      await selectInspectorFile(fixture.page, "media/broken.png");
      await expect(fixture.page.getByRole("heading", {
        name: "Image preview unavailable",
      })).toBeVisible();
      const brokenFallback = fixture.page.getByRole("alert").filter({
        hasText: "Image preview unavailable",
      });
      await expect(brokenFallback.getByText("media/broken.png", {exact: true}))
        .toBeVisible();
      await expect(brokenFallback.getByText("image/png", {exact: true})).toBeVisible();
      await expect(fixture.page.getByRole("button", {name: "Retry preview"})).toBeVisible();
      await expect(fixture.page.getByRole("link", {name: "Download file"})).toBeVisible();

      await selectInspectorFile(fixture.page, "bundle/archive.zip");
      await expect(fixture.page.getByRole("heading", {
        name: "Preview not supported",
      })).toBeVisible();
      await expect(fixture.page.getByRole("alert").filter({
        hasText: "Preview not supported",
      }).getByText("application/zip", {exact: true})).toBeVisible();

      await fixture.page.goto(
        `${fixture.server.baseUrl}/review?${new URLSearchParams({
          artifact: media.artifactId,
          path: "missing/not-in-manifest.png",
          project: media.projectId,
          version: media.versionId,
        })}`,
      );
      await expect(fixture.page.getByRole("heading", {name: "File not found"}))
        .toBeVisible();
      await expect(fixture.page.getByText("missing/not-in-manifest.png", {exact: true}))
        .toBeVisible();
      await expect(fixture.page.getByText("Loading preview", {exact: true}))
        .toHaveCount(0);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("AUTH-023-B AUTH-026-B: local-owner access, projects, artifact opening, session recovery, and deep links work", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const privateArtifact = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><title>Private fixture</title><p>private browser content</p>",
        idempotencyKey: "frontend-browser-private",
        name: "Private fixture",
        tags: ["private"],
      });
      const publicArtifact = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "public_link",
        content: "<!doctype html><title>Public fixture</title><p>public browser content</p>",
        idempotencyKey: "frontend-browser-public",
        name: "Public fixture",
        tags: ["ready"],
      });

      await localLogin(fixture);
      await expect(galleryRow(fixture.page, "Private fixture")).toBeVisible();
      await expect(galleryRow(fixture.page, "Public fixture")).toBeVisible();

      await fixture.page.getByRole("searchbox", {name: "Search artifacts"}).fill("ready");
      await expect(galleryRow(fixture.page, "Public fixture")).toBeVisible();
      await expect(galleryRow(fixture.page, "Private fixture")).toHaveCount(0);
      await fixture.page.getByRole("searchbox", {name: "Search artifacts"}).fill("");
      await expect(galleryRow(fixture.page, "Private fixture")).toBeVisible();

      await openArtifactFromGallery(fixture.page, "Public fixture");
      const [publicPage] = await Promise.all([
        fixture.context.waitForEvent("page"),
        fixture.page.getByRole("button", {name: "Open raw artifact"}).click(),
      ]);
      await expect(publicPage.locator("body")).toContainText("public browser content");
      await publicPage.close();

      await artifactSidebar(fixture.page).getByRole("link", {
        exact: true,
        name: "Private fixture",
      }).click();
      await expect(fixture.page.getByRole("heading", {exact: true, level: 1, name: "Private fixture"}))
        .toBeVisible();
      const [privatePage] = await Promise.all([
        fixture.context.waitForEvent("page"),
        fixture.page.getByRole("button", {name: "Open raw artifact"}).click(),
      ]);
      await expect(privatePage.locator("body")).toContainText("private browser content");
      await privatePage.close();

      await expect(fixture.page).toHaveURL(
        new RegExp(`/review\\?project=prj_default&artifact=${privateArtifact.body.artifact.id}`, "u"),
      );
      await fixture.page.reload();
      await expect(fixture.page.getByRole("heading", {name: "Private fixture"})).toBeVisible();

      const cookies = await fixture.context.cookies();
      expect(cookies.some((cookie) => cookie.name === "artifact_session")).toBe(true);
      expect(await fixture.page.evaluate(() => document.cookie)).not.toContain("artifact_session");
      expect((await browserStorage(fixture.page)).indexedDatabaseNames).toEqual([]);

      await fixture.context.clearCookies();
      await fixture.page.reload();
      await expect(fixture.page.getByRole("heading", {name: "Private fixture"})).toBeVisible();
      await expect(fixture.page.getByRole("button", {name: "Log out"})).toHaveCount(0);

      expect(publicArtifact.body.artifact.projectId).toBe("prj_default");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("ADM-003-B ADM-003-F ADM-004-B ADM-004-F ADM-007-B ADM-007-F: Review owns artifact history, mutations, members, and API keys", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const first = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: `before\n${"x".repeat(270_000)}`,
        idempotencyKey: "frontend-workflow-first",
        mediaType: "text/plain; charset=utf-8",
        name: "Workflow fixture",
        path: "payload.txt",
        tags: ["draft"],
      });
      const second = await publishVersion(fixture.server, fixture.installation, {
        artifactId: first.body.artifact.id,
        content: `after\n${"y".repeat(270_000)}`,
        expectedCurrentVersionId: first.body.version.id,
        idempotencyKey: "frontend-workflow-second",
        mediaType: "text/plain; charset=utf-8",
        path: "payload.txt",
      });
      await createActionHistory(fixture, first.body.artifact.id, second.body.version.id);

      await localLogin(fixture);
      await fixture.page.goto(
        `${fixture.server.baseUrl}/review?project=prj_default&artifact=${first.body.artifact.id}`,
      );
      await expect(fixture.page.getByRole("heading", {exact: true, level: 1, name: "Workflow fixture"}))
        .toBeVisible();

      await fixture.page.getByRole("button", {name: "Edit tags"}).click();
      await fixture.page
        .getByRole("textbox", {name: "Tags"})
        .fill("approved, release");
      await fixture.page.getByRole("button", {name: "Save tags"}).click();
      await expect(fixture.page.getByText("approved", {exact: true})).toBeVisible();

      await fixture.page.getByRole("tab", {name: "Versions"}).click();
      await fixture.page.getByRole("button", {name: "Compare"}).click();
      await expect(fixture.page.getByRole("heading", {name: "Changed files"})).toBeVisible();
      await expect(
        fixture.page.getByRole("tabpanel", {name: "Compare"}).getByText("payload.txt", {exact: true}),
      ).toBeVisible();

      await fixture.page.getByRole("tab", {name: "Versions"}).click();
      await fixture.page.getByRole("button", {name: "Make current"}).click();
      await fixture.page.getByRole("alertdialog", {name: /^Make Version \d+ current\?$/u})
        .getByRole("button", {name: "Make current"}).click();
      await expect(fixture.page.getByText("current", {exact: true})).toBeVisible();

      await fixture.page.getByRole("tab", {name: "Activity"}).click();
      await expect(fixture.page.getByText("Restored version")).toBeVisible();
      await expect(fixture.page.getByText("Replaced tags").first()).toBeVisible();
      await expect(fixture.page.getByRole("button", {name: "Load more"})).toBeVisible();
      const activityItems = fixture.page.getByRole("list", {name: "Artifact activity"})
        .getByRole("listitem");
      await expect(activityItems).toHaveCount(50);
      await fixture.page.getByRole("button", {name: "Load more"}).click();
      await expect(activityItems).toHaveCount(56);

      await fixture.page.goto(`${fixture.server.baseUrl}/review/settings/members`);
      await fixture.page.getByRole("button", {name: "Admit member"}).click();
      await fixture.page.getByLabel("Display name").fill("Frontend member");
      await fixture.page.getByLabel("Email").fill("frontend-member@example.test");
      const admitDialog = fixture.page.getByRole("dialog", {name: "Admit member"});
      await admitDialog.getByRole("button", {name: "Admit member"}).click();
      await expect(admitDialog).toHaveCount(0);
      const memberRow = fixture.page.getByRole("row").filter({hasText: "Frontend member"});
      await expect(memberRow).toBeVisible();
      await memberRow.getByRole("button", {name: "Deactivate"}).click();
      const deactivateDialog = fixture.page.getByRole("alertdialog", {name: "Deactivate member"});
      await deactivateDialog.getByRole("button", {name: "Deactivate member"}).click();
      await expect(deactivateDialog).toHaveCount(0);
      await expect(memberRow.getByText("inactive", {exact: true})).toBeVisible();

      await fixture.page.getByRole("navigation", {name: "Settings"})
        .getByRole("link", {exact: true, name: "API keys"}).click();
      await fixture.page.getByRole("button", {name: "Issue API key"}).click();
      await fixture.page
        .getByRole("textbox", {name: "Name", exact: true})
        .fill("Browser workflow key");
      await fixture.page
        .getByLabel("Expires at", {exact: true})
        .fill("2099-01-01T00:00");
      await fixture.page
        .getByRole("checkbox", {name: /Read artifacts/u})
        .click();
      await fixture.page
        .getByRole("checkbox", {name: /Manage comments/u})
        .click();
      await fixture.page.getByRole("dialog", {name: "Issue API key"})
        .getByRole("button", {name: "Issue API key"}).click();
      const secret = fixture.page.locator("code").filter({hasText: "as_key_"});
      await expect(secret).toBeVisible();
      const secretValue = await secret.textContent();
      expect(secretValue).toMatch(/^as_key_/u);
      await fixture.page.getByRole("button", {name: "I stored it"}).click();
      await expect(fixture.page.getByText(secretValue ?? "missing-secret")).toHaveCount(0);
      expect(await browserStorage(fixture.page)).toEqual({
        indexedDatabaseNames: [],
        localStorageKeys: ["artifact-review-theme"],
        sessionStorageKeys: [],
      });

      const keyCard = fixture.page.getByRole("row").filter({hasText: "Browser workflow key"});
      await expect(keyCard.getByText("comment:write", {exact: true})).toBeVisible();
      await keyCard.getByRole("button", {name: "Rotate"}).click();
      await expect(fixture.page.locator("code").filter({hasText: "as_key_"})).toBeVisible();
      await fixture.page.getByRole("button", {name: "I stored it"}).click();
      await expect(keyCard.getByText("Revoked", {exact: true})).toBeVisible();

      await fixture.page.goto(
        `${fixture.server.baseUrl}/review?project=prj_default&artifact=${first.body.artifact.id}`,
      );
      await fixture.page.getByRole("button", {exact: true, name: "Delete artifact"}).click();
      const deleteDialog = fixture.page.getByRole("alertdialog", {name: "Delete Workflow fixture?"});
      await deleteDialog.getByRole("textbox", {name: "Artifact name"}).fill("Workflow fixture");
      await deleteDialog.getByRole("button", {name: "Delete artifact"}).click();
      await expect(fixture.page.getByRole("link", {name: /Workflow fixture/u})).toHaveCount(0);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("ADM-005-B ADM-005-F: administrators inventory public links across projects and retry stale bulk changes accessibly", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const first = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "public_link",
        content: "first public-link administration bytes",
        idempotencyKey: "frontend-public-links-first",
        name: "First public link",
      });
      const stale = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "public_link",
        content: "stale public-link administration bytes",
        idempotencyKey: "frontend-public-links-stale",
        name: "Stale public link",
      });
      const otherProject = await createProject(fixture, "Public links project");
      const other = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "public_link",
        content: "cross-project public-link administration bytes",
        idempotencyKey: "frontend-public-links-cross-project",
        name: "Cross-project public link",
        projectId: otherProject.id,
      });

      await localLogin(fixture);
      await fixture.page.goto(`${fixture.server.baseUrl}/review/settings/public-links`);
      await expect(fixture.page.getByRole("heading", {name: "Public links"})).toBeVisible();
      const firstRow = fixture.page.getByRole("row").filter({hasText: "First public link"});
      await expect(firstRow.getByText("Default", {exact: true})).toBeVisible();
      const crossProjectRow = fixture.page.getByRole("row").filter({
        hasText: "Cross-project public link",
      });
      await expect(
        crossProjectRow.getByText("Public links project", {exact: true}),
      ).toBeVisible();
      await expect(fixture.page.getByRole("button", {name: "Select all (3)"})).toBeVisible();
      await expect(fixture.page.locator("#main-content").getByText("Version 1", {exact: true}))
        .toHaveCount(3);
      const accessibility = await new AxeBuilder({page: fixture.page})
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      expect(accessibility.violations).toEqual([]);

      // The shell fills the window, so the page's own scroll container is the
      // main content area.
      await fixture.page.setViewportSize({height: 600, width: 1024});
      const mainContent = fixture.page.locator("#main-content");
      const settingsScrollRange = await mainContent.evaluate((element) => ({
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
      }));
      expect(settingsScrollRange.scrollHeight).toBeGreaterThan(settingsScrollRange.clientHeight);
      await mainContent.evaluate((element) => element.scrollTo(0, element.scrollHeight));
      expect(await mainContent.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      await mainContent.evaluate((element) => element.scrollTo(0, 0));

      const inventory = fixture.page.getByRole("table", {name: "Public links inventory"});
      expect(await inventory.evaluate((element) => element.scrollWidth - element.clientWidth))
        .toBe(0);
      const compactRowBox = await firstRow.boundingBox();
      expect(compactRowBox?.height).toBeLessThan(96);

      await fixture.page.setViewportSize({height: 720, width: 390});
      expect(await fixture.page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth
      )).toBe(0);
      expect(await inventory.evaluate((element) => element.scrollWidth - element.clientWidth))
        .toBe(0);
      await expect(firstRow.getByRole("link", {exact: true, name: "Open"})).toBeVisible();
      await expect(firstRow.getByRole("button", {name: "Make private"})).toBeVisible();

      const otherRow = fixture.page.getByRole("row").filter({
        hasText: "Cross-project public link",
      });
      await otherRow.getByRole("button", {name: "Make private"}).click();
      await fixture.page.getByRole("alertdialog")
        .getByRole("button", {exact: true, name: "Make private"}).click();
      await expect(otherRow).toHaveCount(0);

      await fixture.page.getByRole("checkbox", {name: "Select First public link"}).click();
      await fixture.page.getByRole("checkbox", {name: "Select Stale public link"}).click();
      await fixture.page.getByRole("button", {name: "Make 2 private"}).click();
      const staleUpdate = await publishVersion(fixture.server, fixture.installation, {
        artifactId: stale.body.artifact.id,
        content: "updated after the administrator selected the row",
        expectedCurrentVersionId: stale.body.version.id,
        idempotencyKey: "frontend-public-links-stale-update",
        projectId: "prj_default",
      });
      await fixture.page.getByRole("alertdialog")
        .getByRole("button", {exact: true, name: "Make private"}).click();

      // The sidebar still lists every artifact, so the inventory is read
      // inside the main content.
      await expect(fixture.page.getByText("1 link was not changed")).toBeVisible();
      await expect(fixture.page.getByText(/1 public link is now private/u)).toBeVisible();
      await expect(mainContent.getByText("First public link")).toHaveCount(0);
      await expect(inventory.getByRole("link", {name: "Stale public link"})).toBeVisible();
      await fixture.page.getByRole("button", {name: "Retry failed"}).click();
      await expect(fixture.page.getByRole("heading", {name: "No public links"})).toBeVisible();

      expect((await fetch(first.body.links.artifact, {redirect: "manual"})).status).toBe(401);
      expect((await fetch(other.body.links.artifact, {redirect: "manual"})).status).toBe(401);
      expect((await fetchVersion(fixture.server, staleUpdate.body.links.version)).status).toBe(401);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("ADM-002-B ADM-002-F ADM-006-B ADM-006-F: canonical routing, project settings, and hostile boundaries fail closed", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const first = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "public_link",
        content: "<!doctype html><title>Isolation fixture</title><p>content only</p>",
        idempotencyKey: "frontend-hostile-first",
        name: "Isolation fixture",
      });
      const otherProject = await createProject(fixture, "Other project");

      await localLogin(fixture);
      const shell = await fixture.page.request.get(`${fixture.server.baseUrl}/review`);
      expect(shell.status()).toBe(200);
      expect(shell.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(shell.headers()["referrer-policy"]).toBe("no-referrer");
      expect(shell.headers()["x-content-type-options"]).toBe("nosniff");
      expect(shell.headers()["cache-control"]).toBe("no-cache, must-revalidate");

      const apiFallback = await fixture.page.request.get(
        `${fixture.server.baseUrl}/api/v1/route-that-does-not-exist`,
      );
      expect(apiFallback.status()).toBe(404);
      expect(apiFallback.headers()["content-type"]).toContain("application/json");

      const noCsrf = await fixture.page.request.post(
        `${fixture.server.baseUrl}/api/v1/projects`,
        {data: {name: "Must not exist"}},
      );
      expect(noCsrf.status()).toBe(403);

      const crossedProject = await fixture.page.request.get(
        `${fixture.server.baseUrl}/api/v1/artifacts/${first.body.artifact.id}?projectId=${otherProject.id}`,
      );
      expect(crossedProject.status()).toBe(404);

      const contentUi = new URL("/projects", first.body.links.version);
      const isolated = await fixture.page.request.get(contentUi.toString());
      expect(isolated.status()).toBe(404);
      expect(isolated.headers()["content-type"]).toContain("application/json");

      await fixture.page.goto(`${fixture.server.baseUrl}/projects`);
      await expect(fixture.page).toHaveURL(/\/review\/settings\/projects$/u);
      await expect(fixture.page.getByRole("heading", {name: "Projects"})).toBeVisible();
      const defaultProjectRow = fixture.page.getByRole("row").filter({hasText: "Default"});
      await defaultProjectRow.getByRole("link", {name: "Settings"}).click();
      await expect(fixture.page.getByRole("heading", {name: "Project identity"})).toBeVisible();
      // The settings header is the shell's compact breadcrumb bar.
      const settingsBreadcrumb = fixture.page.getByRole("navigation", {name: "breadcrumb"});
      await expect(settingsBreadcrumb).toContainText("Settings");
      await expect(settingsBreadcrumb).toContainText("Project");
      const settingsHeaderBox = await fixture.page.locator("header")
        .filter({has: settingsBreadcrumb}).boundingBox();
      expect(settingsHeaderBox?.height).toBeLessThanOrEqual(48);
      const compactSettingsActions = [
        fixture.page.getByRole("button", {name: "Save name"}),
        fixture.page.getByRole("button", {name: "Archive project"}),
      ];
      const compactSettingsActionMetrics = await Promise.all(compactSettingsActions.map(async (action) => ({
        box: await action.boundingBox(),
        textTransform: await action.evaluate((element) => getComputedStyle(element).textTransform),
      })));
      for (const {box, textTransform} of compactSettingsActionMetrics) {
        expect(box?.height).toBeLessThanOrEqual(32);
        expect(textTransform).toBe("none");
      }
      const lifecycleBox = await fixture.page.getByLabel("Project lifecycle").boundingBox();
      const archiveBox = await fixture.page.getByRole("button", {name: "Archive project"}).boundingBox();
      expect(archiveBox?.width).toBeLessThan((lifecycleBox?.width ?? 0) / 2);
      await fixture.page.getByLabel("Project name").fill("Default renamed");
      await fixture.page.getByRole("button", {name: "Save name"}).click();
      await expect(fixture.page.getByRole("heading", {name: "Default renamed"})).toBeVisible();
      await fixture.page.getByRole("button", {name: "Archive project"}).click();
      await fixture.page.getByRole("alertdialog", {name: "Archive project?"})
        .getByRole("button", {name: "Archive project"}).click();
      await expect(
        fixture.page.getByLabel("Project lifecycle").getByRole("button", {name: "Unarchive project"}),
      ).toBeVisible();
      await expect(fixture.page.getByRole("alertdialog")).toHaveCount(0);
      await fixture.page.getByLabel("Project lifecycle").getByRole("button", {name: "Unarchive project"}).click();
      await fixture.page.getByRole("alertdialog", {name: "Unarchive project?"})
        .getByRole("button", {name: "Unarchive project"}).click();
      await expect(
        fixture.page.getByLabel("Project lifecycle").getByRole("button", {name: "Archive project"}),
      ).toBeVisible();
      await expect(fixture.page.getByRole("alertdialog")).toHaveCount(0);
      await expect(fixture.page.getByRole("dialog")).toHaveCount(0);
      const accessibility = await new AxeBuilder({page: fixture.page})
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      expect(accessibility.violations).toEqual([]);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("project bootstrap failures remain visible and local expiration bounds use wall-clock time", async ({browser}) => {
    const fixture = await startBrowserFixture(browser, {
      timezoneId: "America/Los_Angeles",
    });
    try {
      await fixture.page.clock.install({
        time: new Date("2026-08-16T12:34:00.000Z"),
      });
      await fixture.page.route("**/api/v1/projects", async (route) => {
        await route.fulfill({
          body: JSON.stringify({
            error: {
              code: "INTERNAL_ERROR",
              message: "Project storage is temporarily unavailable.",
            },
          }),
          contentType: "application/json",
          status: 500,
        });
      });
      await localLogin(fixture, false);
      await expect(fixture.page.getByRole("heading", {name: "Artifact Server unavailable"})).toBeVisible();
      await expect(fixture.page.getByRole("heading", {name: "No projects"})).toHaveCount(0);

      await fixture.page.unroute("**/api/v1/projects");
      await fixture.page.getByRole("button", {name: "Try again"}).click();
      await expect(fixture.page.getByRole("link", {name: "Artifact Server"})).toBeVisible();

      await fixture.page.goto(`${fixture.server.baseUrl}/review/settings/api-keys`);
      await fixture.page.getByRole("button", {name: "Issue API key"}).click();
      await expect(fixture.page.getByLabel("Expires at", {exact: true})).toHaveAttribute(
        "min",
        "2026-08-16T05:34",
      );
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});

async function publishReviewMultifileFixture(fixture: BrowserFixture) {
  const encoder = new TextEncoder();
  const imageBytes = await readFile(
    new URL("../../project/evidence/frontend-mvp/error-not-found.png", import.meta.url),
  );
  const fontBytes = await readFile(
    new URL("./fixtures/Inter-Bold.ttf", import.meta.url),
  );
  const files = [
    {
      bytes: encoder.encode(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Private historical site</title>
    <link rel="stylesheet" href="../styles/site.css">
  </head>
  <body>
    <main>
      <h1 id="multi-title">Private historical site</h1>
      <img alt="Relative pixel" id="relative-image" src="/assets/pixel.png">
      <p id="release-status">Loading</p>
    </main>
    <script src="../scripts/app.js" type="module"></script>
  </body>
</html>`),
      mediaType: "text/html; charset=utf-8",
      path: "site/pages/index.html",
    },
    {
      bytes: encoder.encode(`@font-face {
  font-family: "Review Lease Font";
  font-style: normal;
  font-weight: 700;
  src: url("../../assets/Inter-Bold.ttf") format("truetype");
}
#multi-title {
  color: rgb(12 34 56);
  font-family: "Review Lease Font", sans-serif;
  font-weight: 700;
}`),
      mediaType: "text/css; charset=utf-8",
      path: "site/styles/site.css",
    },
    {
      bytes: encoder.encode(`import {moduleStatus} from "./status.js";
const response = await fetch("../../data/release.json");
const release = await response.json();
document.documentElement.dataset.module = moduleStatus;
document.querySelector("#release-status").textContent = release.status;
await document.fonts.load('700 16px "Review Lease Font"');
document.documentElement.dataset.font = document.fonts.check('700 16px "Review Lease Font"')
  ? "loaded"
  : "missing";`),
      mediaType: "text/javascript; charset=utf-8",
      path: "site/scripts/app.js",
    },
    {
      bytes: encoder.encode('export const moduleStatus = "module-ready";'),
      mediaType: "text/javascript; charset=utf-8",
      path: "site/scripts/status.js",
    },
    {
      bytes: encoder.encode('{"status":"historical-data"}'),
      mediaType: "application/json; charset=utf-8",
      path: "data/release.json",
    },
    {
      bytes: imageBytes,
      mediaType: "image/png",
      path: "assets/pixel.png",
    },
    {
      bytes: fontBytes,
      mediaType: "font/ttf",
      path: "assets/Inter-Bold.ttf",
    },
  ] satisfies readonly TestSiteFile[];
  const upload = await createStagedUpload(
    fixture.server,
    fixture.installation,
    "site/pages/index.html",
    files,
  );
  await uploadEveryStagedFile(fixture.installation, upload.body, files);
  return commitStagedUpload(
    fixture.installation,
    upload.body,
    "frontend-private-multifile-v1",
    {
      accessSetting: "account_required",
      kind: "new_artifact",
      name: "Private multi-file history",
      tags: ["private", "multi-file"],
    },
  );
}

async function publishReviewMediaFixture(
  fixture: BrowserFixture,
): Promise<{
  readonly artifactId: string;
  readonly projectId: string;
  readonly versionId: string;
}> {
  const encoder = new TextEncoder();
  const files = [
    {
      bytes: encoder.encode(
        "<!doctype html><html lang=\"en\"><title>Media entry</title><p>Media fixture entry</p>",
      ),
      mediaType: "text/html; charset=utf-8",
      path: "index.html",
    },
    {
      bytes: Buffer.from(reviewPngBase64, "base64"),
      mediaType: "image/png",
      path: "media/preview.png",
    },
    {
      bytes: Buffer.from(reviewJpegBase64, "base64"),
      mediaType: "image/jpeg",
      path: "media/preview.jpg",
    },
    {
      bytes: Buffer.from(reviewWebpBase64, "base64"),
      mediaType: "image/webp",
      path: "media/preview.webp",
    },
    {
      bytes: Buffer.from(reviewGifBase64, "base64"),
      mediaType: "image/gif",
      path: "media/preview.gif",
    },
    {
      bytes: encoder.encode(
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16"><script>parent.__artifactSvgExecuted=true</script><rect width="24" height="16" fill="#4f46e5"/></svg>',
      ),
      mediaType: "image/svg+xml",
      path: "media/preview.svg",
    },
    {
      bytes: Buffer.from(reviewWebmBase64, "base64"),
      mediaType: "video/webm",
      path: "media/clip.webm",
    },
    {
      bytes: encoder.encode("not image bytes"),
      mediaType: "image/png",
      path: "media/broken.png",
    },
    {
      bytes: encoder.encode("not an archive"),
      mediaType: "application/zip",
      path: "bundle/archive.zip",
    },
  ] satisfies readonly TestSiteFile[];
  const upload = await createStagedUpload(
    fixture.server,
    fixture.installation,
    "index.html",
    files,
  );
  await uploadEveryStagedFile(fixture.installation, upload.body, files);
  const committed = await commitStagedUpload(
    fixture.installation,
    upload.body,
    "frontend-review-media-fixture",
    {
      accessSetting: "account_required",
      kind: "new_artifact",
      name: "Review media fixture",
      tags: ["media", "preview"],
    },
  );
  return {
    artifactId: committed.body.artifact.id,
    projectId: committed.body.artifact.projectId,
    versionId: committed.body.version.id,
  };
}

async function publishReviewDownloadFixture(
  fixture: BrowserFixture,
): Promise<{
  readonly artifactId: string;
  readonly files: readonly TestSiteFile[];
  readonly projectId: string;
  readonly versionId: string;
}> {
  const encoder = new TextEncoder();
  const files = [
    {
      bytes: encoder.encode(
        "<!doctype html><html lang=\"en\"><title>Download fixture</title><p>Exact export</p>",
      ),
      mediaType: "text/html; charset=utf-8",
      path: "index.html",
    },
    {
      bytes: encoder.encode("export const downloaded = true;\n"),
      mediaType: "text/javascript; charset=utf-8",
      path: "assets/app.js",
    },
  ] satisfies readonly TestSiteFile[];
  const upload = await createStagedUpload(
    fixture.server,
    fixture.installation,
    "index.html",
    files,
  );
  await uploadEveryStagedFile(fixture.installation, upload.body, files);
  const committed = await commitStagedUpload(
    fixture.installation,
    upload.body,
    "frontend-review-download-fixture",
    {
      accessSetting: "account_required",
      kind: "new_artifact",
      name: "Download fixture",
      tags: ["download"],
    },
  );
  return {
    artifactId: committed.body.artifact.id,
    files,
    projectId: committed.body.artifact.projectId,
    versionId: committed.body.version.id,
  };
}

async function requiredDownloadBytes(
  pendingPath: Promise<string | null>,
): Promise<Uint8Array> {
  const path = await pendingPath;
  if (path === null) {
    throw new Error("The browser did not retain the downloaded file.");
  }
  return readFile(path);
}

function expectDownloadArchive(
  archive: Uint8Array,
  expectedFiles: readonly TestSiteFile[],
): void {
  const decoded = unzipSync(archive);
  expect(Object.keys(decoded).toSorted()).toEqual(
    expectedFiles.map(({path}) => path).toSorted(),
  );
  for (const file of expectedFiles) {
    expect(decoded[file.path]).toEqual(file.bytes);
  }
}

async function createProject(
  fixture: BrowserFixture,
  name: string,
): Promise<{readonly id: string}> {
  const response = await fetch(`${fixture.server.baseUrl}/api/v1/projects`, {
    body: JSON.stringify({name}),
    headers: apiHeaders(fixture.installation, "frontend-browser-project"),
    method: "POST",
  });
  expect(response.status).toBe(201);
  return z.object({
    project: z.object({id: z.string()}),
  }).parse(await response.json()).project;
}

async function createActionHistory(
  fixture: BrowserFixture,
  artifactId: string,
  expectedCurrentVersionId: string,
): Promise<void> {
  const responses = await Promise.all(Array.from({length: 52}, (_, index) =>
    fetch(
      `${fixture.server.baseUrl}/api/v1/artifacts/${artifactId}/tags?projectId=prj_default`,
      {
        body: JSON.stringify({
          expectedCurrentVersionId,
          tags: [`history-${index}`],
        }),
        headers: apiHeaders(
          fixture.installation,
          `frontend-history-${String(index).padStart(3, "0")}`,
        ),
        method: "PATCH",
      },
    )
  ));
  expect(responses.every((response) => response.status === 200)).toBe(true);
}
