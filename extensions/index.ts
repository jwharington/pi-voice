/**
 * pi-voice extension – voice interface for pi coding agent.
 *
 * Replaces the previous Electron-daemon architecture with a normal pi
 * extension that runs in-process while pi is active.
 *
 * Features:
 *   - Toggle-to-record via a configurable in-pi keyboard shortcut
 *   - STT via local Whisper, Gemini, OpenAI, or ElevenLabs
 *   - Transcripts routed to the active pi session
 *   - Optional TTS playback via the same provider (or macOS `say`)
 *   - Short click cues when recording starts/stops
 *   - Voice config from `.pi/pi-voice.json` (project or global)
 *   - Live recording indicator in the pi status bar
 *
 * Configuration (.pi/pi-voice.json):
 *   {
 *     "shortcut": "f12",            // default
 *     "provider": "local",          // local | gemini | openai | elevenlabs
 *     "tts": true
 *   }
 *
 * Commands:
 *   /voice          – toggle recording on/off
 *   /voice status   – show current state and config
 *   /voice config   – print effective config path and values
 *   /voice stop     – stop any in-progress recording
 */

import { CustomEditor, type ExtensionAPI, type ExtensionContext, type ExtensionEvent } from "@mariozechner/pi-coding-agent";
import { AudioRecorder, playClick, playPcmStream, stopPlayback } from "../src/services/audio.js";
import { transcribeStreaming } from "../src/services/stt.js";
import { VadProcessor, type VadCallbacks } from "../src/services/vad.js";
import { synthesizeStream, speakLocal } from "../src/services/tts.js";
import { createSettingsComponent } from "./settings.js";
import { getVoicesForProvider } from "../src/services/voices.js";
import { getEditableConfigPath, loadConfig, ConfigError, type PiVoiceConfig, updateConfig, type DeliveryMode } from "../src/services/config.js";
import { resolveModelPath } from "../src/services/whisper-model.js";
import { isKeyRelease, isKittyProtocolActive, matchesKey, type KeyId } from "@mariozechner/pi-tui";
import logger from "../src/services/logger.js";

// ── State ─────────────────────────────────────────────────────────────

const STATUS_KEY = "pi-voice";
const SPINNER = ["⠁", "⠂", "⠄", "⠂"];

/**
 * Global symbol used to share the active voice input handler across extensions.
 * Rather than calling setEditorComponent (which replaces any editor set by other
 * extensions like pi-powerline-footer), we patch CustomEditor.prototype.handleInput
 * once and store the per-session handler here. Any editor that extends CustomEditor
 * (including BashModeEditor) will invoke it via super.handleInput(), so the two
 * extensions compose transparently.
 */
const VOICE_HANDLER_SYMBOL = Symbol.for("pi-voice:handleInput");
const ESCAPE_KEY = "escape"; // key id for Escape key

/** True once the one-time prototype patch has been applied. */
let protoPatchApplied = false;

/**
 * Patches CustomEditor.prototype.handleInput exactly once so that any active voice
 * handler stored in globalThis[VOICE_HANDLER_SYMBOL] is called before normal input
 * processing. Returning true from the handler means the key was consumed.
 */
function ensureProtoPatch(): void {
    if (protoPatchApplied) return;
    protoPatchApplied = true;

    const originalHandleInput = CustomEditor.prototype.handleInput as (data: string) => void;
    CustomEditor.prototype.handleInput = function (data: string): void {
        const handler = Reflect.get(globalThis, VOICE_HANDLER_SYMBOL) as
            | ((data: string) => boolean)
            | undefined;
        if (handler?.(data)) return;
        originalHandleInput.call(this, data);
    };
}

let config: PiVoiceConfig | null = null;
let recorder: AudioRecorder | null = null;
let spinnerFrame = 0;
let spinnerTimer: ReturnType<typeof setInterval> | null = null;
let vuLevel = 0;
let keyPressed = false;
/**
 * Timestamp (ms) of the last recording stop. Used to ignore spurious key-repeat
 * events that arrive a few milliseconds after the terminal delivers the release.
 */
let lastStopTime = 0;

/** Marks the next `agent_end` event as voice-triggered so TTS fires. */
let pendingTts = false;

/** Tracks whether we already started TTS from message_end for the current voice turn. */
let spokeViaMessageEnd = false;

/** True while TTS playback is active — pressing the shortcut cancels speech. */
let isSpeaking = false;

/** AbortController used to cancel in-flight TTS synthesis streams. */
let ttsAbort: AbortController | null = null;

/** Monotonic token for active TTS run; increment to cancel stale runs safely. */
let ttsRunToken = 0;

/** VAD processor for progressive transcription during recording. */
let vadProcessor: VadProcessor | null = null;

/** Accumulated intermediate transcript text from progressive VAD transcription. */
let intermediateTranscript = "";

/** Flag: in-flight transcription of a VAD-detected utterance. Prevents concurrent calls. */
let transcriptionPending = false;

