/**
 * In-process audio recording and PCM playback using sox.
 *
 * Recording: captures 16kHz 16-bit signed mono PCM from the default
 * microphone via `rec` (the sox recording front-end, available on both
 * macOS and Linux). The raw PCM buffer is suitable for passing directly
 * to `transcribe()`.
 *
 * Playback: pipes 24kHz 16-bit signed mono PCM to `sox` / `play` so
 * that cloud TTS output is played through the system's default speaker
 * without requiring Electron or a browser AudioContext.
 *
 * Requirements: sox must be installed (`brew install sox` / `apt install sox`).
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import logger from "./logger.js";

// ── Constants ─────────────────────────────────────────────────────────

/** Recording parameters – must match what STT providers expect. */
const REC_SAMPLE_RATE = 16000;
const REC_BITS = 16;
const REC_CHANNELS = 1;

/** TTS playback parameters – must match synthesizeStream output. */
export const PLAY_SAMPLE_RATE = 24000;
export const PLAY_BITS = 16;
export const PLAY_CHANNELS = 1;

// ── Recorder ──────────────────────────────────────────────────────────

/**
 * Toggle-based microphone recorder built on top of `rec` (sox).
 * Call `start()` to begin capturing, `stop()` to flush and return the buffer.
 *
 * The returned buffer is raw little-endian signed 16-bit mono PCM at
 * 16kHz – pass it directly to `transcribe()` as an `ArrayBuffer`.
 */
export class AudioRecorder {
    private proc: ChildProcessByStdio<null, Readable, Readable> | null = null;
    private chunks: Buffer[] = [];
    private onLevel: ((level: number) => void) | undefined;

    get isRecording(): boolean {
        return this.proc !== null;
    }

    start(options?: { onLevel?: (level: number) => void }): void {
        if (this.proc) return;

        this.chunks = [];
        this.onLevel = options?.onLevel;

        // `rec` is the recording front-end shipped with sox.  We capture raw
        // signed-integer 16-bit PCM at 16kHz, mono, little-endian to stdout.
        const args = [
            "--rate", String(REC_SAMPLE_RATE),
            "--encoding", "signed-integer",
            "--bits", String(REC_BITS),
            "--channels", String(REC_CHANNELS),
            "--endian", "little",
            "--type", "raw",
            "-",          // write to stdout
        ];

        const proc = spawn("rec", args, {
            stdio: ["ignore", "pipe", "pipe"],
        });
        this.proc = proc;

        proc.stdout.on("data", (chunk: Buffer) => {
            this.chunks.push(chunk);
            if (this.onLevel) {
                this.onLevel(computePcmLevel(chunk));
            }
        });

        proc.stderr.on("data", (data: Buffer) => {
            // sox writes progress info to stderr; suppress unless debug logging
            logger.debug({ msg: data.toString().trim() }, "rec stderr");
        });

        proc.on("error", (err) => {
            logger.error({ err: err.message }, "rec process error");
        });

        logger.info("Recording started");
    }

    /**
     * Stop recording and return the collected raw PCM as a Buffer.
     * Rejects if `rec` was never started or exited with an error.
     */
    stop(): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            if (!this.proc) {
                resolve(Buffer.alloc(0));
                return;
            }

            const proc = this.proc;
            this.proc = null;
            this.onLevel = undefined;

            proc.on("close", (code) => {
                if (code !== null && code !== 0 && code !== 130 /* SIGINT */) {
                    reject(new Error(`rec exited with code ${code}`));
                    return;
                }
                const buf = Buffer.concat(this.chunks);
                logger.info({ bytes: buf.length }, "Recording stopped");
                resolve(buf);
            });

            proc.on("error", reject);

            // SIGINT causes sox/rec to stop recording and flush output cleanly.
            proc.kill("SIGINT");
        });
    }
}

function computePcmLevel(chunk: Buffer): number {
    const sampleCount = Math.floor(chunk.length / 2);
    if (sampleCount <= 0) return 0;

    let sumSquares = 0;
    for (let i = 0; i < sampleCount; i++) {
        const sample = chunk.readInt16LE(i * 2) / 32768;
        sumSquares += sample * sample;
    }

    // Mild boost so quiet speech is still visible in the meter.
    const rms = Math.sqrt(sumSquares / sampleCount);
    return Math.max(0, Math.min(1, rms * 3));
}

