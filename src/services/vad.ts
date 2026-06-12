/**
 * Voice Activity Detection (VAD) for raw 16-bit signed mono PCM at 16kHz.
 *
 * Uses an energy-based approach with exponential moving average to detect
 * speech boundaries. When a silence pause follows speech, the accumulated
 * utterance is emitted via `onUtteranceReady`.
 *
 * Designed for progressive STT: detect pauses mid-recording, transcribe
 * each utterance immediately while recording continues.
 */

import logger from "./logger.js";

// ── Types ─────────────────────────────────────────────────────────────

export interface VadConfig {
  /**
   * Minimum silence duration (ms) to mark end of speech.
   * Default: 800ms — catches natural pauses without being too aggressive.
   */
  silenceThresholdMs?: number;
  /**
   * Baseline minimum RMS threshold above which audio is considered speech.
   * Normalized [0, 1] from 16-bit PCM.
   * Default: 0.03 — roughly -30 dBFS, filters background noise.
   */
  speechThreshold?: number;
  /**
   * Exponential moving average smoothing factor (0–1).
   * Lower values smooth more, reducing false triggers.
   * Default: 0.3.
   */
  smoothing?: number;
  /**
   * Maximum speech duration (ms) before triggering an utterance even without a pause.
   * Prevents long continuous speech from blocking progressive transcription.
   * Default: 3000ms (3 seconds).
   */
  maxSpeechDurationMs?: number;
  /**
   * Enable adaptive thresholding based on measured background level.
   * Default: true.
   */
  autoGain?: boolean;
  /**
   * Noise floor EMA smoothing for adaptive threshold.
   * Default: 0.05.
   */
  noiseFloorSmoothing?: number;
  /**
   * Multiplier applied to measured noise floor to derive dynamic threshold.
   * Default: 2.5.
   */
  gainFactor?: number;
  /** Minimum adaptive threshold clamp. Default: 0.001 */
  minSpeechThreshold?: number;
  /** Maximum adaptive threshold clamp. Default: 0.08 */
  maxSpeechThreshold?: number;
}

export interface VadCallbacks {
  /** Fired when a speech segment ends (silence detected). Contains the utterance as a Buffer. */
  onUtteranceReady: (utterance: Buffer) => void;
  /** Fired when speech begins. */
  onSpeechStart?: () => void;
  /** Fired when speech ends. */
  onSpeechEnd?: () => void;
}

// ── Processor ─────────────────────────────────────────────────────────

export class VadProcessor {
  private config: Required<VadConfig>;
  private callbacks: VadCallbacks;
  private smoothedLevel = 0;
  private noiseFloor = 0.001;
  private isSpeech = false;
  private speechStartTime = 0;
  private silenceStartTime = 0;
  private buffer: Buffer[] = [];
  private sampleCount = 0;
  /** Sample rate for time calculations. */
  private sampleRate = 16000;
  /** Last timestamp (ms) we emitted periodic telemetry. */
  private lastTelemetryMs = 0;

  constructor(config: VadConfig = {}, callbacks: VadCallbacks) {
    this.config = {
      silenceThresholdMs: config.silenceThresholdMs ?? 800,
      speechThreshold: config.speechThreshold ?? 0.03,
      smoothing: config.smoothing ?? 0.3,
      maxSpeechDurationMs: config.maxSpeechDurationMs ?? 3000,
      autoGain: config.autoGain ?? true,
      noiseFloorSmoothing: config.noiseFloorSmoothing ?? 0.05,
      gainFactor: config.gainFactor ?? 2.5,
      minSpeechThreshold: config.minSpeechThreshold ?? 0.001,
      maxSpeechThreshold: config.maxSpeechThreshold ?? 0.08,
    };
    this.callbacks = callbacks;
  }

  private getEffectiveThreshold(): number {
    if (!this.config.autoGain) return this.config.speechThreshold;

    const dynamic = this.noiseFloor * this.config.gainFactor;
    const candidate = Math.max(this.config.speechThreshold, dynamic);
    return Math.max(this.config.minSpeechThreshold, Math.min(this.config.maxSpeechThreshold, candidate));
  }

