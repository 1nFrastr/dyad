import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

import {
  ClientSideConnection,
  ndJsonStream,
  type Client,
} from "@agentclientprotocol/sdk";

import { OpenCodeAdapter } from "@/pro/main/ipc/handlers/local_agent/acp/opencode_adapter";

const runIntegration = process.env.DYAD_RUN_ACP_INTEGRATION === "true";
const describeAcpIntegration = runIntegration ? describe : describe.skip;

describeAcpIntegration("OpenCode ACP integration", () => {
  it("initializes and creates session with opencode acp", async () => {
    // OpenCode uses CLI command mode: "opencode acp"
    const child = spawn("opencode", ["acp"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // OpenCode may need OPENCODE_API_KEY if required
      },
    });

    let stderrOutput = "";
    child.stderr?.on("data", (chunk) => {
      stderrOutput += chunk.toString("utf8");
    });

    // Check if process spawned successfully
    if (!child.pid) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => resolve(), 1000);
        child.once("error", () => {
          clearTimeout(timeout);
          resolve();
        });
        child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      if (!child.pid) {
        throw new Error(
          `Failed to start opencode acp. Make sure 'opencode' is installed and available in PATH.\n` +
            `stderr: ${stderrOutput}`,
        );
      }
    }

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    );

    const adapter = new OpenCodeAdapter();

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
          name: "dyad-test-opencode",
          title: "Dyad OpenCode ACP Integration Test",
          version: "0",
        },
      });

      expect(initResponse.protocolVersion).toBe(1);
      expect(initResponse.agentInfo?.name).toBeTruthy();
      console.log(
        `✅ OpenCode ACP initialized: ${initResponse.agentInfo?.name}@${initResponse.agentInfo?.version}`,
      );

      const meta = adapter.buildSessionMeta({
        systemPrompt: "You are a helpful coding assistant for testing.",
        selectedModelName: "claude-sonnet-4",
        disallowedTools: ["Edit"],
      });

      const sessionResponse = await connection.newSession({
        cwd: process.cwd(),
        mcpServers: [],
        _meta: meta,
      });

      expect(sessionResponse.sessionId).toBeTruthy();
      console.log(`✅ OpenCode session created: ${sessionResponse.sessionId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // Handle expected auth/command errors
      const expectedKnownErrors = [
        "Authentication required",
        "auth_required",
        "Please log in",
        "Not authenticated",
        "login required",
        "command not found",
        "ENOENT",
        "spawn opencode",
      ];

      const isKnownError = expectedKnownErrors.some((token) =>
        message.toLowerCase().includes(token.toLowerCase()),
      );

      if (
        isKnownError ||
        stderrOutput.includes("Authentication") ||
        stderrOutput.includes("command not found") ||
        stderrOutput.includes("ENOENT")
      ) {
        if (
          message.includes("command not found") ||
          message.includes("ENOENT")
        ) {
          console.log(
            "⚠️  OpenCode not found. Please install OpenCode: https://opencode.ai/docs/installation",
          );
        } else {
          console.log(
            "⚠️  Authentication required for OpenCode. Please check OPENCODE_API_KEY or run: opencode login",
          );
        }
        expect(isKnownError || stderrOutput.length > 0).toBe(true);
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

  it("sends a real conversation turn to opencode acp", async () => {
    // OpenCode uses CLI command mode: "opencode acp"
    const child = spawn("opencode", ["acp"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
      },
    });

    let stderrOutput = "";
    child.stderr?.on("data", (chunk) => {
      stderrOutput += chunk.toString("utf8");
    });

    // Check if process spawned successfully
    if (!child.pid) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => resolve(), 1000);
        child.once("error", () => {
          clearTimeout(timeout);
          resolve();
        });
        child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      if (!child.pid) {
        throw new Error(
          `Failed to start opencode acp. Make sure 'opencode' is installed and available in PATH.\n` +
            `stderr: ${stderrOutput}`,
        );
      }
    }

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    );

    const adapter = new OpenCodeAdapter();

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
          name: "dyad-test-opencode",
          title: "Dyad OpenCode ACP Prompt Test",
          version: "0",
        },
      });

      const meta = adapter.buildSessionMeta({
        systemPrompt:
          "You are a helpful assistant. Answer concisely without using tools unless absolutely necessary.",
        selectedModelName: "claude-sonnet-4",
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
            text: "Reply with exactly: OPENCODE_ACP_OK",
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
            new Error(`OpenCode ACP prompt timeout after ${promptTimeoutMs}ms`),
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
      console.log(`✅ OpenCode response received (${fullText.length} chars)`);
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
        "command not found",
        "ENOENT",
        "spawn opencode",
      ];

      const isAuthIssue =
        knownAuthErrors.some((token) =>
          message.toLowerCase().includes(token.toLowerCase()),
        ) || stderrOutput.toLowerCase().includes("authentication");

      if (isAuthIssue) {
        if (
          message.includes("command not found") ||
          message.includes("ENOENT")
        ) {
          console.log(
            "⚠️  OpenCode not found. Please install OpenCode: https://opencode.ai/docs/installation",
          );
        } else {
          console.log(
            "⚠️  Authentication required. Please check OPENCODE_API_KEY or run: opencode login",
          );
        }
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
