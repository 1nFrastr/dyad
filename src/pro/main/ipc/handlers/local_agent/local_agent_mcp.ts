import type { UserSettings } from "@/lib/schemas";

export function isLocalAgentMcpDisabled(settings?: UserSettings): boolean {
  if (process.env.DYAD_DISABLE_LOCAL_AGENT_MCP === "true") {
    return true;
  }

  return (
    (settings as UserSettings & { disableLocalAgentMcp?: boolean })
      ?.disableLocalAgentMcp === true
  );
}

export const MCP_DISCOVERY_TOOLS = [
  "MCP",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
] as const;
