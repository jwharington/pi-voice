import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

// Mock logger to prevent file I/O during tests
mock.module("../../services/logger.js", () => ({
  default: {
    info: () => { },
    warn: () => { },
    error: () => { },
    debug: () => { },
  },
}));

import {
  getEditableConfigPath,
  loadConfig,
  updateConfig,
  ConfigError,
} from "../../services/config.js";

describe("loadConfig", () => {
  let tmpDir: string;
  let homeDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tmpDir = join(tmpdir(), `pi-voice-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    homeDir = join(tmpDir, "home");
    mkdirSync(tmpDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    process.env.HOME = homeDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns defaults when no config file exists", () => {
    const config = loadConfig(tmpDir);
    expect(config.provider).toBe("local");
    expect(config.enabled).toBe(true);
    expect(config.ttsEnabled).toBe(true);
    expect(config.shortcut).toBe("f12");
  });

  test("loads shortcut field from config file", () => {
    const piDir = join(tmpDir, ".pi");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(
      join(piDir, "pi-voice.json"),
      JSON.stringify({ shortcut: "ctrl+t", provider: "gemini" }),
    );

    const config = loadConfig(tmpDir);
    expect(config.provider).toBe("gemini");
    expect(config.enabled).toBe(true);
    expect(config.shortcut).toBe("ctrl+t");
    expect(config.ttsEnabled).toBe(true);
  });

  test("accepts legacy key field as shortcut", () => {
    const piDir = join(tmpDir, ".pi");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(
      join(piDir, "pi-voice.json"),
      JSON.stringify({ key: "ctrl+t", provider: "gemini" }),
    );

    const config = loadConfig(tmpDir);
    expect(config.provider).toBe("gemini");
    expect(config.shortcut).toBe("ctrl+t");
  });

  test("shortcut takes precedence over legacy key field", () => {
    const piDir = join(tmpDir, ".pi");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(
      join(piDir, "pi-voice.json"),
      JSON.stringify({ shortcut: "alt+space", key: "ctrl+t" }),
    );

    const config = loadConfig(tmpDir);
    expect(config.shortcut).toBe("alt+space");
  });

  test("loads config from nearest ascendant directory", () => {
    const projectRoot = join(tmpDir, "work");
    const nestedDir = join(projectRoot, "a", "b");
    const piDir = join(projectRoot, ".pi");
    mkdirSync(nestedDir, { recursive: true });
    mkdirSync(piDir, { recursive: true });
    writeFileSync(
      join(piDir, "pi-voice.json"),
      JSON.stringify({ shortcut: "ctrl+t", provider: "gemini" }),
    );

    const config = loadConfig(nestedDir);
    expect(config.provider).toBe("gemini");
    expect(config.shortcut).toBe("ctrl+t");
  });

  test("falls back to global config when no ascendant config exists", () => {
    const cwd = join(tmpDir, "work", "project");
    const globalPiDir = join(homeDir, ".pi");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(globalPiDir, { recursive: true });
    writeFileSync(
      join(globalPiDir, "pi-voice.json"),
      JSON.stringify({ shortcut: "ctrl+t", provider: "openai" }),
    );

    const config = loadConfig(cwd);
    expect(config.provider).toBe("openai");
    expect(config.shortcut).toBe("ctrl+t");
  });

  test("uses defaults for missing fields", () => {
    const piDir = join(tmpDir, ".pi");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, "pi-voice.json"), JSON.stringify({}));

    const config = loadConfig(tmpDir);
    expect(config.provider).toBe("local");
    expect(config.enabled).toBe(true);
    expect(config.ttsEnabled).toBe(true);
    expect(config.shortcut).toBe("f12");
  });

  test("loads enabled flag when provided", () => {
    const piDir = join(tmpDir, ".pi");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(
      join(piDir, "pi-voice.json"),
      JSON.stringify({ enabled: false }),
    );

    const config = loadConfig(tmpDir);
    expect(config.enabled).toBe(false);
  });

  test("loads tts flag when provided", () => {
    const piDir = join(tmpDir, ".pi");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(
      join(piDir, "pi-voice.json"),
      JSON.stringify({ provider: "openai", tts: false }),
    );

    const config = loadConfig(tmpDir);
    expect(config.provider).toBe("openai");
    expect(config.ttsEnabled).toBe(false);
  });

  test("accepts all valid providers", () => {
    const piDir = join(tmpDir, ".pi");
    mkdirSync(piDir, { recursive: true });

    for (const provider of ["local", "gemini", "openai", "elevenlabs"] as const) {
      writeFileSync(
        join(piDir, "pi-voice.json"),
        JSON.stringify({ provider }),
      );
      const config = loadConfig(tmpDir);
      expect(config.provider).toBe(provider);
    }
  });

  test("throws ConfigError on invalid JSON syntax", () => {
    const piDir = join(tmpDir, ".pi");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, "pi-voice.json"), "not json {{{");

    expect(() => loadConfig(tmpDir)).toThrow(ConfigError);
    try {
      loadConfig(tmpDir);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).details).toContain("Invalid JSON");
    }
  });

  test("throws ConfigError on invalid provider", () => {
    const piDir = join(tmpDir, ".pi");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(
      join(piDir, "pi-voice.json"),
      JSON.stringify({ provider: "invalid-provider" }),
    );

    expect(() => loadConfig(tmpDir)).toThrow(ConfigError);
  });

  test("ConfigError includes configPath and details", () => {
    const piDir = join(tmpDir, ".pi");
    mkdirSync(piDir, { recursive: true });
    const configPath = join(piDir, "pi-voice.json");
    writeFileSync(configPath, "bad json");

    try {
      loadConfig(tmpDir);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const ce = err as ConfigError;
      expect(ce.configPath).toBe(configPath);
      expect(ce.details).toBeDefined();
      expect(ce.name).toBe("ConfigError");
    }
  });

  test("updateConfig creates project-local config file when none exists", () => {
    const cwd = join(tmpDir, "work", "project");
    mkdirSync(cwd, { recursive: true });

    const next = updateConfig(cwd, { provider: "openai", enabled: false, ttsEnabled: false });
    expect(next.provider).toBe("openai");
    expect(next.enabled).toBe(false);
    expect(next.ttsEnabled).toBe(false);

    const configPath = getEditableConfigPath(cwd);
    const raw = readFileSync(configPath, "utf-8");
    const json = JSON.parse(raw);
    expect(json.provider).toBe("openai");
    expect(json.enabled).toBe(false);
    expect(json.tts).toBe(false);
  });

  test("updateConfig updates existing config file", () => {
    const piDir = join(tmpDir, ".pi");
    const configPath = join(piDir, "pi-voice.json");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ provider: "local", enabled: true, tts: true }));

    const next = updateConfig(tmpDir, { shortcut: "ctrl+t" });
    expect(next.shortcut).toBe("ctrl+t");

    const json = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(json.shortcut).toBe("ctrl+t");
    expect(json.provider).toBe("local");
  });
});
