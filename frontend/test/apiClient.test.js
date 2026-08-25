import assert from "node:assert/strict";
import test from "node:test";

import { createTaskIdempotencyKey } from "../src/apiClient.js";

test("creates stable-format task idempotency keys", () => {
  const key = createTaskIdempotencyKey({
    now: () => 1_776_886_400_000,
    randomUUID: () => "12345678-1234-1234-1234-1234567890ab",
  });

  assert.equal(key, "task_moaga8zk_123456781234123412341234567890ab");
  assert.match(key, /^[a-zA-Z0-9._:-]{16,128}$/u);
});
