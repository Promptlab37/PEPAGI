// ═══════════════════════════════════════════════════════════════
// PEPAGI — Browser Automation Tool (Playwright)
// Requires: npm install playwright && npx playwright install chromium
// ═══════════════════════════════════════════════════════════════

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, Page } from "playwright";
import { Logger } from "../core/logger.js";
import { eventBus } from "../core/event-bus.js";
// SECURITY: SEC-28 — SSRF protection for browser navigation
import { validateUrl } from "../security/tool-guard.js";
// SECURITY: SEC-28 — DLP inspection for credential patterns in form fills
import { dlpEngine } from "../security/dlp-engine.js";

const logger = new Logger("Browser");

const SCREENSHOT_DIR = "/tmp/pepagi-browser";

// ─── Singleton browser instance ──────────────────────────────

let browserInstance: Browser | null = null;
let pageInstance: Page | null = null;

/**
 * Get (or create) the shared browser and page instances.
 * Uses dynamic import so playwright is optional at runtime.
 * @returns Object with browser and page, or null if playwright is unavailable.
 */
async function getBrowserAndPage(): Promise<{ browser: Browser; page: Page } | null> {
  try {
    const { chromium } = await import("playwright");

    if (!browserInstance) {
      logger.debug("Launching headless Chromium browser");
      browserInstance = await chromium.launch({ headless: true });
    }

    if (!pageInstance) {
      pageInstance = await browserInstance.newPage();
    }

    return { browser: browserInstance, page: pageInstance };
  } catch {
    logger.warn("Playwright not available — run: npx playwright install chromium");
    return null;
  }
}

/**
 * Close the shared browser instance and clean up singletons.
 */
export async function closeBrowser(): Promise<void> {
  try {
    if (browserInstance) {
      await browserInstance.close();
      logger.debug("Browser closed");
    }
  } catch (err) {
    logger.warn("Error closing browser", { error: String(err) });
  } finally {
    browserInstance = null;
    pageInstance = null;
  }
}

// MEM-01: Ensure the Chromium process is not orphaned when the Node process exits.
// OPUS: "exit" handlers must be synchronous — async closeBrowser() won't complete.
// Use SIGINT/SIGTERM which allow async cleanup, plus synchronous "exit" fallback
// that kills the browser process directly if it's still alive.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => { closeBrowser().catch(() => {}).finally(() => process.exit()); });
}
process.on("exit", () => {
  // Synchronous best-effort: Playwright's BrowserServer has .process() but the
  // Browser interface does not. Cast through unknown to attempt the kill — if the
  // method doesn't exist, the catch swallows it.
  try {
    // AUDIT: narrowed type from `as any` to `as unknown` with safe property access
    const instance = browserInstance as unknown as Record<string, unknown> | undefined;
    const processFn = typeof instance?.["process"] === "function" ? instance["process"] as () => { kill?: (sig: string) => void } : null;
    const proc = processFn?.();
    if (proc && typeof proc.kill === "function") proc.kill("SIGKILL");
  } catch { /* best-effort */ }
});

// ─── Action helpers ───────────────────────────────────────────

/**
 * Navigate to a URL and return the page title and final URL.
 * @param page - Playwright page instance
 * @param url - URL to navigate to
 */
async function actionNavigate(page: Page, url: string): Promise<string> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const title = await page.title();
  const finalUrl = page.url();
  return `Navigated to: ${finalUrl}\nTitle: ${title}`;
}

/**
 * Take a screenshot of the current page and save it to /tmp/pepagi-browser/.
 * @param page - Playwright page instance
 */
async function actionScreenshot(page: Page): Promise<string> {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  const filename = `screenshot_${Date.now()}.png`;
  const filePath = join(SCREENSHOT_DIR, filename);
  await page.screenshot({ path: filePath });
  return `Screenshot saved to: ${filePath}`;
}

/**
 * Extract visible text content from the current page, removing noise elements.
 * @param page - Playwright page instance
 */
async function actionExtractText(page: Page): Promise<string> {
  // SECURITY: SEC-28 — Filter hidden elements that could contain injection payloads
  // PerplexedBrowser: hidden HTML elements processed by agents as if visible
  const extractScript = `(function() {
    var removeSelectors = ['script', 'style', 'nav', 'footer', 'header', 'noscript', 'iframe', 'svg'];
    removeSelectors.forEach(function(tag) {
      document.querySelectorAll(tag).forEach(function(el) { el.parentNode && el.parentNode.removeChild(el); });
    });
    // SEC-28: Remove hidden elements (display:none, visibility:hidden, opacity:0, aria-hidden)
    document.querySelectorAll('*').forEach(function(el) {
      var style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' ||
          parseFloat(style.opacity) === 0 || el.getAttribute('aria-hidden') === 'true') {
        el.parentNode && el.parentNode.removeChild(el);
      }
    });
    // SEC-28: Remove elements with event handlers (onclick, onerror, onload, etc.)
    document.querySelectorAll('[onclick],[onerror],[onload],[onmouseover],[onfocus]').forEach(function(el) {
      el.removeAttribute('onclick');
      el.removeAttribute('onerror');
      el.removeAttribute('onload');
      el.removeAttribute('onmouseover');
      el.removeAttribute('onfocus');
    });
    var main = document.querySelector('main') || document.querySelector('article') || document.body;
    if (!main) return '';
    var raw = main.innerText || main.textContent || '';
    return raw.replace(/\\n{3,}/g, '\\n\\n').replace(/[ \\t]{2,}/g, ' ').trim().slice(0, 8000);
  })()`;
  const text = await page.evaluate(extractScript) as string;
  return text || "(No text content found)";
}

