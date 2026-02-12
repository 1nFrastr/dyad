/**
 * OpenCode ACP Runtime Adapter
 * Implements the AcpRuntimeAdapter interface for OpenCode CLI.
 * OpenCode supports ACP natively via the `opencode acp` command.
 */

import type { ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { UserSettings } from "@/lib/schemas";
import { BaseAcpAdapter } from "./base_adapter";
import type { SessionMetaParams } from "./types";

export class OpenCodeAdapter extends BaseAcpAdapter {
  readonly id = "opencode" as const;
  readonly displayName = "OpenCode";

  // OpenCode uses CLI command, so we don't need a package config
  // But BaseAcpAdapter requires it, so we provide a dummy one
  protected readonly packageConfig = {
    packageName: "opencode",
    entryPath: "acp",
  };

  /**
   * OpenCode uses CLI command mode, not Node.js script execution.
   * Return the command name.
   */
  getSpawnCommand(): string {
    return "opencode";
  }

  /**
   * Return the arguments for the opencode command.
   */
  getSpawnArgs(): string[] {
    return ["acp"];
  }

  /**
   * Override resolveEntrypoint since we use CLI mode.
   * This won't be called if getSpawnCommand() returns a value,
   * but we provide a fallback implementation.
   */
  resolveEntrypoint(): string {
    // This shouldn't be called in CLI mode, but provide a fallback
    return "opencode";
  }

  getSpawnEnv(settings: UserSettings): Record<string, string> {
    const env: Record<string, string> = {};

    // Set OpenCode API key from settings if available
    // Check for OPENCODE_API_KEY in settings (similar to other providers)
    const opencodeKey = (settings as any)?.providerSettings?.opencode?.apiKey
      ?.value;
    if (opencodeKey && !process.env.OPENCODE_API_KEY) {
      env.OPENCODE_API_KEY = opencodeKey;
    }

    // Also check if OPENCODE_API_KEY is already in environment
    if (process.env.OPENCODE_API_KEY && !env.OPENCODE_API_KEY) {
      env.OPENCODE_API_KEY = process.env.OPENCODE_API_KEY;
    }

    return env;
  }

  buildSessionMeta(params: SessionMetaParams): Record<string, unknown> {
    // OpenCode uses standard ACP session meta format
    // Note: Do NOT add agent info here - it will be added by the handler
    // after initialize to ensure we have the correct agent name/version
    return {
      systemPrompt: {
        append: `${params.systemPrompt}\n\nRUNTIME RULES:\n- If you need to modify files, perform edits via OpenCode tools directly.\n- Do not rely on dyad XML patch tags (<dyad-write>, <dyad-edit>, etc.) as the execution mechanism.\n- Only use tags in plain text when the user explicitly asks for tag examples.`,
      },
      opencode: {
        options: {
          maxTurns: 25,
          model: "moonshotai-cn/kimi-k2.5",
          disallowedTools:
            params.disallowedTools.length > 0
              ? params.disallowedTools
              : undefined,
        },
      },
    };
  }

  normalizeToolInput(input: unknown, _title?: string): Record<string, unknown> {
    // OpenCode uses standard ACP format - pass through with basic normalization
    return this.normalizeToolInputDefault(input);
  }

  parseToolName(update: ToolCall | ToolCallUpdate): string {
    // Try OpenCode specific metadata first
    const opencodeToolName = (update as any)?._meta?.opencode?.toolName;
    if (typeof opencodeToolName === "string" && opencodeToolName.length > 0) {
      return opencodeToolName;
    }

    // Try generic _meta.toolName
    const metaToolName = (update as any)?._meta?.toolName;
    if (typeof metaToolName === "string" && metaToolName.length > 0) {
      return metaToolName;
    }

    // Handle MCP tools
    if (typeof update.title === "string" && update.title.startsWith("mcp__")) {
      return update.title;
    }

    // Fallback to default parsing
    return this.parseToolNameDefault(update);
  }
}