/** Extension context reference for use in VAD callbacks (scoped to session). */
let activeCtx: ExtensionContext | null = null;

/** Extension API reference for use in recording pipeline. */
let activePi: ExtensionAPI | null = null;

/** Editor text before recording started (used for interim prompt preview). */
let editorTextBeforeRecording = "";

/** True while interim transcription is being previewed in the editor. */
let interimPreviewActive = false;

// ── Helpers ───────────────────────────────────────────────────────────

function spin(ctx: ExtensionContext): void {
    const frame = SPINNER[spinnerFrame % SPINNER.length]!;
    spinnerFrame++;
    const bars = renderVuBars(vuLevel);
    ctx.ui.setStatus(STATUS_KEY, `${frame} recording ${bars}`);
}

function startSpinner(ctx: ExtensionContext): void {
    vuLevel = 0;
    spinnerTimer = setInterval(() => spin(ctx), 250);
}

function stopSpinner(ctx: ExtensionContext): void {
    if (spinnerTimer) {
        clearInterval(spinnerTimer);
        spinnerTimer = null;
    }
    vuLevel = 0;
    ctx.ui.setStatus(STATUS_KEY, undefined);
}

function setStatus(ctx: ExtensionContext, msg: string): void {
    ctx.ui.setStatus(STATUS_KEY, msg);
}

function renderInterimTranscriptInPrompt(ctx: ExtensionContext): void {
    const preview = intermediateTranscript.trim();
    if (!preview) return;
    const sep =
        editorTextBeforeRecording.length > 0 && !editorTextBeforeRecording.endsWith(" ")
            ? " "
            : "";
    ctx.ui.setEditorText(`${editorTextBeforeRecording}${sep}🎤 ${preview}`);
    interimPreviewActive = true;
}

function showMicListeningIndicatorInPrompt(ctx: ExtensionContext): void {
    if (interimPreviewActive || intermediateTranscript.trim()) return;
    const sep =
        editorTextBeforeRecording.length > 0 && !editorTextBeforeRecording.endsWith(" ")
            ? " "
            : "";
    ctx.ui.setEditorText(`${editorTextBeforeRecording}${sep}🎤 …`);
    interimPreviewActive = true;
}

function clearInterimTranscriptFromPrompt(ctx: ExtensionContext): void {
    if (!interimPreviewActive) return;
    ctx.ui.setEditorText(editorTextBeforeRecording);
    interimPreviewActive = false;
}

function cancelTtsPlayback(ctx: ExtensionContext): void {
    // Invalidate any in-flight speakSegments() run so stale finally blocks don't clobber state.
    ttsRunToken++;
    isSpeaking = false;
    stopPlayback();
    ctx.ui.setStatus(STATUS_KEY, "cancelled");
    setTimeout(() => ctx.ui.setStatus(STATUS_KEY, undefined), 1500);
}

function parseBooleanish(input: string): boolean | undefined {
    const normalized = input.trim().toLowerCase();
    if (["1", "true", "on", "yes", "enabled"].includes(normalized)) return true;
    if (["0", "false", "off", "no", "disabled"].includes(normalized)) return false;
    return undefined;
}

function renderVuBars(level: number): string {
    const width = 10;
    const PARTIAL = ["▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const;

    const clamped = Math.max(0, Math.min(1, level));
    const lit = clamped * width;
    const full = Math.floor(lit);
    const frac = lit - full;

    const color = clamped < 0.4 ? "\x1b[32m" : clamped < 0.7 ? "\x1b[33m" : "\x1b[31m";

    // Always produce exactly `width` visible characters so `]` stays fixed.
    let content = "█".repeat(full);
    if (full < width) {
        const partialIdx = Math.round(frac * PARTIAL.length) - 1;
        content += partialIdx >= 0 ? PARTIAL[partialIdx]! : "-";
        content += "-".repeat(width - full - 1);  // pad remainder
    }

    return `[${color}${content}\x1b[0m]`;
}

async function stopRecording(ctx: ExtensionContext, pi: ExtensionAPI, runTranscription: boolean): Promise<void> {
    if (!recorder?.isRecording) return;

    lastStopTime = Date.now();
    stopSpinner(ctx);
    setStatus(ctx, runTranscription ? "processing…" : "stopped");

    const recRef = recorder;
    const vadRef = vadProcessor;
    recorder = null;
    vadProcessor = null;

    // Reset intermediate state
    transcriptionPending = false;

    let pcm: Buffer;
    try {
        pcm = await recRef.stop();
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err: msg }, "Failed to stop recording");
        ctx.ui.notify(`Recording failed: ${msg}`, "error");
        clearInterimTranscriptFromPrompt(ctx);
        ctx.ui.setStatus(STATUS_KEY, undefined);
        return;
    }

    void playClick("stop").catch((err) => {
        logger.warn({ err: (err as Error).message }, "Could not play stop click");
    });

    if (runTranscription) {
        await runPipeline(pcm, vadRef, ctx, pi);
    } else {
        clearInterimTranscriptFromPrompt(ctx);
        ctx.ui.setStatus(STATUS_KEY, undefined);
    }
}

