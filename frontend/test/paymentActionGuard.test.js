import assert from "node:assert/strict";
import test from "node:test";

import { createInFlightActionGuard } from "../src/paymentActionGuard.js";

test("in-flight live payment action ignores repeated signing events", async () => {
  const guard = createInFlightActionGuard();
  let releaseFirstAction;
  let signingCalls = 0;

  const first = guard.run(async () => {
    signingCalls += 1;
    await new Promise((resolve) => {
      releaseFirstAction = resolve;
    });
    return "submitted";
  });
  const second = guard.run(async () => {
    signingCalls += 1;
    return "duplicate";
  });

  assert.deepEqual(await second, { ignored: true });
  assert.equal(signingCalls, 1);
  assert.equal(guard.inFlight, true);

  releaseFirstAction();
  assert.deepEqual(await first, { ignored: false, value: "submitted" });
  assert.equal(guard.inFlight, false);
});
