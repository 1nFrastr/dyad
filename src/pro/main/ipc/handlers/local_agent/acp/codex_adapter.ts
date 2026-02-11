/**
 * Codex ACP Runtime Adapter
 * Implements the AcpRuntimeAdapter interface for @zed-industries/codex-acp.
 */

import type { ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { UserSettings } from "@/lib/schemas";
import { BaseAcpAdapter, type AcpPackageConfig } from "./base_adapter";
import type { SessionMetaParams } from "./types";

export class CodexAdapter extends BaseAcpAdapter {
  readonly id = "codex" as const;
  readonly displayName = "Codex";

  protected readonly packageConfig: AcpPackageConfig = {
    packageName: "@zed-industries/codex-acp",
    entryPath: "bin/codex-acp.js",
  };

  getSpawnEnv(settings: UserSettings): Record<string, string> {
    const env: Record<string, string> = {};

    // Set OpenAI API key from settings if not already in environment
    const openaiKey = (settings as any)?.providerSettings?.openai?.apiKey
      ?.value;
    if (openaiKey && !process.env.OPENAI_API_KEY) {
      env.OPENAI_API_KEY = openaiKey;
    }
    // Codex also accepts CODEX_API_KEY
    if (openaiKey && !process.env.CODEX_API_KEY) {
      env.CODEX_API_KEY = openaiKey;
    }

    return env;
  }

  buildSessionMeta(params: SessionMetaParams): Record<string, unknown> {
    // Codex uses the same session meta format as Claude Code for now
    // This can be customized if Codex requires different metadata
    return {
      systemPrompt: {
        append: `${params.systemPrompt}\n\nRUNTIME RULES:\n- If you need to modify files, perform edits via Codex tools directly.\n- Do not rely on dyad XML patch tags (<dyad-write>, <dyad-edit>, etc.) as the execution mechanism.\n- Only use tags in plain text when the user explicitly asks for tag examples.`,
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

  normalizeToolInput(input: unknown, title?: string): Record<string, unknown> {
    if (input == null) {
      // Try to extract input from title for Codex format
      return this.extractInputFromTitle(title);
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
      const inputObj = input as Record<string, unknown>;

      // Check if this is Codex format (has parsed_cmd or command but no file_path/path)
      const isCodexFormat =
        (inputObj.parsed_cmd != null || inputObj.command != null) &&
        inputObj.file_path == null &&
        inputObj.path == null &&
        inputObj.target_file == null;

      // If Codex format and we have title, extract from title instead
      if (isCodexFormat && title) {
        const extracted = this.extractInputFromTitleWithCommand(
          title,
          inputObj,
        );
        if (Object.keys(extracted).length > 0) {
          return extracted;
        }
      }

      // Check for Codex Edit format (has changes object)
      if (inputObj.changes != null && typeof inputObj.changes === "object") {
        const normalized = this.normalizeChangesObject(inputObj.changes);
        if (normalized) {
          return normalized;
        }
      }

      // Return as-is for other formats
      return { ...inputObj };
    }

    return {};
  }

  parseToolName(update: ToolCall | ToolCallUpdate): string {
    // Try Codex specific metadata first
    const codexToolName = (update as any)?._meta?.codex?.toolName;
    if (typeof codexToolName === "string" && codexToolName.length > 0) {
      return codexToolName;
    }

    // Try Claude Code metadata (Codex might use same structure)
    const claudeCodeToolName = (update as any)?._meta?.claudeCode?.toolName;
    if (
      typeof claudeCodeToolName === "string" &&
      claudeCodeToolName.length > 0
    ) {
      return claudeCodeToolName;
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

    // Fallback to title, but extract just the tool name (Codex includes args in title)
    if (typeof update.title === "string" && update.title.length > 0) {
      // Codex format: "Read Index.tsx" or "Run npm install"
      // Extract first word as tool name
      const firstWord = update.title.split(/\s+/)[0];
      return firstWord || update.title;
    }

    return "unknown";
  }

  /**
   * Extract tool input from title when input is null.
   * Codex often puts tool args in the title like "Read file.ts".
   */
  private extractInputFromTitle(title?: string): Record<string, unknown> {
    if (!title) {
      return {};
    }

    const parts = title.split(/\s+/);
    if (parts.length <= 1) {
      return {};
    }

    const toolName = parts[0];
    const args = parts.slice(1).join(" ");

    // Common patterns
    if (toolName === "Read" || toolName === "Write" || toolName === "Edit") {
      return { path: args, file_path: args };
    }
    if (toolName === "Run") {
      return { command: args };
    }
    return { args };
  }

  /**
   * Extract tool input from title when we also have a command object.
   * Handles special patterns like "cat > file <<'EOF'".
   */
  private extractInputFromTitleWithCommand(
    title: string,
    inputObj: Record<string, unknown>,
  ): Record<string, unknown> {
    const parts = title.split(/\s+/);
    if (parts.length <= 1) {
      return {};
    }

    const toolName = parts[0];
    const args = parts.slice(1).join(" ");

    // Common patterns
    if (toolName === "Read" || toolName === "Write" || toolName === "Edit") {
      return { path: args, file_path: args };
    }

    if (toolName === "Run") {
      // Check for "cat > file <<'EOF'" pattern (Codex file write pattern)
      const catWriteMatch = args.match(/cat\s+>\s+([^\s<]+)\s+<<['"]EOF['"]/);
      if (catWriteMatch) {
        const filePath = catWriteMatch[1];
        const content = this.extractContentFromCommand(inputObj);
        return {
          path: filePath,
          file_path: filePath,
          content: content,
        };
      }
      // Regular Run command
      return { command: args };
    }

    return { args };
  }

  /**
   * Extract content from a Codex command object.
   * Handles both string and array command formats.
   */
  private extractContentFromCommand(inputObj: Record<string, unknown>): string {
    let commandStr = "";
    if (typeof inputObj.command === "string") {
      commandStr = inputObj.command;
    } else if (Array.isArray(inputObj.command)) {
      // Codex format: ["/bin/zsh", "-lc", "cat > file <<'EOF'\ncontent\nEOF"]
      // The actual command is usually in the last element or joined
      commandStr =
        inputObj.command.length > 2
          ? inputObj.command[2] // Usually the third element contains the full command
          : inputObj.command.join(" ");
    }

    // Extract content between <<'EOF' and EOF (handle both 'EOF and "EOF)
    const contentMatch = commandStr.match(/<<['"]EOF['"]([\s\S]*?)EOF/);
    return contentMatch ? contentMatch[1].trim() : "";
  }

  /**
   * Normalize Codex's changes object format for edits.
   * Codex uses: { changes: { "filepath": { new_content: "..." } } }
   */
  private normalizeChangesObject(
    changes: unknown,
  ): Record<string, unknown> | null {
    if (typeof changes !== "object" || changes === null) {
      return null;
    }

    const changesObj = changes as Record<string, unknown>;
    const filePath = Object.keys(changesObj)[0];
    if (!filePath) {
      return null;
    }

    const change = changesObj[filePath] as Record<string, unknown> | undefined;
    if (change?.new_content != null) {
      const newContent =
        typeof change.new_content === "string" ? change.new_content : "";
      return {
        path: filePath,
        file_path: filePath,
        new_string: newContent,
        // Codex Edit doesn't provide old_string, so we'll use empty string
        old_string: "",
      };
    }

    return null;
  }
}
