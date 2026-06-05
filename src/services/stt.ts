import OpenAI, { toFile } from "openai";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import type { SpeechProvider } from "./config.js";
import { getGeminiClient } from "./gemini-client.js";
import logger from "./logger.js";

// ── OpenAI client cache (keyed by base URL) ──────────────────────────

const openAiClients = new Map<string, OpenAI>();

function resolveBaseUrl(configValue?: string): string | undefined {
  // Priority: config field → provider-specific env → shared env
  if (configValue) return configValue;
  return process.env.OPENAI_BASE_URL;
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
  const key = baseUrl ?? "__default__";
  if (openAiClients.has(key)) return openAiClients.get(key)!;

  const apiKey = resolveApiKey(baseUrl);
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY environment variable is required");
  }

  const clientOptions: { apiKey: string; baseURL?: string } = { apiKey };
  if (baseUrl) clientOptions.baseURL = baseUrl;

  const client = new OpenAI(clientOptions);
  openAiClients.set(key, client);
  return client;
}

// ── Local (Whisper) client ───────────────────────────────────────────
// @napi-rs/whisper uses a native binding that must NOT be imported at
// module load time because Electron runs a different Node ABI than the
// host. We lazy-load it here so it is only resolved when the "local"
// provider is actually invoked.

import { resolveModelPath } from "./whisper-model.js";

let whisperInstance: unknown | null = null;
let whisperInitPromise: Promise<unknown> | null = null;

async function getWhisperInstance(): Promise<unknown> {
  if (whisperInstance) return whisperInstance;
  if (whisperInitPromise) return whisperInitPromise;

  whisperInitPromise = (async () => {
    const { Whisper, WhisperFullParams, WhisperSamplingStrategy } =
      await import("@napi-rs/whisper");
    const modelPath = await resolveModelPath();
    logger.info({ modelPath }, "Loading Whisper model");
    const instance = new Whisper(modelPath);
    logger.info("Whisper model loaded");
    whisperInstance = { instance, WhisperFullParams, WhisperSamplingStrategy };
    return whisperInstance;
  })();

  return whisperInitPromise;
}

// ── Gemini STT ───────────────────────────────────────────────────────

async function transcribeGemini(audioBuffer: Buffer): Promise<string> {
  const client = getGeminiClient();
  const base64Audio = audioBuffer.toString("base64");

  const response = await client.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          {
            inlineData: {
              mimeType: "audio/wav",
              data: base64Audio,
            },
          },
          {
            text: "Transcribe this audio exactly as spoken. Output only the transcription, nothing else. If the audio is in Japanese, output in Japanese. If the audio is silent or empty, output an empty string.",
          },
        ],
      },
    ],
  });

  return response.text?.trim() ?? "";
}

// ── OpenAI STT ───────────────────────────────────────────────────────

const DEFAULT_OPENAI_STT_MODEL = "whisper-1";

function sanitizeTranscriptionText(raw: string): string {
  let text = raw.trim();

  // Some OpenAI-compatible local models may return internal reasoning wrappers
  // instead of plain transcript text. Keep only the user-facing transcript.
  const hasReasoningMarkers =
    /<\|channel\>thought/i.test(text) || /thinking process:/i.test(text);

  if (hasReasoningMarkers) {
    const lastChannelTag = text.lastIndexOf("<channel|>");
    if (lastChannelTag >= 0) {
      text = text.slice(lastChannelTag + "<channel|>".length);
    }

    text = text
      .replace(/<\|channel\>thought[\s\S]*?<channel\|>/gi, "")
      .replace(/<\|?channel\|?>/gi, "");

    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length > 1) {
      text = lines[lines.length - 1]!;
    }
  }

  return text.replace(/\s+/g, " ").trim();
}

function pcmFloat32ToWav(samples: Float32Array, sampleRate = 16000): Buffer {
  const channels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const dataSize = samples.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF header
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);

  // fmt chunk
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // PCM fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  // data chunk
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  // PCM samples (Float32 [-1,1] -> Int16 LE)
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    const v = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
    buffer.writeInt16LE(v, offset);
    offset += 2;
  }

  return buffer;
}

function getOpenAISttTemperature(): number | undefined {
  const raw = process.env.OPENAI_STT_TEMPERATURE;
  if (raw === undefined || raw.trim() === "") return undefined;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    logger.warn(
      { value: raw },
      "Ignoring invalid OPENAI_STT_TEMPERATURE: expected a number",
    );
    return undefined;
  }

  return parsed;
}

interface SttOptions {
  sttModel?: string;
  sttBaseUrl?: string;
}

