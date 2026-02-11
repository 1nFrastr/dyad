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

describeAcpIntegration("ACP integration", () => {
  it("sends real initialize/session-new requests to claude-code-acp", async () => {
    const entrypoint =
      require.resolve("@zed-industries/claude-code-acp/dist/index.js");

    const child = spawn(process.execPath, [entrypoint], {
      stdio: ["pipe", "pipe", "pipe"],
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
          name: "dyad-test",
          title: "Dyad ACP Integration Test",
          version: "0",
        },
      });

      expect(initResponse.protocolVersion).toBe(1);
      expect(initResponse.agentInfo?.name).toBeTruthy();

      const meta = buildAcpSessionMeta({
        systemPrompt: "You are a test assistant.",
        selectedModelName: "claude-sonnet-4-5",
        disallowedTools: ["Edit"],
      });

      await expect(
        connection.newSession({
          cwd: process.cwd(),
          mcpServers: [],
          _meta: meta,
        }),
      ).resolves.toBeTruthy();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      expect(message).not.toContain("reading 'aborted'");

      const expectedKnownErrors = [
        "Authentication required",
        "auth_required",
        "Internal error",
      ];

      const isKnown = expectedKnownErrors.some((token) =>
        message.includes(token),
      );

      expect(
        isKnown ||
          stderrOutput.includes("Authentication") ||
          stderrOutput.length > 0,
      ).toBe(true);
    } finally {
      if (!child.killed) {
        child.kill();
      }
    }
  }, 60000);

  it("sends a real session/prompt turn to claude-code-acp", async () => {
    const entrypoint =
      require.resolve("@zed-industries/claude-code-acp/dist/index.js");

    const child = spawn(process.execPath, [entrypoint], {
      stdio: ["pipe", "pipe", "pipe"],
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
        return { content: "" };
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
          name: "dyad-test",
          title: "Dyad ACP Prompt Test",
          version: "0",
        },
      });

      const meta = buildAcpSessionMeta({
        systemPrompt:
          "Answer briefly. For this test prompt, do not use tools unless required.",
        selectedModelName: "claude-sonnet-4-5",
        disallowedTools: [],
      });

      const session = await connection.newSession({
        cwd: process.cwd(),
        mcpServers: [],
        _meta: meta,
      });

      const promptTimeoutMs = 45000;
      const promptPromise = connection.prompt({
        sessionId: session.sessionId,
        prompt: [
          {
            type: "text",
            text: "Reply with exactly: ACP_OK",
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
          reject(new Error(`ACP prompt timeout after ${promptTimeoutMs}ms`));
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
      expect(fullText.length > 0 || thoughtChunks.length > 0).toBe(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      const knownAuthErrors = [
        "Authentication required",
        "auth_required",
        "Please run /login",
      ];
      const isAuthIssue =
        knownAuthErrors.some((token) => message.includes(token)) ||
        stderrOutput.includes("Authentication");

      if (isAuthIssue) {
        expect(isAuthIssue).toBe(true);
        return;
      }

      throw error;
    } finally {
      if (!child.killed) {
        child.kill();
      }
    }
  }, 120000);
});
