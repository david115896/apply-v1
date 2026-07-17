// Maps a detected AtsId to its adapter. Adding an ATS = write an adapter and
// register it here. Everything upstream (runner, queue) stays untouched.

import type { AtsAdapter, AtsId } from "../types.js";
import { GreenhouseAdapter } from "./greenhouse.js";

const ADAPTERS: Partial<Record<AtsId, AtsAdapter>> = {
  greenhouse: new GreenhouseAdapter(),
  // lever: new LeverAdapter(),      // next
  // ashby: new AshbyAdapter(),
};

export function getAdapter(ats: AtsId): AtsAdapter | null {
  return ADAPTERS[ats] ?? null;
}

export function supportedAts(): AtsId[] {
  return Object.keys(ADAPTERS) as AtsId[];
}
