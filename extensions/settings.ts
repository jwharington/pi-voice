/**
 * pi-voice TUI settings component.
 *
 * Provides a settings menu for pi-voice using Pi's SettingsList component.
 * Accessed via /voice settings command.
 */

import { Input, SettingsList, type Component, type TUI } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { KeybindingsManager } from "@mariozechner/pi-coding-agent";
import type { PiVoiceConfig } from "../src/services/config.js";
import { updateConfig, getEditableConfigPath, loadConfig } from "../src/services/config.js";
import { getVoicesForProvider } from "../src/services/voices.js";

/**
 * Creates a Component that wraps a SettingsList for pi-voice settings.
 * Uses Pi's native settings menu style with keyboard navigation, search, and submenus.
 * Fetches available voices from the provider API.
 */
export async function createSettingsComponent(
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (result: boolean) => void,
): Promise<Component & { dispose?(): void; }> {
  const config = loadConfig(process.cwd());
  const configPath = getEditableConfigPath(process.cwd());

  // Fetch available voices from the provider API (may take a moment)
  const voiceList: string[] = [];
  try {
    const voices = await getVoicesForProvider(config.provider);
    voiceList.push(...voices.map((v) => v.voiceId));
  } catch {
    // Use empty list if API fails
  }

  // Helper to update config and the SettingsList value
  function updateSetting(id: string, newValue: string): void {
    const patch: Partial<PiVoiceConfig> = {};

    switch (id) {
      case "shortcut":
        patch.shortcut = newValue.trim().toLowerCase() || config.shortcut;
        break;
      case "provider":
        patch.provider = newValue as PiVoiceConfig["provider"];
        break;
      case "enabled":
        patch.enabled = newValue === "On";
        break;
      case "tts":
        patch.ttsEnabled = newValue === "On";
        break;
      case "inputMode":
        patch.inputMode = newValue as PiVoiceConfig["inputMode"];
        break;
      case "ttsVerbosity":
        const v = parseInt(newValue, 10);
        if (!isNaN(v) && v >= 1 && v <= 4) patch.ttsVerbosity = v;
        break;
      case "ttsFilterSymbols":
        patch.ttsFilterSymbols = newValue === "On";
        break;
      case "volume":
        const vol = parseFloat(newValue.replace("%", "")) / 100;
        if (!isNaN(vol)) patch.volume = Math.max(0, Math.min(1, vol));
        break;
      case "ecoMode":
        patch.ecoMode = newValue === "On";
        break;
      case "deliveryMode":
        patch.deliveryMode = newValue as PiVoiceConfig["deliveryMode"];
        break;
      case "sttModel":
        patch.sttModel = newValue.trim() || undefined;
        break;
      case "ttsModel":
        patch.ttsModel = newValue.trim() || undefined;
        break;
      case "ttsVoice":
        patch.ttsVoice = newValue.trim() || undefined;
        break;
      case "sttBaseUrl":
        patch.sttBaseUrl = newValue.trim() || undefined;
        break;
      case "ttsBaseUrl":
        patch.ttsBaseUrl = newValue.trim() || undefined;
        break;
    }

    if (Object.keys(patch).length > 0) {
      updateConfig(process.cwd(), patch);
    }
  }

  // Helper to create an Input submenu component
  function createInputSubmenu(title: string, initialValue: string, onSubmit: (value: string) => void): Component {
    const input = new Input();
    input.setValue(initialValue);
    input.onSubmit = onSubmit;
    input.onEscape = () => {};

    return {
      handleInput(data: string): void {
        input.handleInput(data);
      },
      render(width: number): string[] {
        const lines: string[] = [];
        lines.push(`  ${title}`);
        lines.push(...input.render(width));
        return lines;
      },
      invalidate(): void {
        // Input doesn't need invalidation
      },
    };
  }

  // Create a theme for the SettingsList
  const settingsListTheme = {
    label: (text: string, selected: boolean) => selected ? theme.bold(text) : text,
    value: (text: string, selected: boolean) => selected ? theme.bold(text) : text,
    description: (text: string) => theme.fg("muted", text),
    cursor: theme.bold("▸"),
    hint: (text: string) => theme.fg("muted", text),
  };

  const settingsList = new SettingsList([
    {
      id: "shortcut",
      label: "Voice Hotkey",
      description: "Keyboard shortcut to start/stop recording",
      currentValue: config.shortcut,
      submenu: (currentValue, done) => createInputSubmenu(
        "Enter shortcut (e.g. f12, ctrl+t)",
        currentValue,
        (value: string) => {
          updateSetting("shortcut", value);
          done(value.trim().toLowerCase() || currentValue);
        },
      ),
    },
    {
      id: "provider",
      label: "Speech Provider",
      description: "Provider for STT and TTS",
      currentValue: config.provider,
      values: ["local", "gemini", "openai", "elevenlabs"],
    },
    {
      id: "enabled",
      label: "Voice Enabled",
      description: "Enable/disable voice hotkey",
      currentValue: config.enabled ? "On" : "Off",
      values: ["On", "Off"],
    },
    {
      id: "tts",
      label: "TTS Enabled",
      description: "Enable/disable text-to-speech",
      currentValue: config.ttsEnabled ? "On" : "Off",
      values: ["On", "Off"],
    },
    {
      id: "inputMode",
      label: "Input Mode",
      description: "How final transcript is delivered",
      currentValue: config.inputMode,
      values: ["draft", "autoSend"],
    },
    {
      id: "ttsVerbosity",
      label: "TTS Verbosity",
      description: "1: assistant only | 2: +agent | 3: +model | 4: all",
      currentValue: String(config.ttsVerbosity),
      values: ["1", "2", "3", "4"],
    },
    {
      id: "ttsFilterSymbols",
      label: "Filter Symbols in TTS",
      description: "Remove emojis and symbols from speech",
      currentValue: config.ttsFilterSymbols ? "On" : "Off",
      values: ["On", "Off"],
    },
    {
      id: "volume",
      label: "TTS Volume",
      description: "Volume level for TTS playback (0.0 to 1.0)",
      currentValue: `${Math.round(config.volume * 100)}%`,
      values: ["0%", "25%", "50%", "75%", "100%"],
    },
    {
      id: "ecoMode",
      label: "Eco Mode",
      description: "Only speak final response (skip intermediate steps)",
      currentValue: config.ecoMode ? "On" : "Off",
      values: ["On", "Off"],
    },
    {
      id: "sttModel",
      label: "STT Model",
      description: "Model name for speech-to-text (blank = use env/default)",
      currentValue: config.sttModel ?? "(env/default)",
      submenu: (currentValue, done) => createInputSubmenu(
        "Enter STT model (blank = use env/default)",
        currentValue === "(env/default)" ? "" : currentValue,
        (value: string) => {
          updateSetting("sttModel", value);
          done(value.trim() || "(env/default)");
        },
      ),
    },
    {
      id: "ttsModel",
      label: "TTS Model",
      description: "Model name for text-to-speech (blank = use env/default)",
      currentValue: config.ttsModel ?? "(env/default)",
      submenu: (currentValue, done) => createInputSubmenu(
        "Enter TTS model (blank = use env/default)",
        currentValue === "(env/default)" ? "" : currentValue,
        (value: string) => {
          updateSetting("ttsModel", value);
          done(value.trim() || "(env/default)");
        },
      ),
    },
    {
      id: "ttsVoice",
      label: "TTS Voice",
      description: "Voice name for text-to-speech (blank = use env/default)",
      currentValue: config.ttsVoice ?? "(env/default)",
      ...(voiceList.length > 0 ? { values: ["(env/default)", ...voiceList] } : {}),
      submenu: (currentValue, done) => createInputSubmenu(
        "Enter TTS voice (blank = use env/default)",
        currentValue === "(env/default)" ? "" : currentValue,
        (value: string) => {
          updateSetting("ttsVoice", value);
          done(value.trim() || "(env/default)");
        },
      ),
    },
    {
      id: "sttBaseUrl",
      label: "STT Base URL",
      description: "Base URL for STT provider (blank = use env/default)",
      currentValue: config.sttBaseUrl ?? "(env/default)",
      submenu: (currentValue, done) => createInputSubmenu(
        "Enter STT base URL (blank = use env/default)",
        currentValue === "(env/default)" ? "" : currentValue,
        (value: string) => {
          updateSetting("sttBaseUrl", value);
          done(value.trim() || "(env/default)");
        },
      ),
    },
    {
      id: "ttsBaseUrl",
      label: "TTS Base URL",
      description: "Base URL for TTS provider (blank = use env/default)",
      currentValue: config.ttsBaseUrl ?? "(env/default)",
      submenu: (currentValue, done) => createInputSubmenu(
        "Enter TTS base URL (blank = use env/default)",
        currentValue === "(env/default)" ? "" : currentValue,
        (value: string) => {
          updateSetting("ttsBaseUrl", value);
          done(value.trim() || "(env/default)");
        },
      ),
    },
    {
      id: "deliveryMode",
      label: "Delivery Mode",
      description: "How to handle messages when agent is busy",
      currentValue: config.deliveryMode,
      values: ["followUp", "steer"],
    },
    {
      id: "configPath",
      label: "Config Path",
      description: "Path to pi-voice configuration file",
      currentValue: configPath,
    },
  ], 8, settingsListTheme,
  (id: string, newValue: string) => {
    updateSetting(id, newValue);
  },
  () => done(true),
  { enableSearch: true }
  );

  return {
    handleInput(data: string): void {
      settingsList.handleInput(data);
    },
    render(width: number): string[] {
      return settingsList.render(width);
    },
    invalidate(): void {
      settingsList.invalidate();
    },
    dispose(): void {
      done(true);
    },
  };
}
