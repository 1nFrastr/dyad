/**
 * ACP Runtime Adapter Factory
 * Provides a unified interface for getting the appropriate ACP runtime adapter.
 */

import type { UserSettings } from "@/lib/schemas";
import { getAcpRuntime, type AcpRuntime } from "../local_agent_runtime";
import type { AcpRuntimeAdapter } from "./types";
import { ClaudeCodeAdapter } from "./claude_code_adapter";
import { CodexAdapter } from "./codex_adapter";

// Re-export types and adapters
export type { AcpRuntimeAdapter, SessionMetaParams } from "./types";
export { ClaudeCodeAdapter } from "./claude_code_adapter";
export { CodexAdapter } from "./codex_adapter";
export { BaseAcpAdapter } from "./base_adapter";

/**
 * Singleton instances of all adapters.
 * Using singletons avoids unnecessary object creation on each call.
 */
const adapters: Record<AcpRuntime, AcpRuntimeAdapter> = {
  "claude-code": new ClaudeCodeAdapter(),
  codex: new CodexAdapter(),
};

/**
 * Get the ACP runtime adapter based on user settings.
 *
 * @param settings - User settings (optional, will read from env if not provided)
 * @returns The appropriate AcpRuntimeAdapter instance
 *
 * @example
 * ```ts
 * const adapter = getAcpAdapter(settings);
 * const entrypoint = adapter.resolveEntrypoint();
 * const env = adapter.getSpawnEnv(settings);
 * ```
 */
export function getAcpAdapter(settings?: UserSettings): AcpRuntimeAdapter {
  const runtime = getAcpRuntime(settings);
  return adapters[runtime];
}

/**
 * Get an adapter by its runtime ID.
 * Useful for testing or when you know the specific runtime you want.
 */
export function getAcpAdapterById(runtimeId: AcpRuntime): AcpRuntimeAdapter {
  return adapters[runtimeId];
}

/**
 * Get all available adapter instances.
 * Useful for iterating over all runtimes.
 */
export function getAllAcpAdapters(): AcpRuntimeAdapter[] {
  return Object.values(adapters);
}
