// Greenhouse adapter (Tier 1).
//
// Greenhouse is the friendliest ATS to start with: stable, semantic markup and
// no forced account creation. The canonical fields below cover the standard
// application form. Custom per-job questions are left to the gate/Tier-2 path.
//
// IMPORTANT: selectors must be validated against a live Greenhouse form before
// enabling real submission. Greenhouse ships both the classic `boards.` and the
// newer `job-boards.` React board; the selector lists below intentionally cover
// both, and every field falls back to label matching. Treat the ids as a
// starting point, not gospel — verify against a real posting.

import type { AtsAdapter, AdapterResult, CanonicalProfile, FieldFillResult } from "../types.js";
import { fillText, uploadFile, snapshot, firstMatch } from "./dom.js";
import type { Page } from "playwright";
import path from "node:path";
import { config } from "../config.js";

interface FieldSpec {
  key: string;
  required: boolean;
  selectors: string[];
  labels: RegExp[];
  kind: "text" | "file";
}

const FIELDS: FieldSpec[] = [
  {
    key: "first_name",
    required: true,
    selectors: ["#first_name", "input[name='first_name']", "input[autocomplete='given-name']"],
    labels: [/first name/i],
    kind: "text",
  },
  {
    key: "last_name",
    required: true,
    selectors: ["#last_name", "input[name='last_name']", "input[autocomplete='family-name']"],
    labels: [/last name/i],
    kind: "text",
  },
  {
    key: "email",
    required: true,
    selectors: ["#email", "input[name='email']", "input[type='email']"],
    labels: [/email/i],
    kind: "text",
  },
  {
    key: "phone",
    required: false,
    selectors: ["#phone", "input[name='phone']", "input[type='tel']"],
    labels: [/phone/i],
    kind: "text",
  },
  {
    key: "resume_file",
    required: true,
    selectors: [
      "input[type='file'][id*='resume']",
      "input[type='file'][name*='resume']",
      "input[type='file']",
    ],
    labels: [/resume|cv/i],
    kind: "file",
  },
  {
    key: "linkedin_url",
    required: false,
    selectors: ["input[name*='linkedin' i]", "input[id*='linkedin' i]"],
    labels: [/linkedin/i],
    kind: "text",
  },
];

export class GreenhouseAdapter implements AtsAdapter {
  readonly id = "greenhouse" as const;

  matches(url: string): boolean {
    return /greenhouse\.io/i.test(url);
  }

  async fill(pageUnknown: unknown, profile: CanonicalProfile): Promise<AdapterResult> {
    const page = pageUnknown as Page;
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    const results: FieldFillResult[] = [];

    for (const spec of FIELDS) {
      const resolved = profile.get(spec.key);

      // No value available for this field.
      if (!resolved || resolved.value === null || resolved.needsInput) {
        // Probe whether the form even asks for it, so we don't over-report blockers.
        const present = (await firstMatch(page, spec.selectors)) !== null;
        results.push({
          key: spec.key,
          status: spec.required && present ? "missing" : "skipped",
          confidence: 0,
          note: resolved?.needsInput ? "flagged needs_input" : "no value",
        });
        continue;
      }

      try {
        if (spec.kind === "file") {
          const filePath = resolved.filePath ?? null;
          const ok = filePath ? await uploadFile(page, filePath, spec.selectors) : false;
          results.push({
            key: spec.key,
            status: ok ? "filled" : filePath ? "error" : "missing",
            confidence: ok ? resolved.confidence : 0,
            note: filePath ? undefined : "resume file not downloaded",
          });
        } else {
          const ok = await fillText(page, resolved.value, spec.selectors, spec.labels);
          results.push({
            key: spec.key,
            status: ok ? "filled" : spec.required ? "missing" : "skipped",
            confidence: ok ? resolved.confidence : 0,
          });
        }
      } catch (err) {
        results.push({
          key: spec.key,
          status: "error",
          confidence: 0,
          note: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const shotPath = path.join(config.artifactDir, `greenhouse-${Date.now()}.png`);
    const screenshotPath = await snapshot(page, shotPath);

    const formComplete = results.every(
      (r) => r.status === "filled" || r.status === "skipped",
    );

    return { ats: this.id, fields: results, formComplete, screenshotPath };
  }

  async submit(pageUnknown: unknown): Promise<{ ok: boolean; externalRef?: string | null }> {
    const page = pageUnknown as Page;
    const submitBtn = await firstMatch(page, [
      "#submit_app",
      "button[type='submit']",
      "input[type='submit']",
    ]);
    if (!submitBtn) return { ok: false };
    await submitBtn.click();
    // Greenhouse shows a confirmation heading on success; wait for it defensively.
    const confirmed = await page
      .getByText(/thank you|application (was )?submitted|received/i)
      .first()
      .waitFor({ timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    return { ok: confirmed, externalRef: null };
  }
}