// ── PCM Playback ──────────────────────────────────────────────────────

/** Reference to the active sox playback process for cancellation. */
let activePlaybackProc: ChildProcessByStdio<Writable, null, Readable> | null = null;

/** Kill the currently running sox playback process. Returns true if a process was active. */
export function stopPlayback(): boolean {
  if (activePlaybackProc) {
    const proc = activePlaybackProc;
    activePlaybackProc = null;
    proc.kill("SIGTERM");
    return true;
  }
  return false;
}

/**
 * Play an async stream of 24kHz 16-bit signed mono PCM chunks through
 * the system's default audio output using `sox`.
 *
 * Can be cancelled by calling `stopPlayback()` from another context.
 * Resolves when all chunks have been played and sox exits cleanly.
 */
export async function playPcmStream(
    chunks: AsyncIterable<Buffer>,
    options?: { volume?: number },
): Promise<void> {
    const volume = options?.volume ?? 1.0;
    // sox: read raw signed 16-bit LE PCM from stdin, play to default output
    const args = [
        "--type", "raw",
        "--rate", String(PLAY_SAMPLE_RATE),
        "--encoding", "signed-integer",
        "--bits", String(PLAY_BITS),
        "--channels", String(PLAY_CHANNELS),
        "--endian", "little",
        "-",          // read from stdin
        "--default",  // play to default output device
        "vol", String(volume),
    ];

    const proc: ChildProcessByStdio<Writable, null, Readable> = spawn("sox", args, {
        stdio: ["pipe", "ignore", "pipe"],
    });
    activePlaybackProc = proc;

    proc.on("error", (err) => {
        logger.error({ err: err.message }, "sox playback process error");
    });

    proc.stderr.on("data", (data: Buffer) => {
        logger.debug({ msg: data.toString().trim() }, "sox stderr");
    });

    // Track whether this playback was externally cancelled (e.g. Escape pressed).
    let cancelled = false;

    const done = new Promise<void>((resolve, reject) => {
        proc.on("close", (code) => {
            // EPIPE on stdin causes sox to exit with code 1.
            // When cancelled, we treat this as clean shutdown.
            if (cancelled) {
                resolve();
                return;
            }
            if (code !== null && code !== 0) {
                reject(new Error(`sox exited with code ${code}`));
            } else {
                resolve();
            }
        });
        proc.on("error", (err) => {
            if (cancelled) return; // suppress errors after cancellation
            reject(err);
        });
    });

    // Catch EPIPE when sox is killed externally (e.g. stopPlayback via Escape).
    // Without this handler, EPIPE becomes an uncaught exception that crashes Pi.
    proc.stdin.on("error", (err) => {
        const systemErr = err as NodeJS.ErrnoException;
        if (systemErr.syscall === "write" && systemErr.code === "EPIPE") {
            cancelled = true;
            logger.info("PCM playback cancelled (pipe broken)");
            return;
        }
        // For non-EPIPE errors, propagate them
        if (!cancelled) {
            logger.error({ err: err.message }, "sox stdin error");
        }
    });

    for await (const chunk of chunks) {
        // If sox was killed (e.g. Escape pressed), stop feeding chunks
        if (cancelled) break;

        if (!proc.stdin.write(chunk)) {
            // Back-pressure: wait for drain before continuing
            await new Promise<void>((r) => proc.stdin.once("drain", r));
        }
    }

    proc.stdin.end();
    await done;
    logger.info("PCM playback finished");
}

/**
 * Play a short click cue through the default output device.
 */
export async function playClick(kind: "start" | "stop"): Promise<void> {
    // Start: A6 (1760 Hz) — bright, rising feel.
    // Stop:  slightly lower (1480 Hz, a major third down) — settling feel.
    const freq = kind === "start" ? "1760" : "1480";
    const args = [
        "-n",
        "--default",
        "synth",
        "0.02",
        "sine",
        freq,
        "vol",
        "0.12",
    ];

    const proc = spawn("sox", args, { stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
        proc.on("close", (code) => {
            if (code !== null && code !== 0) {
                reject(new Error(`sox click exited with code ${code}`));
            } else {
                resolve();
            }
        });
        proc.on("error", reject);
    });
}
