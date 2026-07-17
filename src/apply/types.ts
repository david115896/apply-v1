// Core types shared across the apply pipeline.
//
// The pipeline is deliberately layered so each tier is independently testable:
//   detect ATS  ->  resolve canonical profile  ->  adapter fills form  ->  gate  ->  persist
//
// Nothing here imports Playwright/BullMQ/Supabase directly; concrete tiers do.

/** Applicant-tracking systems we can recognise. Extend as adapters are added. */
export type AtsId =
  | "greenhouse"
  | "lever"
  | "ashby"
  | "workday"
  | "smartrecruiters"
  | "icims"
  | "unknown";

/**
 * Canonical field keys. Every form field on every site resolves to one of these
 * (or to a free-text custom question keyed by its own label). This is the single
 * vocabulary the adapters and the answer store agree on.
 */
export type CanonicalKey =
  | "first_name"
  | "last_name"
  | "full_name"
  | "email"
  | "phone"
  | "resume_file"
  | "cover_letter"
  | "linkedin_url"
  | "website"
  | "location"
  | "work_authorization"
  | "requires_sponsorship"
  | "salary_expectation"
  | "notice_period"
  | "years_experience";

/** Where a resolved value came from — used for audit and debugging. */
export type FieldSource = "user_profile" | "answer_store" | "resume" | "derived";

/** A single resolved canonical value plus provenance and confidence. */
export interface ResolvedField {
  key: CanonicalKey | string; // string allows custom, label-keyed questions
  value: string | null;
  /** Local filesystem path for file fields (resume, cover letter); null otherwise. */
  filePath?: string | null;
  source: FieldSource;
  /** 0..1. Low confidence or null value routes the run to the human via the gate. */
  confidence: number;
  /** Explicitly flagged by the user as "I still need to provide this". */
  needsInput: boolean;
}

/** The full resolved profile for one user, keyed by canonical key. */
export interface CanonicalProfile {
  userId: string;
  fields: Map<string, ResolvedField>;
  get(key: string): ResolvedField | undefined;
}

/** Minimal job shape the runner needs (subset of public.jobs). */
export interface JobRef {
  id: string;
  title: string;
  apply_url: string | null;
  company_id: string | null;
}

/** Per-field outcome after an adapter attempts to fill it. */
export interface FieldFillResult {
  key: string;
  /** filled = value entered; skipped = not present on form; missing = required but no value. */
  status: "filled" | "skipped" | "missing" | "error";
  confidence: number;
  note?: string;
}

/** What an adapter reports back after attempting the whole form. */
export interface AdapterResult {
  ats: AtsId;
  fields: FieldFillResult[];
  /** True if the adapter believes every required field is satisfied. */
  formComplete: boolean;
  /** Path to a screenshot captured just before the submit decision. */
  screenshotPath?: string | null;
}

/** The contract every ATS adapter implements. */
export interface AtsAdapter {
  readonly id: AtsId;
  /** Cheap check: does this adapter handle the given URL/page? */
  matches(url: string): boolean;
  /**
   * Fill the form from the profile. MUST NOT submit — the runner owns the
   * submit decision after the confidence gate. `page` is a Playwright Page,
   * typed as unknown here to keep this file dependency-free.
   */
  fill(page: unknown, profile: CanonicalProfile): Promise<AdapterResult>;
  /** Click the final submit control. Called only when the gate passes and !dryRun. */
  submit(page: unknown): Promise<{ ok: boolean; externalRef?: string | null }>;
}

/** Final outcome of a run, mapped to run_status when persisted. */
export type RunOutcome = "submitted" | "ready" | "needs_human" | "failed";

export interface ApplyResult {
  jobId: string;
  userId: string;
  ats: AtsId;
  outcome: RunOutcome;
  /** Fields that blocked auto-submit (missing / needs_input / low confidence). */
  blockers: string[];
  adapter?: AdapterResult;
  screenshotPath?: string | null;
  externalRef?: string | null;
  error?: string;
}