/** Minimum ms between a stop and the next allowed start (debounce for key-repeat). */
const START_COOLDOWN_MS = 400;

function startRecording(ctx: ExtensionContext): void {
    if (Date.now() - lastStopTime < START_COOLDOWN_MS) {
        logger.debug({ elapsed: Date.now() - lastStopTime }, "Ignoring start within cooldown window");
        return;
    }

    // Reset progressive transcription state
    intermediateTranscript = "";
    transcriptionPending = false;
    editorTextBeforeRecording = ctx.ui.getEditorText();
    interimPreviewActive = false;
    showMicListeningIndicatorInPrompt(ctx);
    activeCtx = ctx;
    vadProcessor = new VadProcessor({}, createVadCallbacks(ctx));

    recorder = new AudioRecorder();
    recorder.start({
        onLevel: (level) => {
            vuLevel = (vuLevel * 0.6) + (level * 0.4);
        },
        onChunk: (chunk) => {
            vadProcessor?.processChunk(chunk);
        },
    });

    void playClick("start").catch((err) => {
        logger.warn({ err: (err as Error).message }, "Could not play start click");
    });
    startSpinner(ctx);
}

/** Build VAD callbacks that trigger progressive transcription. */
function createVadCallbacks(ctx: ExtensionContext): VadCallbacks {
    return {
        onSpeechStart: () => {
            logger.debug("VAD: speech started");
            showMicListeningIndicatorInPrompt(ctx);
        },
        onSpeechEnd: () => {
            logger.debug("VAD: speech ended");
        },
        onUtteranceReady: (utterance: Buffer) => {
            if (utterance.byteLength < 1600) {
                // Ignore very short utterances (< 50ms)
                return;
            }
            if (!config || !activePi) return;
            // Transcribe the utterance in the background (non-blocking)
            void transcribeUtterance(utterance, ctx);
        },
    };
}

/** Transcribe a single utterance captured by VAD (non-blocking). */
async function transcribeUtterance(pcm: Buffer, ctx: ExtensionContext): Promise<void> {
    // Prevent concurrent transcription calls
    if (transcriptionPending) {
        logger.debug("Skipping concurrent transcription");
        return;
    }

    transcriptionPending = true;
    setStatus(ctx, "transcribing…");

    try {
        const transcriptBeforeUtterance = intermediateTranscript.trim();
        let utteranceFromDelta = "";

        await transcribeStreaming(
            pcm.buffer as ArrayBuffer,
            config!.provider,
            {
                sttModel: config!.sttModel,
                sttBaseUrl: config!.sttBaseUrl,
            },
            {
                onDelta: (delta) => {
                    utteranceFromDelta += delta;
                    const parts = [transcriptBeforeUtterance, utteranceFromDelta.trim()].filter(Boolean);
                    intermediateTranscript = parts.join(" ");
                    renderInterimTranscriptInPrompt(ctx);
                },
                onDone: (text) => {
                    const utteranceFinal = text.trim() || utteranceFromDelta.trim();
                    if (!utteranceFinal) return;
                    const parts = [transcriptBeforeUtterance, utteranceFinal].filter(Boolean);
                    intermediateTranscript = parts.join(" ");
                    renderInterimTranscriptInPrompt(ctx);
                    logger.info({ transcript: utteranceFinal }, "Intermediate transcription ready");
                },
            },
        );
    } catch (err) {
        logger.error({ err: (err as Error).message }, "Intermediate transcription failed");
    } finally {
        transcriptionPending = false;
    }
}

