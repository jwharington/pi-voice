import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";

// Mock logger
mock.module("../../services/logger.js", () => ({
  default: {
    info: () => { },
    warn: () => { },
    error: () => { },
    debug: () => { },
  },
}));

// Mock GoogleGenAI (used by real gemini-client)
const mockGenerateContent = mock(async () => ({
  text: "gemini transcription",
}));
mock.module("@google/genai", () => ({
  GoogleGenAI: class {
    models = {
      generateContent: mockGenerateContent,
    };
  },
}));

// Mock OpenAI
const mockOpenAITranscription = mock(async () => ({
  text: "openai transcription",
}));
const mockOpenAIToFile = mock(async (buf: any, name: string) => ({ name, data: buf }));
mock.module("openai", () => {
  return {
    default: class OpenAI {
      audio = {
        transcriptions: {
          create: mockOpenAITranscription,
        },
      };
    },
    toFile: mockOpenAIToFile,
  };
});

// Mock ElevenLabs
const mockElevenLabsSTT = mock(async () => ({
  text: "elevenlabs transcription",
}));
mock.module("@elevenlabs/elevenlabs-js", () => ({
  ElevenLabsClient: class {
    speechToText = {
      convert: mockElevenLabsSTT,
    };
  },
}));

// Mock Whisper
const mockWhisperFull = mock(async () => "whisper transcription");
mock.module("@napi-rs/whisper", () => ({
  Whisper: class {
    full = mockWhisperFull;
  },
  WhisperFullParams: class {
    language = "auto";
    printProgress = false;
    printRealtime = false;
    printTimestamps = false;
    singleSegment = false;
    noTimestamps = true;
  },
  WhisperSamplingStrategy: { Greedy: 0 },
}));

const { transcribe } = await import("../../services/stt.js");

