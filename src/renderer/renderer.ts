/**
 * Audio worker running in a hidden BrowserWindow.
 * Handles microphone recording (MediaRecorder or raw PCM) and PCM streaming playback (Web Audio API).
 * No UI rendering – all visual elements have been removed.
 */

/// <reference path="../shared/types.ts" />

import toggleOnUrl from "../assets/toggle_on.wav?url";
import toggleOffUrl from "../assets/toggle_off.wav?url";
import { downsample } from "../shared/audio-utils.js";

let mediaRecorder: MediaRecorder | null = null;
let audioChunks: Blob[] = [];
let audioContext: AudioContext | null = null;
let recordingChunkTimerId: number | null = null;
let recordingRequested = false;
let recordingStartToken = 0;

const DEFAULT_CHUNK_ROLLOVER_MS = 30_000;
const DEFAULT_ROLLOVER_CLICK_GAIN = 0.005;
const MIN_SEND_AUDIO_SECONDS = 1.0;
const SILENCE_RMS_THRESHOLD = 0.003;

// ── PCM recording state ──────────────────────────────────────────────
let pcmStream: MediaStream | null = null;
let pcmSourceNode: MediaStreamAudioSourceNode | null = null;
let pcmProcessorNode: ScriptProcessorNode | null = null;
let pcmChunks: Float32Array[] = [];
let pcmRecording = false;
let chunkRolloverMs = DEFAULT_CHUNK_ROLLOVER_MS;
let rolloverClickGain = DEFAULT_ROLLOVER_CLICK_GAIN;

/** Target sample rate for Whisper */
const WHISPER_SAMPLE_RATE = 16000;

function playSoundEffect(url: string) {
  const ctx = audioContext ?? new AudioContext();
  if (!audioContext) audioContext = ctx;

  fetch(url)
    .then((res) => res.arrayBuffer())
    .then((buf) => ctx.decodeAudioData(buf))
    .then((decoded) => {
      const source = ctx.createBufferSource();
      source.buffer = decoded;
      const gain = ctx.createGain();
      gain.gain.value = 0.12;
      source.connect(gain);
      gain.connect(ctx.destination);
      source.start();
    })
    .catch((err) => {
      console.error("Failed to play sound effect:", err);
    });
}

function playCrossoverClick() {
  const ctx = audioContext ?? new AudioContext();
  if (!audioContext) audioContext = ctx;

  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = "sine";
  osc.frequency.setValueAtTime(1400, now);

  // Keep crossover click subtle so it doesn't distract speech capture.
  gain.gain.setValueAtTime(0.0, now);
  gain.gain.linearRampToValueAtTime(rolloverClickGain, now + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.03);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(now);
  osc.stop(now + 0.03);
}

// ── WebM recording (for cloud providers) ─────────────────────────────

function startWebmRecording(stream: MediaStream) {
  audioChunks = [];

  mediaRecorder = new MediaRecorder(stream, {
    mimeType: "audio/webm;codecs=opus",
  });

  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      audioChunks.push(event.data);
    }
  };

  mediaRecorder.onstop = async () => {
    stream.getTracks().forEach((track) => track.stop());

    if (audioChunks.length === 0) {
      window.piVoice.sendRecordingError("No audio data captured");
      return;
    }

    const blob = new Blob(audioChunks, { type: "audio/webm" });
    const arrayBuffer = await blob.arrayBuffer();
    window.piVoice.sendRecordingData(arrayBuffer);
  };

  mediaRecorder.start(100);
}

async function flushWebmChunk() {
  if (audioChunks.length === 0) return;

  const chunkBlob = new Blob(audioChunks, { type: "audio/webm" });
  audioChunks = [];

  if (chunkBlob.size === 0) return;
  const arrayBuffer = await chunkBlob.arrayBuffer();
  window.piVoice.sendRecordingData(arrayBuffer);
}

function stopWebmRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
}

// ── Raw PCM recording (for local Whisper) ────────────────────────────

