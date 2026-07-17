// Resolve a user's canonical profile — the single source of truth every adapter
// fills from. Merges three sources, later ones winning on conflict:
//   1. structured columns on public.users      (name, email, salary, ...)
//   2. the active resume's storage_url          (the file to upload)
//   3. public.application_answers key/value      (explicit overrides + custom Q&A)
//
// application_answers.needs_input === true means "the user knows this is missing";
// that flag is surfaced straight to the confidence gate rather than guessed at.

import { promises as fs } from "node:fs";
import path from "node:path";
import type { CanonicalProfile, ResolvedField } from "./types.js";
import { config } from "./config.js";

/** Rows we read. Kept minimal and matching the live schema. */
export interface UserRow {
  id: string;
  email: string;
  full_name: string;
  salary_expectation_min: number | null;
  salary_expectation_max: number | null;
  salary_expectation_currency: string | null;
  current_role_title: string | null;
}
export interface ResumeRow {
  storage_url: string;
  filename: string;
}
export interface AnswerRow {
  key: string;
  value: string | null;
  needs_input: boolean;
}

/** Abstracts the DB so this module is unit-testable without Supabase. */
export interface ProfileDataSource {
  getUser(userId: string): Promise<UserRow | null>;
  getActiveResume(userId: string): Promise<ResumeRow | null>;
  getAnswers(userId: string): Promise<AnswerRow[]>;
}

function field(
  key: string,
  value: string | null,
  source: ResolvedField["source"],
  confidence: number,
  needsInput = false,
  filePath: string | null = null,
): ResolvedField {
  return { key, value, source, confidence, needsInput, filePath };
}

/**
 * Download a resume from its storage URL to a local temp file so Playwright can
 * upload it via setInputFiles (which needs a filesystem path, not a URL).
 */
async function downloadResume(resume: ResumeRow, userId: string): Promise<string | null> {
  try {
    await fs.mkdir(config.artifactDir, { recursive: true });
    const res = await fetch(resume.storage_url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const safe = resume.filename.replace(/[^\w.\-]/g, "_");
    const dest = path.join(config.artifactDir, `${userId}-${safe}`);
    await fs.writeFile(dest, buf);
    return dest;
  } catch {
    return null;
  }
}

export async function buildCanonicalProfile(
  userId: string,
  ds: ProfileDataSource,
): Promise<CanonicalProfile> {
  const [user, resume, answers] = await Promise.all([
    ds.getUser(userId),
    ds.getActiveResume(userId),
    ds.getAnswers(userId),
  ]);

  const fields = new Map<string, ResolvedField>();
  const put = (f: ResolvedField) => fields.set(f.key, f);

  // 1. Structured user columns.
  if (user) {
    put(field("email", user.email ?? null, "user_profile", user.email ? 1 : 0));
    const name = (user.full_name ?? "").trim();
    if (name) {
      put(field("full_name", name, "user_profile", 1));
      const [first, ...rest] = name.split(/\s+/);
      put(field("first_name", first ?? null, "derived", first ? 0.9 : 0));
      put(field("last_name", rest.join(" ") || null, "derived", rest.length ? 0.9 : 0.4));
    }
    if (user.salary_expectation_min || user.salary_expectation_max) {
      const cur = (user.salary_expectation_currency ?? "").trim();
      const lo = user.salary_expectation_min;
      const hi = user.salary_expectation_max;
      const val = lo && hi ? `${lo}-${hi} ${cur}`.trim() : `${lo ?? hi} ${cur}`.trim();
      put(field("salary_expectation", val, "user_profile", 0.85));
    }
  }

  // 2. Active resume -> downloaded file path.
  if (resume) {
    const filePath = await downloadResume(resume, userId);
    put(field("resume_file", resume.filename, "resume", filePath ? 1 : 0, !filePath, filePath));
  }

  // 3. Answer store overrides + custom questions (highest precedence).
  for (const a of answers) {
    const confidence = a.needs_input ? 0 : a.value ? 0.95 : 0;
    put(field(a.key, a.value, "answer_store", confidence, a.needs_input));
  }

  return {
    userId,
    fields,
    get: (k) => fields.get(k),
  };
}
