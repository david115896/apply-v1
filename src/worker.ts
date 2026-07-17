// Worker process entrypoint. Deploy this as a separate Railway service:
//   node dist/worker.js   (or: tsx src/worker.ts in dev)
import { startApplyWorker } from "./apply/queue.js";

startApplyWorker();
