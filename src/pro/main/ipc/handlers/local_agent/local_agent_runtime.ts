import type { UserSettings } from "@/lib/schemas";

export const LOCAL_AGENT_RUNTIMES = [
  "claude-agent-sdk",
  "vercel-ai",
  "acp",
] as const;

export type LocalAgentRuntime = (typeof LOCAL_AGENT_RUNTIMES)[number];

const FALLBACK_RUNTIME: LocalAgentRuntime = "claude-agent-sdk";

function isLocalAgentRuntime(value: unknown): value is LocalAgentRuntime {
  return (
    typeof value === "string" &&
    (LOCAL_AGENT_RUNTIMES as readonly string[]).includes(value)
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
