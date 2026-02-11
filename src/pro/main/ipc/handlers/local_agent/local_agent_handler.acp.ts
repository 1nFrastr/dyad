/**
 * Local Agent v2 Handler
 * ACP runtime implementation backed by @zed-industries/claude-code-acp.
 */

import { IpcMainInvokeEvent } from "electron";
import type { ModelMessage } from "ai";
import {
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type ToolCall,
  type ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import log from "electron-log";
import { createRequire } from "node:module";
import path from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

import { db } from "@/db";
import { chats, messages } from "@/db/schema";
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
import { buildAcpSessionMeta } from "./local_agent_handler_acp_meta";

const logger = log.scope("local_agent_handler_acp");
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

type PermissionMode = "default" | "acceptEdits" | "plan" | "dontAsk";

function resolveAcpAgentEntrypoint(): string {
  const envPath = process.env.DYAD_ACP_AGENT_ENTRY;
  if (envPath && existsSync(envPath)) {
    return envPath;
  }

  try {
    const resolved =
      require.resolve("@zed-industries/claude-code-acp/dist/index.js");
    if (existsSync(resolved)) {
      return resolved;
    }
  } catch {
    // Continue with fallback.
  }

  const fallback = path.join(
    process.cwd(),
    "node_modules",
    "@zed-industries",
    "claude-code-acp",
    "dist",
    "index.js",
  );
  if (existsSync(fallback)) {
    return fallback;
  }

  throw new Error(
    "Claude Code ACP adapter not found. Install @zed-industries/claude-code-acp or set DYAD_ACP_AGENT_ENTRY.",
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

function truncateText(value: string, max = 1500): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}\n... [truncated]`;
}

function normalizeToolInput(input: unknown): Record<string, unknown> {
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

function hasMeaningfulToolInput(input: Record<string, unknown>): boolean {
  if (Object.keys(input).length === 0) {
    return false;
  }
  return Object.values(input).some((value) => {
    if (value == null) return false;
    if (typeof value === "string") return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "object") return Object.keys(value).length > 0;
    return true;
  });
}

function getInputPath(input: Record<string, unknown>): string {
  const candidates = [
    input.file_path,
    input.path,
    input.target_file,
    input.directory,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return "";
}

function buildPrettyToolCallXml(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const normalizedToolName = toolName.startsWith("mcp__acp__")
    ? toolName.slice("mcp__acp__".length)
    : toolName;
  const filePath = getInputPath(input);
  switch (normalizedToolName) {
    case "Read":
      return `<dyad-read path="${escapeXmlAttr(filePath)}"></dyad-read>\n`;
    case "Write": {
      const content = typeof input.content === "string" ? input.content : "";
      return `<dyad-write path="${escapeXmlAttr(filePath)}" description="Write file with Claude Code ACP runtime">${escapeXmlContent(truncateText(content))}</dyad-write>\n`;
    }
    case "Edit": {
      const content = serializeMaybeJson({
        old_string: input.old_string,
        new_string: input.new_string,
        replace_all: input.replace_all,
      });
      return `<dyad-edit path="${escapeXmlAttr(filePath)}" description="Edit file with Claude Code ACP runtime">${escapeXmlContent(truncateText(content))}</dyad-edit>\n`;
    }
    case "MultiEdit": {
      const content = serializeMaybeJson({ edits: input.edits });
      return `<dyad-edit path="${escapeXmlAttr(filePath)}" description="Multi-edit file with Claude Code ACP runtime">${escapeXmlContent(truncateText(content))}</dyad-edit>\n`;
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
      return `<dyad-list-files directory="${escapeXmlAttr(filePath || ".")}" recursive="true" state="finished"></dyad-list-files>\n`;
    default: {
      const toolInput = serializeMaybeJson(input);
      return `<dyad-mcp-tool-call server="local" tool="${escapeXmlAttr(normalizedToolName)}">\n${escapeXmlContent(truncateText(toolInput))}\n</dyad-mcp-tool-call>\n`;
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
    .map((message) => {
      if (!message.content) {
        return "";
      }
      if (typeof message.content === "string") {
        return `${message.role}:\n${message.content}`;
      }
      const text = message.content
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
      return `${message.role}:\n${text}`;
    })
    .filter(Boolean)
    .join("\n\n");

  return [
    "Continue this existing conversation and respond to the latest user request.",
    "",
    transcript,
  ].join("\n");
}

function parseToolNameFromUpdate(update: ToolCall | ToolCallUpdate): string {
  const metaToolName = (update as any)?._meta?.claudeCode?.toolName;
  if (typeof metaToolName === "string" && metaToolName.length > 0) {
    return metaToolName;
  }

  if (typeof update.title === "string" && update.title.startsWith("mcp__")) {
    return update.title;
  }

  return typeof update.title === "string" && update.title.length > 0
    ? update.title
    : "unknown";
}

function findAllowOption(params: RequestPermissionRequest): string | undefined {
  return (
    params.options.find((option) => option.kind === "allow_once")?.optionId ??
    params.options.find((option) => option.kind === "allow_always")?.optionId
  );
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
    const lastMessage = currentMessages[currentMessages.length - 1];
    if (lastMessage.role === "assistant") {
      lastMessage.content = fullResponse;
    }
  }
  safeSend(event.sender, "chat:response:chunk", {
    chatId,
    messages: currentMessages,
  });
}

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
    readOnly?: boolean;
    planModeOnly?: boolean;
    skipProCheck?: boolean;
    messageOverride?: ModelMessage[];
  },
): Promise<boolean> {
  const settings = readSettings();

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

  safeSend(event.sender, "chat:response:chunk", {
    chatId: req.chatId,
    messages: chat.messages,
  });

  let fullResponse = "";
  let inThinkingBlock = false;
  let promptStopReason = "end_turn";
  let streamAborted = false;

  const runtimeMode = readOnly
    ? "ask"
    : planModeOnly
      ? "plan"
      : skipProCheck
        ? "build"
        : "agent";

  const permissionMode: PermissionMode = planModeOnly
    ? "plan"
    : readOnly
      ? "dontAsk"
      : "acceptEdits";

  const disallowedTools = [
    ...(readOnly ? Array.from(MUTATING_TOOLS) : []),
    ...(planModeOnly ? PLAN_MODE_DISALLOWED_TOOLS : []),
  ];

  const conversationPrompt = messageOverride
    ? buildConversationPromptFromModelMessages(messageOverride)
    : buildConversationPromptFromDbMessages(
        chat.messages.map((m) => ({ role: m.role, content: m.content })),
      );

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
    onXmlStream: () => {},
    onXmlComplete: () => {},
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

  const appendError = async (message: string) => {
    await appendChunk(
      `<dyad-output type="error" message="${escapeXmlAttr(message)}">${escapeXmlContent(message)}</dyad-output>\n`,
    );
  };

  const toolCallInputSignatures = new Map<string, string>();
  let appendChain: Promise<void> = Promise.resolve();
  const enqueueAppend = (chunk: string) => {
    appendChain = appendChain.then(async () => {
      await appendChunk(chunk);
    });
    return appendChain;
  };

  const acpEntrypoint = resolveAcpAgentEntrypoint();
  const child = spawn(process.execPath, [acpEntrypoint], {
    cwd: appPath,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ...(process.env.DYAD_CLAUDE_CODE_EXECUTABLE
        ? { CLAUDE_CODE_EXECUTABLE: process.env.DYAD_CLAUDE_CODE_EXECUTABLE }
        : {}),
      ...((settings as any)?.providerSettings?.anthropic?.apiKey?.value &&
      !process.env.ANTHROPIC_API_KEY
        ? {
            ANTHROPIC_API_KEY: (settings as any).providerSettings.anthropic
              .apiKey.value,
          }
        : {}),
    },
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8").trim();
    if (text) {
      logger.debug(`[acp-runtime:stderr] ${text}`);
    }
  });

  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );

  const client: Client = {
    async sessionUpdate(notification: SessionNotification): Promise<void> {
      if (notification.sessionId !== sessionId) {
        return;
      }

      const update = notification.update;
      switch (update.sessionUpdate) {
        case "agent_message_chunk": {
          if (update.content.type === "text") {
            if (inThinkingBlock) {
              await enqueueAppend("</think>\n");
              inThinkingBlock = false;
            }
            await enqueueAppend(update.content.text);
          }
          break;
        }

        case "agent_thought_chunk": {
          if (update.content.type === "text") {
            if (!inThinkingBlock) {
              await enqueueAppend("<think>");
              inThinkingBlock = true;
            }
            await enqueueAppend(update.content.text);
          }
          break;
        }

        case "tool_call": {
          const toolName = parseToolNameFromUpdate(update);
          const input = normalizeToolInput(update.rawInput);
          const signature = JSON.stringify({ toolName, input });
          if (hasMeaningfulToolInput(input)) {
            await enqueueAppend(buildPrettyToolCallXml(toolName, input));
          }
          toolCallInputSignatures.set(update.toolCallId, signature);
          break;
        }

        case "tool_call_update": {
          const toolName = parseToolNameFromUpdate(update);
          const input = normalizeToolInput(update.rawInput);
          const signature = JSON.stringify({ toolName, input });
          const previousSignature = toolCallInputSignatures.get(
            update.toolCallId,
          );
          const shouldEmit =
            hasMeaningfulToolInput(input) &&
            (previousSignature == null || previousSignature !== signature);

          if (shouldEmit) {
            await enqueueAppend(buildPrettyToolCallXml(toolName, input));
          }
          toolCallInputSignatures.set(update.toolCallId, signature);

          if (update.status === "failed") {
            const errorText = serializeMaybeJson(
              update.rawOutput ?? "Tool failed",
            );
            await appendError(`Tool failed: ${errorText}`);
          }
          if (update.status === "completed" || update.status === "failed") {
            toolCallInputSignatures.delete(update.toolCallId);
          }
          break;
        }

        default:
          break;
      }
    },

    async requestPermission(
      params: RequestPermissionRequest,
    ): Promise<RequestPermissionResponse> {
      if (abortController.signal.aborted) {
        return { outcome: { outcome: "cancelled" } };
      }

      // ACP runtime policy: auto-allow tool calls (including MCP).
      // Do not route MCP permissions through Dyad's per-server consent flow.
      const allowOption = findAllowOption(params);
      if (!allowOption) {
        return { outcome: { outcome: "cancelled" } };
      }
      return {
        outcome: {
          outcome: "selected",
          optionId: allowOption,
        },
      };
    },

    async readTextFile(params) {
      let content = await readFile(params.path, "utf8");
      if (params.line !== undefined || params.limit !== undefined) {
        const lines = content.split("\n");
        const start = params.line ? Math.max(0, params.line - 1) : 0;
        const end = params.limit ? start + params.limit : lines.length;
        content = lines.slice(start, end).join("\n");
      }
      return { content };
    },

    async writeTextFile(params) {
      await writeFile(params.path, params.content, "utf8");
      return {};
    },
  };

  const connection = new ClientSideConnection(() => client, stream);
  let sessionId = "";

  const cleanup = async () => {
    try {
      if (sessionId && abortController.signal.aborted) {
        await connection.cancel({ sessionId });
      }
    } catch {
      // Best effort cleanup.
    }

    if (!child.killed) {
      child.kill();
    }
  };

  logger.log(
    `[acp-runtime] start chatId=${req.chatId} mode=${runtimeMode} model=${settings.selectedModel.name} cwd=${appPath} adapter=${acpEntrypoint}`,
  );

  try {
    if (abortController.signal.aborted) {
      throw new Error("Stream aborted");
    }

    const initResponse = await connection.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
      },
      clientInfo: {
        name: "dyad",
        title: "Dyad",
        version: "0",
      },
    });

    logger.log(
      `[acp-runtime] initialized protocol=${initResponse.protocolVersion} agent=${initResponse.agentInfo?.name ?? "unknown"}@${initResponse.agentInfo?.version ?? "unknown"}`,
    );

    const sessionResponse = await connection.newSession({
      cwd: appPath,
      // Do not inject Dyad-managed MCP servers for ACP runtime.
      // Claude Code ACP uses runtime-side MCP configuration.
      mcpServers: [],
      _meta: buildAcpSessionMeta({
        systemPrompt,
        selectedModelName: settings.selectedModel.name,
        disallowedTools,
      }),
    });

    sessionId = sessionResponse.sessionId;

    try {
      await connection.setSessionMode({
        sessionId,
        modeId: permissionMode,
      });
    } catch (error) {
      logger.warn("[acp-runtime] setSessionMode failed", error);
    }

    const modelMatch = sessionResponse.models?.availableModels?.find(
      (model) => {
        const selected = settings.selectedModel.name.toLowerCase();
        return (
          model.modelId.toLowerCase() === selected ||
          model.name.toLowerCase() === selected ||
          model.modelId.toLowerCase().includes(selected) ||
          selected.includes(model.modelId.toLowerCase())
        );
      },
    );

    if (modelMatch) {
      try {
        await connection.unstable_setSessionModel({
          sessionId,
          modelId: modelMatch.modelId,
        });
      } catch (error) {
        logger.warn("[acp-runtime] setSessionModel failed", error);
      }
    }

    abortController.signal.addEventListener("abort", () => {
      streamAborted = true;
      if (sessionId) {
        connection.cancel({ sessionId }).catch(() => {});
      }
    });

    const promptResponse = await connection.prompt({
      sessionId,
      prompt: [{ type: "text", text: conversationPrompt || req.prompt }],
    });

    promptStopReason = promptResponse.stopReason;

    await appendChain;

    if (inThinkingBlock) {
      inThinkingBlock = false;
      await appendChunk("</think>\n");
    }

    if (
      streamAborted ||
      abortController.signal.aborted ||
      promptStopReason === "cancelled"
    ) {
      throw new Error("Stream aborted");
    }

    if (!readOnly && !planModeOnly) {
      await deployAllFunctionsIfNeeded(ctx);

      const commitResult = await commitAllChanges(ctx, ctx.chatSummary);

      if (commitResult.commitHash) {
        await db
          .update(messages)
          .set({ commitHash: commitResult.commitHash })
          .where(eq(messages.id, placeholderMessageId));
      }
    }

    await db
      .update(messages)
      .set({ approvalState: "approved" })
      .where(eq(messages.id, placeholderMessageId));

    for (const [filePath, counts] of Object.entries(fileEditTracker)) {
      const toolsUsed = Object.entries(counts).filter(([, count]) => count > 0);
      if (toolsUsed.length >= 2) {
        sendTelemetryEvent("local_agent:file_edit_retry", {
          filePath,
          ...counts,
        });
      }
    }

    safeSend(event.sender, "chat:response:end", {
      chatId: req.chatId,
      updatedFiles: !readOnly,
      chatSummary: ctx.chatSummary,
    } satisfies ChatResponseEnd);

    return true;
  } catch (error) {
    clearPendingConsentsForChat(req.chatId);

    if (
      abortController.signal.aborted ||
      streamAborted ||
      promptStopReason === "cancelled"
    ) {
      if (fullResponse) {
        await db
          .update(messages)
          .set({ content: `${fullResponse}\n\n[Response cancelled by user]` })
          .where(eq(messages.id, placeholderMessageId));
      }
      return false;
    }

    logger.error("Local ACP agent error:", error);
    safeSend(event.sender, "chat:response:error", {
      chatId: req.chatId,
      error: `Error: ${error}`,
    });
    return false;
  } finally {
    await cleanup();
  }
}
