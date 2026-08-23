import assert from "node:assert/strict";
import test from "node:test";

import {
  BASE_BUILDER_CODE,
  BUILDER_DATA_SUFFIX,
} from "../src/builderAttribution.js";

const EXPECTED_BUILDER_DATA_SUFFIX =
  "0x62635f747579626e6877320b0080218021802180218021802180218021";

test("encodes the Base Builder Code as the expected ERC-8021 suffix", () => {
  assert.equal(BASE_BUILDER_CODE, "bc_tuybnhw2");
  assert.equal(BUILDER_DATA_SUFFIX, EXPECTED_BUILDER_DATA_SUFFIX);
});