function startPcmRecording(stream: MediaStream) {
  const ctx = audioContext ?? new AudioContext();
  if (!audioContext) audioContext = ctx;

  pcmStream = stream;
  pcmChunks = [];
  pcmRecording = true;

  pcmSourceNode = ctx.createMediaStreamSource(stream);

  // Buffer size 4096 is a good balance between latency and performance
  pcmProcessorNode = ctx.createScriptProcessor(4096, 1, 1);
  pcmProcessorNode.onaudioprocess = (event) => {
    if (!pcmRecording) return;
    // Copy the channel data (it gets reused by the browser)
    const input = event.inputBuffer.getChannelData(0);
    pcmChunks.push(new Float32Array(input));
  };

  pcmSourceNode.connect(pcmProcessorNode);
  // ScriptProcessorNode requires connection to destination to fire events
  pcmProcessorNode.connect(ctx.destination);
}

function flushPcmChunk() {
  if (pcmChunks.length === 0) {
    return false;
  }

  // Concatenate all chunks
  const totalLength = pcmChunks.reduce((sum, c) => sum + c.length, 0);
  const fullBuffer = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of pcmChunks) {
    fullBuffer.set(chunk, offset);
    offset += chunk.length;
  }

  // Downsample from AudioContext.sampleRate (typically 48kHz) to 16kHz
  const sourceSampleRate = audioContext?.sampleRate ?? 48000;
  const resampled = downsample(fullBuffer, sourceSampleRate, WHISPER_SAMPLE_RATE);

  const durationSec = resampled.length / WHISPER_SAMPLE_RATE;
  if (durationSec < MIN_SEND_AUDIO_SECONDS) {
    pcmChunks = [];
    return false;
  }

  let sumSquares = 0;
  for (let i = 0; i < resampled.length; i++) {
    const s = resampled[i]!;
    sumSquares += s * s;
  }
  const rms = Math.sqrt(sumSquares / resampled.length);
  if (rms < SILENCE_RMS_THRESHOLD) {
    pcmChunks = [];
    return false;
  }

  // Send as ArrayBuffer (Float32)
  window.piVoice.sendRecordingData(resampled.buffer as ArrayBuffer);
  pcmChunks = [];
  return true;
}

function stopPcmRecording() {
  if (!pcmRecording && !pcmProcessorNode && !pcmStream) {
    return;
  }

  pcmRecording = false;

  pcmProcessorNode?.disconnect();
  pcmSourceNode?.disconnect();
  pcmStream?.getTracks().forEach((track) => track.stop());

  if (pcmChunks.length === 0) {
    window.piVoice.sendRecordingError("No audio data captured");
    pcmProcessorNode = null;
    pcmSourceNode = null;
    pcmStream = null;
    return;
  }

  flushPcmChunk();

  pcmChunks = [];
  pcmProcessorNode = null;
  pcmSourceNode = null;
  pcmStream = null;
}

function clearRecordingChunkTimer() {
  if (recordingChunkTimerId !== null) {
    clearTimeout(recordingChunkTimerId);
    recordingChunkTimerId = null;
  }
}

function isRecordingActive(): boolean {
  if (currentRecordingFormat === "pcm") {
    return pcmRecording;
  }
  return !!mediaRecorder && mediaRecorder.state !== "inactive";
}

function rolloverCurrentRecordingChunk() {
  if (!isRecordingActive()) return;

  playCrossoverClick();

  if (currentRecordingFormat === "pcm") {
    flushPcmChunk();
  } else {
    void flushWebmChunk();
  }
}

function scheduleRecordingChunkRollover() {
  clearRecordingChunkTimer();
  recordingChunkTimerId = window.setTimeout(() => {
    rolloverCurrentRecordingChunk();
    scheduleRecordingChunkRollover();
  }, chunkRolloverMs);
}

function stopCurrentRecording(playToggleSound: boolean) {
  clearRecordingChunkTimer();

  if (playToggleSound) {
    playSoundEffect(toggleOffUrl);
  }

  if (currentRecordingFormat === "pcm") {
    stopPcmRecording();
  } else {
    stopWebmRecording();
  }
}