async function runPipeline(
    pcm: Buffer,
    vadRef: VadProcessor | null,
    ctx: ExtensionContext,
    pi: ExtensionAPI,
): Promise<void> {
    if (!config) return;

    if (pcm.byteLength < 1600) {
        // < 50 ms of audio at 16kHz – accidental tap, ignore
        clearInterimTranscriptFromPrompt(ctx);
        setStatus(ctx, "too short, ignored");
        setTimeout(() => ctx.ui.setStatus(STATUS_KEY, undefined), 2000);
        logger.info("Recording too short, ignoring");
        return;
    }

    try {
        // Flush any remaining VAD buffer (speech that ended without a trailing pause)
        vadRef?.flush();

        let transcript: string;

        // Transcribe the full recording for the authoritative final result.
        // VAD intermediate results were already shown during recording;
        // the full transcription is more accurate (handles segment boundaries).
        setStatus(ctx, "transcribing…");
        transcript = await transcribeStreaming(
            pcm.buffer as ArrayBuffer,
            config.provider,
            {
                sttModel: config.sttModel,
                sttBaseUrl: config.sttBaseUrl,
            },
            {},
        );

        // Fall back to accumulated VAD results if the full transcription is empty
        if (!transcript.trim() && intermediateTranscript.trim()) {
            transcript = intermediateTranscript;
        }

        // Reset interim prompt preview before applying final behavior.
        clearInterimTranscriptFromPrompt(ctx);

        // Reset intermediate state for next recording
        const finalTranscript = transcript.trim();
        intermediateTranscript = "";

        if (!finalTranscript) {
            setStatus(ctx, "no speech detected");
            setTimeout(() => ctx.ui.setStatus(STATUS_KEY, undefined), 2000);
            return;
        }

        logger.info({ transcript: finalTranscript }, "Transcript ready");

        if (config.inputMode === "draft") {
            // Insert final transcript into editor for review/edit.
            const current = ctx.ui.getEditorText();
            const sep = current.length > 0 && !current.endsWith(" ") ? " " : "";
            ctx.ui.setEditorText(`${current}${sep}${finalTranscript}`);
            ctx.ui.setStatus(STATUS_KEY, undefined);
            return;
        }

        // ── Auto-send to active pi session ────────────────────────────────
        // TTS playback itself is still controlled by config.ttsEnabled.
        setStatus(ctx, "thinking…");
        pendingTts = true;
        spokeViaMessageEnd = false;
        pi.sendUserMessage(finalTranscript, {
          deliverAs: config!.deliveryMode as DeliveryMode,
        });
        // TTS is handled in the agent_end listener below

    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err: msg }, "Voice pipeline error");
        clearInterimTranscriptFromPrompt(ctx);
        setStatus(ctx, `error: ${msg.slice(0, 80)}`);
        setTimeout(() => ctx.ui.setStatus(STATUS_KEY, undefined), 4000);
    }
}

