import OpenAI from "openai";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { spawn } from "node:child_process";
import type { SpeechProvider } from "./config.js";
import { getGeminiClient } from "./gemini-client.js";
import logger from "./logger.js";

// ── OpenAI client cache (keyed by base URL) ──────────────────────────

const openAiTtsClients = new Map<string, OpenAI>();

function resolveTtsBaseUrl(configValue?: string): string | undefined {
  // Priority: config field → OPENAI_TTS_BASE_URL env → OPENAI_BASE_URL env
  if (configValue) return configValue;
  return process.env.OPENAI_TTS_BASE_URL ?? process.env.OPENAI_BASE_URL;
}

/** OpenAI SDK v6 default base URL includes /v1, so local servers need it too. */
function ensureV1Prefix(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (url.endsWith("/v1")) return url;
  return url.endsWith("/") ? `${url}v1` : `${url}/v1`;
}

function resolveApiKey(baseUrl?: string): string | undefined {
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) return apiKey;

  // Auto-detect localhost – use dummy key when no real key needed
  const isLocalhost =
    baseUrl !== undefined &&
    (baseUrl.startsWith("http://localhost") ||
      baseUrl.startsWith("http://127.0.0.1") ||
      baseUrl.startsWith("https://localhost") ||
      baseUrl.startsWith("https://127.0.0.1"));

  return isLocalhost ? "sk-test" : undefined;
}

function getOpenAIClient(baseUrl: string | undefined): OpenAI {
  const normalized = ensureV1Prefix(baseUrl);
  const key = normalized ?? "__default__";
  if (openAiTtsClients.has(key)) return openAiTtsClients.get(key)!;

  const apiKey = resolveApiKey(normalized);
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY environment variable is required");
  }

  const clientOptions: { apiKey: string; baseURL?: string } = { apiKey };
  if (normalized) clientOptions.baseURL = normalized;

  const client = new OpenAI(clientOptions);
  openAiTtsClients.set(key, client);
  return client;
}

// ── Audio parameters ─────────────────────────────────────────────────

/** Default audio parameters (shared across providers – both output 24kHz 16-bit mono PCM) */
export const TTS_SAMPLE_RATE = 24000;
export const TTS_CHANNELS = 1;
export const TTS_BITS_PER_SAMPLE = 16;

/** Chunk size for splitting PCM response (~100ms of audio) */
const PCM_CHUNK_SIZE = TTS_SAMPLE_RATE * (TTS_BITS_PER_SAMPLE / 8) * TTS_CHANNELS * 0.1; // 4800 bytes

// ── Gemini TTS ───────────────────────────────────────────────────────

interface TtsOptions {
  ttsBaseUrl?: string;
  ttsModel?: string;
  ttsVoice?: string;
}

async function* synthesizeStreamGemini(
  text: string,
  options?: TtsOptions,
): AsyncGenerator<Buffer, void, undefined> {
  const client = getGeminiClient();
  const voice = options?.ttsVoice ?? process.env.GEMINI_TTS_VOICE ?? "Aoede";

  const response = await client.models.generateContentStream({
    model: "gemini-2.5-flash-preview-tts",
    contents: [
      {
        role: "user",
        parts: [{ text }],
      },
    ],
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: voice,
          },
        },
      },
    },
  });

  let totalBytes = 0;
  // Carry over odd trailing byte for 16-bit alignment
  let leftover: Buffer | null = null;

  for await (const chunk of response) {
    const candidate = chunk.candidates?.[0];
    const parts = candidate?.content?.parts;
    if (!parts) continue;

    for (const part of parts) {
      if (!part.inlineData?.data) continue;

      let pcm = Buffer.from(part.inlineData.data, "base64");

      // Prepend leftover byte from previous chunk if any
      if (leftover) {
        pcm = Buffer.concat([leftover, pcm]);
        leftover = null;
      }

      // Ensure 16-bit (2-byte) alignment
      const bytesPerSample = TTS_BITS_PER_SAMPLE / 8;
      const remainder = pcm.length % bytesPerSample;
      if (remainder !== 0) {
        leftover = pcm.subarray(pcm.length - remainder);
        pcm = pcm.subarray(0, pcm.length - remainder);
      }

      if (pcm.length > 0) {
        totalBytes += pcm.length;
        yield pcm;
      }
    }
  }

  // Flush any remaining leftover (shouldn't happen with well-formed data)
  if (leftover && leftover.length > 0) {
    totalBytes += leftover.length;
    yield leftover;
  }

  logger.info(
    { provider: "gemini", totalBytes, text: text.substring(0, 50) },
    "Streamed PCM audio",
  );
}

