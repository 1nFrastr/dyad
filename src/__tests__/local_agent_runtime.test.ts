import { describe, expect, it } from "vitest";

import {
  getLocalAgentRuntime,
  getAcpRuntime,
} from "@/pro/main/ipc/handlers/local_agent/local_agent_runtime";

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

describe("getAcpRuntime", () => {
  it("prefers env var when valid", () => {
    process.env.DYAD_ACP_RUNTIME = "codex";
    const runtime = getAcpRuntime({
      acpRuntime: "claude-code",
    } as any);
    expect(runtime).toBe("codex");
    delete process.env.DYAD_ACP_RUNTIME;
  });

  it("uses settings value when env var is missing", () => {
    delete process.env.DYAD_ACP_RUNTIME;
    const runtime = getAcpRuntime({
      acpRuntime: "codex",
    } as any);
    expect(runtime).toBe("codex");
  });

  it("falls back to claude-code for unknown values", () => {
    process.env.DYAD_ACP_RUNTIME = "unknown";
    const runtime = getAcpRuntime({
      acpRuntime: "invalid",
    } as any);
    expect(runtime).toBe("claude-code");
    delete process.env.DYAD_ACP_RUNTIME;
  });

  it("returns claude-code by default when no config is provided", () => {
    delete process.env.DYAD_ACP_RUNTIME;
    const runtime = getAcpRuntime();
    expect(runtime).toBe("claude-code");
  });
});
