import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createReleaseMetadata,
  writeReleaseJson,
} from "../../scripts/generate-release-json.mjs";

const FIXED_DATE = new Date("2026-08-27T12:00:00.000Z");
const SENSITIVE_PATTERNS = [
  /CDP_API_KEY_SECRET/u,
  /PAYMENT_DATABASE_URL/u,
  /PAYMENT-SIGNATURE/u,
  /authorization/i,
  /private[_-]?key/i,
  /seed/i,
  /secret/i,
];

test("release metadata contains project and repository identity", () => {
  const metadata = createReleaseMetadata({
    env: {
      VERCEL_ENV: "production",
      VERCEL_GIT_COMMIT_SHA: "16fe9f5",
      VERCEL_GIT_COMMIT_REF: "main",
    },
    now: () => FIXED_DATE,
  });

  assert.deepEqual(metadata, {
    project: "base-agent-pay",
    repository: "tufantoktar/base-agent-pay",
    environment: "production",
    commit: "16fe9f5",
    branch: "main",
    buildTimestamp: "2026-08-27T12:00:00.000Z",
    version: 1,
  });
});

test("release metadata fails safely when deployment git metadata is absent", () => {
  const metadata = createReleaseMetadata({
    env: {},
    now: () => FIXED_DATE,
  });

  assert.equal(metadata.environment, "unknown");
  assert.equal(metadata.commit, null);
  assert.equal(metadata.branch, null);
});

test("release metadata does not expose known sensitive field names or secret values", () => {
  const metadata = createReleaseMetadata({
    env: {
      VERCEL_ENV: "production",
      VERCEL_GIT_COMMIT_SHA: "16fe9f5",
      VERCEL_GIT_COMMIT_REF: "main",
      CDP_API_KEY_SECRET: "must-not-appear",
      PAYMENT_DATABASE_URL: "postgres://must-not-appear",
      PRIVATE_KEY: "must-not-appear",
      SEED_PHRASE: "must-not-appear",
    },
    now: () => FIXED_DATE,
  });
  const serialized = JSON.stringify(metadata);

  for (const pattern of SENSITIVE_PATTERNS) {
    assert.doesNotMatch(serialized, pattern);
  }
  assert.doesNotMatch(serialized, /must-not-appear/u);
});

test("release json writer emits deterministic JSON structure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "base-agent-pay-release-"));
  const out = join(directory, "release.json");
  const metadata = await writeReleaseJson({
    out,
    env: {
      VERCEL_ENV: "preview",
      VERCEL_GIT_COMMIT_SHA: "abcdef123456",
      VERCEL_GIT_COMMIT_REF: "release/canary",
    },
    now: () => FIXED_DATE,
  });
  const parsed = JSON.parse(await readFile(out, "utf8"));

  assert.deepEqual(parsed, metadata);
  assert.deepEqual(Object.keys(parsed), [
    "project",
    "repository",
    "environment",
    "commit",
    "branch",
    "buildTimestamp",
    "version",
  ]);
});
