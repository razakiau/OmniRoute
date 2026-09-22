// Focused release gate for the v3.8.50 Opus 5.5 backport.
import { spawnSync } from "node:child_process";

const suites = [
  "claude-opus-5-5",
  "claude-codex-identity-version-sync",
  "claude-identity-version-sync",
  "anthropic-cache-fingerprint",
  "cc-bridge-transforms",
  "client-identity-profiles",
  "executor-default-base",
  "glm-executor",
  "system-transforms",
  "provider-translate-path-golden",
  "claude-adaptive-thinking-normalize",
  "claude-fast-mode",
  "claude-context-1m-supported-models",
  "claude-code-compatible-request",
  "claude-code-compatible-helpers",
  "chatcore-claude-effort-variant",
  "translator-openai-to-claude",
  "openai-to-claude-tool-result-images-9692",
  "model-spec-lookup-index-8697",
  "pricing-cc-anthropic-rates",
];
const result = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx/esm",
    "--import",
    "./open-sse/utils/setupPolyfill.ts",
    "--import",
    "./tests/_setup/isolateDataDir.ts",
    "--test",
    "--test-force-exit",
    "--test-concurrency=4",
    ...suites.map((name) => `tests/unit/${name}.test.ts`),
  ],
  { stdio: "inherit", env: { ...process.env, DISABLE_SQLITE_AUTO_BACKUP: "true" } }
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
