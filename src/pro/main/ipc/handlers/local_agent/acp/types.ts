/**
 * ACP Runtime Adapter Types
 * Defines the interface for pluggable ACP runtime implementations.
 */

import type { ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { UserSettings } from "@/lib/schemas";
import type { AcpRuntime } from "../local_agent_runtime";

/**
 * Parameters for building session metadata.
 */
export interface SessionMetaParams {
  systemPrompt: string;
  selectedModelName: string;
  disallowedTools: string[];
}

/**
 * Interface for ACP runtime adapters.
 * Each runtime (claude-code, codex, etc.) implements this interface
 * to provide runtime-specific behavior.
 */
export interface AcpRuntimeAdapter {
  /** Unique identifier for this runtime */
  readonly id: AcpRuntime;

  /** Human-readable display name */
  readonly displayName: string;

  /**
   * Resolve the path to the ACP agent entrypoint script.
   * @throws Error if the entrypoint cannot be found
   */
  resolveEntrypoint(): string;

  /**
   * Get environment variables to set when spawning the ACP process.
   * Typically includes API keys based on user settings.
   */
  getSpawnEnv(settings: UserSettings): Record<string, string>;

  /**
   * Build the _meta object for the newSession call.
   * Different runtimes expect different metadata structures.
   */
  buildSessionMeta(params: SessionMetaParams): Record<string, unknown>;

  /**
   * Normalize tool input from runtime-specific format to a standard format.
   * Different runtimes may encode tool inputs differently.
   *
   * @param input - Raw input from the tool call
   * @param title - Optional title that may contain additional info (e.g., "Read file.ts")
   * @returns Normalized input object with standard keys like `path`, `file_path`, `content`
   */
  normalizeToolInput(input: unknown, title?: string): Record<string, unknown>;

  /**
   * Extract the tool name from a ToolCall or ToolCallUpdate.
   * Different runtimes store tool names in different places in _meta.
   */
  parseToolName(update: ToolCall | ToolCallUpdate): string;
}
