import { readSettings, writeSettings } from "./settings";

export function handleDyadProReturn({ apiKey }: { apiKey: string }) {
  const settings = readSettings();
  writeSettings({
    providerSettings: {
      ...settings.providerSettings,
      auto: {
        ...settings.providerSettings.auto,
        apiKey: {
          value: apiKey,
        },
      },
    },
    enableDyadPro: true,
    // Keep Build mode as the default entry chat mode.
    selectedChatMode: "build",
    selectedModel: {
      name: "auto",
      provider: "auto",
    },
  });
}
