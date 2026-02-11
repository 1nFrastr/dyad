# ACP Runtime Configuration

This document describes how to configure and use different Agent Client Protocol (ACP) runtimes in Dyad.

## Overview

Dyad supports multiple ACP-compatible agent runtimes when using the ACP local agent mode. The ACP protocol provides a standardized interface, allowing you to switch between different runtime implementations seamlessly.

## Available Runtimes

### 1. Claude Code (Default)

**Package**: `@zed-industries/claude-code-acp`

**Provider**: Anthropic Claude

**Features**:

- Full Claude Code toolset (Read, Write, Edit, MultiEdit, Grep, Glob, Bash, etc.)
- Advanced code understanding and generation
- MCP server support

**Requirements**:

- `ANTHROPIC_API_KEY` environment variable or configured in Dyad settings

**Usage**:

```bash
# Default - no configuration needed
DYAD_LOCAL_AGENT_RUNTIME=acp npm start
```

### 2. Codex

**Package**: `@zed-industries/codex-acp`

**Provider**: OpenAI (formerly Codex, now GPT-based)

**Features**:

- Code completion and generation
- Standard ACP toolset
- Compatible with ChatGPT subscription or OpenAI API key

**Requirements**:

- `OPENAI_API_KEY` or `CODEX_API_KEY` environment variable or configured in Dyad settings
- Alternatively, ChatGPT subscription (for local non-remote projects)

**Usage**:

```bash
# Set ACP runtime to codex
DYAD_LOCAL_AGENT_RUNTIME=acp DYAD_ACP_RUNTIME=codex npm start
```

## Configuration

### Environment Variables

#### `DYAD_LOCAL_AGENT_RUNTIME`

Selects the overall agent runtime implementation.

**Options**:

- `claude-agent-sdk` (default)
- `vercel-ai`
- `acp` - Uses ACP protocol (enables `DYAD_ACP_RUNTIME` selection)

#### `DYAD_ACP_RUNTIME`

Selects the specific ACP-compatible runtime (only applies when `DYAD_LOCAL_AGENT_RUNTIME=acp`).

**Options**:

- `claude-code` (default) - Uses Claude Code adapter
- `codex` - Uses Codex adapter

#### `DYAD_ACP_AGENT_ENTRY`

Optional override to specify a custom ACP agent entry point (path to executable or JS file).

**Example**:

```bash
DYAD_ACP_AGENT_ENTRY=/path/to/custom-acp-agent npm start
```

### Settings File

You can also configure the ACP runtime in user settings (future feature):

```json
{
  "localAgentRuntime": "acp",
  "acpRuntime": "codex"
}
```

## Examples

### Using Claude Code (Default)

```bash
# Method 1: Default behavior
DYAD_LOCAL_AGENT_RUNTIME=acp npm start

# Method 2: Explicit configuration
DYAD_LOCAL_AGENT_RUNTIME=acp DYAD_ACP_RUNTIME=claude-code npm start
```

### Using Codex

```bash
# Requires OPENAI_API_KEY
export OPENAI_API_KEY=sk-...
DYAD_LOCAL_AGENT_RUNTIME=acp DYAD_ACP_RUNTIME=codex npm start
```

### Using Custom ACP Runtime

```bash
# Build or download a custom ACP-compatible agent
DYAD_LOCAL_AGENT_RUNTIME=acp DYAD_ACP_AGENT_ENTRY=/path/to/custom-agent npm start
```

## API Key Configuration

### Priority Order

The system checks for API keys in the following order:

1. Environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY`)
2. Dyad settings UI (Settings → Provider Settings)

### Setting API Keys

**Via Environment Variables** (.env file):

```bash
# For Claude Code
ANTHROPIC_API_KEY=sk-ant-...

# For Codex
OPENAI_API_KEY=sk-...
# Or
CODEX_API_KEY=sk-...
```

**Via Dyad UI**:

1. Open Dyad Settings
2. Navigate to Provider Settings
3. Enter your API key for Anthropic (Claude Code) or OpenAI (Codex)
4. Save settings

## Runtime Comparison

| Feature      | Claude Code    | Codex                       |
| ------------ | -------------- | --------------------------- |
| Provider     | Anthropic      | OpenAI                      |
| Code Quality | Excellent      | Very Good                   |
| Cost         | Pay-per-use    | Pay-per-use or Subscription |
| MCP Support  | Yes            | Yes (via ACP)               |
| Tool Support | Full           | Full                        |
| Maintenance  | Zed Industries | Zed Industries              |

## Troubleshooting

### Runtime Not Found Error

```
Error: Claude Code ACP adapter not found. Install @zed-industries/claude-code-acp or set DYAD_ACP_AGENT_ENTRY.
```

**Solution**: Run `npm install` to ensure all dependencies are installed.

### API Key Issues

```
Error: ANTHROPIC_API_KEY is required
```

**Solution**: Set the appropriate API key in environment variables or Dyad settings.

### Runtime Crashes

Check the logs:

```bash
# Logs appear in console with [acp-runtime] prefix
[acp-runtime] start chatId=123 runtime=Codex model=...
```

### Unknown Runtime Error

```
Error: Invalid ACP runtime: unknown
```

**Solution**: Ensure `DYAD_ACP_RUNTIME` is set to either `claude-code` or `codex`.

## Development

### Adding a New ACP Runtime

To add support for a new ACP-compatible runtime:

1. Install the runtime package:

   ```bash
   npm install @vendor/new-acp-runtime
   ```

2. Add configuration to `ACP_RUNTIME_CONFIGS` in `local_agent_handler.acp.ts`:

   ```typescript
   "new-runtime": {
     packageName: "@vendor/new-acp-runtime",
     entryPath: "dist/index.js",
     displayName: "New Runtime",
     apiKeyEnvName: "NEW_RUNTIME_API_KEY",
   }
   ```

3. Update types in `local_agent_runtime.ts`:

   ```typescript
   export const ACP_RUNTIMES = ["claude-code", "codex", "new-runtime"] as const;
   ```

4. Add tests and documentation.

## References

- [Agent Client Protocol](https://agentclientprotocol.com/)
- [zed-industries/claude-code-acp](https://github.com/zed-industries/claude-code-acp)
- [zed-industries/codex-acp](https://github.com/zed-industries/codex-acp)
- [Dyad Agent Architecture](./agent_architecture.md)