describe("transcribe", () => {
  let savedEnv: Record<string, string | undefined>;
  let testWhisperModelPath: string;

  beforeEach(() => {
    savedEnv = {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      OPENAI_STT_MODEL: process.env.OPENAI_STT_MODEL,
      OPENAI_STT_RESPONSE_FORMAT: process.env.OPENAI_STT_RESPONSE_FORMAT,
      OPENAI_STT_PROMPT: process.env.OPENAI_STT_PROMPT,
      OPENAI_STT_LANGUAGE: process.env.OPENAI_STT_LANGUAGE,
      OPENAI_STT_TEMPERATURE: process.env.OPENAI_STT_TEMPERATURE,
      ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      WHISPER_MODEL_PATH: process.env.WHISPER_MODEL_PATH,
    };
    process.env.OPENAI_API_KEY = "test-openai-key";
    delete process.env.OPENAI_STT_MODEL;
    delete process.env.OPENAI_STT_RESPONSE_FORMAT;
    delete process.env.OPENAI_STT_PROMPT;
    delete process.env.OPENAI_STT_LANGUAGE;
    delete process.env.OPENAI_STT_TEMPERATURE;
    process.env.ELEVENLABS_API_KEY = "test-elevenlabs-key";
    process.env.GEMINI_API_KEY = "test-gemini-key";
    const testDir = join(
      tmpdir(),
      `pi-voice-stt-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
    testWhisperModelPath = join(testDir, "fake-model.bin");
    writeFileSync(testWhisperModelPath, "fake-model");
    process.env.WHISPER_MODEL_PATH = testWhisperModelPath;

    mockGenerateContent.mockClear();
    mockOpenAITranscription.mockClear();
    mockOpenAIToFile.mockClear();
    mockElevenLabsSTT.mockClear();
    mockWhisperFull.mockClear();
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }

    rmSync(testWhisperModelPath, { force: true });
    rmSync(dirname(testWhisperModelPath), { recursive: true, force: true });
  });

  test("transcribes with gemini provider", async () => {
    const data = new ArrayBuffer(100);
    const result = await transcribe(data, "gemini");
    expect(result).toBe("gemini transcription");
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
  });

  test("transcribes with openai provider", async () => {
    const samples = new Float32Array([0, 0.1, -0.1, 0.2, -0.2]);
    const result = await transcribe(samples.buffer as ArrayBuffer, "openai");
    expect(result).toBe("openai transcription");
    expect(mockOpenAITranscription).toHaveBeenCalledTimes(1);

    const req = (mockOpenAITranscription.mock.calls as any[])[0]?.[0];
    expect(req.model).toBe("whisper-1");
    expect(req.response_format).toBe("json");
    expect(mockOpenAIToFile).toHaveBeenCalledTimes(1);
    const toFileCall = (mockOpenAIToFile.mock.calls as any[])[0];
    expect(toFileCall?.[1]).toBe("recording.wav");
  });

  test("openai provider supports transcription request env overrides", async () => {
    process.env.OPENAI_STT_MODEL = "gpt-4o-mini-transcribe";
    process.env.OPENAI_STT_RESPONSE_FORMAT = "verbose_json";
    process.env.OPENAI_STT_PROMPT = "Only output the transcription.";
    process.env.OPENAI_STT_LANGUAGE = "en";
    process.env.OPENAI_STT_TEMPERATURE = "0";

    const samples = new Float32Array([0.05, 0.01, -0.02]);
    await transcribe(samples.buffer as ArrayBuffer, "openai");

    const req = (mockOpenAITranscription.mock.calls as any[])[0]?.[0];
    expect(req.model).toBe("gpt-4o-mini-transcribe");
    expect(req.response_format).toBe("verbose_json");
    expect(req.prompt).toBe("Only output the transcription.");
    expect(req.language).toBe("en");
    expect(req.temperature).toBe(0);
  });

  test("openai provider strips reasoning wrapper text", async () => {
    mockOpenAITranscription.mockImplementationOnce(async () => ({
      text: `<|channel>thought\nThinking Process:\n1. Analyze.\n2. Transcribe.\n<channel|>This is a test`,
    }));

    const samples = new Float32Array([0.05, 0.01, -0.02]);
    const result = await transcribe(samples.buffer as ArrayBuffer, "openai");

    expect(result).toBe("This is a test");
  });

  test("transcribes with elevenlabs provider", async () => {
    const data = new ArrayBuffer(100);
    const result = await transcribe(data, "elevenlabs");
    expect(result).toBe("elevenlabs transcription");
    expect(mockElevenLabsSTT).toHaveBeenCalledTimes(1);
  });

  test("transcribes with local provider", async () => {
    // local expects Float32Array PCM data
    const samples = new Float32Array([0.1, 0.2, 0.3]);
    const result = await transcribe(samples.buffer as ArrayBuffer, "local");
    expect(result).toBe("whisper transcription");
    expect(mockWhisperFull).toHaveBeenCalledTimes(1);
  });

  test("defaults to local provider when not specified", async () => {
    const samples = new Float32Array([0.1, 0.2]);
    // The function signature defaults to "local"
    const result = await transcribe(samples.buffer as ArrayBuffer);
    expect(result).toBe("whisper transcription");
  });

  test("gemini provider sends base64 audio data", async () => {
    const data = new Uint8Array([1, 2, 3]).buffer;
    await transcribe(data, "gemini");

    const calls = mockGenerateContent.mock.calls as any[];
    const content = calls[0]![0].contents[0].parts;
    // Should have inlineData and text parts
    expect(content.length).toBe(2);
    expect(content[0].inlineData.mimeType).toBe("audio/wav");
    expect(typeof content[0].inlineData.data).toBe("string"); // base64
  });

  test("returns empty string from gemini when text is null", async () => {
    mockGenerateContent.mockImplementation(async () => ({
      text: null as any,
    }));

    const data = new ArrayBuffer(10);
    const result = await transcribe(data, "gemini");
    expect(result).toBe("");

    // Restore
    mockGenerateContent.mockImplementation(async () => ({
      text: "gemini transcription",
    }));
  });

  test("trims whitespace from transcription", async () => {
    mockGenerateContent.mockImplementation(async () => ({
      text: "  hello world  ",
    }));

    const data = new ArrayBuffer(10);
    const result = await transcribe(data, "gemini");
    expect(result).toBe("hello world");

    // Restore
    mockGenerateContent.mockImplementation(async () => ({
      text: "gemini transcription",
    }));
  });
});
