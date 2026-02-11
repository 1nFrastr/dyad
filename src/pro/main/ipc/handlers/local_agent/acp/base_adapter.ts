/**
 * Base ACP Runtime Adapter
 * Provides common functionality shared across all ACP runtime implementations.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { existsSync } from "node:fs";
import type { ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { UserSettings } from "@/lib/schemas";
import type { AcpRuntimeAdapter, SessionMetaParams } from "./types";
import type { AcpRuntime } from "../local_agent_runtime";

const require = createRequire(import.meta.url);

/**
 * Configuration for an ACP runtime package.
 */
export interface AcpPackageConfig {
  packageName: string;
  entryPath: string;
}

/**
 * Abstract base class for ACP runtime adapters.
 * Provides common entrypoint resolution logic.
 */
export abstract class BaseAcpAdapter implements AcpRuntimeAdapter {
  abstract readonly id: AcpRuntime;
  abstract readonly displayName: string;

  protected abstract readonly packageConfig: AcpPackageConfig;

  /**
   * Resolve the ACP agent entrypoint path.
   * Checks in order:
   * 1. DYAD_ACP_AGENT_ENTRY environment variable
   * 2. require.resolve() from node_modules
   * 3. Fallback to direct node_modules path
   */
  resolveEntrypoint(): string {
    const { packageName, entryPath } = this.packageConfig;

    // 1. Check environment variable override
    const envPath = process.env.DYAD_ACP_AGENT_ENTRY;
    if (envPath && existsSync(envPath)) {
      return envPath;
    }

    // 2. Try require.resolve
    try {
      const resolved = require.resolve(`${packageName}/${entryPath}`);
      if (existsSync(resolved)) {
        return resolved;
      }
    } catch {
      // Continue with fallback.
    }

    // 3. Fallback to node_modules path
    const fallback = path.join(
      process.cwd(),
      "node_modules",
      ...packageName.split("/"),
      entryPath,
    );
    if (existsSync(fallback)) {
      return fallback;
    }

    throw new Error(
      `${this.displayName} ACP adapter not found. Install ${packageName} or set DYAD_ACP_AGENT_ENTRY.`,
    );
  }

  abstract getSpawnEnv(settings: UserSettings): Record<string, string>;
  abstract buildSessionMeta(params: SessionMetaParams): Record<string, unknown>;
  abstract normalizeToolInput(
    input: unknown,
    title?: string,
  ): Record<string, unknown>;
  abstract parseToolName(update: ToolCall | ToolCallUpdate): string;

  /**
   * Default tool name parsing that tries common metadata locations.
   * Subclasses can override for runtime-specific behavior.
   */
  protected parseToolNameDefault(update: ToolCall | ToolCallUpdate): string {
    // Try generic _meta.toolName
    const metaToolName = (update as any)?._meta?.toolName;
    if (typeof metaToolName === "string" && metaToolName.length > 0) {
      return metaToolName;
    }

    // Handle MCP tools
    if (typeof update.title === "string" && update.title.startsWith("mcp__")) {
      return update.title;
    }

    // Fallback to title
    if (typeof update.title === "string" && update.title.length > 0) {
      return update.title;
    }

    return "unknown";
  }

  /**
   * Default tool input normalization that handles common formats.
   * Subclasses can override for runtime-specific behavior.
   */
  protected normalizeToolInputDefault(input: unknown): Record<string, unknown> {
    if (input == null) {
      return {};
    }

    if (typeof input === "string") {
      const trimmed = input.trim();
      if (!trimmed) {
        return {};
      }
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return { input };
      }
      return {};
    }

    if (typeof input === "object" && !Array.isArray(input)) {
      return { ...(input as Record<string, unknown>) };
    }

    return {};
  }
}
