import { describe, expect, it } from "vitest";

import { isLocalAgentMcpDisabled } from "@/pro/main/ipc/handlers/local_agent/local_agent_mcp";

describe("isLocalAgentMcpDisabled", () => {
  it("uses env var override when true", () => {
    process.env.DYAD_DISABLE_LOCAL_AGENT_MCP = "true";

    expect(
      isLocalAgentMcpDisabled({ disableLocalAgentMcp: false } as any),
    ).toBe(true);

    delete process.env.DYAD_DISABLE_LOCAL_AGENT_MCP;
  });

  it("uses settings when env var is not set", () => {
    delete process.env.DYAD_DISABLE_LOCAL_AGENT_MCP;

    expect(isLocalAgentMcpDisabled({ disableLocalAgentMcp: true } as any)).toBe(
      true,
    );
    expect(
      isLocalAgentMcpDisabled({ disableLocalAgentMcp: false } as any),
    ).toBe(false);
  });

  it("defaults to false", () => {
    delete process.env.DYAD_DISABLE_LOCAL_AGENT_MCP;

    expect(isLocalAgentMcpDisabled({} as any)).toBe(false);
  });
});
