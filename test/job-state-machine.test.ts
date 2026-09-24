import { describe, expect, it } from "vitest";
import type { ExecutionStatus } from "../src/contracts.js";
import {
  canTransition,
  executionStatuses,
  isTerminalStatus,
  transitionExecution,
} from "../src/jobs/state-machine.js";

const allowed: Record<ExecutionStatus, readonly ExecutionStatus[]> = {
  preparing: ["queued", "failed", "cancelled", "interrupted"],
  queued: ["running", "cancelled"],
  running: ["cancel_requested", "succeeded", "failed", "interrupted"],
  cancel_requested: ["cancelled", "interrupted"],
  succeeded: [],
  failed: [],
  cancelled: [],
  interrupted: [],
};

describe("job execution state machine", () => {
  it("accepts every defined transition and rejects every undefined transition", () => {
    for (const from of executionStatuses) {
      for (const to of executionStatuses) {
        const expected = allowed[from].includes(to);
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expected);
        expect(transitionExecution(from, to), `${from} -> ${to}`).toBe(expected ? to : null);
      }
    }
  });

  it("keeps all execution terminal states immutable", () => {
    for (const status of ["succeeded", "failed", "cancelled", "interrupted"] as const) {
      expect(isTerminalStatus(status)).toBe(true);
      expect(allowed[status]).toEqual([]);
    }
    for (const status of ["preparing", "queued", "running", "cancel_requested"] as const) {
      expect(isTerminalStatus(status)).toBe(false);
    }
  });
});