// ── Recording control from main ──────────────────────────────────────

let currentRecordingFormat: "webm" | "pcm" = "webm";

window.piVoice.onStartRecording(async (format) => {
  recordingRequested = true;
  const startToken = ++recordingStartToken;

  playSoundEffect(toggleOnUrl);
  currentRecordingFormat = format.format;
  chunkRolloverMs = format.chunkRolloverMs;
  rolloverClickGain = format.rolloverClickGain;
  clearRecordingChunkTimer();
  scheduleRecordingChunkRollover();

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // If key-up happened while waiting for mic permission/device startup,
    // abort this start to avoid leaving the mic active.
    if (!recordingRequested || startToken !== recordingStartToken) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    if (format.format === "pcm") {
      startPcmRecording(stream);
    } else {
      startWebmRecording(stream);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    window.piVoice.sendRecordingError(`Microphone access failed: ${msg}`);
  }
});

window.piVoice.onStopRecording(() => {
  recordingRequested = false;
  // Invalidate any in-flight start operation waiting on getUserMedia.
  recordingStartToken++;
  stopCurrentRecording(true);
});

// ── Streaming PCM playback ──────────────────────────────────────────
let streamSampleRate = 24000;
let streamChannels = 1;
let streamBitsPerSample = 16;
let streamNextPlayTime = 0;
let streamActiveSources = 0;
let streamEnded = false;

function stopStreamPlayback() {
  streamActiveSources = 0;
  streamEnded = false;
  streamNextPlayTime = 0;
}

window.piVoice.onPlayAudioStreamStart((meta) => {
  try {
    if (!audioContext) {
      audioContext = new AudioContext();
    }

    // Reset streaming state
    stopStreamPlayback();
    streamSampleRate = meta.sampleRate;
    streamChannels = meta.channels;
    streamBitsPerSample = meta.bitsPerSample;
    streamNextPlayTime = 0;
    streamEnded = false;
  } catch (err) {
    console.error("Stream start error:", err);
  }
});

window.piVoice.onPlayAudioStreamChunk((pcmData) => {
  try {
    if (!audioContext) {
      audioContext = new AudioContext();
    }

    const raw = pcmData instanceof ArrayBuffer ? pcmData : new Uint8Array(pcmData as any).buffer;
    const bytesPerSample = streamBitsPerSample / 8;
    const sampleCount = raw.byteLength / bytesPerSample / streamChannels;

    if (sampleCount <= 0) return;

    // Create an AudioBuffer from raw PCM (16-bit signed LE)
    const audioBuffer = audioContext.createBuffer(
      streamChannels,
      sampleCount,
      streamSampleRate
    );

    const view = new DataView(raw);
    for (let ch = 0; ch < streamChannels; ch++) {
      const channelData = audioBuffer.getChannelData(ch);
      for (let i = 0; i < sampleCount; i++) {
        const byteOffset = (i * streamChannels + ch) * bytesPerSample;
        const int16 = view.getInt16(byteOffset, true); // little-endian
        channelData[i] = int16 / 32768;
      }
    }

    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContext.destination);

    // Schedule playback at the end of the current queue
    const now = audioContext.currentTime;
    if (streamNextPlayTime < now) {
      streamNextPlayTime = now;
    }

    source.start(streamNextPlayTime);
    streamNextPlayTime += audioBuffer.duration;

    streamActiveSources++;
    source.onended = () => {
      streamActiveSources--;
      if (streamEnded && streamActiveSources <= 0) {
        window.piVoice.sendPlaybackDone();
      }
    };
  } catch (err) {
    console.error("Stream chunk playback error:", err);
  }
});

window.piVoice.onPlayAudioStreamEnd(() => {
  streamEnded = true;
  // If all sources already finished (or no chunks received), signal done now
  if (streamActiveSources <= 0) {
    window.piVoice.sendPlaybackDone();
  }
});
