import { describe, expect, it } from "vitest";

import { getLocalAgentRuntime } from "@/pro/main/ipc/handlers/local_agent/local_agent_runtime";

describe("getLocalAgentRuntime", () => {
  it("prefers env var when valid", () => {
    process.env.DYAD_LOCAL_AGENT_RUNTIME = "acp";
    const runtime = getLocalAgentRuntime({
      localAgentRuntime: "vercel-ai",
    } as any);
    expect(runtime).toBe("acp");
    delete process.env.DYAD_LOCAL_AGENT_RUNTIME;
  });

  it("uses settings value when env var is missing", () => {
    delete process.env.DYAD_LOCAL_AGENT_RUNTIME;
    const runtime = getLocalAgentRuntime({
      localAgentRuntime: "vercel-ai",
    } as any);
    expect(runtime).toBe("vercel-ai");
  });

  it("falls back to claude-agent-sdk for unknown values", () => {
    process.env.DYAD_LOCAL_AGENT_RUNTIME = "unknown";
    const runtime = getLocalAgentRuntime({
      localAgentRuntime: "invalid",
    } as any);
    expect(runtime).toBe("claude-agent-sdk");
    delete process.env.DYAD_LOCAL_AGENT_RUNTIME;
  });
});
