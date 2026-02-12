import { describe, expect, it, beforeEach, afterEach } from "vitest";

import {
  getAcpAdapter,
  getAcpAdapterById,
  ClaudeCodeAdapter,
  CodexAdapter,
  OpenCodeAdapter,
} from "@/pro/main/ipc/handlers/local_agent/acp";

describe("ClaudeCodeAdapter", () => {
  const adapter = new ClaudeCodeAdapter();

  describe("id and displayName", () => {
    it("has correct id", () => {
      expect(adapter.id).toBe("claude-code");
    });

    it("has correct displayName", () => {
      expect(adapter.displayName).toBe("Claude Code");
    });
  });

  describe("normalizeToolInput", () => {
    it("passes through standard format unchanged", () => {
      const input = { path: "/test/file.ts", content: "test content" };
      expect(adapter.normalizeToolInput(input)).toEqual(input);
    });

    it("handles null/undefined input", () => {
      expect(adapter.normalizeToolInput(null)).toEqual({});
      expect(adapter.normalizeToolInput(undefined)).toEqual({});
    });

    it("parses JSON string input", () => {
      const input = '{"path": "/test/file.ts"}';
      expect(adapter.normalizeToolInput(input)).toEqual({
        path: "/test/file.ts",
      });
    });

    it("returns empty object for invalid JSON", () => {
      expect(adapter.normalizeToolInput("not json")).toEqual({
        input: "not json",
      });
    });

    it("returns empty object for empty string", () => {
      expect(adapter.normalizeToolInput("")).toEqual({});
      expect(adapter.normalizeToolInput("   ")).toEqual({});
    });
  });

  describe("parseToolName", () => {
    it("extracts tool name from _meta.claudeCode.toolName", () => {
      const update = {
        toolCallId: "123",
        title: "some title",
        _meta: { claudeCode: { toolName: "Read" } },
      } as any;
      expect(adapter.parseToolName(update)).toBe("Read");
    });

    it("falls back to title when _meta is missing", () => {
      const update = {
        toolCallId: "123",
        title: "Write",
      } as any;
      expect(adapter.parseToolName(update)).toBe("Write");
    });

    it("handles MCP tools with mcp__ prefix", () => {
      const update = {
        toolCallId: "123",
        title: "mcp__server__tool",
      } as any;
      expect(adapter.parseToolName(update)).toBe("mcp__server__tool");
    });

    it("returns unknown when no tool name available", () => {
      const update = { toolCallId: "123" } as any;
      expect(adapter.parseToolName(update)).toBe("unknown");
    });
  });

  describe("buildSessionMeta", () => {
    it("includes claudeCode options with model and maxTurns", () => {
      const meta = adapter.buildSessionMeta({
        systemPrompt: "You are a helpful assistant",
        selectedModelName: "claude-sonnet-4-5",
        disallowedTools: ["Edit", "Write"],
      });

      expect(meta.claudeCode).toBeDefined();
      const claudeCode = meta.claudeCode as Record<string, unknown>;
      expect(claudeCode.options).toBeDefined();
      const options = claudeCode.options as Record<string, unknown>;
      expect(options.model).toBe("claude-sonnet-4-5");
      expect(options.maxTurns).toBe(25);
      expect(options.disallowedTools).toEqual(["Edit", "Write"]);
    });

    it("omits disallowedTools when empty", () => {
      const meta = adapter.buildSessionMeta({
        systemPrompt: "test",
        selectedModelName: "model",
        disallowedTools: [],
      });

      const claudeCode = meta.claudeCode as Record<string, unknown>;
      const options = claudeCode.options as Record<string, unknown>;
      expect(options.disallowedTools).toBeUndefined();
    });

    it("includes system prompt in meta", () => {
      const meta = adapter.buildSessionMeta({
        systemPrompt: "Custom prompt",
        selectedModelName: "model",
        disallowedTools: [],
      });

      expect(meta.systemPrompt).toBeDefined();
      const systemPrompt = meta.systemPrompt as Record<string, unknown>;
      expect(systemPrompt.append).toContain("Custom prompt");
    });

    it("produces serializable output", () => {
      const meta = adapter.buildSessionMeta({
        systemPrompt: "test",
        selectedModelName: "model",
        disallowedTools: [],
      });

      expect(() => JSON.stringify(meta)).not.toThrow();
    });
  });

  describe("getSpawnEnv", () => {
    it("returns empty object when no API key in settings", () => {
      const env = adapter.getSpawnEnv({} as any);
      // Should not have ANTHROPIC_API_KEY unless it's in settings
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it("includes ANTHROPIC_API_KEY from settings", () => {
      const settings = {
        providerSettings: {
          anthropic: {
            apiKey: { value: "test-key" },
          },
        },
      } as any;
      const env = adapter.getSpawnEnv(settings);
      expect(env.ANTHROPIC_API_KEY).toBe("test-key");
    });
  });
});

describe("CodexAdapter", () => {
  const adapter = new CodexAdapter();

  describe("id and displayName", () => {
    it("has correct id", () => {
      expect(adapter.id).toBe("codex");
    });

    it("has correct displayName", () => {
      expect(adapter.displayName).toBe("Codex");
    });
  });

  describe("normalizeToolInput", () => {
    it("extracts path from title for Read", () => {
      const result = adapter.normalizeToolInput(null, "Read Index.tsx");
      expect(result).toEqual({ path: "Index.tsx", file_path: "Index.tsx" });
    });

    it("extracts path from title for Write", () => {
      const result = adapter.normalizeToolInput(null, "Write src/app.ts");
      expect(result).toEqual({ path: "src/app.ts", file_path: "src/app.ts" });
    });

    it("extracts path from title for Edit", () => {
      const result = adapter.normalizeToolInput(null, "Edit file.js");
      expect(result).toEqual({ path: "file.js", file_path: "file.js" });
    });

    it("extracts command from title for Run", () => {
      const result = adapter.normalizeToolInput(null, "Run npm install");
      expect(result).toEqual({ command: "npm install" });
    });

    it("handles changes object format for edits", () => {
      const input = {
        changes: {
          "src/test.ts": { new_content: "new code here" },
        },
      };
      const result = adapter.normalizeToolInput(input);
      expect(result).toEqual({
        path: "src/test.ts",
        file_path: "src/test.ts",
        new_string: "new code here",
        old_string: "",
      });
    });

    it("detects cat > file <<EOF pattern", () => {
      const input = {
        command: [
          "/bin/zsh",
          "-lc",
          "cat > test.txt <<'EOF'\nhello world\nEOF",
        ],
      };
      const result = adapter.normalizeToolInput(
        input,
        "Run cat > test.txt <<'EOF'",
      );
      expect(result.path).toBe("test.txt");
      expect(result.file_path).toBe("test.txt");
      expect(result.content).toBe("hello world");
    });

    it("handles command array format", () => {
      const input = {
        command: ["echo", "hello"],
      };
      // When not matching cat pattern, should extract from title
      const result = adapter.normalizeToolInput(input, "Run echo hello");
      expect(result).toEqual({ command: "echo hello" });
    });

    it("passes through standard format unchanged", () => {
      const input = { path: "/test/file.ts", content: "test" };
      const result = adapter.normalizeToolInput(input);
      expect(result).toEqual(input);
    });
  });

  describe("parseToolName", () => {
    it("extracts tool name from _meta.codex.toolName", () => {
      const update = {
        toolCallId: "123",
        title: "Read file.ts",
        _meta: { codex: { toolName: "Read" } },
      } as any;
      expect(adapter.parseToolName(update)).toBe("Read");
    });

    it("extracts first word from title when _meta is missing", () => {
      const update = {
        toolCallId: "123",
        title: "Read Index.tsx",
      } as any;
      expect(adapter.parseToolName(update)).toBe("Read");
    });

    it("extracts first word from Run command", () => {
      const update = {
        toolCallId: "123",
        title: "Run npm install express",
      } as any;
      expect(adapter.parseToolName(update)).toBe("Run");
    });

    it("handles MCP tools with mcp__ prefix", () => {
      const update = {
        toolCallId: "123",
        title: "mcp__server__tool",
      } as any;
      expect(adapter.parseToolName(update)).toBe("mcp__server__tool");
    });

    it("returns unknown when no tool name available", () => {
      const update = { toolCallId: "123" } as any;
      expect(adapter.parseToolName(update)).toBe("unknown");
    });
  });

  describe("buildSessionMeta", () => {
    it("includes claudeCode options (shared format)", () => {
      const meta = adapter.buildSessionMeta({
        systemPrompt: "You are a helpful assistant",
        selectedModelName: "gpt-4",
        disallowedTools: ["Edit"],
      });

      expect(meta.claudeCode).toBeDefined();
      const claudeCode = meta.claudeCode as Record<string, unknown>;
      expect(claudeCode.options).toBeDefined();
      const options = claudeCode.options as Record<string, unknown>;
      expect(options.model).toBe("gpt-4");
      expect(options.maxTurns).toBe(25);
      expect(options.disallowedTools).toEqual(["Edit"]);
    });

    it("includes Codex-specific system prompt rules", () => {
      const meta = adapter.buildSessionMeta({
        systemPrompt: "Custom prompt",
        selectedModelName: "model",
        disallowedTools: [],
      });

      const systemPrompt = meta.systemPrompt as Record<string, unknown>;
      expect(systemPrompt.append).toContain("Codex tools");
    });

    it("produces serializable output", () => {
      const meta = adapter.buildSessionMeta({
        systemPrompt: "test",
        selectedModelName: "model",
        disallowedTools: [],
      });

      expect(() => JSON.stringify(meta)).not.toThrow();
    });
  });

  describe("getSpawnEnv", () => {
    it("returns empty object when no API key in settings", () => {
      const env = adapter.getSpawnEnv({} as any);
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.CODEX_API_KEY).toBeUndefined();
    });

    it("includes OPENAI_API_KEY and CODEX_API_KEY from settings", () => {
      const settings = {
        providerSettings: {
          openai: {
            apiKey: { value: "test-openai-key" },
          },
        },
      } as any;
      const env = adapter.getSpawnEnv(settings);
      expect(env.OPENAI_API_KEY).toBe("test-openai-key");
      expect(env.CODEX_API_KEY).toBe("test-openai-key");
    });
  });
});

describe("getAcpAdapter", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.DYAD_ACP_RUNTIME;
    delete process.env.DYAD_ACP_RUNTIME;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.DYAD_ACP_RUNTIME = originalEnv;
    } else {
      delete process.env.DYAD_ACP_RUNTIME;
    }
  });

  it("returns ClaudeCodeAdapter by default", () => {
    const adapter = getAcpAdapter();
    expect(adapter.id).toBe("claude-code");
    expect(adapter).toBeInstanceOf(ClaudeCodeAdapter);
  });

  it("returns CodexAdapter when settings.acpRuntime is codex", () => {
    const adapter = getAcpAdapter({ acpRuntime: "codex" } as any);
    expect(adapter.id).toBe("codex");
    expect(adapter).toBeInstanceOf(CodexAdapter);
  });

  it("returns OpenCodeAdapter when settings.acpRuntime is opencode", () => {
    const adapter = getAcpAdapter({ acpRuntime: "opencode" } as any);
    expect(adapter.id).toBe("opencode");
    expect(adapter).toBeInstanceOf(OpenCodeAdapter);
  });

  it("respects DYAD_ACP_RUNTIME env var", () => {
    process.env.DYAD_ACP_RUNTIME = "codex";
    const adapter = getAcpAdapter();
    expect(adapter.id).toBe("codex");
  });

  it("respects DYAD_ACP_RUNTIME env var for opencode", () => {
    process.env.DYAD_ACP_RUNTIME = "opencode";
    const adapter = getAcpAdapter();
    expect(adapter.id).toBe("opencode");
    expect(adapter).toBeInstanceOf(OpenCodeAdapter);
  });

  it("env var takes precedence over settings", () => {
    process.env.DYAD_ACP_RUNTIME = "codex";
    const adapter = getAcpAdapter({ acpRuntime: "claude-code" } as any);
    expect(adapter.id).toBe("codex");
  });
});

