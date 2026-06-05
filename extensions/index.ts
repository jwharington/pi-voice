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

import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { AudioRecorder, playClick, playPcmStream } from "../src/services/audio.js";
import { transcribe } from "../src/services/stt.js";
import { synthesizeStream, speakLocal } from "../src/services/tts.js";
import { getEditableConfigPath, loadConfig, ConfigError, type PiVoiceConfig, updateConfig } from "../src/services/config.js";
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
    recorder = null;

    let pcm: Buffer;
    try {
        pcm = await recRef.stop();
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err: msg }, "Failed to stop recording");
        ctx.ui.notify(`Recording failed: ${msg}`, "error");
        ctx.ui.setStatus(STATUS_KEY, undefined);
        return;
    }

    void playClick("stop").catch((err) => {
        logger.warn({ err: (err as Error).message }, "Could not play stop click");
    });

    if (runTranscription) {
        await runPipeline(pcm, ctx, pi);
    } else {
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
    recorder = new AudioRecorder();
    recorder.start({
        onLevel: (level) => {
            vuLevel = (vuLevel * 0.6) + (level * 0.4);
        },
    });

    void playClick("start").catch((err) => {
        logger.warn({ err: (err as Error).message }, "Could not play start click");
    });
    startSpinner(ctx);
}

