/**
 * Voice discovery service for TTS providers.
 *
 * Fetches available voices from provider APIs and caches the results.
 */

import { spawn } from "node:child_process";
import logger from "./logger.js";

// ── OpenAI voices ────────────────────────────────────────────────────

/**
 * Default OpenAI voices (documented by OpenAI).
 * Used when the API query fails or no base URL is configured.
 */
const OPENAI_DEFAULT_VOICES = [
  { voiceId: "alloy", voiceName: "alloy" },
  { voiceId: "ash", voiceName: "ash" },
  { voiceId: "ballad", voiceName: "ballad" },
  { voiceId: "coral", voiceName: "coral" },
  { voiceId: "echo", voiceName: "echo" },
  { voiceId: "nova", voiceName: "nova" },
  { voiceId: "sage", voiceName: "sage" },
  { voiceId: "shimmer", voiceName: "shimmer" },
];

let openAiVoicesCache: Array<{ voiceId: string; voiceName: string }> | null = null;

/**
 * Resolve the base URL for OpenAI-compatible TTS.
 * Priority: OPENAI_TTS_BASE_URL env → OPENAI_BASE_URL env → default OpenAI API.
 */
function resolveOpenAIBaseUrl(): string | undefined {
  return process.env.OPENAI_TTS_BASE_URL ?? process.env.OPENAI_BASE_URL;
}

/**
 * Resolve the API key for OpenAI-compatible TTS.
 * Falls back to a dummy key for localhost (many local servers don't require auth).
 */
function resolveOpenAIApiKey(): string {
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) return apiKey;
  return "sk-test"; // Dummy key for localhost servers that don't require auth
}

/**
 * Fetch available voices from an OpenAI-compatible provider.
 * Queries the /v1/voices endpoint and caches the results.
 */
export async function getOpenAIVoices(): Promise<Array<{ voiceId: string; voiceName: string }>> {
  if (openAiVoicesCache) return openAiVoicesCache;

  const baseUrl = resolveOpenAIBaseUrl();
  const apiKey = resolveOpenAIApiKey();

  // Only query the API if there's a custom base URL (local OpenAI-compatible server).
  // Default OpenAI doesn't support querying voices via the API.
  if (baseUrl) {
    try {
      const url = baseUrl.endsWith("/v1")
        ? `${baseUrl}/voices`
        : baseUrl.endsWith("/")
          ? `${baseUrl}v1/voices`
          : `${baseUrl}/v1/voices`;

      logger.debug({ url }, "Fetching OpenAI-compatible voices");
      const response = await fetch(url, {
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      });

      if (response.ok) {
        const data = await response.json();

        // Handle various response shapes:
        // - { voices: [{ id, name }] }
        // - [{ id, name }] (flat array)
        // - { data: [{ id, name }] }
        let voices: Array<{ id?: string; name?: string; voice_id?: string }> = [];

        if (Array.isArray(data)) {
          voices = data;
        } else if (Array.isArray(data.voices)) {
          voices = data.voices;
        } else if (Array.isArray(data.data)) {
          voices = data.data;
        }

        if (voices.length > 0) {
          const voiceList: Array<{ voiceId: string; voiceName: string }> = voices
            .map((v) => ({
              voiceId: v.voice_id ?? v.id ?? "",
              voiceName: v.name ?? v.voice_id ?? v.id ?? "",
            }))
            .filter((v) => v.voiceId);

          openAiVoicesCache = voiceList;
          logger.info({ count: voiceList.length, url }, "Cached OpenAI voices from API");
          return voiceList;
        }
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message, url: baseUrl }, "Failed to fetch OpenAI voices from API");
    }
  }

  // Fall back to default OpenAI voices
  openAiVoicesCache = [...OPENAI_DEFAULT_VOICES];
  logger.info({ count: openAiVoicesCache.length }, "Using default OpenAI voices");
  return openAiVoicesCache;
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
      return getOpenAIVoices();
    case "gemini":
      return getGeminiVoices().map((voice) => ({ voiceId: voice, voiceName: voice }));
    case "elevenlabs":
      return getElevenLabsVoices();
    case "local":
      return getLocalVoices();
  }
}
