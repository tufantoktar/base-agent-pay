import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT = "base-agent-pay";
const REPOSITORY = "tufantoktar/base-agent-pay";
const VERSION = 1;

export function createReleaseMetadata({
  env = process.env,
  now = () => new Date(),
} = {}) {
  return {
    project: PROJECT,
    repository: REPOSITORY,
    environment: normalizeOptional(env.VERCEL_ENV) ?? "unknown",
    commit: normalizeOptional(env.VERCEL_GIT_COMMIT_SHA),
    branch: normalizeOptional(env.VERCEL_GIT_COMMIT_REF),
    buildTimestamp: now().toISOString(),
    version: VERSION,
  };
}

export async function writeReleaseJson({
  out,
  env = process.env,
  now = () => new Date(),
} = {}) {
  if (!out) {
    throw new Error("release.json output path is required.");
  }

  const outputPath = resolve(out);
  const metadata = createReleaseMetadata({ env, now });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  return metadata;
}

function normalizeOptional(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function readOutputArg(argv) {
  const outIndex = argv.indexOf("--out");
  if (outIndex >= 0) {
    return argv[outIndex + 1];
  }

  const equalsArg = argv.find((arg) => arg.startsWith("--out="));
  return equalsArg ? equalsArg.slice("--out=".length) : null;
}

const executedPath = process.argv[1] ? resolve(process.argv[1]) : "";
const currentPath = fileURLToPath(import.meta.url);

if (executedPath === currentPath) {
  const out = readOutputArg(process.argv.slice(2));
  await writeReleaseJson({ out });
}
