/**
 * Voice discovery service for TTS providers.
 *
 * Fetches available voices from provider APIs and caches the results.
 */

import { spawn } from "node:child_process";
import logger from "./logger.js";

// ── OpenAI voices (documented, not queryable via API) ────────────────

const OPENAI_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "nova", "sage", "shimmer"];

/** Get OpenAI voices (static list). */
export function getOpenAIVoices(): string[] {
  return [...OPENAI_VOICES];
}

// ── ElevenLabs voices (queried via REST API) ─────────────────────────

let elevenlabsVoicesCache: Array<{ voiceId: string; voiceName: string }> | null = null;

/** Fetch available ElevenLabs voices from the REST API. */
export async function getElevenLabsVoices(): Promise<Array<{ voiceId: string; voiceName: string }>> {
  if (elevenlabsVoicesCache) return elevenlabsVoicesCache;

  try {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      throw new Error("ELEVENLABS_API_KEY environment variable is required");
    }

    const response = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": apiKey },
    });

    if (!response.ok) {
      throw new Error(`ElevenLabs API returned ${response.status}`);
    }

    const data = await response.json();
    const voices = data.voices as Array<{ voice_id: string; name: string }> | undefined;

    const voiceList: Array<{ voiceId: string; voiceName: string }> = [];
    if (Array.isArray(voices)) {
      for (const voice of voices) {
        if (voice.voice_id && voice.name) {
          voiceList.push({
            voiceId: voice.voice_id,
            voiceName: voice.name,
          });
        }
      }
    }

    elevenlabsVoicesCache = voiceList;
    logger.info({ count: voiceList.length }, "Cached ElevenLabs voices");
    return voiceList;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Failed to fetch ElevenLabs voices");
    // Fall back to known default voices
    elevenlabsVoicesCache = [
      { voiceId: "CwhRBWXzGAHq8TQ4Fs17", voiceName: "Rachel" },
      { voiceId: "EXAVITQu4yrSjH2TgNRO", voiceName: "Domi" },
      { voiceId: "ERZXwtonYiIzNbAI7bF4", voiceName: "Bella" },
      { voiceId: "TADEJ8kSvY3fGnY4Gk1R", voiceName: "Arthur" },
      { voiceId: "Xb7hHFS8MBMKi4iF9M1u", voiceName: "Callum" },
      { voiceId: "LRQ7DUQzKMUk69NUoZdO", voiceName: "Charlie" },
      { voiceId: "cjAv6jQ3tT0NGz8cKHNx", voiceName: "Charlotte" },
      { voiceId: "IK17q0bJgV3QwEz0gZKZ", voiceName: "Clyde" },
      { voiceId: "nDJIcG3fHwM2vGhK8k8G", voiceName: "Dawn" },
      { voiceId: "pFj2d1b8qMvKf0gJ0gYj", voiceName: "Ethan" },
      { voiceId: "g5CIjBkf17edRJdQZ5Ji", voiceName: "Fable" },
      { voiceId: "jsCqWA0g6BhHJFjXpKkM", voiceName: "Gerry" },
    ];
    return elevenlabsVoicesCache;
  }
}

// ── Gemini voices (prebuilt voices documented by Google) ─────────────

/** Gemini prebuilt voices (from Gemini API docs). */
const GEMINI_VOICES = [
  "Aoede",
  "Chimeira",
  "Kore",
  "Damni",
  "Petropolis",
  "Orpheus",
];

export function getGeminiVoices(): string[] {
  return [...GEMINI_VOICES];
}

// ── Local voices (macOS say command) ──────────────────────────────────

/**
 * Get available macOS voices by querying the `say` command.
 * Returns an empty array if not on macOS.
 */
export async function getLocalVoices(): Promise<Array<{ voiceId: string; voiceName: string }>> {
  if (process.platform !== "darwin") return [];

  return new Promise((resolve) => {
    // `say -v ?` lists available voices
    const proc = spawn("say", ["-v", "?"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", () => {
      // macOS say outputs voice list to stderr with format: "VoiceName (Language)"
      const lines = stderr.split("\n");
      const voices: Array<{ voiceId: string; voiceName: string }> = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("Usage") || trimmed.startsWith("Flags")) continue;

        // Parse "VoiceName (Language)" or just "VoiceName"
        const parts = trimmed.split(/\s+\(/);
        const voiceId = parts[0]?.trim() ?? "";
        const voiceName = parts[0]?.trim() ?? "";

        if (voiceId && !voiceId.includes(" ")) {
          voices.push({ voiceId, voiceName });
        }
      }

      logger.info({ count: voices.length }, "Cached local voices");
      resolve(voices);
    });

    proc.on("error", (err) => {
      logger.warn({ err: (err as Error).message }, "Failed to query local voices");
      resolve([]);
    });
  });
}

// ── Unified voice discovery ──────────────────────────────────────────

export type VoiceInfo = { voiceId: string; voiceName: string };

/**
 * Get available voices for the given provider.
 * Cloud providers query their APIs; local queries the system.
 */
export async function getVoicesForProvider(
  provider: "local" | "gemini" | "openai" | "elevenlabs",
): Promise<VoiceInfo[]> {
  switch (provider) {
    case "openai":
      return getOpenAIVoices().map((voice) => ({ voiceId: voice, voiceName: voice }));
    case "gemini":
      return getGeminiVoices().map((voice) => ({ voiceId: voice, voiceName: voice }));
    case "elevenlabs":
      return getElevenLabsVoices();
    case "local":
      return getLocalVoices();
  }
}
