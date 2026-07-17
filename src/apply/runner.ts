// Orchestrates one application attempt end to end:
//   navigate -> detect ATS -> adapter fills -> confidence gate -> (submit) -> persist
//
// The gate is the heart of the "no silent failures" stance: nothing is submitted
// unless every required field cleared the confidence threshold AND dry-run is off.

import type { AtsAdapter, ApplyResult, CanonicalProfile, JobRef, RunOutcome } from "./types.js";
import { acquireSession } from "./browser.js";
import { detectAts } from "./detect.js";
import { getAdapter } from "./adapters/registry.js";
import type { RunStore } from "./store.js";
import { config } from "./config.js";

export interface RunDeps {
  profile: CanonicalProfile;
  store: RunStore;
  /** Existing applications.id acting as the container for this run. */
  applicationId: string;
}

interface GateDecision {
  outcome: Extract<RunOutcome, "ready" | "needs_human">;
  blockers: string[];
}

/** Decide whether the filled form may be submitted. */
function runGate(adapterResult: {
  fields: { key: string; status: string; confidence: number }[];
}): GateDecision {
  const blockers: string[] = [];
  for (const f of adapterResult.fields) {
    if (f.status === "missing" || f.status === "error") blockers.push(f.key);
    else if (f.status === "filled" && f.confidence < config.confidenceThreshold) {
      blockers.push(`${f.key}(low-confidence)`);
    }
  }
  return blockers.length
    ? { outcome: "needs_human", blockers }
    : { outcome: "ready", blockers: [] };
}

export async function runApplication(job: JobRef, deps: RunDeps): Promise<ApplyResult> {
  const { profile, store, applicationId } = deps;
  const base: ApplyResult = {
    jobId: job.id,
    userId: profile.userId,
    ats: "unknown",
    outcome: "failed",
    blockers: [],
  };

  if (!job.apply_url) {
    return { ...base, error: "job has no apply_url" };
  }

  const runId = await store.startRun(applicationId);
  let steps = 0;
  const session = await acquireSession();

  try {
    await store.logStep(applicationId, `navigating to ${job.apply_url}`);
    await session.page.goto(job.apply_url, { waitUntil: "domcontentloaded" });
    steps++;

    const ats = await detectAts(job.apply_url, session.page);
    await store.logStep(applicationId, `detected ats=${ats}`);
    steps++;

    const adapter: AtsAdapter | null = getAdapter(ats);
    if (!adapter) {
      // Tier-2/Tier-3 fallback would slot in here. For v1, escalate cleanly.
      const result: ApplyResult = {
        ...base,
        ats,
        outcome: "needs_human",
        blockers: ["no-adapter-for-ats"],
      };
      await store.finishRun(runId, applicationId, result, steps);
      return result;
    }

    const adapterResult = await adapter.fill(session.page, profile);
    steps += adapterResult.fields.length;
    await store.logStep(
      applicationId,
      `filled ${adapterResult.fields.filter((f) => f.status === "filled").length}/` +
        `${adapterResult.fields.length} fields`,
    );

    const gate = runGate(adapterResult);

    // Dry-run never submits, regardless of gate result.
    if (config.dryRun || gate.outcome !== "ready") {
      const result: ApplyResult = {
        ...base,
        ats,
        outcome: config.dryRun && gate.outcome === "ready" ? "ready" : "needs_human",
        blockers: gate.blockers,
        adapter: adapterResult,
        screenshotPath: adapterResult.screenshotPath ?? null,
      };
      await store.logStep(
        applicationId,
        config.dryRun ? "dry-run: not submitting" : `gate blocked: ${gate.blockers.join(", ")}`,
      );
      await store.finishRun(runId, applicationId, result, steps);
      return result;
    }

    // Live submit.
    await store.logStep(applicationId, "gate passed — submitting");
    const submit = await adapter.submit(session.page);
    steps++;
    const result: ApplyResult = {
      ...base,
      ats,
      outcome: submit.ok ? "submitted" : "failed",
      blockers: [],
      adapter: adapterResult,
      screenshotPath: adapterResult.screenshotPath ?? null,
      externalRef: submit.externalRef ?? null,
      error: submit.ok ? undefined : "submit not confirmed",
    };
    await store.finishRun(runId, applicationId, result, steps);
    return result;
  } catch (err) {
    const result: ApplyResult = {
      ...base,
      outcome: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
    await store.logStep(applicationId, `error: ${result.error}`);
    await store.finishRun(runId, applicationId, result, steps);
    return result;
  } finally {
    await session.close();
  }
}
