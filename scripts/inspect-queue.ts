// Diagnostic: shows which Redis this process actually resolves REDIS_URL to
// (host only, no credentials) and what's currently sitting in the "apply" queue.
// Usage: npx tsx scripts/inspect-queue.ts
import "dotenv/config";
import { Queue } from "bullmq";
import { APPLY_QUEUE } from "./../src/apply/queue.js";
import IORedis from "ioredis";

const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const host = new URL(redisUrl).host;
console.log(`Resolved REDIS_URL host: ${host}`);

const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
const queue = new Queue(APPLY_QUEUE, { connection });

const counts = await queue.getJobCounts();
console.log("Job counts on queue 'apply':", counts);

const waiting = await queue.getJobs(["waiting", "active", "failed", "delayed"], 0, 20);
for (const job of waiting) {
  console.log(`- id=${job.id} state=${await job.getState()} data=${JSON.stringify(job.data)}`);
}

await queue.close();
await connection.quit();
