import assert from "node:assert/strict";
import test from "node:test";
import { OpencodeExecutor, resolveOpencodeTargetFormat } from "../../open-sse/executors/opencode.ts";
import { resolveChatCoreTargetFormat } from "../../open-sse/handlers/chatCore/targetFormat.ts";

// ZAC-106, 2026-09-28: both live Go requests returned "Model does not support
// this protocol". ChatCore and the executor must independently choose the
// documented Responses endpoint, even after discovery returns only an ID.
for (const model of ["gpt-6-luna", "grok-4.7"]) {
  test(`Go ${model} translates Chat requests and dispatches to Responses`, () => {
    const core = resolveChatCoreTargetFormat({
      provider: "opencode-go", resolvedModel: model, apiFormat: undefined,
      customModelTargetFormat: undefined, providerSpecificData: undefined,
    });
    assert.equal(core.targetFormat, "openai-responses");
    const executor = new OpencodeExecutor("opencode-go");
    executor._requestFormat = resolveOpencodeTargetFormat("opencode-go", model);
    assert.equal(executor.buildUrl(model, false), "https://opencode.ai/zen/go/v1/responses");
    assert.equal(executor.buildUrl(model, true), "https://opencode.ai/zen/go/v1/responses");
    // Keep the protocol override scoped to the Go service.
    assert.equal(resolveOpencodeTargetFormat("not-a-provider", model), "openai");
  });
}
