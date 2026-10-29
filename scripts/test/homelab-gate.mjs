// Focused release gate for the homelab build of release/v3.8.52 (ZAC-193):
// the Claude 5.5 models we route, the fixes our old plugins and backport
// carried, the refresh-hang fix, and the admission/timeout knobs we tune.
import { spawnSync } from "node:child_process";

const suites = [
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-haiku-no-adaptive-thinking",
  "claude-5x-thinking-passthrough",
  "claude-mid-system-models-16127",
  "claude-mid-system-passthrough-16127",
  "chatcore-claude-effort-variant",
  "claude-code-compatible-request",
  "claude-code-compatible-helpers",
  "claude-identity-version-sync",
  "claude-codex-identity-version-sync",
  "opencode-go-gpt6luna-responses-format",
  "homelab-opencode-go-responses",
  "openai-to-claude-tool-result-images-9692",
  "anthropic-toolcall-args-6459",
  "translator-openai-to-claude",
  "anthropic-apikey-prompt-cache",
  "claude-unknown-block-types-4383",
  "claude-prepare-request-preserve-fallback",
  "token-refresh-mutex-timeout-14970",
  "refresh-serializer",
  "token-refresh-race-comprehensive",
  "token-refresh-service",
  "chat-admission-byte-healthy-headroom",
  "chat-admission-wrapper",
  "db-chat-admission-settings",
  "direct-response-start-timeout-reasoning-504",
  "chatcore-plugin-onrequest",
  "plugins-api-routes",
  "pricing-fallback",
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
process.exit(result.status ?? 1);
