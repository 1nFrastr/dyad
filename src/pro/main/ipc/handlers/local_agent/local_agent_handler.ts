/**
 * Local Agent v2 Handler
 * Main orchestrator backed by Claude Agent SDK runtime.
 */

import { IpcMainInvokeEvent } from "electron";
import type { ModelMessage } from "ai";
import { query } from "@anthropic-ai/claude-agent-sdk";
import log from "electron-log";
import { createRequire } from "node:module";
import path from "node:path";
import { existsSync } from "node:fs";

import { db } from "@/db";
import { chats, messages, mcpServers } from "@/db/schema";
import { eq } from "drizzle-orm";

import { isDyadProEnabled, isBasicAgentMode } from "@/lib/schemas";
import { readSettings } from "@/main/settings";
import { getDyadAppPath } from "@/paths/paths";
import { safeSend } from "@/ipc/utils/safe_sender";

import { clearPendingConsentsForChat } from "./tool_definitions";
import {
  deployAllFunctionsIfNeeded,
  commitAllChanges,
} from "./processors/file_operations";

import type { ChatStreamParams, ChatResponseEnd } from "@/ipc/types";
import {
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
  FileEditTracker,
} from "./tools/types";
import { sendTelemetryEvent } from "@/ipc/utils/telemetry";
import { requireMcpToolConsent } from "@/ipc/utils/mcp_consent";

const logger = log.scope("local_agent_handler");
const require = createRequire(import.meta.url);

const MUTATING_TOOLS = new Set([
  "Edit",
  "MultiEdit",
  "Write",
  "Bash",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "MCP",
]);

const PLAN_MODE_DISALLOWED_TOOLS = ["ExitPlanMode"];

function resolveClaudeCodeExecutablePath(): string {
  const envPath = process.env.DYAD_CLAUDE_CODE_EXECUTABLE;
  if (envPath && existsSync(envPath)) {
    return envPath;
  }

  try {
    const resolved = require.resolve("@anthropic-ai/claude-agent-sdk/cli.js");
    if (existsSync(resolved)) {
      return resolved;
    }
  } catch {
    // Continue with fallbacks.
  }

  const fallback = path.join(
    process.cwd(),
    "node_modules",
    "@anthropic-ai",
    "claude-agent-sdk",
    "cli.js",
  );
  if (existsSync(fallback)) {
    return fallback;
  }

  throw new Error(
    "Claude Code executable not found. Set DYAD_CLAUDE_CODE_EXECUTABLE or install @anthropic-ai/claude-agent-sdk.",
  );
}

function serializeMaybeJson(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Normalize MCP tool input so the Claude Code runtime always receives a plain
 * object. The runtime/MCP layer can receive input as string, null, or
 * non-plain object, which leads to "invalid parameters" errors.
 */
function normalizeMcpToolInput(input: Record<string, unknown> | unknown): Record<string, unknown> {
  if (input == null) {
    return {};
  }
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed === "") return {};
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Non-JSON string: pass as single key; many MCP tools accept "input" or "query"
      return { input };
    }
    return {};
  }
  if (typeof input === "object" && !Array.isArray(input)) {
    return { ...(input as Record<string, unknown>) };
  }
  return {};
}