// ── OpenAI TTS ───────────────────────────────────────────────────────


/** Decode MP3 buffer to PCM using ffmpeg. */
async function decodeMp3ToPcm(mp3Buffer: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", ["-y", "-i", "pipe:0", "-f", "s16le", "-ar", "24000", "-ac", "1", "pipe:1"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const chunks: Buffer[] = [];
    ffmpeg.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    ffmpeg.stderr.on("data", () => {}); // Ignore stderr
    ffmpeg.on("error", (err) => reject(new Error(`Failed to spawn ffmpeg: ${err.message}`)));
    ffmpeg.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });

    ffmpeg.stdin.write(mp3Buffer);
    ffmpeg.stdin.end();
  });
}

async function* synthesizeStreamOpenAI(
  text: string,
  options?: TtsOptions,
): AsyncGenerator<Buffer, void, undefined> {
  const baseUrl = resolveTtsBaseUrl(options?.ttsBaseUrl);
  const client = getOpenAIClient(baseUrl);

  const model = options?.ttsModel ?? process.env.OPENAI_TTS_MODEL ?? "gpt-4o-mini-tts";
  const voice = options?.ttsVoice ?? process.env.OPENAI_TTS_VOICE ?? "alloy";

  let totalBytes = 0;

  // Try streaming PCM first — starts playback immediately as audio is generated.
  // Falls back to non-streaming PCM, then MP3 (decoded to PCM) if server doesn't support PCM.
  try {
    const response = await client.audio.speech.create({
      model,
      voice,
      input: text,
      response_format: "pcm",
      stream_format: "audio",
    });

    if (!response.body) {
      throw new Error("No response body");
    }

    const reader = response.body.getReader();
    let streamingBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const buffer = Buffer.from(value);
      streamingBytes += buffer.length;
      yield buffer;
    }

    if (streamingBytes === 0) {
      throw new Error("Streaming produced 0 bytes");
    }
    totalBytes = streamingBytes;
  } catch {
    // Fall back to non-streaming PCM, then MP3
    const pcmResponse = await client.audio.speech.create({
      model,
      voice,
      input: text,
      response_format: "pcm",
    });

    const arrayBuffer = await pcmResponse.arrayBuffer();
    const pcmBuffer = Buffer.from(arrayBuffer);

    if (pcmBuffer.length > 0) {
      let offset = 0;
      while (offset < pcmBuffer.length) {
        const end = Math.min(offset + PCM_CHUNK_SIZE, pcmBuffer.length);
        const chunk = pcmBuffer.subarray(offset, end);
        totalBytes += chunk.length;
        yield chunk;
        offset = end;
      }
    } else {
      // Server doesn't support PCM — fall back to MP3 and decode to PCM
      const mp3Response = await client.audio.speech.create({
        model,
        voice,
        input: text,
        response_format: "mp3",
      });

      const mp3Buffer = Buffer.from(await mp3Response.arrayBuffer());
      if (mp3Buffer.length === 0) {
        throw new Error(`TTS server returned 0 bytes for text: "${text.substring(0, 50)}..."`);
      }

      // Decode MP3 to PCM using ffmpeg/sox
      const decoded = await decodeMp3ToPcm(mp3Buffer);
      let offset = 0;
      while (offset < decoded.length) {
        const end = Math.min(offset + PCM_CHUNK_SIZE, decoded.length);
        const chunk = decoded.subarray(offset, end);
        totalBytes += chunk.length;
        yield chunk;
        offset = end;
      }
    }
  }

  logger.info(
    { provider: "openai", totalBytes, text: text.substring(0, 50) },
    "Streamed PCM audio",
  );

}