// ── Extension entry point ─────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
    // ── Load config ───────────────────────────────────────────────────
    try {
        config = loadConfig(process.cwd());
    } catch (err) {
        const msg = err instanceof ConfigError
            ? err.message
            : `Failed to load pi-voice config: ${err instanceof Error ? err.message : String(err)}`;
        // Notify on first session_start instead of at load time
        pi.on("session_start", (_event, ctx) => {
            ctx.ui.notify(msg, "error");
        });
        return;
    }

    // Pre-warm local Whisper model in the background so the first recording
    // doesn't stall waiting for the download.
    if (config.provider === "local") {
        resolveModelPath().catch((err: unknown) => {
            logger.warn({ err: (err as Error).message }, "Could not pre-warm Whisper model");
        });
    }

    // ── Session lifecycle ─────────────────────────────────────────────
    pi.on("session_start", (_event, _ctx) => {
        logger.info({ shortcut: config!.shortcut }, "pi-voice extension active");
    });

    pi.on("session_shutdown", (_event, ctx) => {
        if (recorder?.isRecording) {
            recorder.stop().catch(() => { });
        }
        // Clear the voice handler so no stale handler remains between sessions.
        Reflect.deleteProperty(globalThis, VOICE_HANDLER_SYMBOL);
        stopSpinner(ctx);
        clearInterimTranscriptFromPrompt(ctx);
        recorder = null;
        vadProcessor = null;
        pendingTts = false;
        ttsRunToken++;
        isSpeaking = false;
        keyPressed = false;
        lastStopTime = 0;
        intermediateTranscript = "";
        transcriptionPending = false;
        editorTextBeforeRecording = "";
        interimPreviewActive = false;
        activeCtx = null;
        activePi = null;
        logger.info("pi-voice extension shut down");
    });

    pi.on("session_start", (_event, ctx) => {
        activePi = pi;

        // Patch CustomEditor.prototype.handleInput once so the voice handler
        // composes with any editor set by other extensions (e.g. pi-powerline-footer's
        // BashModeEditor) without calling setEditorComponent and overwriting them.
        ensureProtoPatch();

        Reflect.set(globalThis, VOICE_HANDLER_SYMBOL, (data: string): boolean => {
            // Cancel voice output with Escape key (always, regardless of config).
            if (isSpeaking && matchesKey(data, ESCAPE_KEY)) {
                cancelTtsPlayback(ctx);
                return true;
            }

            const keyId = config?.shortcut.toLowerCase() as KeyId | undefined;
            if (!keyId || !matchesKey(data, keyId)) return false;
            if (!config?.enabled) return true; // consume but ignore when disabled

            // Cancel voice output if currently speaking (press shortcut to stop TTS).
            if (isSpeaking && !recorder?.isRecording) {
                cancelTtsPlayback(ctx);
                return true;
            }

            // If release events aren't available, gracefully degrade to toggle mode.
            if (!isKittyProtocolActive()) {
                if (recorder?.isRecording) {
                    keyPressed = false;
                    void stopRecording(ctx, pi, true);
                } else {
                    keyPressed = true;
                    try {
                        startRecording(ctx);
                    } catch (err) {
                        keyPressed = false;
                        recorder = null;
                        const msg = err instanceof Error ? err.message : String(err);
                        logger.error({ err: msg }, "Failed to start recording");
                        ctx.ui.notify(`Could not start recording: ${msg}`, "error");
                    }
                }
                return true;
            }

            const released = isKeyRelease(data);
            if (released) {
                // Hold-to-talk: release always stops if we started via hold.
                if (keyPressed) {
                    keyPressed = false;
                    void stopRecording(ctx, pi, true);
                }
                return true;
            }

            // Keydown event.
            if (recorder?.isRecording) {
                // Short-press toggle: a second press while recording stops immediately
                // without waiting for the key release.
                keyPressed = false;
                void stopRecording(ctx, pi, true);
                return true;
            }

            if (keyPressed) return true; // key-repeat guard during start-up

            keyPressed = true;
            try {
                startRecording(ctx);
            } catch (err) {
                keyPressed = false;
                recorder = null;
                const msg = err instanceof Error ? err.message : String(err);
                logger.error({ err: msg }, "Failed to start recording");
                ctx.ui.notify(`Could not start recording: ${msg}`, "error");
            }
            return true;
        });
    });

    // ── TTS after agent response ──────────────────────────────────────

    /** Accumulates assistant text blocks during an agent turn (for eco mode). */
    let ttsQueue: string[] = [];

    function extractTextBlocksFromMessage(message: any): string[] {
        if (!message) return [];

        const role = typeof message.role === "string" ? message.role.toLowerCase() : undefined;
        // Ignore known non-assistant roles, but allow assistant/model or unknown roles.
        if (role && ["user", "tool", "system"].includes(role)) return [];

        // Some hosts provide content as a plain string instead of block array.
        if (typeof message.content === "string" && message.content.trim()) {
            return [message.content.trim()];
        }

        // Some hosts provide a direct text field.
        if (typeof message.text === "string" && message.text.trim()) {
            return [message.text.trim()];
        }

        const blocks = Array.isArray(message.content) ? message.content : [];
        const textBlocks = blocks
            .flatMap((b: any) => {
                // Most common shape: { type: "text", text: string }
                if (typeof b?.text === "string" && b.text.trim()) {
                    return [b.text.trim()];
                }
                // Alternate shapes: { type: "output_text", content/text/value }
                if (typeof b?.content === "string" && b.content.trim()) {
                    return [b.content.trim()];
                }
                if (typeof b?.value === "string" && b.value.trim()) {
                    return [b.value.trim()];
                }
                return [];
            });

        if (textBlocks.length > 0) return textBlocks;

        // Last-resort fallback: stringify unknown content shape so TTS still has something.
        if (message.content && !Array.isArray(message.content)) {
            const raw = String(message.content).trim();
            if (raw) return [raw];
        }

        return [];
    }

    function splitForTts(text: string, maxLen = 700): string[] {
        const normalized = text.trim();
        if (!normalized) return [];
        if (normalized.length <= maxLen) return [normalized];

        const pieces: string[] = [];
        const paragraphs = normalized.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

        for (const para of paragraphs) {
            if (para.length <= maxLen) {
                pieces.push(para);
                continue;
            }

            const sentences = para.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
            let current = "";
            for (const sentence of sentences) {
                const candidate = current ? `${current} ${sentence}` : sentence;
                if (candidate.length <= maxLen) {
                    current = candidate;
                } else {
                    if (current) pieces.push(current);
                    if (sentence.length <= maxLen) {
                        current = sentence;
                    } else {
                        // Hard split very long sentence.
                        for (let i = 0; i < sentence.length; i += maxLen) {
                            pieces.push(sentence.slice(i, i + maxLen));
                        }
                        current = "";
                    }
                }
            }
            if (current) pieces.push(current);
        }

        return pieces.length > 0 ? pieces : [normalized];
    }

    // Listen for message_end to speak as early as possible when supported by the host.
    // Important: do not await TTS here, otherwise message lifecycle completion can be blocked
    // and Pi may remain in "working..." until playback completes.
    pi.on("message_end" as any, (event: any, ctx: any) => {
        if (!pendingTts) return;

        const textBlocks = extractTextBlocksFromMessage(event?.message);
        if (textBlocks.length === 0) return;

        // Eco mode: accumulate assistant text blocks and speak once at agent_end.
        if (config?.ecoMode) {
            ttsQueue.push(...textBlocks);
            return;
        }

        // Non-eco mode: speak immediately
        spokeViaMessageEnd = true;
        void speakSegments(textBlocks, ctx);
    });

    // At agent_end, always provide a fallback path from event.messages so TTS works
    // even on hosts that do not emit message_end.
    pi.on("agent_end", (event: any, ctx) => {
        if (!pendingTts) return;
        pendingTts = false;

        const assistantTexts = Array.isArray(event?.messages)
            ? event.messages.flatMap((m: any) => extractTextBlocksFromMessage(m))
            : [];

        if (config?.ecoMode) {
            // Speak the full final assistant message (all text blocks), not just last line/block.
            let finalText: string | undefined;
            let fallbackLastLine: string | undefined;

            if (ttsQueue.length > 0) {
                finalText = ttsQueue.join("\n\n").trim();
                fallbackLastLine = ttsQueue[ttsQueue.length - 1];
            } else if (Array.isArray(event?.messages)) {
                const allSpeakable = event.messages
                    .flatMap((m: any) => extractTextBlocksFromMessage(m))
                    .filter((t: string) => t.trim().length > 0);
                if (allSpeakable.length > 0) {
                    finalText = allSpeakable.join("\n\n").trim();
                    fallbackLastLine = allSpeakable[allSpeakable.length - 1];
                }
            } else if (assistantTexts.length > 0) {
                finalText = assistantTexts.join("\n\n").trim();
                fallbackLastLine = assistantTexts[assistantTexts.length - 1];
            }

            ttsQueue = [];
            const segments = splitForTts(finalText ?? "");
            if (segments.length > 0) {
                void speakSegments(segments, ctx);
            } else if (fallbackLastLine?.trim()) {
                // Safety fallback to keep eco TTS alive on odd payloads.
                void speakSegments([fallbackLastLine.trim()], ctx);
            } else {
                logger.warn({ eventHasMessages: Array.isArray(event?.messages) }, "No speakable text found for eco TTS");
            }
            return;
        }

        // Non-eco mode: if message_end already spoke, skip fallback to avoid duplicates.
        ttsQueue = [];
        if (!spokeViaMessageEnd && assistantTexts.length > 0) {
            void speakSegments(assistantTexts, ctx);
        } else if (!spokeViaMessageEnd) {
            logger.warn({ eventHasMessages: Array.isArray(event?.messages) }, "No speakable text found for non-eco TTS");
        }
        spokeViaMessageEnd = false;
    });

    /** Speak text segments through TTS (handles volume, provider, cancellation). */
    async function speakSegments(
        segments: string[],
        ctx: ExtensionContext,
    ): Promise<void> {
        if (!config) return;

        // Volume control: 0.0 disables TTS entirely
        if (config.volume === 0) {
            ctx.ui.setStatus(STATUS_KEY, undefined);
            return;
        }

        // Start a new run token; older runs become stale.
        const myRunToken = ++ttsRunToken;

        // If already speaking, stop existing playback before starting new one.
        if (isSpeaking) {
            stopPlayback();
        }

        setStatus(ctx, "speaking…");
        isSpeaking = true;
        try {
            if (config.provider === "local") {
                // macOS `say` command plays directly
                for (const seg of segments) {
                    // Abort stale runs early
                    if (myRunToken !== ttsRunToken) return;
                    await speakLocal(seg, config.ttsVoice);
                }
            } else {
                // Cloud providers: stream PCM to sox for playback
                async function* generateChunks(): AsyncIterable<Buffer> {
                    for (const seg of segments) {
                        // Abort stale runs early
                        if (myRunToken !== ttsRunToken) return;
                        yield* synthesizeStream(seg, config!.provider, {
                            ttsBaseUrl: config!.ttsBaseUrl,
                            ttsModel: config!.ttsModel,
                            ttsVoice: config!.ttsVoice,
                        });
                    }
                }
                await playPcmStream(generateChunks(), { volume: config.volume });
            }
        } catch (err) {
            logger.error({ err: (err as Error).message }, "TTS error");
            ctx.ui.notify(`TTS error: ${(err as Error).message}`, "warning");
        } finally {
            // Only latest run is allowed to clear state.
            if (myRunToken === ttsRunToken) {
                isSpeaking = false;
                ctx.ui.setStatus(STATUS_KEY, undefined);
            }
        }
    }

    // ── Shortcut registration for discoverability/help overlay ────────
    pi.registerShortcut(config.shortcut.toLowerCase() as KeyId, {
        description: "Hold-to-talk (press to cancel speech)",
        handler: async (ctx) => {
            // Actual press/release handling uses raw terminal input in session_start.
            // Keep this command as a discoverable keybinding entry in the help UI.
            ctx.ui.notify("Hold the shortcut to record, release to send. Press while speaking to cancel.", "info");
        },
    });

    // ── /voice command ────────────────────────────────────────────────
    pi.registerCommand("voice", {
        description: "Control pi-voice (status/config/settings/set/enable/disable/stop)",
        handler: async (args, ctx) => {
            const trimmed = args.trim();
            const [actionRaw, ...restParts] = trimmed.length > 0 ? trimmed.split(/\s+/) : ["status"];
            const action = (actionRaw ?? "status").toLowerCase();

            if (action === "stop") {
                if (isSpeaking) {
                    cancelTtsPlayback(ctx);
                    ctx.ui.notify("TTS playback stopped", "info");
                    return;
                }
                if (!recorder?.isRecording) {
                    ctx.ui.notify("No active recording or playback", "info");
                    return;
                }
                stopSpinner(ctx);
                const recRef = recorder;
                recorder = null;
                try {
                    await recRef.stop();
                } catch { /* ignore */ }
                void playClick("stop").catch(() => { });
                keyPressed = false;
                ctx.ui.notify("Recording stopped", "info");
                ctx.ui.setStatus(STATUS_KEY, undefined);
                return;
            }

            if (action === "enable" || action === "disable") {
                const enabled = action === "enable";
                if (!enabled && recorder?.isRecording) {
                    stopSpinner(ctx);
                    const recRef = recorder;
                    recorder = null;
                    try {
                        await recRef.stop();
                    } catch { /* ignore */ }
                    clearInterimTranscriptFromPrompt(ctx);
                    void playClick("stop").catch(() => { });
                }
                config = updateConfig(process.cwd(), { enabled });
                ctx.ui.notify(`pi-voice ${enabled ? "enabled" : "disabled"}`, "info");
                return;
            }

            if (action === "set") {
                if (!config) {
                    ctx.ui.notify("pi-voice config not loaded", "warning");
                    return;
                }
                if (restParts.length < 2) {
                    ctx.ui.notify("Usage: /voice set <shortcut|provider|tts|inputMode|eco|enabled|deliveryMode|sttModel|sttBaseUrl|ttsModel|ttsVoice|sttBaseUrl|ttsBaseUrl> <value>", "info");
                    return;
                }

                const field = restParts[0]!.toLowerCase();
                const value = restParts.slice(1).join(" ");

                if (field === "shortcut") {
                    config = updateConfig(process.cwd(), { shortcut: value.toLowerCase() });
                    ctx.ui.notify("Shortcut updated and applied immediately.", "info");
                    return;
                }

                if (field === "provider") {
                    const provider = value.toLowerCase();
                    if (!["local", "gemini", "openai", "elevenlabs"].includes(provider)) {
                        ctx.ui.notify("Provider must be one of: local, gemini, openai, elevenlabs", "warning");
                        return;
                    }
                    config = updateConfig(process.cwd(), { provider: provider as PiVoiceConfig["provider"] });
                    ctx.ui.notify(`Provider set to ${provider}`, "info");
                    return;
                }

                if (field === "tts" || field === "enabled") {
                    const parsed = parseBooleanish(value);
                    if (parsed === undefined) {
                        ctx.ui.notify(`${field} must be true/false (or on/off)`, "warning");
                        return;
                    }
                    if (field === "tts") {
                        config = updateConfig(process.cwd(), { ttsEnabled: parsed });
                    } else {
                        config = updateConfig(process.cwd(), { enabled: parsed });
                    }
                    ctx.ui.notify(`${field} set to ${parsed}`, "info");
                    return;
                }

                if (field === "inputmode" || field === "input-mode" || field === "input_mode") {
                    const mode = value.trim().toLowerCase();
                    if (!mode || !["draft", "autosend", "auto-send", "auto_send"].includes(mode)) {
                        ctx.ui.notify("inputMode must be one of: draft, autoSend", "warning");
                        return;
                    }
                    const normalized = mode === "draft" ? "draft" : "autoSend";
                    config = updateConfig(process.cwd(), { inputMode: normalized });
                    ctx.ui.notify(`inputMode set to ${normalized}`, "info");
                    return;
                }

                if (field === "eco") {
                    const parsed = parseBooleanish(value);
                    if (parsed === undefined) {
                        ctx.ui.notify("eco must be true/false (or on/off)", "warning");
                        return;
                    }
                    config = updateConfig(process.cwd(), { ecoMode: parsed });
                    ctx.ui.notify(`ecoMode set to ${parsed} (${parsed ? "concise" : "full"} speech)`, "info");
                    return;
                }

                if (field === "sttmodel" || field === "stt-model" || field === "stt_model") {
                    const model = value.trim();
                    config = updateConfig(process.cwd(), { sttModel: model || undefined });
                    ctx.ui.notify(model ? `sttModel set to ${model}` : "sttModel cleared (using env/default)", "info");
                    return;
                }

                if (field === "sttbaseurl" || field === "stt-baseurl" || field === "stt_baseurl") {
                    const url = value.trim();
                    config = updateConfig(process.cwd(), { sttBaseUrl: url || undefined });
                    ctx.ui.notify(url ? `sttBaseUrl set to ${url}` : "sttBaseUrl cleared (using env/default)", "info");
                    return;
                }

                if (field === "ttsbaseurl" || field === "tts-baseurl" || field === "tts_baseurl") {
                    const url = value.trim();
                    config = updateConfig(process.cwd(), { ttsBaseUrl: url || undefined });
                    ctx.ui.notify(url ? `ttsBaseUrl set to ${url}` : "ttsBaseUrl cleared (using env/default)", "info");
                    return;
                }

                if (field === "ttsmodel" || field === "tts-model" || field === "tts_model") {
                    const model = value.trim();
                    config = updateConfig(process.cwd(), { ttsModel: model || undefined });
                    ctx.ui.notify(model ? `ttsModel set to ${model}` : "ttsModel cleared (using env/default)", "info");
                    return;
                }

                if (field === "ttsvoice" || field === "tts-voice" || field === "tts_voice") {
                    const voice = value.trim();
                    config = updateConfig(process.cwd(), { ttsVoice: voice || undefined });
                    ctx.ui.notify(voice ? `ttsVoice set to ${voice}` : "ttsVoice cleared (using env/default)", "info");
                    return;
                }

                if (field === "volume") {
                    const vol = parseFloat(value);
                    if (isNaN(vol) || vol < 0 || vol > 1) {
                        ctx.ui.notify("Volume must be a number between 0.0 (muted) and 1.0 (max)", "warning");
                        return;
                    }
                    config = updateConfig(process.cwd(), { volume: vol });
                    ctx.ui.notify(`Volume set to ${vol} (${vol === 0 ? "muted" : Math.round(vol * 100) + "%"})`, "info");
                    return;
                }

                if (field === "deliverymode" || field === "delivery-mode" || field === "delivery_mode") {
                    const mode = value.toLowerCase();
                    if (!["steer", "followup"].includes(mode)) {
                        ctx.ui.notify("deliveryMode must be one of: steer, followUp", "warning");
                        return;
                    }
                    config = updateConfig(process.cwd(), { deliveryMode: mode === "steer" ? "steer" : "followUp" });
                    ctx.ui.notify(`deliveryMode set to ${mode} (${mode === "steer" ? "interrupt" : "queue after current turn"})`, "info");
                    return;
                }

                ctx.ui.notify("Unknown setting. Use: shortcut, provider, tts, inputMode, eco, enabled, volume, deliveryMode, sttModel, sttBaseUrl, ttsModel, ttsVoice, ttsBaseUrl", "warning");
                return;
            }

            if (action === "voices" || action === "voice-list") {
                if (!config) {
                    ctx.ui.notify("pi-voice config not loaded", "warning");
                    return;
                }
                const provider = config.provider;
                const currentVoice = config.ttsVoice;
                try {
                    const voices = await getVoicesForProvider(provider);
                    if (voices.length === 0) {
                        ctx.ui.notify(`No voices available for provider '${provider}'`, "warning");
                        return;
                    }
                    const lines = voices.map((v) => {
                        const isCurrent = currentVoice === v.voiceId ? " ✓" : "";
                        return `  ${v.voiceName}${isCurrent}`;
                    });
                    ctx.ui.notify(`Available voices for ${provider}:\n${lines.join("\n")}\n\nSet with: /voice set ttsVoice <voiceId>`, "info");
                } catch (err) {
                    ctx.ui.notify(`Failed to fetch voices: ${(err as Error).message}`, "error");
                }
                return;
            }

            if (action === "config") {
                if (!config) {
                    ctx.ui.notify("pi-voice config not loaded", "warning");
                    return;
                }
                const lines = [
                    `configPath: ${getEditableConfigPath(process.cwd())}`,
                    `shortcut:  ${config.shortcut}`,
                    `provider:  ${config.provider}`,
                    `enabled:   ${config.enabled}`,
                    `tts:       ${config.ttsEnabled}`,
                    `inputMode: ${config.inputMode}`,
                    `volume:    ${config.volume} (${Math.round(config.volume * 100)}%)`,
                    `ecoMode:   ${config.ecoMode} (${config.ecoMode ? "concise" : "full"})`,
                    `deliveryMode: ${config.deliveryMode} (${config.deliveryMode === "steer" ? "interrupt" : "queue"})`,
                    `sttBaseUrl: ${config.sttBaseUrl ?? "(env/default)"}`,
                    `ttsBaseUrl: ${config.ttsBaseUrl ?? "(env/default)"}`,
                    `sttModel:  ${config.sttModel ?? "(env/default)"}`,
                    `ttsModel:  ${config.ttsModel ?? "(env/default)"}`,
                    `ttsVoice:  ${config.ttsVoice ?? "(env/default)"}`,
                ];
                ctx.ui.notify(lines.join("\n"), "info");
                return;
            }

            if (action === "settings") {
                if (!config) {
                    ctx.ui.notify("pi-voice config not loaded", "warning");
                    return;
                }

                // Show TUI settings menu using Pi's SettingsList component
                await ctx.ui.custom(
                    (tui, theme, keybindings, done) => createSettingsComponent(tui, theme, keybindings, done),
                );

                // Reload runtime config after settings close so enable/disable and
                // other toggles apply immediately without restarting Pi.
                config = loadConfig(process.cwd());
                return;
            }

            // Default (no args or "status")
            const state = recorder?.isRecording
                ? "🔴 recording"
                : isSpeaking
                ? "🔊 speaking"
                : "idle";
            if (!config) {
                ctx.ui.notify(`pi-voice: ${state}  (config not loaded)`, "info");
                return;
            }
            ctx.ui.notify(`pi-voice: ${state}  (${config.provider}, enabled=${config.enabled}, tts=${config.ttsEnabled}, inputMode=${config.inputMode}, volume=${config.volume}, eco=${config.ecoMode ? "concise" : "full"}, delivery=${config.deliveryMode})`, "info");
        },
    });
}
