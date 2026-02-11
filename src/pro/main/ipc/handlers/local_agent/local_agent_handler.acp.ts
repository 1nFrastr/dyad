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
  type Stream,
  type ToolCall,
  type ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import log from "electron-log";
import { createRequire } from "node:module";
import path from "node:path";
import { existsSync } from "node:fs";
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
import { getAcpRuntime, type AcpRuntime } from "./local_agent_runtime";

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

interface AcpRuntimeConfig {
  packageName: string;
  entryPath: string;
  displayName: string;
  apiKeyEnvName: string;
}

const ACP_RUNTIME_CONFIGS: Record<AcpRuntime, AcpRuntimeConfig> = {
  "claude-code": {
    packageName: "@zed-industries/claude-code-acp",
    entryPath: "dist/index.js",
    displayName: "Claude Code",
    apiKeyEnvName: "ANTHROPIC_API_KEY",
  },
  codex: {
    packageName: "@zed-industries/codex-acp",
    entryPath: "bin/codex-acp.js",
    displayName: "Codex",
    apiKeyEnvName: "OPENAI_API_KEY",
  },
};

function resolveAcpAgentEntrypoint(runtime: AcpRuntime): string {
  const config = ACP_RUNTIME_CONFIGS[runtime];

  // 1. Check environment variable override
  const envPath = process.env.DYAD_ACP_AGENT_ENTRY;
  if (envPath && existsSync(envPath)) {
    return envPath;
  }

  // 2. Try require.resolve
  try {
    const resolved = require.resolve(
      `${config.packageName}/${config.entryPath}`,
    );
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
    ...config.packageName.split("/"),
    config.entryPath,
  );
  if (existsSync(fallback)) {
    return fallback;
  }

  throw new Error(
    `${config.displayName} ACP adapter not found. Install ${config.packageName} or set DYAD_ACP_AGENT_ENTRY.`,
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

function formatAcpMessageSummary(
  msg: {
    method?: string;
    id?: string | number | null;
    params?: unknown;
    result?: unknown;
    error?: { code?: number; message?: string };
  },
  direction: "→" | "←",
): string {
  const method = msg.method ?? "?";
  const id = msg.id != null ? ` id=${msg.id}` : "";
  let extra = "";
  if ("result" in msg && msg.result !== undefined) {
    const r = msg.result as Record<string, unknown>;
    extra = Object.keys(r ?? {})
      .slice(0, 3)
      .join(",");
    if (extra) extra = ` result=${extra}`;
  } else if ("error" in msg && msg.error) {
    extra = ` error=${String(msg.error.message ?? msg.error.code ?? "?")}`;
  } else if (msg.params && typeof msg.params === "object") {
    const p = msg.params as Record<string, unknown>;
    const keys = Object.keys(p).filter((k) => !k.startsWith("_"));
    extra = keys.length ? ` params=${keys.join(",")}` : "";
    // Extract tool name for session/update with tool_call or tool_call_update
    if (
      method === "session/update" &&
      typeof p.update === "object" &&
      p.update
    ) {
      const u = p.update as Record<string, unknown>;
      const sessionUpdate = u.sessionUpdate;
      if (
        sessionUpdate === "tool_call" ||
        sessionUpdate === "tool_call_update"
      ) {
        const meta = u._meta as Record<string, unknown> | undefined;
        const metaToolName = meta?.claudeCode as
          | Record<string, unknown>
          | undefined;
        const toolName =
          (typeof metaToolName?.toolName === "string" &&
            metaToolName.toolName) ||
          (typeof u.title === "string" && u.title) ||
          "unknown";
        extra += ` tool=${toolName}`;
        if (sessionUpdate === "tool_call_update" && u.status) {
          extra += ` status=${u.status}`;
        }
      }
    }
  }
  return `[acp] ${direction} ${method}${id}${extra}`;
}

function createAcpStreamWithLogging(
  output: WritableStream<Uint8Array>,
  input: ReadableStream<Uint8Array>,
): Stream {
  const { readable: baseReadable, writable: baseWritable } = ndJsonStream(
    output,
    input,
  );

  const loggingReadable = baseReadable.pipeThrough(
    new TransformStream({
      transform(msg, controller) {
        logger.debug(formatAcpMessageSummary(msg, "←"));
        controller.enqueue(msg);
      },
    }),
  );

  const logWritableTransform = new TransformStream({
    transform(msg, controller) {
      logger.debug(formatAcpMessageSummary(msg, "→"));
      controller.enqueue(msg);
    },
  });
  logWritableTransform.readable.pipeTo(baseWritable).catch((err) => {
    logger.error("[acp] writable pipe error", err);
  });

  return {
    readable: loggingReadable,
    writable: logWritableTransform.writable,
  } as Stream;
}

function normalizeToolInput(
  input: unknown,
  title?: string,
): Record<string, unknown> {
  if (input == null) {
    // Try to extract input from title for Codex format
    if (title) {
      const parts = title.split(/\s+/);
      if (parts.length > 1) {
        const toolName = parts[0];
        const args = parts.slice(1).join(" ");

        // Common patterns
        if (
          toolName === "Read" ||
          toolName === "Write" ||
          toolName === "Edit"
        ) {
          return { path: args, file_path: args };
        }
        if (toolName === "Run") {
          return { command: args };
        }
        return { args };
      }
    }
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
    const inputObj = input as Record<string, unknown>;

    // Check if this is Codex format (has parsed_cmd or command but no file_path/path)
    const isCodexFormat =
      (inputObj.parsed_cmd != null || inputObj.command != null) &&
      inputObj.file_path == null &&
      inputObj.path == null &&
      inputObj.target_file == null;

    // If Codex format and we have title, extract from title instead
    if (isCodexFormat && title) {
      const parts = title.split(/\s+/);
      if (parts.length > 1) {
        const toolName = parts[0];
        const args = parts.slice(1).join(" ");

        // Common patterns
        if (
          toolName === "Read" ||
          toolName === "Write" ||
          toolName === "Edit"
        ) {
          return { path: args, file_path: args };
        }
        if (toolName === "Run") {
          // Check for "cat > file <<'EOF'" pattern (Codex file write pattern)
          const catWriteMatch = args.match(
            /cat\s+>\s+([^\s<]+)\s+<<['"]EOF['"]/,
          );
          if (catWriteMatch) {
            const filePath = catWriteMatch[1];
            // Try to extract content from command if available
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
            const content = contentMatch ? contentMatch[1].trim() : "";

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
    }

    // Check for Codex Edit format (has changes object)
    if (inputObj.changes != null && typeof inputObj.changes === "object") {
      const changes = inputObj.changes as Record<string, unknown>;
      // Get first file change
      const filePath = Object.keys(changes)[0];
      if (filePath) {
        const change = changes[filePath] as Record<string, unknown> | undefined;
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
      }
    }

    // For Claude Code format (has file_path/path) or other formats, return as-is
    return { ...inputObj };
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
      // If old_string is empty or missing, treat as Write (Codex Edit format)
      const oldString = input.old_string;
      const newString = input.new_string;
      if (
        (!oldString || (typeof oldString === "string" && oldString.trim() === "")) &&
        newString
      ) {
        const content = typeof newString === "string" ? newString : "";
        return `<dyad-write path="${escapeXmlAttr(filePath)}" description="Write file with Codex ACP runtime">${escapeXmlContent(truncateText(content))}</dyad-write>\n`;
      }
      // Regular Edit with old_string and new_string
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
    case "Run": {
      // Check if this is a file write operation (Codex uses "Run cat > file")
      if (filePath && input.content != null) {
        const content = typeof input.content === "string" ? input.content : "";
        return `<dyad-write path="${escapeXmlAttr(filePath)}" description="Write file with Codex ACP runtime">${escapeXmlContent(truncateText(content))}</dyad-write>\n`;
      }
      // Regular Run command
      const command = typeof input.command === "string" ? input.command : "";
      return `<dyad-mcp-tool-call server="local" tool="Run">\n${escapeXmlContent(truncateText(command))}\n</dyad-mcp-tool-call>\n`;
    }
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
  // Try Claude Code metadata first
  const claudeCodeToolName = (update as any)?._meta?.claudeCode?.toolName;
  if (typeof claudeCodeToolName === "string" && claudeCodeToolName.length > 0) {
    return claudeCodeToolName;
  }

  // Try Codex metadata (might use different structure)
  const codexToolName = (update as any)?._meta?.codex?.toolName;
  if (typeof codexToolName === "string" && codexToolName.length > 0) {
    return codexToolName;
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

  const acpRuntime = getAcpRuntime(settings);
  const acpRuntimeConfig = ACP_RUNTIME_CONFIGS[acpRuntime];
  const acpEntrypoint = resolveAcpAgentEntrypoint(acpRuntime);

  const spawnEnv: Record<string, string> = {
    ...process.env,
    ...(process.env.DYAD_CLAUDE_CODE_EXECUTABLE
      ? { CLAUDE_CODE_EXECUTABLE: process.env.DYAD_CLAUDE_CODE_EXECUTABLE }
      : {}),
  };

  // Set API key based on runtime type
  if (acpRuntime === "claude-code") {
    const anthropicKey = (settings as any)?.providerSettings?.anthropic?.apiKey
      ?.value;
    if (anthropicKey && !process.env.ANTHROPIC_API_KEY) {
      spawnEnv.ANTHROPIC_API_KEY = anthropicKey;
    }
  } else if (acpRuntime === "codex") {
    const openaiKey = (settings as any)?.providerSettings?.openai?.apiKey
      ?.value;
    if (openaiKey && !process.env.OPENAI_API_KEY) {
      spawnEnv.OPENAI_API_KEY = openaiKey;
    }
    // Codex also accepts CODEX_API_KEY
    if (openaiKey && !process.env.CODEX_API_KEY) {
      spawnEnv.CODEX_API_KEY = openaiKey;
    }
  }

  const child = spawn(process.execPath, [acpEntrypoint], {
    cwd: appPath,
    stdio: ["pipe", "pipe", "pipe"],
    env: spawnEnv,
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8").trim();
    if (text) {
      logger.debug(`[acp-runtime:stderr] ${text}`);
    }
  });

  const stream = createAcpStreamWithLogging(
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
          const input = normalizeToolInput(
            update.rawInput,
            update.title || undefined,
          );
          const signature = JSON.stringify({ toolName, input });

          // Debug log for tool call structure (helps diagnose format differences)
          logger.debug(
            `[tool_call] runtime=${acpRuntime} toolName=${toolName} title=${update.title} input=${JSON.stringify(input)} _meta=${JSON.stringify((update as any)?._meta || {})}`,
          );

          if (hasMeaningfulToolInput(input)) {
            await enqueueAppend(buildPrettyToolCallXml(toolName, input));
          }
          toolCallInputSignatures.set(update.toolCallId, signature);
          break;
        }

        case "tool_call_update": {
          const toolName = parseToolNameFromUpdate(update);
          const input = normalizeToolInput(
            update.rawInput,
            update.title || undefined,
          );
          const signature = JSON.stringify({ toolName, input });
          const previousSignature = toolCallInputSignatures.get(
            update.toolCallId,
          );
          const shouldEmit =
            hasMeaningfulToolInput(input) &&
            (previousSignature == null || previousSignature !== signature);

          // Debug log for tool call update
          logger.debug(
            `[tool_call_update] toolName=${toolName} status=${update.status} shouldEmit=${shouldEmit} input=${JSON.stringify(input)}`,
          );

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
    `[acp-runtime] start chatId=${req.chatId} mode=${runtimeMode} runtime=${acpRuntimeConfig.displayName} model=${settings.selectedModel.name} cwd=${appPath} adapter=${acpEntrypoint}`,
  );

  try {
    if (abortController.signal.aborted) {
      throw new Error("Stream aborted");
    }

    const initResponse = await connection.initialize({
      protocolVersion: 1,
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
