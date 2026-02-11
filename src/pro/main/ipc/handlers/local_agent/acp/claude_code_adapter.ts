/**
 * Claude Code ACP Runtime Adapter
 * Implements the AcpRuntimeAdapter interface for @zed-industries/claude-code-acp.
 */

import type { ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { UserSettings } from "@/lib/schemas";
import { BaseAcpAdapter, type AcpPackageConfig } from "./base_adapter";
import type { SessionMetaParams } from "./types";

export class ClaudeCodeAdapter extends BaseAcpAdapter {
  readonly id = "claude-code" as const;
  readonly displayName = "Claude Code";

  protected readonly packageConfig: AcpPackageConfig = {
    packageName: "@zed-industries/claude-code-acp",
    entryPath: "dist/index.js",
  };

  getSpawnEnv(settings: UserSettings): Record<string, string> {
    const env: Record<string, string> = {};

    // Pass through CLAUDE_CODE_EXECUTABLE if set
    if (process.env.DYAD_CLAUDE_CODE_EXECUTABLE) {
      env.CLAUDE_CODE_EXECUTABLE = process.env.DYAD_CLAUDE_CODE_EXECUTABLE;
    }

    // Set Anthropic API key from settings if not already in environment
    const anthropicKey = (settings as any)?.providerSettings?.anthropic?.apiKey
      ?.value;
    if (anthropicKey && !process.env.ANTHROPIC_API_KEY) {
      env.ANTHROPIC_API_KEY = anthropicKey;
    }

    return env;
  }

  buildSessionMeta(params: SessionMetaParams): Record<string, unknown> {
    return {
      systemPrompt: {
        append: `${params.systemPrompt}\n\nRUNTIME RULES:\n- If you need to modify files, perform edits via Claude Code tools directly.\n- Do not rely on dyad XML patch tags (<dyad-write>, <dyad-edit>, etc.) as the execution mechanism.\n- Only use tags in plain text when the user explicitly asks for tag examples.`,
      },
      claudeCode: {
        options: {
          maxTurns: 25,
          model: params.selectedModelName,
          disallowedTools:
            params.disallowedTools.length > 0
              ? params.disallowedTools
              : undefined,
        },
      },
    };
  }

  normalizeToolInput(input: unknown, _title?: string): Record<string, unknown> {
    // Claude Code uses standard format - pass through with basic normalization
    return this.normalizeToolInputDefault(input);
  }

  parseToolName(update: ToolCall | ToolCallUpdate): string {
    // Try Claude Code specific metadata first
    const claudeCodeToolName = (update as any)?._meta?.claudeCode?.toolName;
    if (
      typeof claudeCodeToolName === "string" &&
      claudeCodeToolName.length > 0
    ) {
      return claudeCodeToolName;
    }

    // Fall back to default parsing
    return this.parseToolNameDefault(update);
  }
}
