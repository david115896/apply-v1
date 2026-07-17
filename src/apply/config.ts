// Centralised config. Everything reads from env so the same code runs locally,
// on Railway workers, or against a hosted browser provider later.

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  redisUrl: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",

  supabaseUrl: process.env.SUPABASE_URL ?? "",
  // Service-role key: the worker acts server-side, bypassing RLS. Keep it OUT of
  // any client bundle. Only the worker process should ever see this.
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",

  // Dry-run is the default. Nothing is ever submitted unless this is explicitly
  // set to "false". This is the safety switch for the whole system.
  dryRun: process.env.APPLY_DRY_RUN !== "false",

  // Gate threshold: required fields below this confidence route to a human.
  confidenceThreshold: Number(process.env.APPLY_CONFIDENCE_THRESHOLD ?? "0.8"),

  // How many browser contexts one worker process runs in parallel.
  concurrency: Number(process.env.APPLY_CONCURRENCY ?? "3"),

  // Where screenshots / downloaded resumes are written.
  artifactDir: process.env.APPLY_ARTIFACT_DIR ?? "/tmp/apply-artifacts",

  // Set to a Browserbase/Steel/Hyperbrowser CDP endpoint to run browsers
  // remotely instead of locally. Empty = launch a local Chromium.
  browserCdpUrl: process.env.BROWSER_CDP_URL ?? "",

  // A stable id for this worker instance, written to application_runs.claimed_by.
  workerId: process.env.WORKER_ID ?? `worker-${process.pid}`,

  requireSupabase(): { url: string; key: string } {
    return { url: req("SUPABASE_URL"), key: req("SUPABASE_SERVICE_ROLE_KEY") };
  },
};
