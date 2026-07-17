# ApplyForMe — auto-apply v1

A thin vertical slice of the tiered apply architecture: enqueue a job → an isolated
Playwright context fills a known ATS form → a confidence gate decides → everything is
logged. **Dry-run by default: nothing is ever submitted** until you explicitly turn it off.

## Flow

```
enqueueApply (tRPC)
      │
      ▼
BullMQ "apply" queue ──► Worker (Railway)
                              │
                              ▼
                    runApplication(job)
       ┌──────────────┬───────────────┬──────────────┬─────────────┐
       ▼              ▼               ▼              ▼             ▼
  acquireSession  detectAts      adapter.fill    runGate      persist
  (isolated ctx)  (URL/DOM)      (Greenhouse)   (threshold)   (store)
```

## Files

| File | Role |
|------|------|
| `apply/types.ts` | Canonical keys, adapter contract, result shapes |
| `apply/config.ts` | Env config, incl. the `APPLY_DRY_RUN` safety switch |
| `apply/browser.ts` | Playwright browser; one isolated context per application |
| `apply/detect.ts` | ATS fingerprint (URL first, DOM fallback) |
| `apply/canonical.ts` | Merge `users` + active resume + `application_answers` |
| `apply/adapters/dom.ts` | Reusable fill-by-selector / fill-by-label helpers |
| `apply/adapters/greenhouse.ts` | First Tier-1 adapter |
| `apply/adapters/registry.ts` | AtsId → adapter map |
| `apply/store.ts` | `RunStore` interface + Console (default) + Supabase impls |
| `apply/runner.ts` | Orchestration + the confidence gate |
| `apply/queue.ts` | BullMQ producer + worker |
| `worker.ts` | Worker process entrypoint |

## Run

```bash
npm install
npx playwright install chromium

# dev worker (console store, no DB writes, dry-run on)
npm run worker:dev
```

Enqueue from your tRPC layer:

```ts
import { makeApplyQueue, enqueueApply } from "./apply/queue.js";

const queue = makeApplyQueue();
await enqueueApply(queue, {
  userId,
  applicationId,            // an existing applications.id container
  job: { id, title, apply_url, company_id },
});
```

## Config

| Env | Default | Notes |
|-----|---------|-------|
| `APPLY_DRY_RUN` | `true` | `"false"` to enable real submission |
| `APPLY_CONFIDENCE_THRESHOLD` | `0.8` | Required fields below this → human |
| `APPLY_CONCURRENCY` | `3` | Parallel contexts per worker |
| `REDIS_URL` | local | BullMQ connection |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | — | Set both to switch on the Supabase store |
| `BROWSER_CDP_URL` | — | Point at Browserbase/Steel/Hyperbrowser to run browsers remotely |

## Two things to decide before going live

1. **Pre-submit application state.** `application_runs.status` has `needs_human`, but
   `applications.stage` has no draft/queued value and `applied_at` defaults to `now()`.
   So a dry run that wrote an `applications` row would record an application that never
   happened. v1 keeps the Console store active to avoid this. Options: add a `draft`
   value to the `application_stage` enum, or only create the `applications` row at the
   moment of real submission.

2. **Selector validation.** The Greenhouse selectors are a starting point covering both
   the classic and React boards, with label-based fallback. Validate them against a live
   posting before enabling submission — Greenhouse markup shifts.

## Next

- Lever adapter (same shape as Greenhouse; also account-wall-free).
- Turn on the Supabase store once (1) above is decided.
- Tier-2 generic filler reusing `adapters/dom.ts` label matching + an LLM classifier
  for unmapped fields, backed by the same canonical profile.
- A hosted browser provider via `BROWSER_CDP_URL` when anti-bot sites appear.
