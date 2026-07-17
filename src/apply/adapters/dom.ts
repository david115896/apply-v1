// Reusable, defensive form-filling helpers shared by all adapters.
//
// The label-based resolver here is deliberately generic: it's the seed of the
// Tier-2 semantic filler. An ATS adapter mostly supplies a selector map; when a
// selector misses, we fall back to matching the field by its visible label.

import type { Page, Locator } from "playwright";

/** Try each selector in order; return the first that resolves to one element. */
export async function firstMatch(page: Page, selectors: string[]): Promise<Locator | null> {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if ((await loc.count().catch(() => 0)) > 0) return loc;
  }
  return null;
}

/** Find an input by its associated <label> text (case-insensitive contains). */
export async function byLabel(page: Page, patterns: RegExp[]): Promise<Locator | null> {
  for (const re of patterns) {
    const loc = page.getByLabel(re).first();
    if ((await loc.count().catch(() => 0)) > 0) return loc;
  }
  return null;
}

/**
 * Fill a text field. Returns true if a field was found and filled.
 * `selectors` are tried first (fast, precise); `labels` are the fallback.
 */
export async function fillText(
  page: Page,
  value: string,
  selectors: string[],
  labels: RegExp[] = [],
): Promise<boolean> {
  const loc = (await firstMatch(page, selectors)) ?? (await byLabel(page, labels));
  if (!loc) return false;
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  await loc.fill(value);
  return true;
}

/** Upload a file to a (possibly hidden) file input. */
export async function uploadFile(
  page: Page,
  filePath: string,
  selectors: string[],
): Promise<boolean> {
  const loc = await firstMatch(page, selectors);
  if (!loc) return false;
  await loc.setInputFiles(filePath);
  return true;
}

/** Screenshot the current page to a path; never throws. */
export async function snapshot(page: Page, filePath: string): Promise<string | null> {
  try {
    await page.screenshot({ path: filePath, fullPage: true });
    return filePath;
  } catch {
    return null;
  }
}
