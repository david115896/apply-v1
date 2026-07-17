// Browser lifecycle + session isolation.
//
// One Browser per worker process; one fresh BrowserContext per application. The
// context is the isolation boundary — its own cookies, storage, and (later) its
// own proxy — so parallel applications never leak sessions or accounts into each
// other. This is the single most important reliability property of the fleet.

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { config } from "./config.js";

let browserPromise: Promise<Browser> | null = null;

/** Lazily launch (or connect to) a single shared Browser for this process. */
function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = config.browserCdpUrl
      ? // Hosted provider (Browserbase / Steel / Hyperbrowser) via CDP.
        chromium.connectOverCDP(config.browserCdpUrl)
      : chromium.launch({
          headless: true,
          args: ["--disable-blink-features=AutomationControlled"],
        });
  }
  return browserPromise;
}

export interface Session {
  context: BrowserContext;
  page: Page;
  /** Always call this in a finally block — a leaked context is a leaked browser tab. */
  close(): Promise<void>;
}

/** Acquire an isolated session for one application attempt. */
export async function acquireSession(): Promise<Session> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    // A plain, current UA. Real stealth (fingerprint, proxy rotation) belongs in
    // a hosted provider, not hand-rolled here — see the README.
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 900 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);

  return {
    context,
    page,
    async close() {
      await context.close().catch(() => {});
    },
  };
}

/** Shut the shared browser down cleanly on worker exit. */
export async function shutdownBrowser(): Promise<void> {
  if (browserPromise) {
    const b = await browserPromise;
    await b.close().catch(() => {});
    browserPromise = null;
  }
}
