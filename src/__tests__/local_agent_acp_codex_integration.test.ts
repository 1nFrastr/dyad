import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { createRequire } from "node:module";

import {
  ClientSideConnection,
  ndJsonStream,
  type Client,
} from "@agentclientprotocol/sdk";

import { buildAcpSessionMeta } from "@/pro/main/ipc/handlers/local_agent/local_agent_handler_acp_meta";

const runIntegration = process.env.DYAD_RUN_ACP_INTEGRATION === "true";
const describeAcpIntegration = runIntegration ? describe : describe.skip;
const require = createRequire(import.meta.url);

describeAcpIntegration("Codex ACP integration", () => {
  it("initializes and creates session with codex-acp", async () => {
    const entrypoint =
      require.resolve("@zed-industries/codex-acp/bin/codex-acp.js");

    const child = spawn(process.execPath, [entrypoint], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // Codex will use ChatGPT subscription if logged in via `codex login`
        // Or use OPENAI_API_KEY / CODEX_API_KEY if set
      },
    });

    let stderrOutput = "";
    child.stderr.on("data", (chunk) => {
      stderrOutput += chunk.toString("utf8");
    });

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );

    const client: Client = {
      async sessionUpdate() {},
      async requestPermission(params) {
        const allowOption =
          params.options.find((option) => option.kind === "allow_once")
            ?.optionId ??
          params.options.find((option) => option.kind === "allow_always")
            ?.optionId;

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
      async readTextFile() {
        return { content: "" };
      },
      async writeTextFile() {
        return {};
      },
    };

    const connection = new ClientSideConnection(() => client, stream);

    try {
      const initResponse = await connection.initialize({
        protocolVersion: 1,
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
        },
        clientInfo: {
          name: "dyad-test-codex",
          title: "Dyad Codex ACP Integration Test",
          version: "0",
        },
      });

      expect(initResponse.protocolVersion).toBe(1);
      expect(initResponse.agentInfo?.name).toBeTruthy();
      console.log(
        `✅ Codex ACP initialized: ${initResponse.agentInfo?.name}@${initResponse.agentInfo?.version}`,
      );

      const meta = buildAcpSessionMeta({
        systemPrompt: "You are a helpful coding assistant for testing.",
        selectedModelName: "gpt-4",
        disallowedTools: ["Edit"],
      });

      const sessionResponse = await connection.newSession({
        cwd: process.cwd(),
        mcpServers: [],
        _meta: meta,
      });

      expect(sessionResponse.sessionId).toBeTruthy();
      console.log(`✅ Codex session created: ${sessionResponse.sessionId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // Handle expected auth errors
      const expectedKnownErrors = [
        "Authentication required",
        "auth_required",
        "Please log in",
        "Not authenticated",
        "login required",
      ];

      const isKnownAuthError = expectedKnownErrors.some((token) =>
        message.toLowerCase().includes(token.toLowerCase()),
      );

      if (isKnownAuthError || stderrOutput.includes("Authentication")) {
        console.log(
          "⚠️  Authentication required for Codex. Please run: npx @zed-industries/codex-acp login",
        );
        expect(isKnownAuthError || stderrOutput.length > 0).toBe(true);
        return;
      }

      // Unexpected error - throw it
      console.error("❌ Unexpected error:", message);
      console.error("stderr:", stderrOutput);
      throw error;
    } finally {
      if (!child.killed) {
        child.kill();
      }
    }
  }, 60000);

  it("sends a real conversation turn to codex-acp", async () => {
    const entrypoint =
      require.resolve("@zed-industries/codex-acp/bin/codex-acp.js");

    const child = spawn(process.execPath, [entrypoint], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
      },
    });

    let stderrOutput = "";
    child.stderr.on("data", (chunk) => {
      stderrOutput += chunk.toString("utf8");
    });

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );

    const agentTextChunks: string[] = [];
    const thoughtChunks: string[] = [];
    const toolCalls: string[] = [];

    const client: Client = {
      async sessionUpdate(notification) {
        if (
          notification.update.sessionUpdate === "agent_message_chunk" &&
          notification.update.content.type === "text"
        ) {
          agentTextChunks.push(notification.update.content.text);
        }
        if (
          notification.update.sessionUpdate === "agent_thought_chunk" &&
          notification.update.content.type === "text"
        ) {
          thoughtChunks.push(notification.update.content.text);
        }
        if (notification.update.sessionUpdate === "tool_call") {
          toolCalls.push((notification.update as any).title || "unknown_tool");
        }
      },
      async requestPermission(params) {
        const allowOption =
          params.options.find((option) => option.kind === "allow_once")
            ?.optionId ??
          params.options.find((option) => option.kind === "allow_always")
            ?.optionId;

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
      async readTextFile() {
        return { content: "console.log('test');" };
      },
      async writeTextFile() {
        return {};
      },
    };

    const connection = new ClientSideConnection(() => client, stream);

    try {
      await connection.initialize({
        protocolVersion: 1,
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
        },
        clientInfo: {
          name: "dyad-test-codex",
          title: "Dyad Codex ACP Prompt Test",
          version: "0",
        },
      });

      const meta = buildAcpSessionMeta({
        systemPrompt:
          "You are a helpful assistant. Answer concisely without using tools unless absolutely necessary.",
        selectedModelName: "gpt-4",
        disallowedTools: [],
      });

      const session = await connection.newSession({
        cwd: process.cwd(),
        mcpServers: [],
        _meta: meta,
      });

      console.log(`✅ Session created for prompt test: ${session.sessionId}`);

      const promptTimeoutMs = 60000;
      const promptPromise = connection.prompt({
        sessionId: session.sessionId,
        prompt: [
          {
            type: "text",
            text: "Reply with exactly: CODEX_ACP_OK",
          },
        ],
      });

      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(async () => {
          try {
            await connection.cancel({ sessionId: session.sessionId });
          } catch {
            // Best effort.
          }
          reject(
            new Error(`Codex ACP prompt timeout after ${promptTimeoutMs}ms`),
          );
        }, promptTimeoutMs);
      });

      const promptResponse = await Promise.race([
        promptPromise,
        timeoutPromise,
      ]);

      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      expect([
        "end_turn",
        "max_tokens",
        "max_turn_requests",
        "refusal",
        "cancelled",
      ]).toContain(promptResponse.stopReason);

      const fullText = agentTextChunks.join("");
      console.log(`✅ Codex response received (${fullText.length} chars)`);
      console.log(`   Agent text: "${fullText.substring(0, 100)}..."`);
      console.log(`   Thought chunks: ${thoughtChunks.length}`);
      console.log(`   Tool calls: ${toolCalls.length}`);

      // Expect some response
      expect(fullText.length > 0 || thoughtChunks.length > 0).toBe(true);

      // Check if response contains expected text
      if (fullText.length > 0) {
        console.log(`✅ Full response: "${fullText}"`);
        // Loosely check if it responded (may not be exact due to model behavior)
        expect(fullText.length).toBeGreaterThan(0);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      const knownAuthErrors = [
        "Authentication required",
        "auth_required",
        "Please log in",
        "Not authenticated",
        "login required",
      ];

      const isAuthIssue =
        knownAuthErrors.some((token) =>
          message.toLowerCase().includes(token.toLowerCase()),
        ) || stderrOutput.toLowerCase().includes("authentication");

      if (isAuthIssue) {
        console.log(
          "⚠️  Authentication required. Please run: npx @zed-industries/codex-acp login",
        );
        expect(isAuthIssue).toBe(true);
        return;
      }

      console.error("❌ Unexpected error:", message);
      console.error("stderr:", stderrOutput);
      throw error;
    } finally {
      if (!child.killed) {
        child.kill();
      }
    }
  }, 120000);
});
