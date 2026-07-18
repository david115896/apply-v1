// Run persistence, behind an interface.
//
// ConsoleRunStore is the default: it writes nothing to your DB, so dry runs during
// development don't create phantom `applications` rows. SupabaseRunStore targets
// your real columns and is ready to switch on once you've decided how to represent
// pre-submit state (see README — the `application_stage` enum has no draft value).

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ApplyResult, RunOutcome } from "./types.js";
import type { ProfileDataSource, UserRow, ResumeRow, AnswerRow } from "./canonical.js";
import { config } from "./config.js";

/** run_status enum on public.application_runs. */
type RunStatus = "queued" | "running" | "submitted" | "needs_human" | "failed";

function toRunStatus(outcome: RunOutcome): RunStatus {
  switch (outcome) {
    case "submitted":
      return "submitted";
    case "failed":
      return "failed";
    // "ready" (dry-run passed the gate) and "needs_human" both await a human /
    // the real-submit toggle, so both persist as needs_human. The detail note
    // distinguishes them. Consider adding a distinct enum value later.
    case "ready":
    case "needs_human":
    default:
      return "needs_human";
  }
}

export interface RunStore {
  /** Open a run row for an application; returns a run id. */
  startRun(applicationId: string): Promise<string>;
  /** Record a granular step (persisted as an application_event of type 'note'). */
  logStep(applicationId: string, message: string): Promise<void>;
  /** Close the run with its outcome. */
  finishRun(
    runId: string,
    applicationId: string,
    result: ApplyResult,
    stepsCompleted: number,
  ): Promise<void>;
}

/** Default store: structured console output, zero DB writes. */
export class ConsoleRunStore implements RunStore {
  async startRun(applicationId: string): Promise<string> {
    const id = `console-${Date.now()}`;
    console.log(`[run:start] app=${applicationId} run=${id}`);
    return id;
  }
  async logStep(applicationId: string, message: string): Promise<void> {
    console.log(`[run:step] app=${applicationId} ${message}`);
  }
  async finishRun(runId: string, _app: string, result: ApplyResult, steps: number): Promise<void> {
    console.log(
      `[run:finish] run=${runId} outcome=${result.outcome} steps=${steps} ` +
        `blockers=[${result.blockers.join(", ")}]`,
    );
  }
}

/** Writes to public.application_runs and public.application_events. */
export class SupabaseRunStore implements RunStore {
  constructor(private readonly db: SupabaseClient) {}

  async startRun(applicationId: string): Promise<string> {
    const { data, error } = await this.db
      .from("application_runs")
      .insert({
        application_id: applicationId,
        status: "running",
        claimed_by: config.workerId,
        claimed_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (error) throw error;
    return data.id as string;
  }

  async logStep(applicationId: string, message: string): Promise<void> {
    // The application_events.type enum is lifecycle-oriented; granular run steps
    // are recorded as 'note' with the message in `detail`.
    await this.db.from("application_events").insert({
      application_id: applicationId,
      type: "note",
      detail: message,
    });
  }

  async finishRun(
    runId: string,
    applicationId: string,
    result: ApplyResult,
    stepsCompleted: number,
  ): Promise<void> {
    const status = toRunStatus(result.outcome);
    await this.db
      .from("application_runs")
      .update({
        status,
        steps_completed: stepsCompleted,
        failure_reason:
          result.outcome === "failed"
            ? (result.error ?? "unknown error")
            : result.blockers.length
              ? `blocked: ${result.blockers.join(", ")}`
              : null,
        screenshot_url: result.screenshotPath ?? null,
      })
      .eq("id", runId);

    if (result.outcome === "submitted") {
      await this.db.from("application_events").insert({
        application_id: applicationId,
        type: "applied",
        detail: `auto-applied via ${result.ats}`,
      });
    }
  }
}

/** Supabase-backed profile source reading the live schema. */
export class SupabaseProfileSource implements ProfileDataSource {
  constructor(private readonly db: SupabaseClient) {}

  async getUser(userId: string): Promise<UserRow | null> {
    const { data } = await this.db
      .from("users")
      .select(
        "id, email, full_name, salary_expectation_min, salary_expectation_max, " +
          "salary_expectation_currency, current_role_title",
      )
      .eq("id", userId)
      .single();
    return (data as unknown as UserRow) ?? null;
  }

  async getActiveResume(userId: string): Promise<ResumeRow | null> {
    const { data } = await this.db
      .from("resumes")
      .select("storage_url, filename")
      .eq("user_id", userId)
      .eq("is_active", true)
      .maybeSingle();
    return (data as ResumeRow) ?? null;
  }

  async getAnswers(userId: string): Promise<AnswerRow[]> {
    const { data } = await this.db
      .from("application_answers")
      .select("key, value, needs_input")
      .eq("user_id", userId);
    return (data as AnswerRow[]) ?? [];
  }
}

/** Build a service-role client for the worker (bypasses RLS — server only). */
export function createServiceClient(): SupabaseClient {
  const { url, key } = config.requireSupabase();
  return createClient(url, key, { auth: { persistSession: false } });
}
