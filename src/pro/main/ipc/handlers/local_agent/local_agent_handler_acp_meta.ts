export function buildAcpSessionMeta(params: {
  systemPrompt: string;
  selectedModelName: string;
  disallowedTools: string[];
}) {
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