function truncateText(value: string, max = 1500): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}\n... [truncated]`;
}

function getInputPath(input: Record<string, unknown>): string {
  const candidates = [
    input.file_path,
    input.path,
    input.target_file,
    input.directory,
  ];
  for (const v of candidates) {
    if (typeof v === "string" && v.trim().length > 0) {
      return v;
    }
  }
  return "";
}

function buildPrettyToolCallXml(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const path = getInputPath(input);
  switch (toolName) {
    case "Read":
      return `<dyad-read path="${escapeXmlAttr(path)}"></dyad-read>\n`;
    case "Write": {
      const content = typeof input.content === "string" ? input.content : "";
      return `<dyad-write path="${escapeXmlAttr(path)}" description="Write file with Claude Code runtime">${escapeXmlContent(truncateText(content))}</dyad-write>\n`;
    }
    case "Edit": {
      const content = serializeMaybeJson({
        old_string: input.old_string,
        new_string: input.new_string,
        replace_all: input.replace_all,
      });
      return `<dyad-edit path="${escapeXmlAttr(path)}" description="Edit file with Claude Code runtime">${escapeXmlContent(truncateText(content))}</dyad-edit>\n`;
    }
    case "MultiEdit": {
      const content = serializeMaybeJson({
        edits: input.edits,
      });
      return `<dyad-edit path="${escapeXmlAttr(path)}" description="Multi-edit file with Claude Code runtime">${escapeXmlContent(truncateText(content))}</dyad-edit>\n`;
    }
    case "Grep": {
      const query =
        typeof input.pattern === "string"
          ? input.pattern
          : typeof input.query === "string"
            ? input.query
            : "";
      const include =
        typeof input.include === "string"
          ? input.include
          : typeof input.glob === "string"
            ? input.glob
            : "";
      return `<dyad-grep query="${escapeXmlAttr(query)}" include="${escapeXmlAttr(include)}" state="finished"></dyad-grep>\n`;
    }
    case "Glob":
    case "LS":
      return `<dyad-list-files directory="${escapeXmlAttr(path || ".")}" recursive="true" state="finished"></dyad-list-files>\n`;
    default: {
      const toolInput = serializeMaybeJson(input);
      return `<dyad-mcp-tool-call server="local" tool="${escapeXmlAttr(toolName)}">\n${escapeXmlContent(truncateText(toolInput))}\n</dyad-mcp-tool-call>\n`;
    }
  }
}

function buildConversationPromptFromDbMessages(
  history: Array<{ role: "user" | "assistant"; content: string }>,
): string {
  const usable = history.filter((m) => m.content?.trim().length > 0);
  if (usable.length === 0) {
    return "";
  }
  const transcript = usable
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}:\n${m.content}`)
    .join("\n\n");
  return [
    "Continue this existing conversation and respond to the latest user request.",
    "",
    transcript,
  ].join("\n");
}

