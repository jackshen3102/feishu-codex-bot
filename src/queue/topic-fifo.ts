import type { Store } from "../db/store.js";

export function claimTopicFifo(store: Store, availableSlots: number) {
  return store.claimRunnableJobs(availableSlots);
}
