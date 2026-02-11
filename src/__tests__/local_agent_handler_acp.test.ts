import { describe, expect, it } from "vitest";

import { buildAcpSessionMeta } from "@/pro/main/ipc/handlers/local_agent/local_agent_handler_acp_meta";

describe("buildAcpSessionMeta", () => {
  it("builds serializable claudeCode options without abortController", () => {
    const meta = buildAcpSessionMeta({
      systemPrompt: "You are a helpful assistant",
      selectedModelName: "claude-sonnet-4-5",
      disallowedTools: ["Edit", "Write"],
    });

    expect(meta.claudeCode.options.model).toBe("claude-sonnet-4-5");
    expect(meta.claudeCode.options.maxTurns).toBe(25);
    expect(meta.claudeCode.options.disallowedTools).toEqual(["Edit", "Write"]);
    expect(
      (meta.claudeCode.options as Record<string, unknown>).abortController,
    ).toBeUndefined();

    expect(() => JSON.stringify(meta)).not.toThrow();
  });

  it("omits disallowedTools when empty", () => {
    const meta = buildAcpSessionMeta({
      systemPrompt: "test",
      selectedModelName: "model",
      disallowedTools: [],
    });

    expect(meta.claudeCode.options.disallowedTools).toBeUndefined();
  });
});