  /** Feed a PCM chunk (16-bit signed LE mono) through the detector. */
  processChunk(chunk: Buffer): void {
    const sampleCount = Math.floor(chunk.length / 2);
    if (sampleCount === 0) return;

    // Compute RMS of this chunk
    let rms = 0;
    for (let i = 0; i < sampleCount; i++) {
      const sample = chunk.readInt16LE(i * 2) / 32768;
      rms += sample * sample;
    }
    rms = Math.sqrt(rms / sampleCount);

    // Exponential moving average on signal level
    this.smoothedLevel = this.config.smoothing * rms + (1 - this.config.smoothing) * this.smoothedLevel;

    const now = (this.sampleCount / this.sampleRate) * 1000; // approximate ms

    // Learn ambient level while not in active speech.
    if (!this.isSpeech) {
      this.noiseFloor =
        this.config.noiseFloorSmoothing * this.smoothedLevel +
        (1 - this.config.noiseFloorSmoothing) * this.noiseFloor;
    }

    const threshold = this.getEffectiveThreshold();

    // Periodic telemetry so we can see whether levels ever cross threshold.
    if (now - this.lastTelemetryMs >= 1000) {
      this.lastTelemetryMs = now;
      logger.info(
        {
          nowMs: Math.round(now),
          rms: Number(rms.toFixed(4)),
          smoothed: Number(this.smoothedLevel.toFixed(4)),
          noiseFloor: Number(this.noiseFloor.toFixed(4)),
          threshold: Number(threshold.toFixed(4)),
          autoGain: this.config.autoGain,
          isSpeech: this.isSpeech,
          silenceMs: this.silenceStartTime ? Math.max(0, Math.round(now - this.silenceStartTime)) : 0,
        },
        "VAD level sample",
      );
    }

    if (!this.isSpeech) {
      // Silence → speech transition
      if (this.smoothedLevel >= threshold) {
        this.isSpeech = true;
        this.speechStartTime = now;
        // Start buffer with the triggering chunk so initial speech isn't dropped.
        this.buffer = [chunk];
        logger.info(
          {
            nowMs: Math.round(now),
            rms: Number(rms.toFixed(4)),
            smoothed: Number(this.smoothedLevel.toFixed(4)),
            threshold: Number(threshold.toFixed(4)),
            noiseFloor: Number(this.noiseFloor.toFixed(4)),
          },
          "VAD speech started",
        );
        this.callbacks.onSpeechStart?.();
      }
      this.sampleCount += sampleCount;
      return;
    }

    // In speech
    this.buffer.push(chunk);
    this.sampleCount += sampleCount;

    // Time-based fallback: if speech has been going for too long without a pause,
    // fire the utterance anyway so the user gets progressive results.
    const speechDuration = now - this.speechStartTime;
    if (speechDuration >= this.config.maxSpeechDurationMs && this.buffer.length > 0) {
      const utterance = Buffer.concat(this.buffer);
      this.buffer = [];
      // Reset speech timer — start fresh for the next segment
      this.speechStartTime = now;
      logger.info(
        {
          nowMs: Math.round(now),
          speechDurationMs: Math.round(speechDuration),
          utteranceBytes: utterance.length,
        },
        "VAD max-duration utterance emitted",
      );
      this.callbacks.onSpeechEnd?.();
      this.callbacks.onUtteranceReady(utterance);
      // Stay in speech mode — continue collecting
      return;
    }

    if (this.smoothedLevel < threshold) {
      // Speech → silence transition
      if (!this.silenceStartTime) {
        this.silenceStartTime = now;
        logger.info(
          {
            nowMs: Math.round(now),
            smoothed: Number(this.smoothedLevel.toFixed(4)),
            threshold: Number(threshold.toFixed(4)),
          },
          "VAD silence started",
        );
      }

      if (now - this.silenceStartTime >= this.config.silenceThresholdMs) {
        // Long enough silence — fire utterance
        const utterance = Buffer.concat(this.buffer);
        const silenceMs = now - this.silenceStartTime;
        this.buffer = [];
        this.isSpeech = false;
        this.silenceStartTime = 0;
        logger.info(
          {
            nowMs: Math.round(now),
            silenceMs: Math.round(silenceMs),
            utteranceBytes: utterance.length,
          },
          "VAD silence utterance emitted",
        );
        this.callbacks.onSpeechEnd?.();
        this.callbacks.onUtteranceReady(utterance);
      }
    } else {
      // Still speech, reset silence timer
      this.silenceStartTime = 0;
    }
  }

  /**
   * Flush any remaining buffered audio.
   * Called when recording stops to catch speech that ended without a trailing pause.
   * Returns the flushed buffer if speech was active, null otherwise.
   */
  flush(): Buffer | null {
    if (this.buffer.length > 0) {
      const utterance = Buffer.concat(this.buffer);
      this.buffer = [];
      this.isSpeech = false;
      this.silenceStartTime = 0;
      return utterance;
    }
    return null;
  }

  reset(): void {
    this.smoothedLevel = 0;
    this.noiseFloor = this.config.minSpeechThreshold;
    this.isSpeech = false;
    this.speechStartTime = 0;
    this.silenceStartTime = 0;
    this.buffer = [];
    this.sampleCount = 0;
    this.lastTelemetryMs = 0;
  }
}
