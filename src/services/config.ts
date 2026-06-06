import { dirname, join, resolve } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { z } from "zod";
import logger from "./logger.js";

// ── Types ────────────────────────────────────────────────────────────

/** Supported speech provider */
export type SpeechProvider = "local" | "gemini" | "openai" | "elevenlabs";

/** Controls how voice messages are delivered when the agent is busy */
export type DeliveryMode = "steer" | "followUp";

/** Controls what happens with final transcript text after recording. */
export type InputMode = "draft" | "autoSend";

export interface PiVoiceConfig {
  /**
  * Pi in-app shortcut string for toggle-to-record (e.g. "f12").
   * Passed directly to pi.registerShortcut().
   */
  shortcut: string;
  /** Speech provider for STT & TTS (default: "local") */
  provider: SpeechProvider;
  /** Whether voice hotkey handling is enabled (default: true) */
  enabled: boolean;
  /** Whether to synthesize spoken output (default: true) */
  ttsEnabled: boolean;
  /**
   * How final transcript text is delivered:
   * - "draft": insert into editor for review/edit
   * - "autoSend": send directly as a user message
   * Default: "autoSend".
   */
  inputMode: InputMode;
  /**
   * Eco mode — lightweight voice interface where speech goes to Pi
   * and only the final response is spoken back (no intermediate
   * reasoning). Matches pi-realtime's eco mode behavior.
   * Default: true.
   */
  ecoMode: boolean;
  /**
   * How voice messages are delivered when the agent is already processing.
   * - "followUp": queue the message to be processed after the current turn (default)
   * - "steer": interrupt the current turn with the new message
   * Default: "followUp".
   */
  deliveryMode: DeliveryMode;
  /**
   * OpenAI-compatible base URL for STT (e.g. http://localhost:8010).
   * Falls back to OPENAI_STT_BASE_URL env, then OPENAI_BASE_URL env.
   */
  sttBaseUrl?: string;
  /**
   * OpenAI-compatible base URL for TTS (e.g. http://localhost:8011).
   * Falls back to OPENAI_TTS_BASE_URL env, then OPENAI_BASE_URL env.
   */
  ttsBaseUrl?: string;
  /** STT model name (default: "whisper-1") */
  sttModel?: string;
  /** TTS model name (default: "gpt-4o-mini-tts") */
  ttsModel?: string;
  /** TTS voice name (default: "alloy") */
  ttsVoice?: string;
  /**
   * Volume level for TTS playback (0.0 to 1.0).
   * 0.0 disables TTS entirely.
   * Default: 1.0.
   */
  volume: number;
  /**
   * Controls which message roles are spoken.
   * 1 = only assistant, 2 = assistant + agent, 3 = assistant + agent + model, 4 = all.
   * Default: 1.
   */
  ttsVerbosity: number;
  /**
   * Whether to filter out emojis and symbols from TTS output.
   * Default: true.
   */
  ttsFilterSymbols: boolean;
}

// ── Default config ───────────────────────────────────────────────────

const DEFAULT_SHORTCUT = "f12";
const DEFAULT_PROVIDER: SpeechProvider = "local";

function defaultConfig(): PiVoiceConfig {
  return {
    shortcut: DEFAULT_SHORTCUT,
    provider: DEFAULT_PROVIDER,
    enabled: true,
    ttsEnabled: true,
    inputMode: "autoSend",
    ecoMode: true,
    deliveryMode: "followUp",
    volume: 1.0,
    ttsVerbosity: 1,
    ttsFilterSymbols: true,
  };
}

// ── Zod schema for pi-voice.json ─────────────────────────────────────

const configFileSchema = z.object({
  /** New field – plain shortcut string for pi.registerShortcut() */
  shortcut: z.string().min(1).optional(),
  /**
   * Legacy field from the daemon era ("meta+shift+i" style).
   * Accepted for backward-compatibility; `shortcut` takes precedence when both are present.
   */
  key: z.string().min(1).optional(),
  provider: z.enum(["local", "gemini", "openai", "elevenlabs"]).optional().default(DEFAULT_PROVIDER),
  enabled: z.boolean().optional().default(true),
  ecoMode: z.boolean().optional().default(true),
  tts: z.boolean().optional().default(true),
  inputMode: z.enum(["draft", "autoSend"]).optional(),
  deliveryMode: z.enum(["steer", "followUp"]).optional().default("followUp"),
  sttBaseUrl: z.string().url().min(1).optional(),
  ttsBaseUrl: z.string().url().min(1).optional(),
  sttModel: z.string().min(1).optional(),
  ttsModel: z.string().min(1).optional(),
  ttsVoice: z.string().min(1).optional(),
  volume: z.number().min(0).max(1).optional().default(1.0),
  ttsVerbosity: z.number().int().min(1).max(4).optional().default(1),
  ttsFilterSymbols: z.boolean().optional().default(true),
});

// ── Config loader ────────────────────────────────────────────────────

/**
 * Custom error class thrown when the config file is present but invalid.
 * Callers should catch this to show a user-friendly message and exit.
 */
export class ConfigError extends Error {
  constructor(
    public readonly configPath: string,
    public readonly details: string,
  ) {
    super(`Invalid config at ${configPath}:\n${details}`);
    this.name = "ConfigError";
  }
}

/**
 * Resolve config path from nearest ascendant `.pi/pi-voice.json`,
 * then fallback to `~/.pi/pi-voice.json`.
 */