describe("OpenCodeAdapter", () => {
  const adapter = new OpenCodeAdapter();

  describe("id and displayName", () => {
    it("has correct id", () => {
      expect(adapter.id).toBe("opencode");
    });

    it("has correct displayName", () => {
      expect(adapter.displayName).toBe("OpenCode");
    });
  });

  describe("getSpawnCommand and getSpawnArgs", () => {
    it("returns opencode command", () => {
      expect(adapter.getSpawnCommand()).toBe("opencode");
    });

    it("returns acp as argument", () => {
      expect(adapter.getSpawnArgs()).toEqual(["acp"]);
    });
  });

  describe("normalizeToolInput", () => {
    it("passes through standard format unchanged", () => {
      const input = { path: "/test/file.ts", content: "test content" };
      expect(adapter.normalizeToolInput(input)).toEqual(input);
    });

    it("handles null/undefined input", () => {
      expect(adapter.normalizeToolInput(null)).toEqual({});
      expect(adapter.normalizeToolInput(undefined)).toEqual({});
    });

    it("parses JSON string input", () => {
      const input = '{"path": "/test/file.ts"}';
      expect(adapter.normalizeToolInput(input)).toEqual({
        path: "/test/file.ts",
      });
    });

    it("returns empty object for invalid JSON", () => {
      expect(adapter.normalizeToolInput("not json")).toEqual({
        input: "not json",
      });
    });

    it("returns empty object for empty string", () => {
      expect(adapter.normalizeToolInput("")).toEqual({});
      expect(adapter.normalizeToolInput("   ")).toEqual({});
    });
  });

  describe("parseToolName", () => {
    it("extracts tool name from _meta.opencode.toolName", () => {
      const update = {
        toolCallId: "123",
        title: "some title",
        _meta: { opencode: { toolName: "Read" } },
      } as any;
      expect(adapter.parseToolName(update)).toBe("Read");
    });

    it("falls back to generic _meta.toolName", () => {
      const update = {
        toolCallId: "123",
        title: "some title",
        _meta: { toolName: "Write" },
      } as any;
      expect(adapter.parseToolName(update)).toBe("Write");
    });

    it("falls back to title when _meta is missing", () => {
      const update = {
        toolCallId: "123",
        title: "Edit",
      } as any;
      expect(adapter.parseToolName(update)).toBe("Edit");
    });

    it("handles MCP tools with mcp__ prefix", () => {
      const update = {
        toolCallId: "123",
        title: "mcp__server__tool",
      } as any;
      expect(adapter.parseToolName(update)).toBe("mcp__server__tool");
    });

    it("returns unknown when no tool name available", () => {
      const update = { toolCallId: "123" } as any;
      expect(adapter.parseToolName(update)).toBe("unknown");
    });
  });

  describe("buildSessionMeta", () => {
    it("includes opencode options with hardcoded kimi model and maxTurns", () => {
      const meta = adapter.buildSessionMeta({
        systemPrompt: "You are a helpful assistant",
        selectedModelName: "claude-sonnet-4", // This will be ignored
        disallowedTools: ["Edit", "Write"],
      });

      expect(meta.opencode).toBeDefined();
      const opencode = meta.opencode as Record<string, unknown>;
      expect(opencode.options).toBeDefined();
      const options = opencode.options as Record<string, unknown>;
      expect(options.model).toBe("moonshotai-cn/kimi-k2.5"); // Hardcoded kimi model
      expect(options.maxTurns).toBe(25);
      expect(options.disallowedTools).toEqual(["Edit", "Write"]);
    });

    it("omits disallowedTools when empty", () => {
      const meta = adapter.buildSessionMeta({
        systemPrompt: "test",
        selectedModelName: "model",
        disallowedTools: [],
      });

      const opencode = meta.opencode as Record<string, unknown>;
      const options = opencode.options as Record<string, unknown>;
      expect(options.disallowedTools).toBeUndefined();
    });

    it("includes system prompt in meta", () => {
      const meta = adapter.buildSessionMeta({
        systemPrompt: "Custom prompt",
        selectedModelName: "model",
        disallowedTools: [],
      });

      expect(meta.systemPrompt).toBeDefined();
      const systemPrompt = meta.systemPrompt as Record<string, unknown>;
      expect(systemPrompt.append).toContain("Custom prompt");
    });

    it("includes OpenCode-specific system prompt rules", () => {
      const meta = adapter.buildSessionMeta({
        systemPrompt: "Custom prompt",
        selectedModelName: "model",
        disallowedTools: [],
      });

      const systemPrompt = meta.systemPrompt as Record<string, unknown>;
      expect(systemPrompt.append).toContain("OpenCode tools");
    });

    it("produces serializable output", () => {
      const meta = adapter.buildSessionMeta({
        systemPrompt: "test",
        selectedModelName: "model",
        disallowedTools: [],
      });

      expect(() => JSON.stringify(meta)).not.toThrow();
    });
  });

  describe("getSpawnEnv", () => {
    it("returns empty object when no API key in settings", () => {
      const env = adapter.getSpawnEnv({} as any);
      // Should not have OPENCODE_API_KEY unless it's in settings or env
      expect(env.OPENCODE_API_KEY).toBeUndefined();
    });

    it("includes OPENCODE_API_KEY from settings", () => {
      const settings = {
        providerSettings: {
          opencode: {
            apiKey: { value: "test-opencode-key" },
          },
        },
      } as any;
      const env = adapter.getSpawnEnv(settings);
      expect(env.OPENCODE_API_KEY).toBe("test-opencode-key");
    });

    it("includes OPENCODE_API_KEY from environment if not in settings", () => {
      const originalEnv = process.env.OPENCODE_API_KEY;
      process.env.OPENCODE_API_KEY = "env-key";
      try {
        const env = adapter.getSpawnEnv({} as any);
        expect(env.OPENCODE_API_KEY).toBe("env-key");
      } finally {
        if (originalEnv !== undefined) {
          process.env.OPENCODE_API_KEY = originalEnv;
        } else {
          delete process.env.OPENCODE_API_KEY;
        }
      }
    });
  });
});

describe("getAcpAdapterById", () => {
  it("returns ClaudeCodeAdapter for claude-code", () => {
    const adapter = getAcpAdapterById("claude-code");
    expect(adapter).toBeInstanceOf(ClaudeCodeAdapter);
  });

  it("returns CodexAdapter for codex", () => {
    const adapter = getAcpAdapterById("codex");
    expect(adapter).toBeInstanceOf(CodexAdapter);
  });

  it("returns OpenCodeAdapter for opencode", () => {
    const adapter = getAcpAdapterById("opencode");
    expect(adapter).toBeInstanceOf(OpenCodeAdapter);
  });
});