// ── ElevenLabs TTS ───────────────────────────────────────────────────

let elevenlabsClient: ElevenLabsClient | null = null;

function getElevenLabsClient(): ElevenLabsClient {
  if (elevenlabsClient) return elevenlabsClient;
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error("ELEVENLABS_API_KEY environment variable is required");
  }
  elevenlabsClient = new ElevenLabsClient({ apiKey });
  return elevenlabsClient;
}

const DEFAULT_ELEVENLABS_VOICE_ID = "CwhRBWXzGAHq8TQ4Fs17";

async function* synthesizeStreamElevenLabs(
  text: string,
  options?: TtsOptions,
): AsyncGenerator<Buffer, void, undefined> {
  const client = getElevenLabsClient();
  const voiceId = options?.ttsVoice ?? process.env.ELEVENLABS_VOICE_ID ?? DEFAULT_ELEVENLABS_VOICE_ID;
  const modelId = process.env.ELEVENLABS_TTS_MODEL ?? "eleven_flash_v2_5";

  // SDK returns a ReadableStream; outputFormat pcm_24000 gives raw 24kHz 16-bit signed LE mono PCM
  const audio = await client.textToSpeech.convert(voiceId, {
    text,
    modelId,
    outputFormat: "pcm_24000",
  });

  // Collect the stream into a Buffer, then split into fixed-size chunks
  const chunks: Uint8Array[] = [];
  const reader = audio.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const fullBuffer = Buffer.concat(chunks);

  let totalBytes = 0;
  let offset = 0;

  while (offset < fullBuffer.length) {
    const end = Math.min(offset + PCM_CHUNK_SIZE, fullBuffer.length);
    const chunk = fullBuffer.subarray(offset, end);
    totalBytes += chunk.length;
    yield chunk;
    offset = end;
  }

  logger.info(
    { provider: "elevenlabs", totalBytes, text: text.substring(0, 50) },
    "Streamed PCM audio",
  );
}

// ── Local TTS (macOS say command) ────────────────────────────────────

/**
 * Speak text using the macOS `say` command, playing directly through the
 * system's default audio output. Returns a promise that resolves when speech finishes.
 */
export function speakLocal(text: string, voice?: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (process.platform !== "darwin") {
      reject(new Error("Local TTS (say command) is only supported on macOS"));
      return;
    }

    const effectiveVoice = voice ?? process.env.SAY_VOICE;
    const args: string[] = [];
    if (effectiveVoice) {
      args.push("-v", effectiveVoice);
    }
    args.push(text);

    const child = spawn("say", args, { stdio: "ignore" });

    child.on("error", (err) => {
      reject(new Error(`Failed to spawn say command: ${err.message}`));
    });

    child.on("close", (code) => {
      if (code === 0) {
        logger.info(
          { provider: "local", text: text.substring(0, 50) },
          "Spoke text",
        );
        resolve();
      } else {
        reject(new Error(`say command exited with code ${code}`));
      }
    });
  });
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Convert text to speech using the configured provider (streaming).
 * Yields raw PCM chunks (24kHz, 16-bit, mono) as Buffers.
 *
 * NOTE: For the "local" provider, use `speakLocal()` instead – the `say`
 * command plays audio directly through the system speaker, so PCM streaming
 * is not applicable.
 */
export async function* synthesizeStream(
  text: string,
  provider: SpeechProvider = "local",
  options?: TtsOptions,
): AsyncGenerator<Buffer, void, undefined> {
  switch (provider) {
    case "local":
      // say plays directly – yield nothing; callers should use speakLocal()
      throw new Error(
        "Local TTS does not support PCM streaming. Use speakLocal() instead.",
      );
    case "openai":
    case "gemma":
      // Gemma uses an OpenAI-compatible endpoint in this setup.
      yield* synthesizeStreamOpenAI(text, options);
      break;
    case "elevenlabs":
      yield* synthesizeStreamElevenLabs(text, options);
      break;
    case "gemini":
    default:
      yield* synthesizeStreamGemini(text, options);
      break;
  }
}