async function transcribeOpenAI(
  samples: Float32Array,
  options?: SttOptions,
): Promise<string> {
  const baseUrl = resolveBaseUrl(options?.sttBaseUrl);
  const client = getOpenAIClient(baseUrl);

  const wavBuffer = pcmFloat32ToWav(samples);
  const file = await toFile(wavBuffer, "recording.wav");

  const model = options?.sttModel ?? process.env.OPENAI_STT_MODEL ?? DEFAULT_OPENAI_STT_MODEL;
  const language = process.env.OPENAI_STT_LANGUAGE;
  const prompt = process.env.OPENAI_STT_PROMPT;
  const temperature = getOpenAISttTemperature();
  const responseFormat = (process.env.OPENAI_STT_RESPONSE_FORMAT ?? "json") as
    | "json"
    | "text"
    | "srt"
    | "verbose_json"
    | "vtt";

  const transcription = await client.audio.transcriptions.create({
    model,
    file,
    response_format: responseFormat,
    ...(language ? { language } : {}),
    ...(prompt ? { prompt } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
  });

  return sanitizeTranscriptionText(transcription.text ?? "");
}

// ── ElevenLabs STT ───────────────────────────────────────────────────

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

async function transcribeElevenLabs(audioBuffer: Buffer): Promise<string> {
  const client = getElevenLabsClient();

  const result = await client.speechToText.convert({
    file: {
      data: audioBuffer,
      filename: "recording.wav",
      contentType: "audio/wav",
    },
    modelId: "scribe_v2",
  });

  // Response is a union type; SpeechToTextChunkResponseModel has .text
  if ("text" in result) {
    return (result.text ?? "").trim();
  }
  // MultichannelSpeechToTextResponseModel has .transcripts
  if ("transcripts" in result && result.transcripts?.[0]) {
    return (result.transcripts[0].text ?? "").trim();
  }
  return "";
}

// ── Local STT (Whisper) ──────────────────────────────────────────────

/**
 * Transcribe raw 16kHz mono Float32 PCM samples using Whisper.
 */
async function transcribeLocal(samples: Float32Array): Promise<string> {
  const { instance, WhisperFullParams, WhisperSamplingStrategy } =
    (await getWhisperInstance()) as Awaited<ReturnType<typeof getWhisperInstance>> & {
      instance: { full: (params: unknown, samples: Float32Array) => Promise<string> };
      WhisperFullParams: new (strategy: unknown) => {
        language: string;
        printProgress: boolean;
        printRealtime: boolean;
        printTimestamps: boolean;
        singleSegment: boolean;
        noTimestamps: boolean;
      };
      WhisperSamplingStrategy: { Greedy: unknown };
    };

  const params = new WhisperFullParams(WhisperSamplingStrategy.Greedy);
  params.language = "auto";
  params.printProgress = false;
  params.printRealtime = false;
  params.printTimestamps = false;
  params.singleSegment = false;
  params.noTimestamps = true;

  return instance.full(params, samples);
}

// ── WAV utilities ────────────────────────────────────────────────────

/**
 * Convert a raw 16kHz 16-bit signed little-endian mono PCM buffer to
 * a Float32Array in the range [-1, 1] suitable for Whisper / OpenAI.
 */
function pcmInt16ToFloat32(pcm: Buffer): Float32Array {
  const samples = new Float32Array(pcm.length / 2);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = pcm.readInt16LE(i * 2) / 32768.0;
  }
  return samples;
}

/**
 * Wrap a raw PCM buffer in a WAV container.
 * Assumes 16kHz, 16-bit, mono, little-endian signed integer PCM.
 */
export function pcmInt16ToWav(pcm: Buffer, sampleRate = 16000): Buffer {
  const channels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);               // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  header.writeUInt16LE(channels * bytesPerSample, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}

// ── Public API ───────────────────────────────────────────────────────

interface TranscribeOptions {
  sttModel?: string;
  sttBaseUrl?: string;
}

/**
 * Transcribe audio to text.
 *
 * `audioData` must be a raw 16kHz 16-bit signed little-endian mono PCM
 * buffer as produced by sox (`rec -r 16000 -e signed-integer -b 16 -c 1
 * -L -t raw`).
 *
 * The function converts internally to the format required by each provider:
 * - local / openai : Float32 samples
 * - gemini / elevenlabs : WAV container sent as audio/wav
 */
export async function transcribe(
  audioData: ArrayBuffer,
  provider: SpeechProvider = "local",
  options?: TranscribeOptions,
): Promise<string> {
  const pcm = Buffer.from(audioData);
  let text: string;

  switch (provider) {
    case "local": {
      const samples = pcmInt16ToFloat32(pcm);
      text = await transcribeLocal(samples);
      break;
    }
    case "openai": {
      const samples = pcmInt16ToFloat32(pcm);
      text = await transcribeOpenAI(samples, options);
      break;
    }
    case "elevenlabs":
      text = await transcribeElevenLabs(pcmInt16ToWav(pcm));
      break;
    case "gemini":
    default:
      text = await transcribeGemini(pcmInt16ToWav(pcm));
      break;
  }

  logger.info({ provider, text }, "Transcribed");
  return text;
}
