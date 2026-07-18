// BullMQ wiring: a producer (enqueue, called from your tRPC layer) and a worker
// (run on Railway). Concurrency here = number of parallel isolated browser
// contexts per worker process; scale horizontally by running more workers.

import { Queue, Worker, type Job } from "bullmq";
import { Redis as IORedis } from "ioredis";
import type { JobRef } from "./types.js";
import { buildCanonicalProfile } from "./canonical.js";
import { runApplication } from "./runner.js";
import { config } from "./config.js";
import {
  ConsoleRunStore,
  SupabaseRunStore,
  SupabaseProfileSource,
  createServiceClient,
} from "./store.js";
import { shutdownBrowser } from "./browser.js";

export const APPLY_QUEUE = "apply";

export interface ApplyJobData {
  userId: string;
  /** Existing applications.id container for this attempt. */
  applicationId: string;
  job: JobRef;
}

function connection() {
  // BullMQ requires maxRetriesPerRequest: null on the connection.
  return new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
}

/** Producer — call this from a tRPC mutation when a user opts to apply. */
export function makeApplyQueue(): Queue<ApplyJobData> {
  return new Queue<ApplyJobData>(APPLY_QUEUE, { connection: connection() });
}

export async function enqueueApply(
  queue: Queue<ApplyJobData>,
  data: ApplyJobData,
): Promise<void> {
  await queue.add("apply", data, {
    attempts: 2,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  });
}

/** Worker entrypoint — run as its own process on Railway. */
export function startApplyWorker(): Worker<ApplyJobData> {
  // Console store by default (no DB writes). Flip to Supabase once you're ready
  // to persist attempts and have resolved the pre-submit stage question.
  const useSupabase = Boolean(config.supabaseUrl && config.supabaseServiceKey);
  const db = useSupabase ? createServiceClient() : null;

  const worker = new Worker<ApplyJobData>(
    APPLY_QUEUE,
    async (job: Job<ApplyJobData>) => {
      const { userId, applicationId, job: jobRef } = job.data;

      const profileSource = db ? new SupabaseProfileSource(db) : null;
      if (!profileSource) {
        throw new Error("SUPABASE_* env not set; profile source unavailable");
      }
      const profile = await buildCanonicalProfile(userId, profileSource);
      const store = db ? new SupabaseRunStore(db) : new ConsoleRunStore();

      const result = await runApplication(jobRef, { profile, store, applicationId });
      return result;
    },
    { connection: connection(), concurrency: config.concurrency },
  );

  worker.on("completed", (job, result) =>
    console.log(`[apply] job ${job.id} -> ${result?.outcome}`),
  );
  worker.on("failed", (job, err) =>
    console.error(`[apply] job ${job?.id} failed: ${err.message}`),
  );

  const shutdown = async () => {
    await worker.close();
    await shutdownBrowser();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  console.log(
    `[apply] worker up (dryRun=${config.dryRun}, concurrency=${config.concurrency}, ` +
      `store=${db ? "supabase" : "console"})`,
  );
  return worker;
}