/**
 * Click an element identified by a CSS selector and wait for navigation to settle.
 * @param page - Playwright page instance
 * @param selector - CSS selector
 */
async function actionClick(page: Page, selector: string): Promise<string> {
  await page.click(selector);
  await page.waitForLoadState("domcontentloaded");
  const title = await page.title();
  return `Clicked "${selector}". Current page title: ${title}`;
}

/**
 * Fill an input field identified by a CSS selector with a value.
 * @param page - Playwright page instance
 * @param selector - CSS selector for the input
 * @param value - Value to fill in
 */
async function actionFill(page: Page, selector: string, value: string): Promise<string> {
  // SECURITY: SEC-28 — DLP inspection of form fill values (credential detection)
  const currentUrl = page.url();
  const dlpResult = dlpEngine.inspect(value, currentUrl);
  if (!dlpResult.allowed) {
    eventBus.emit({
      type: "security:blocked",
      taskId: "browser-fill",
      reason: `SEC-28: DLP blocked form fill: ${dlpResult.issues.join(", ")}`,
    });
    return `Form fill blocked by DLP: ${dlpResult.issues.join(", ")}`;
  }
  await page.fill(selector, value);
  return `Filled "${selector}" with value (redacted for security)`;
}

/**
 * Extract all hyperlinks from the current page.
 * @param page - Playwright page instance
 */
async function actionGetLinks(page: Page): Promise<string> {
  // FIX: use string-based evaluate to avoid DOM type issues and @ts-ignore
  const extractLinksScript = `(function() {
    return Array.from(document.querySelectorAll("a[href]"))
      .map(function(a) { return { text: (a.innerText || "").trim().slice(0, 80), href: a.href }; })
      .filter(function(l) { return l.href && l.href.startsWith("http"); })
      .slice(0, 50)
      .map(function(l) { return l.text ? l.text + " — " + l.href : l.href; });
  })()`;
  const links = await page.evaluate(extractLinksScript) as string[];
  if (!links.length) return "(No links found on page)";
  return links.join("\n");
}

// SEC-08: actionEvaluate() has been removed. Executing arbitrary agent-supplied
// JavaScript via page.evaluate() is an unsandboxed code-execution vulnerability.
// The evaluate case in the switch statement below returns a hard rejection instead.

// ─── Tool export ──────────────────────────────────────────────

export const browserTool = {
  name: "browser",
  description: "Control web browser: navigate, screenshot, extract text, click, fill forms.",
  parameters: [
    {
      name: "action",
      type: "string" as const,
      // SEC-08: "evaluate" removed from advertised actions — it is disabled for security.
      description: "Action: navigate, screenshot, extract_text, click, fill, get_links",
      required: true,
    },
    {
      name: "url",
      type: "string" as const,
      description: "URL to navigate to (for navigate action)",
      required: false,
    },
    {
      name: "selector",
      type: "string" as const,
      description: "CSS selector for click/fill actions",
      required: false,
    },
    {
      name: "value",
      type: "string" as const,
      description: "Value to fill (for fill action)",
      required: false,
    },
  ],
  // SEC-08: "script" parameter removed along with the evaluate action —
  // advertising it would invite agents to supply code even though execution is blocked.

  execute: async (params: Record<string, string>): Promise<{ success: boolean; output: string }> => {
    const action = params.action ?? "";
    if (!action) {
      return { success: false, output: "action parameter is required" };
    }

    const context = await getBrowserAndPage();
    if (!context) {
      return {
        success: false,
        output: "Browser not available. Run: npx playwright install chromium",
      };
    }

    const { page } = context;

    try {
      switch (action) {
        case "navigate": {
          const url = params.url ?? "";
          if (!url) return { success: false, output: "url parameter required for navigate" };
          // SECURITY: SEC-28 — Block private IPs and dangerous protocols
          const urlCheck = validateUrl(url);
          if (!urlCheck.valid) {
            return { success: false, output: `URL blocked: ${urlCheck.reason}` };
          }
          return { success: true, output: await actionNavigate(page, url) };
        }

        case "screenshot": {
          return { success: true, output: await actionScreenshot(page) };
        }

        case "extract_text": {
          return { success: true, output: await actionExtractText(page) };
        }

        case "click": {
          const selector = params.selector ?? "";
          if (!selector) return { success: false, output: "selector parameter required for click" };
          return { success: true, output: await actionClick(page, selector) };
        }

        case "fill": {
          const selector = params.selector ?? "";
          if (!selector) return { success: false, output: "selector parameter required for fill" };
          return { success: true, output: await actionFill(page, selector, params.value ?? "") };
        }

        case "get_links": {
          return { success: true, output: await actionGetLinks(page) };
        }

        // SEC-08: case "evaluate" removed entirely — accepting the action name at all
        // (even to reject it) still signals to agents that the surface exists.
        // The default branch below handles any attempt with a clear error message.

        default:
          return {
            success: false,
            output: `Unknown action: ${action}. Valid: navigate, screenshot, extract_text, click, fill, get_links`,
          };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("Browser tool error", { action, error: msg });
      // Reset page on error so next call gets a fresh one
      pageInstance = null;
      return { success: false, output: `Browser error: ${msg}` };
    }
  },
};
