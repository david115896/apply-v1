// Reference for the WEBAPP side (Next.js + tRPC + Fastify + Clerk). Nothing in
// this repo (apply-v1) actually imports this file -- it's not part of the
// build. Copy the relevant pieces into your webapp project.
//
// IMPORTANT: your webapp should NOT depend on the whole apply-v1 package.
// apply-v1 pulls in `playwright` (a large browser download) purely for the
// WORKER side; the webapp only ever needs to be a BullMQ *producer*, which
// only needs `bullmq` + `ioredis`. So this file intentionally re-declares
// the two small things producer and worker must agree on (the queue name and
// the payload shape) rather than importing apply-v1's queue.ts directly.
// If they ever drift out of sync with apply-v1/src/apply/queue.ts and types.ts,
// that mismatch is exactly what the test script (scripts/enqueue-test.ts) is
// for catching before it reaches production.

import { Queue } from "bullmq";
import { Redis as IORedis } from "ioredis";

// Must exactly match APPLY_QUEUE in apply-v1/src/apply/queue.ts.
const APPLY_QUEUE = "apply";

// Must exactly match the JobRef fields in apply-v1/src/apply/types.ts and the
// ApplyJobData shape in apply-v1/src/apply/queue.ts.
interface JobRef {
  id: string;
  title: string;
  apply_url: string | null;
  company_id: string | null;
}
interface ApplyJobData {
  userId: string;
  applicationId: string;
  job: JobRef;
}

// Create ONE queue instance and reuse it across requests -- don't construct a
// new Queue() (and therefore a new Redis connection) per request/mutation.
// In Next.js this typically lives in a module-scoped singleton, e.g.
// `lib/applyQueue.ts`, imported wherever a router needs it.
let _queue: Queue<ApplyJobData> | null = null;
export function getApplyQueue(): Queue<ApplyJobData> {
  if (!_queue) {
    // BullMQ requires maxRetriesPerRequest: null on the connection -- same as
    // apply-v1's connection() helper.
    const connection = new IORedis(requireEnv("REDIS_URL"), { maxRetriesPerRequest: null });
    _queue = new Queue<ApplyJobData>(APPLY_QUEUE, { connection });
  }
  return _queue;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// ---------------------------------------------------------------------------
// tRPC mutation. Adapt `protectedProcedure`/`ctx.auth`/`ctx.supabase` to
// whatever your actual tRPC context + Clerk middleware are called -- this is
// written against the common create-t3-app-style convention, not your real
// context type (I don't have your webapp's source, so I can't match it
// exactly).
// ---------------------------------------------------------------------------
/*
export const applyRouter = router({
  applyToJob: protectedProcedure
    .input(z.object({ jobId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.auth.userId; // Clerk user id -- make sure this is the
                                       // SAME id space as public.users.id; if
                                       // Clerk and Supabase user ids differ in
                                       // your setup, resolve to the Supabase
                                       // users.id here before continuing.

      // 1. Create the applications row FIRST. apply-v1's SupabaseRunStore
      //    requires an existing applications.id (application_runs.application_id
      //    is a NOT NULL foreign key) -- see apply-v1/src/apply/store.ts.
      const { data: application, error } = await ctx.supabase
        .from("applications")
        .insert({ user_id: userId, job_id: input.jobId })
        .select("id")
        .single();
      if (error || !application) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Could not record application" });
      }

      // 2. Look up the minimal JobRef the worker needs (it does NOT re-query
      //    the jobs table itself -- whatever you pass here is what it uses).
      const { data: job } = await ctx.supabase
        .from("jobs")
        .select("id, title, apply_url, company_id")
        .eq("id", input.jobId)
        .single();
      if (!job) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Job not found" });
      }

      // 3. Enqueue. This call returns as soon as BullMQ has accepted the job
      //    onto the Redis-backed queue -- it does NOT wait for the Railway
      //    worker to pick it up or finish. The mutation should return quickly;
      //    surface run progress to the user by polling/subscribing to
      //    application_runs for this applicationId, not by awaiting here.
      const queue = getApplyQueue();
      await queue.add(
        "apply",
        { userId, applicationId: application.id, job },
        { attempts: 2, backoff: { type: "exponential", delay: 5_000 }, removeOnComplete: 100, removeOnFail: 500 },
      );

      return { applicationId: application.id };
    }),
});
*/
