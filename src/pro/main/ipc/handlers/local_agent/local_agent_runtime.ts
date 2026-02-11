import type { UserSettings } from "@/lib/schemas";

export const LOCAL_AGENT_RUNTIMES = [
  "claude-agent-sdk",
  "vercel-ai",
  "acp",
] as const;

export type LocalAgentRuntime = (typeof LOCAL_AGENT_RUNTIMES)[number];

export const ACP_RUNTIMES = ["claude-code", "codex"] as const;

export type AcpRuntime = (typeof ACP_RUNTIMES)[number];

const FALLBACK_RUNTIME: LocalAgentRuntime = "claude-agent-sdk";
const FALLBACK_ACP_RUNTIME: AcpRuntime = "claude-code";

function isLocalAgentRuntime(value: unknown): value is LocalAgentRuntime {
  return (
    typeof value === "string" &&
    (LOCAL_AGENT_RUNTIMES as readonly string[]).includes(value)
  );
}

function isAcpRuntime(value: unknown): value is AcpRuntime {
  return (
    typeof value === "string" &&
    (ACP_RUNTIMES as readonly string[]).includes(value)
  );
}

export function getLocalAgentRuntime(
  settings?: UserSettings,
): LocalAgentRuntime {
  const fromEnv = process.env.DYAD_LOCAL_AGENT_RUNTIME;
  if (isLocalAgentRuntime(fromEnv)) {
    return fromEnv;
  }

  const fromSettings = (
    settings as UserSettings & { localAgentRuntime?: unknown }
  )?.localAgentRuntime;
  if (isLocalAgentRuntime(fromSettings)) {
    return fromSettings;
  }

  return FALLBACK_RUNTIME;
}

export function getAcpRuntime(settings?: UserSettings): AcpRuntime {
  const fromEnv = process.env.DYAD_ACP_RUNTIME;
  if (isAcpRuntime(fromEnv)) {
    return fromEnv;
  }

  const fromSettings = (settings as UserSettings & { acpRuntime?: unknown })
    ?.acpRuntime;
  if (isAcpRuntime(fromSettings)) {
    return fromSettings;
  }

  return FALLBACK_ACP_RUNTIME;
}
