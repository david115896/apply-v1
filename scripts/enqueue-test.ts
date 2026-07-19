// One-off script: enqueue a SINGLE real apply job so you can watch it move
// through the Railway worker's logs before touching any webapp code.
//
// What this does, step by step:
//   1. Inserts a throwaway `jobs` row pointing at the apply_url you give it.
//      (The worker never re-reads the jobs table — JobRef is passed straight
//      through in the queue payload — but `applications.job_id` is a NOT NULL
//      foreign key, so a real row has to exist to satisfy that constraint.)
//   2. Inserts a throwaway `applications` row for your own account, which is
//      REQUIRED before enqueueing (application_runs.application_id is a NOT
//      NULL foreign key to applications.id — see src/apply/store.ts:startRun).
//   3. Builds the exact ApplyJobData payload and enqueues it on the same
//      "apply" BullMQ queue the Railway worker is listening on, using your
//      actual production queue.ts code (not a re-implementation).
//   4. Prints the ids it created and a ready-to-paste SQL cleanup block.
//
// IMPORTANT CAVEAT (see README "Two things to decide before going live" #1):
// because SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are both set on the
// Railway worker, it uses SupabaseRunStore, not ConsoleRunStore -- so this
// test WILL write a real `applications` row with stage='applied' into your
// tracker (dry-run only blocks the final submit click, not this bookkeeping).
// That's why step 1/2 are clearly marked as TEST rows and step 4 gives you
// the exact DELETE statements to remove them once you've inspected the run.
//
// Usage:
//   npx tsx scripts/enqueue-test.ts <any apply_url>
//
// The URL doesn't have to be Greenhouse -- it's checked against the same
// detectFromUrl() the real worker uses (src/apply/detect.ts) and you're told
// up front which ATS it resolves to and whether an adapter exists for it yet
// (see src/apply/adapters/registry.ts). Only "greenhouse" has one today --
// anything else (e.g. a myworkdayjobs.com posting) will correctly land in
// needs_human with blocker "no-adapter-for-ats". That's still a real,
// useful result: it proves navigate -> detect -> escalate -> persist all work
// end to end, ahead of actually building that ATS's adapter.
//
// Requires a local .env with REDIS_URL (the PUBLIC Railway proxy endpoint --
// redis.railway.internal only resolves inside Railway, not from your laptop),
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and TEST_USER_ID (your own
// users.id -- the account whose profile/resume/answers should be used).

import "dotenv/config";
import { createServiceClient } from "../src/apply/store.js";
import { makeApplyQueue, enqueueApply, type ApplyJobData } from "../src/apply/queue.js";
import { detectFromUrl } from "../src/apply/detect.js";
import { getAdapter } from "../src/apply/adapters/registry.js";

function req(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name} (check your .env)`);
    process.exit(1);
  }
  return v;
}

async function main() {
  const applyUrl = process.argv[2];
  if (!applyUrl) {
    console.error("Usage: npx tsx scripts/enqueue-test.ts <apply-url>");
    process.exit(1);
  }

  const ats = detectFromUrl(applyUrl);
  const hasAdapter = !!getAdapter(ats);
  console.log(`URL resolves to ats=${ats} (adapter ${hasAdapter ? "exists" : "NOT built yet"})`);
  if (!hasAdapter) {
    console.log(
      `  -> expect this run to finish as needs_human / "no-adapter-for-ats" -- ` +
        `that's the correct, expected outcome until src/apply/adapters/${ats}.ts exists.`,
    );
  }

  const userId = req("TEST_USER_ID");
  const db = createServiceClient();

  console.log("1/3 creating throwaway jobs row...");
  const { data: job, error: jobErr } = await db
    .from("jobs")
    .insert({
      external_id: `test-enqueue-${Date.now()}`,
      title: "TEST — apply-v1 enqueue check (safe to delete)",
      apply_url: applyUrl,
    })
    .select("id, title, apply_url, company_id")
    .single();
  if (jobErr || !job) {
    console.error("Failed to create test job:", jobErr?.message);
    process.exit(1);
  }
  console.log(`    jobs.id = ${job.id}`);

  console.log("2/3 creating throwaway applications row...");
  const { data: application, error:appErr } = await db
    .from("applications")
    .insert({ user_id: userId, job_id: job.id, external_ref: "TEST-ENQUEUE" })
    .select("id")
    .single();
  if (appErr || !application) {
    console.error("Failed to create test application:", appErr?.message);
    process.exit(1);
  }
  console.log(`    applications.id = ${application.id}`);

  console.log("3/3 enqueueing onto the apply queue...");
  const queue = makeApplyQueue();
  const payload: ApplyJobData = {
    userId,
    applicationId: application.id as string,
    job: {
      id: job.id as string,
      title: job.title as string,
      apply_url: job.apply_url as string,
      company_id: (job.company_id as string | null) ?? null,
    },
  };
  await enqueueApply(queue, payload);
  await queue.close();

  console.log("\nEnqueued. Watch the Railway apply-v1 logs now for:");
  console.log('  navigating to ... -> detected ats=greenhouse -> filled X/Y fields -> dry-run: not submitting');
  console.log("\nWhen you're done inspecting the run, clean up the test rows with:\n");
  console.log(`  delete from application_events where application_id = '${application.id}';`);
  console.log(`  delete from application_runs where application_id = '${application.id}';`);
  console.log(`  delete from applications where id = '${application.id}';`);
  console.log(`  delete from jobs where id = '${job.id}';`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