async function runPipeline(
    pcm: Buffer,
    ctx: ExtensionContext,
    pi: ExtensionAPI,
): Promise<void> {
    if (!config) return;

    if (pcm.byteLength < 1600) {
        // < 50 ms of audio at 16kHz – accidental tap, ignore
        setStatus(ctx, "too short, ignored");
        setTimeout(() => ctx.ui.setStatus(STATUS_KEY, undefined), 2000);
        logger.info("Recording too short, ignoring");
        return;
    }

    try {
        // ── STT ──────────────────────────────────────────────────────────
        setStatus(ctx, "transcribing…");
        const transcript = await transcribe(
          pcm.buffer as ArrayBuffer,
          config.provider,
          {
            sttModel: config.sttModel,
            sttBaseUrl: config.sttBaseUrl,
          },
        );

        if (!transcript.trim()) {
            setStatus(ctx, "no speech detected");
            setTimeout(() => ctx.ui.setStatus(STATUS_KEY, undefined), 2000);
            return;
        }

        logger.info({ transcript }, "Transcript ready");

        if (!config.ttsEnabled) {
            // Inject transcript into the editor buffer – user can edit / submit
            const current = ctx.ui.getEditorText();
            const sep = current.length > 0 && !current.endsWith(" ") ? " " : "";
            ctx.ui.setEditorText(`${current}${sep}${transcript}`);
            ctx.ui.setStatus(STATUS_KEY, undefined);
            return;
        }

        // ── Send to active pi session ─────────────────────────────────────
        setStatus(ctx, "thinking…");
        pendingTts = true;
        pi.sendUserMessage(transcript);
        // TTS is handled in the agent_end listener below

    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err: msg }, "Voice pipeline error");
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
        recorder = null;
        pendingTts = false;
        keyPressed = false;
        lastStopTime = 0;
        logger.info("pi-voice extension shut down");
    });

    pi.on("session_start", (_event, ctx) => {
        const keyId = config!.shortcut.toLowerCase() as KeyId;

        // Patch CustomEditor.prototype.handleInput once so the voice handler
        // composes with any editor set by other extensions (e.g. pi-powerline-footer's
        // BashModeEditor) without calling setEditorComponent and overwriting them.
        ensureProtoPatch();

        Reflect.set(globalThis, VOICE_HANDLER_SYMBOL, (data: string): boolean => {
            if (!matchesKey(data, keyId)) return false;
            if (!config?.enabled) return true; // consume but ignore when disabled

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
    pi.on("agent_end", async (event, ctx) => {
        if (!pendingTts) return;
        pendingTts = false;

        if (!config) return;

        // Collect all text content from this agent turn
        const textSegments: string[] = [];
        for (const msg of event.messages) {
            if (msg.role !== "assistant") continue;
            for (const block of msg.content) {
                if (block.type === "text" && block.text.trim()) {
                    textSegments.push(block.text.trim());
                }
            }
        }

        if (textSegments.length === 0) {
            ctx.ui.setStatus(STATUS_KEY, undefined);
            return;
        }

        setStatus(ctx, "speaking…");
        try {
            if (config.provider === "local") {
                // macOS `say` command plays directly
                for (const seg of textSegments) {
                    await speakLocal(seg);
                }
            } else {
                // Cloud providers: stream PCM to sox for playback
                async function* generateChunks(): AsyncIterable<Buffer> {
                    for (const seg of textSegments) {
                        yield* synthesizeStream(seg, config!.provider, {
                            ttsBaseUrl: config!.ttsBaseUrl,
                            ttsModel: config!.ttsModel,
                            ttsVoice: config!.ttsVoice,
                        });
                    }
                }
                await playPcmStream(generateChunks());
            }
        } catch (err) {
            logger.error({ err: (err as Error).message }, "TTS error");
            ctx.ui.notify(`TTS error: ${(err as Error).message}`, "warning");
        } finally {
            ctx.ui.setStatus(STATUS_KEY, undefined);
        }
    });

    // ── Shortcut registration for discoverability/help overlay ────────
    pi.registerShortcut(config.shortcut.toLowerCase() as KeyId, {
        description: "Hold-to-talk (press to start, release to send)",
        handler: async (ctx) => {
            // Actual press/release handling uses raw terminal input in session_start.
            // Keep this command as a discoverable keybinding entry in the help UI.
            ctx.ui.notify("Hold the shortcut to record, release to send", "info");
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
                if (!recorder?.isRecording) {
                    ctx.ui.notify("No active recording", "info");
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
                    ctx.ui.notify("Usage: /voice set <shortcut|provider|tts|enabled|sttModel|sttBaseUrl|ttsModel|ttsVoice|sttBaseUrl|ttsBaseUrl> <value>", "info");
                    return;
                }

                const field = restParts[0]!.toLowerCase();
                const value = restParts.slice(1).join(" ");

                if (field === "shortcut") {
                    config = updateConfig(process.cwd(), { shortcut: value.toLowerCase() });
                    ctx.ui.notify("Shortcut updated. Restart pi to apply new shortcut binding.", "info");
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

                ctx.ui.notify("Unknown setting. Use: shortcut, provider, tts, enabled, sttModel, sttBaseUrl, ttsModel, ttsVoice, ttsBaseUrl", "warning");
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

                // Interactive menu loop — mirrors pi's own settings style.
                while (true) {
                    const choice = await ctx.ui.select("pi-voice settings", [
                        `shortcut     ${config.shortcut}`,
                        `provider     ${config.provider}`,
                        `enabled      ${config.enabled}`,
                        `tts          ${config.ttsEnabled}`,
                        `sttBaseUrl   ${config.sttBaseUrl ?? "(env/default)"}`,
                        `ttsBaseUrl   ${config.ttsBaseUrl ?? "(env/default)"}`,
                        `sttModel     ${config.sttModel ?? "(env/default)"}`,
                        `ttsModel     ${config.ttsModel ?? "(env/default)"}`,
                        `ttsVoice     ${config.ttsVoice ?? "(env/default)"}`,
                        "✓ done",
                    ]);

                    if (!choice || choice.startsWith("✓")) break;

                    if (choice.startsWith("shortcut")) {
                        const val = await ctx.ui.input("Shortcut (e.g. f12, ctrl+t)", config.shortcut);
                        if (val !== undefined && val.trim()) {
                            config = updateConfig(process.cwd(), { shortcut: val.trim().toLowerCase() });
                            ctx.ui.notify("Shortcut updated — restart pi to activate.", "info");
                        }
                    } else if (choice.startsWith("provider")) {
                        const val = await ctx.ui.select("Provider", ["local", "gemini", "openai", "elevenlabs"]);
                        if (val) {
                            config = updateConfig(process.cwd(), { provider: val as PiVoiceConfig["provider"] });
                        }
                    } else if (choice.startsWith("enabled")) {
                        const val = await ctx.ui.select("Voice hotkey enabled", ["true", "false"]);
                        if (val !== undefined) {
                            config = updateConfig(process.cwd(), { enabled: val === "true" });
                        }
                    } else if (choice.startsWith("tts ")) {
                        const val = await ctx.ui.select("TTS enabled", ["true", "false"]);
                        if (val !== undefined) {
                            config = updateConfig(process.cwd(), { ttsEnabled: val === "true" });
                        }
                    } else if (choice.startsWith("sttBaseUrl")) {
                        const val = await ctx.ui.input(
                            "STT base URL (blank = use OPENAI_BASE_URL env)",
                            config.sttBaseUrl ?? "",
                        );
                        if (val !== undefined) {
                            const trimmed = val.trim();
                            config = updateConfig(process.cwd(), { sttBaseUrl: trimmed || undefined });
                        }
                    } else if (choice.startsWith("ttsBaseUrl")) {
                        const val = await ctx.ui.input(
                            "TTS base URL (blank = use OPENAI_BASE_URL env)",
                            config.ttsBaseUrl ?? "",
                        );
                        if (val !== undefined) {
                            const trimmed = val.trim();
                            config = updateConfig(process.cwd(), { ttsBaseUrl: trimmed || undefined });
                        }
                    } else if (choice.startsWith("sttModel")) {
                        const val = await ctx.ui.input(
                            "STT model (blank = use OPENAI_STT_MODEL env / whisper-1 default)",
                            config.sttModel ?? "",
                        );
                        if (val !== undefined) {
                            const trimmed = val.trim();
                            config = updateConfig(process.cwd(), { sttModel: trimmed || undefined });
                        }
                    } else if (choice.startsWith("ttsModel")) {
                        const val = await ctx.ui.input(
                            "TTS model (blank = use OPENAI_TTS_MODEL env / gpt-4o-mini-tts default)",
                            config.ttsModel ?? "",
                        );
                        if (val !== undefined) {
                            const trimmed = val.trim();
                            config = updateConfig(process.cwd(), { ttsModel: trimmed || undefined });
                        }
                    } else if (choice.startsWith("ttsVoice")) {
                        const val = await ctx.ui.input(
                            "TTS voice (blank = use OPENAI_TTS_VOICE env / alloy default)",
                            config.ttsVoice ?? "",
                        );
                        if (val !== undefined) {
                            const trimmed = val.trim();
                            config = updateConfig(process.cwd(), { ttsVoice: trimmed || undefined });
                        }
                    }
                }
                ctx.ui.notify("Settings saved.", "info");
                return;
            }

            // Default (no args or "status")
            const state = recorder?.isRecording ? "🔴 recording" : "idle";
            if (!config) {
                ctx.ui.notify(`pi-voice: ${state}  (config not loaded)`, "info");
                return;
            }
            ctx.ui.notify(`pi-voice: ${state}  (${config.provider}, enabled=${config.enabled}, tts=${config.ttsEnabled})`, "info");
        },
    });
}
