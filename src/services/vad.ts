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

// ── Types ─────────────────────────────────────────────────────────────

export interface VadConfig {
  /**
   * Minimum silence duration (ms) to mark end of speech.
   * Default: 800ms — catches natural pauses without being too aggressive.
   */
  silenceThresholdMs?: number;
  /**
   * RMS energy threshold above which audio is considered speech.
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
  private isSpeech = false;
  private speechStartTime = 0;
  private silenceStartTime = 0;
  private buffer: Buffer[] = [];
  private sampleCount = 0;
  /** Sample rate for time calculations. */
  private sampleRate = 16000;

  constructor(config: VadConfig = {}, callbacks: VadCallbacks) {
    this.config = {
      silenceThresholdMs: config.silenceThresholdMs ?? 800,
      speechThreshold: config.speechThreshold ?? 0.03,
      smoothing: config.smoothing ?? 0.3,
    };
    this.callbacks = callbacks;
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

    // Exponential moving average
    this.smoothedLevel = this.config.smoothing * rms + (1 - this.config.smoothing) * this.smoothedLevel;

    const now = this.sampleCount / this.sampleRate * 1000; // approximate ms

    if (!this.isSpeech) {
      // Silence → speech transition
      if (this.smoothedLevel >= this.config.speechThreshold) {
        this.isSpeech = true;
        this.speechStartTime = now;
        this.buffer = [];
        this.sampleCount = 0;
        this.callbacks.onSpeechStart?.();
      }
      this.sampleCount += sampleCount;
      return;
    }

    // In speech
    this.buffer.push(chunk);
    this.sampleCount += sampleCount;

    if (this.smoothedLevel < this.config.speechThreshold) {
      // Speech → silence transition
      if (!this.silenceStartTime) {
        this.silenceStartTime = now;
      }

      if (now - this.silenceStartTime >= this.config.silenceThresholdMs) {
        // Long enough silence — fire utterance
        const utterance = Buffer.concat(this.buffer);
        this.buffer = [];
        this.isSpeech = false;
        this.silenceStartTime = 0;
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
   * Called when recording stops to catch speech that ends without a trailing pause.
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
    this.isSpeech = false;
    this.speechStartTime = 0;
    this.silenceStartTime = 0;
    this.buffer = [];
    this.sampleCount = 0;
  }
}