function resolveConfigPath(cwd: string): string | undefined {
  let currentDir = resolve(cwd);

  while (true) {
    const candidate = join(currentDir, ".pi", "pi-voice.json");
    try {
      readFileSync(candidate, "utf-8");
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new ConfigError(candidate, `Failed to read file: ${(err as Error).message}`);
      }
    }

    const parent = dirname(currentDir);
    if (parent === currentDir) break;
    currentDir = parent;
  }

  const homePath = process.env.HOME && process.env.HOME.length > 0 ? process.env.HOME : homedir();
  const globalConfigPath = join(homePath, ".pi", "pi-voice.json");
  try {
    readFileSync(globalConfigPath, "utf-8");
    return globalConfigPath;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new ConfigError(globalConfigPath, `Failed to read file: ${(err as Error).message}`);
  }
}

/** Returns the currently active config path if one exists. */
export function getExistingConfigPath(cwd: string): string | undefined {
  return resolveConfigPath(cwd);
}

/**
 * Returns the path that should be used for writes from commands.
 * If no config exists yet, we create a project-local config at `<cwd>/.pi/pi-voice.json`.
 */
export function getEditableConfigPath(cwd: string): string {
  return resolveConfigPath(cwd) ?? join(resolve(cwd), ".pi", "pi-voice.json");
}

/**
 * Load config from nearest ascendant `.pi/pi-voice.json`.
 * Falls back to `~/.pi/pi-voice.json`, then defaults if missing.
 * Throws `ConfigError` if the file exists but contains invalid values.
 */
export function loadConfig(cwd: string): PiVoiceConfig {
  const configPath = resolveConfigPath(cwd);

  if (!configPath) {
    logger.info({ cwd }, "No config file found in ascendants or global path, using defaults");
    return defaultConfig();
  }

  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (err) {
    throw new ConfigError(configPath, `Failed to read file: ${(err as Error).message}`);
  }

  // Parse JSON
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ConfigError(configPath, "Invalid JSON syntax");
  }

  // Validate with zod
  const result = configFileSchema.safeParse(json);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? `"${issue.path.join(".")}"` : "(root)";
        return `  - ${path}: ${issue.message}`;
      })
      .join("\n");
    throw new ConfigError(configPath, details);
  }

  const parsed = result.data;
  // `shortcut` (new field) takes precedence; fall back to legacy `key` field,
  // then the hard-coded default. This ensures old configs keep working.
  const shortcut = parsed.shortcut ?? parsed.key ?? DEFAULT_SHORTCUT;

  logger.debug(
    {
      shortcut,
      provider: parsed.provider,
      enabled: parsed.enabled,
      tts: parsed.tts,
      configPath,
    },
    "Loaded config",
  );
  return {
    shortcut,
    provider: parsed.provider,
    enabled: parsed.enabled,
    ttsEnabled: parsed.tts,
    // Backward compatibility: if inputMode is missing, preserve legacy behavior
    // where tts=true implied auto-send and tts=false implied draft.
    inputMode: parsed.inputMode ?? (parsed.tts ? "autoSend" : "draft"),
    ecoMode: parsed.ecoMode ?? true,
    deliveryMode: parsed.deliveryMode ?? "followUp",
    volume: parsed.volume ?? 1.0,
    ttsVerbosity: parsed.ttsVerbosity ?? 1,
    ttsFilterSymbols: parsed.ttsFilterSymbols ?? true,
    ...(parsed.sttBaseUrl ? { sttBaseUrl: parsed.sttBaseUrl } : {}),
    ...(parsed.ttsBaseUrl ? { ttsBaseUrl: parsed.ttsBaseUrl } : {}),
    ...(parsed.sttModel ? { sttModel: parsed.sttModel } : {}),
    ...(parsed.ttsModel ? { ttsModel: parsed.ttsModel } : {}),
    ...(parsed.ttsVoice ? { ttsVoice: parsed.ttsVoice } : {}),
  };
}

type ConfigPatch = Partial<Pick<PiVoiceConfig, "shortcut" | "provider" | "enabled" | "ttsEnabled" | "inputMode" | "ecoMode" | "deliveryMode" | "volume" | "sttBaseUrl" | "ttsBaseUrl" | "sttModel" | "ttsModel" | "ttsVoice" | "ttsVerbosity" | "ttsFilterSymbols">>;

/**
 * Persist partial config updates and return the merged effective config.
 * Creates `<cwd>/.pi/pi-voice.json` when no config exists yet.
 */
export function updateConfig(cwd: string, patch: ConfigPatch): PiVoiceConfig {
  const configPath = getEditableConfigPath(cwd);
  const current = loadConfig(cwd);
  const next: PiVoiceConfig = {
    ...current,
    ...patch,
  };

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    `${JSON.stringify({
      shortcut: next.shortcut,
      provider: next.provider,
      enabled: next.enabled,
      tts: next.ttsEnabled,
      inputMode: next.inputMode,
      ecoMode: next.ecoMode,
      deliveryMode: next.deliveryMode,
      volume: next.volume,
      ...(next.sttBaseUrl ? { sttBaseUrl: next.sttBaseUrl } : {}),
      ...(next.ttsBaseUrl ? { ttsBaseUrl: next.ttsBaseUrl } : {}),
      ...(next.sttModel ? { sttModel: next.sttModel } : {}),
      ...(next.ttsModel ? { ttsModel: next.ttsModel } : {}),
      ...(next.ttsVoice ? { ttsVoice: next.ttsVoice } : {}),
      ...(next.ttsVerbosity ? { ttsVerbosity: next.ttsVerbosity } : {}),
      ttsFilterSymbols: next.ttsFilterSymbols,
    }, null, 2)}\n`,
    "utf-8",
  );

  logger.info({ configPath }, "Updated pi-voice config");
  return next;
}