function buildConversationPromptFromModelMessages(
  messageOverride: ModelMessage[],
): string {
  const transcript = messageOverride
    .map((m) => {
      if (!m.content) {
        return "";
      }
      if (typeof m.content === "string") {
        return `${m.role}:\n${m.content}`;
      }
      const text = m.content
        .map((part: any) => {
          if (!part || typeof part !== "object") {
            return "";
          }
          if (part.type === "text") {
            return part.text ?? "";
          }
          if (part.type === "tool-call") {
            return `<tool-call ${part.toolName ?? "unknown"}>${serializeMaybeJson(part.input)}</tool-call>`;
          }
          if (part.type === "tool-result") {
            return `<tool-result ${part.toolName ?? "unknown"}>${serializeMaybeJson(part.output)}</tool-result>`;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
      return `${m.role}:\n${text}`;
    })
    .filter(Boolean)
    .join("\n\n");
  return [
    "Continue this existing conversation and respond to the latest user request.",
    "",
    transcript,
  ].join("\n");
}

/**
 * Handle a chat stream in local-agent mode
 */
export async function handleLocalAgentStream(
  event: IpcMainInvokeEvent,
  req: ChatStreamParams,
  abortController: AbortController,
  {
    placeholderMessageId,
    systemPrompt,
    dyadRequestId,
    readOnly = false,
    planModeOnly = false,
    skipProCheck = false,
    messageOverride,
  }: {
    placeholderMessageId: number;
    systemPrompt: string;
    dyadRequestId: string;
    /**
     * If true, the agent operates in read-only mode (e.g., ask mode).
     * State-modifying tools are disabled, and no commits/deploys are made.
     */
    readOnly?: boolean;
    /**
     * If true, only include tools allowed in plan mode.
     * This includes read-only exploration tools and planning-specific tools.
     */
    planModeOnly?: boolean;
    /**
     * If true, do not enforce Dyad Pro / Basic Agent mode gate.
     * Used by build mode migration to Claude Code runtime.
     */
    skipProCheck?: boolean;
    /**
     * If provided, use these messages instead of fetching from the database.
     * Used for summarization where messages need to be transformed.
     */
    messageOverride?: ModelMessage[];
  },
): Promise<boolean> {
  const settings = readSettings();

  // Check Pro status or Basic Agent mode
  // Basic Agent mode allows non-Pro users with quota (quota check is done in chat_stream_handlers)
  // Read-only mode (ask mode) is allowed for all users without Pro
  if (
    !skipProCheck &&
    !readOnly &&
    !isDyadProEnabled(settings) &&
    !isBasicAgentMode(settings)
  ) {
    safeSend(event.sender, "chat:response:error", {
      chatId: req.chatId,
      error:
        "Agent v2 requires Dyad Pro. Please enable Dyad Pro in Settings → Pro.",
    });
    return false;
  }

  // Get the chat and app
  const chat = await db.query.chats.findFirst({
    where: eq(chats.id, req.chatId),
    with: {
      messages: {
        orderBy: (messages, { asc }) => [asc(messages.createdAt)],
      },
      app: true,
    },
  });

  if (!chat || !chat.app) {
    throw new Error(`Chat not found: ${req.chatId}`);
  }

  const appPath = getDyadAppPath(chat.app.path);

  // Send initial message update
  safeSend(event.sender, "chat:response:chunk", {
    chatId: req.chatId,
    messages: chat.messages,
  });

  let fullResponse = "";

  try {
    const enabledMcpServers = await db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.enabled, true as any));

    const fileEditTracker: FileEditTracker = Object.create(null);
    const ctx: AgentContext = {
      event,
      appId: chat.app.id,
      appPath,
      chatId: chat.id,
      supabaseProjectId: chat.app.supabaseProjectId,
      supabaseOrganizationSlug: chat.app.supabaseOrganizationSlug,
      messageId: placeholderMessageId,
      isSharedModulesChanged: false,
      todos: [],
      dyadRequestId,
      fileEditTracker,
      isDyadPro: isDyadProEnabled(settings),
      onXmlStream: (accumulatedXml: string) => {
        sendResponseChunk(
          event,
          req.chatId,
          chat,
          fullResponse + accumulatedXml,
        );
      },
      onXmlComplete: (finalXml: string) => {
        fullResponse += finalXml + "\n";
        updateResponseInDb(placeholderMessageId, fullResponse);
        sendResponseChunk(event, req.chatId, chat, fullResponse);
      },
      requireConsent: async () => true,
      appendUserMessage: () => {},
      onUpdateTodos: (todos) => {
        safeSend(event.sender, "agent-tool:todos-update", {
          chatId: chat.id,
          todos,
        });
      },
    };

    const appendChunk = async (chunk: string) => {
      if (!chunk) {
        return;
      }
      fullResponse += chunk;
      await updateResponseInDb(placeholderMessageId, fullResponse);
      sendResponseChunk(event, req.chatId, chat, fullResponse);
    };

    const conversationPrompt = messageOverride
      ? buildConversationPromptFromModelMessages(messageOverride)
      : buildConversationPromptFromDbMessages(
          chat.messages.map((m) => ({ role: m.role, content: m.content })),
        );

    const readOnlyDisallowed = Array.from(MUTATING_TOOLS);
    const disallowedTools = [
      ...(readOnly ? readOnlyDisallowed : []),
      ...(planModeOnly ? PLAN_MODE_DISALLOWED_TOOLS : []),
    ];
    const claudeExecutablePath = resolveClaudeCodeExecutablePath();
    const runtimeMode = readOnly
      ? "ask"
      : planModeOnly
        ? "plan"
        : skipProCheck
          ? "build"
          : "agent";
    logger.log(
      `[cc-runtime] start chatId=${req.chatId} mode=${runtimeMode} model=${settings.selectedModel.name} cwd=${appPath} executable=${claudeExecutablePath}`,
    );

    let inThinkingBlock = false;
    let hasStreamedText = false;
    let wasAborted = false;
    let latestResult:
      | {
          subtype: string;
          usage?: { inputTokens?: number; outputTokens?: number };
          result?: string;
          errors?: string[];
        }
      | undefined;

    const stream = query({
      prompt: conversationPrompt || req.prompt,
      options: {
        cwd: appPath,
        pathToClaudeCodeExecutable: claudeExecutablePath,
        abortController,
        model: settings.selectedModel.name,
        maxTurns: 25,
        permissionMode: planModeOnly ? "plan" : "acceptEdits",
        tools: { type: "preset", preset: "claude_code" },
        disallowedTools:
          disallowedTools.length > 0 ? disallowedTools : undefined,
        includePartialMessages: true,
        settingSources: ["user", "project", "local"],
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: `${systemPrompt}

RUNTIME RULES:
- If you need to modify files, perform edits via Claude Code tools directly.
- Do not rely on dyad XML patch tags (<dyad-write>, <dyad-edit>, etc.) as the execution mechanism.
- Only use tags in plain text when the user explicitly asks for tag examples.`,
        },
        canUseTool: async (toolName, input, options) => {
          const isMcpTool = toolName.startsWith("mcp__");
          if (!isMcpTool) {
            return { behavior: "allow", toolUseID: options.toolUseID };
          }

          // Normalize MCP tool input so the runtime always gets a plain object.
          // The runtime can receive string/empty/wrong shape and MCP then reports "invalid parameters".
          const normalizedInput = normalizeMcpToolInput(input);

          const normalized = toolName.replace(/^mcp__/, "");
          const splitIndex = normalized.indexOf("__");
          const serverName =
            splitIndex >= 0 ? normalized.slice(0, splitIndex) : normalized;
          const mcpToolName =
            splitIndex >= 0 ? normalized.slice(splitIndex + 2) : normalized;

          const inputPreview = serializeMaybeJson(normalizedInput).slice(0, 500);
          const matchingServer = enabledMcpServers.find(
            (s) =>
              (s.name || "").toLowerCase().replace(/\W+/g, "_") === serverName,
          );
          const ok = matchingServer
            ? await requireMcpToolConsent(event, {
                serverId: matchingServer.id,
                serverName: matchingServer.name,
                toolName: mcpToolName,
                toolDescription: "",
                inputPreview,
              })
            : true;

          if (!ok) {
            return {
              behavior: "deny",
              message: `User denied MCP tool ${toolName}`,
              toolUseID: options.toolUseID,
            };
          }

          return {
            behavior: "allow",
            toolUseID: options.toolUseID,
            updatedInput: normalizedInput,
          };
        },
        hooks: {
          PreToolUse: [
            {
              hooks: [
                async (input: any) => {
                  const toolName = input?.tool_name ?? "unknown";
                  const toolInput =
                    (input?.tool_input as Record<string, unknown>) ?? {};
                  await appendChunk(
                    buildPrettyToolCallXml(toolName, toolInput),
                  );
                  return { continue: true };
                },
              ],
            },
          ],
          PostToolUse: [
            {
              hooks: [
                async () => ({ continue: true }),
              ],
            },
          ],
          PostToolUseFailure: [
            {
              hooks: [
                async (input: any) => {
                  const toolName = input?.tool_name ?? "unknown";
                  const errorMessage = String(input?.error ?? "Tool failed");
                  await appendChunk(
                    `<dyad-output type="error" message="Tool '${escapeXmlAttr(toolName)}' failed: ${escapeXmlAttr(errorMessage)}">${escapeXmlContent(errorMessage)}</dyad-output>\n`,
                  );
                  return { continue: true };
                },
              ],
            },
          ],
        },
      },
    });

    for await (const part of stream) {
      if (abortController.signal.aborted) {
        logger.log(`Stream aborted for chat ${req.chatId}`);
        clearPendingConsentsForChat(req.chatId);
        wasAborted = true;
        stream.close();
        break;
      }

      if (part.type === "stream_event") {
        const eventPart: any = part.event;
        if (
          eventPart?.type === "content_block_delta" &&
          eventPart?.delta?.type === "text_delta"
        ) {
          if (inThinkingBlock) {
            inThinkingBlock = false;
            await appendChunk("</think>\n");
          }
          hasStreamedText = true;
          await appendChunk(eventPart.delta.text ?? "");
        } else if (
          eventPart?.type === "content_block_delta" &&
          eventPart?.delta?.type === "thinking_delta"
        ) {
          if (!inThinkingBlock) {
            inThinkingBlock = true;
            await appendChunk("<think>");
          }
          await appendChunk(eventPart.delta.thinking ?? "");
        } else if (
          eventPart?.type === "content_block_stop" &&
          inThinkingBlock
        ) {
          inThinkingBlock = false;
          await appendChunk("</think>\n");
        }
        continue;
      }

      if (part.type === "system" && (part as any).subtype === "init") {
        const initPart: any = part;
        logger.log(
          `[cc-runtime] init claude_code_version=${initPart.claude_code_version ?? "unknown"} model=${initPart.model ?? "unknown"} permissionMode=${initPart.permissionMode ?? "unknown"} tools=${Array.isArray(initPart.tools) ? initPart.tools.length : 0}`,
        );
        continue;
      }

      if (part.type === "assistant" && !hasStreamedText) {
        const contentParts: any[] = (part as any).message?.content ?? [];
        for (const content of contentParts) {
          if (content?.type === "text" && typeof content.text === "string") {
            await appendChunk(content.text);
          } else if (
            content?.type === "thinking" &&
            typeof content.thinking === "string"
          ) {
            await appendChunk(`<think>${content.thinking}</think>\n`);
          }
        }
        continue;
      }

      if (part.type === "result") {
        latestResult = {
          subtype: (part as any).subtype,
          usage: (part as any).usage,
          result: (part as any).result,
          errors: (part as any).errors,
        };
        logger.log(
          `[cc-runtime] result subtype=${latestResult.subtype} inputTokens=${latestResult.usage?.inputTokens ?? 0} outputTokens=${latestResult.usage?.outputTokens ?? 0}`,
        );
      }
    }

    if (inThinkingBlock) {
      await appendChunk("</think>\n");
    }

    if (wasAborted) {
      throw new Error("Stream aborted");
    }

    if (!hasStreamedText && latestResult?.result) {
      await appendChunk(latestResult.result);
    }

    const totalTokens =
      (latestResult?.usage?.inputTokens ?? 0) +
      (latestResult?.usage?.outputTokens ?? 0);
    if (totalTokens > 0) {
      await db
        .update(messages)
        .set({ maxTokensUsed: totalTokens })
        .where(eq(messages.id, placeholderMessageId))
        .catch((err) => logger.error("Failed to save token count", err));
    }

    if (latestResult?.subtype && latestResult.subtype !== "success") {
      throw new Error(
        latestResult.errors?.join("\n") ||
          `Claude agent runtime failed with subtype: ${latestResult.subtype}`,
      );
    }

    // In read-only and plan mode, skip deploys and commits
    if (!readOnly && !planModeOnly) {
      // Deploy all Supabase functions if shared modules changed
      await deployAllFunctionsIfNeeded(ctx);

      // Commit all changes
      const commitResult = await commitAllChanges(ctx, ctx.chatSummary);

      if (commitResult.commitHash) {
        await db
          .update(messages)
          .set({ commitHash: commitResult.commitHash })
          .where(eq(messages.id, placeholderMessageId));
      }
    }

    // Mark as approved (auto-approve for local-agent)
    await db
      .update(messages)
      .set({ approvalState: "approved" })
      .where(eq(messages.id, placeholderMessageId));

    // Send telemetry for files with multiple edit tool types
    for (const [filePath, counts] of Object.entries(fileEditTracker)) {
      const toolsUsed = Object.entries(counts).filter(([, count]) => count > 0);
      if (toolsUsed.length >= 2) {
        sendTelemetryEvent("local_agent:file_edit_retry", {
          filePath,
          ...counts,
        });
      }
    }

    // Send completion
    safeSend(event.sender, "chat:response:end", {
      chatId: req.chatId,
      updatedFiles: !readOnly,
      chatSummary: ctx.chatSummary,
    } satisfies ChatResponseEnd);

    return true; // Success
  } catch (error) {
    // Clean up any pending consent requests for this chat to prevent
    // stale UI banners and orphaned promises
    clearPendingConsentsForChat(req.chatId);

    if (abortController.signal.aborted) {
      // Handle cancellation
      if (fullResponse) {
        await db
          .update(messages)
          .set({ content: `${fullResponse}\n\n[Response cancelled by user]` })
          .where(eq(messages.id, placeholderMessageId));
      }
      return false; // Cancelled - don't consume quota
    }

    logger.error("Local agent error:", error);
    safeSend(event.sender, "chat:response:error", {
      chatId: req.chatId,
      error: `Error: ${error}`,
    });
    return false; // Error - don't consume quota
  }
}

async function updateResponseInDb(messageId: number, content: string) {
  await db
    .update(messages)
    .set({ content })
    .where(eq(messages.id, messageId))
    .catch((err) => logger.error("Failed to update message", err));
}

function sendResponseChunk(
  event: IpcMainInvokeEvent,
  chatId: number,
  chat: any,
  fullResponse: string,
) {
  const currentMessages = [...chat.messages];
  if (currentMessages.length > 0) {
    const lastMsg = currentMessages[currentMessages.length - 1];
    if (lastMsg.role === "assistant") {
      lastMsg.content = fullResponse;
    }
  }
  safeSend(event.sender, "chat:response:chunk", {
    chatId,
    messages: currentMessages,
  });
}
