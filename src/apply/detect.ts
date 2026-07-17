// Tier-0: figure out which ATS we're looking at.
//
// URL patterns are the cheapest, most reliable signal and resolve the large
// majority of pages. DOM signals are a fallback for cases where the ATS is
// embedded on the company's own domain (iframe / script include).

import type { AtsId } from "./types.js";
import type { Page } from "playwright";

interface UrlRule {
  ats: AtsId;
  test: RegExp;
}

// Ordered most-specific first.
const URL_RULES: UrlRule[] = [
  { ats: "greenhouse", test: /(?:job-)?boards\.greenhouse\.io/i },
  { ats: "greenhouse", test: /greenhouse\.io\/embed/i },
  { ats: "lever", test: /jobs\.lever\.co/i },
  { ats: "ashby", test: /jobs\.ashbyhq\.com/i },
  { ats: "workday", test: /myworkdayjobs\.com/i },
  { ats: "smartrecruiters", test: /jobs\.smartrecruiters\.com/i },
  { ats: "icims", test: /\.icims\.com/i },
];

/** Fast path: classify from the URL alone. */
export function detectFromUrl(url: string): AtsId {
  for (const rule of URL_RULES) {
    if (rule.test.test(url)) return rule.ats;
  }
  return "unknown";
}

/**
 * Slower path: inspect the loaded DOM for embedded-ATS signatures. Only worth
 * running when the URL check returned "unknown" (e.g. a careers page that
 * iframes Greenhouse). Cheap, defensive selector probes — no interaction.
 */
export async function detectFromDom(page: Page): Promise<AtsId> {
  const signals: { ats: AtsId; selector: string }[] = [
    { ats: "greenhouse", selector: "iframe#grnhse_iframe, [id^='grnhse']" },
    { ats: "lever", selector: "form[action*='lever.co']" },
    { ats: "ashby", selector: "[class*='ashby'], iframe[src*='ashbyhq']" },
    { ats: "smartrecruiters", selector: "iframe[src*='smartrecruiters']" },
  ];
  for (const s of signals) {
    const found = await page.locator(s.selector).count().catch(() => 0);
    if (found > 0) return s.ats;
  }
  return "unknown";
}

/** Combined detection: URL first, DOM fallback. */
export async function detectAts(url: string, page: Page): Promise<AtsId> {
  const fromUrl = detectFromUrl(url);
  if (fromUrl !== "unknown") return fromUrl;
  return detectFromDom(page);
}
