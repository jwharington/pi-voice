import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const VOICE_DIR = join(homedir(), ".pi-voice");
const VOICE_FOCUS_FILE = join(VOICE_DIR, "voice-focus.json");
const VOICE_INPUT_FILE = join(VOICE_DIR, "voice-input.json");
const VOICE_ACTIVITY_FILE = join(VOICE_DIR, "voice-activity.json");

type VoiceDraft = {
    id: string;
    sessionFile: string;
    text: string;
    createdAt: string;
};

type VoiceActivity = {
    recording: boolean;
    updatedAt: string;
};

let pollTimer: ReturnType<typeof setInterval> | null = null;
let activeSessionFile: string | undefined;
let lastSeenDraftId: string | undefined;
let spinnerFrame = 0;

const SPINNER_FRAMES = ["⠁", "⠂", "⠄", "⠂"];

function readDraft(): VoiceDraft | null {
    if (!existsSync(VOICE_INPUT_FILE)) return null;
    try {
        const raw = readFileSync(VOICE_INPUT_FILE, "utf-8");
        const parsed = JSON.parse(raw) as Partial<VoiceDraft>;
        if (!parsed.id || !parsed.sessionFile || typeof parsed.text !== "string") {
            return null;
        }
        return {
            id: parsed.id,
            sessionFile: parsed.sessionFile,
            text: parsed.text,
            createdAt: parsed.createdAt ?? "",
        };
    } catch {
        return null;
    }
}

function readActivity(): VoiceActivity | null {
    if (!existsSync(VOICE_ACTIVITY_FILE)) return null;
    try {
        const raw = readFileSync(VOICE_ACTIVITY_FILE, "utf-8");
        const parsed = JSON.parse(raw) as Partial<VoiceActivity>;
        if (typeof parsed.recording !== "boolean") {
            return null;
        }
        return {
            recording: parsed.recording,
            updatedAt: parsed.updatedAt ?? "",
        };
    } catch {
        return null;
    }
}

function readFocusSessionFile(): string | undefined {
    if (!existsSync(VOICE_FOCUS_FILE)) return undefined;
    try {
        const raw = readFileSync(VOICE_FOCUS_FILE, "utf-8");
        const parsed = JSON.parse(raw) as { sessionFile?: string };
        return typeof parsed.sessionFile === "string" ? parsed.sessionFile : undefined;
    } catch {
        return undefined;
    }
}

function startDraftPolling(ctx: any) {
    if (pollTimer) return;

    const initialDraft = readDraft();
    if (initialDraft?.id) {
        lastSeenDraftId = initialDraft.id;
    }

    pollTimer = setInterval(() => {
        if (!activeSessionFile) return;

        const focusedSessionFile = readFocusSessionFile();
        const isFocused = focusedSessionFile === activeSessionFile;
        const activity = readActivity();
        if (isFocused && activity?.recording) {
            const spin = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]!;
            spinnerFrame++;
            ctx.ui.setWidget("voice-recording", [`${spin} voice recording`], { placement: "belowEditor" });
        } else {
            ctx.ui.setWidget("voice-recording", undefined);
        }

        const draft = readDraft();
        if (!draft) return;
        if (draft.id === lastSeenDraftId) return;
        if (draft.sessionFile !== activeSessionFile) return;

        const current = ctx.ui.getEditorText();
        const separator = current.length > 0 && !current.endsWith(" ") ? " " : "";
        ctx.ui.setEditorText(`${current}${separator}${draft.text}`);
        lastSeenDraftId = draft.id;
        ctx.ui.notify("Voice text inserted", "info");
    }, 250);
}

function stopDraftPolling() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
}

type PiVoiceCommandResult = {
    ok: boolean;
    stdout: string;
    stderr: string;
};

function runPiVoiceCommand(args: string[]): PiVoiceCommandResult {
    const result = spawnSync("pi-voice", args, {
        cwd: process.cwd(),
        env: process.env,
        encoding: "utf-8",
    });
    return {
        ok: result.status === 0,
        stdout: (result.stdout ?? "").toString().trim(),
        stderr: (result.stderr ?? "").toString().trim(),
    };
}

function getDaemonStatus() {
    const res = runPiVoiceCommand(["status"]);
    const output = [res.stdout, res.stderr].filter(Boolean).join("\n").trim();

    if (res.ok && res.stdout.startsWith("running:")) {
        return { running: true, message: res.stdout };
    }

    if (output.includes("not running")) {
        return { running: false, message: output || "not running" };
    }

    return {
        running: false,
        message: output || "failed to get daemon status",
    };
}

function ensureDaemonRunning(ctx: any): boolean {
    const status = getDaemonStatus();
    if (status.running) return true;

    const startRes = runPiVoiceCommand(["start"]);
    if (!startRes.ok) {
        const detail = [startRes.stdout, startRes.stderr].filter(Boolean).join("\n").trim();
        ctx.ui.notify(`Failed to start pi-voice${detail ? `: ${detail}` : ""}`, "error");
        return false;
    }

    const verify = getDaemonStatus();
    if (!verify.running) {
        ctx.ui.notify(`pi-voice start did not produce a running daemon: ${verify.message}`, "error");
        return false;
    }

    ctx.ui.notify("pi-voice daemon started", "info");
    return true;
}

export default function (pi: ExtensionAPI) {
    pi.on("session_start", async (_event, ctx) => {
        activeSessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
        spinnerFrame = 0;
        startDraftPolling(ctx);
    });

    pi.on("session_shutdown", async (_event, ctx) => {
        stopDraftPolling();
        activeSessionFile = undefined;
        ctx.ui.setWidget("voice-recording", undefined);
    });

    pi.registerCommand("voice", {
        description: "Manage pi-voice focus and daemon (usage: /voice [off|status|stop])",
        handler: async (args, ctx) => {
            const action = args.trim().toLowerCase();

            if (action === "off") {
                rmSync(VOICE_FOCUS_FILE, { force: true });
                ctx.ui.notify("Voice focus cleared", "info");
                return;
            }

            if (action === "stop") {
                const stopRes = runPiVoiceCommand(["stop"]);
                if (!stopRes.ok) {
                    const detail = [stopRes.stdout, stopRes.stderr].filter(Boolean).join("\n").trim();
                    ctx.ui.notify(`Failed to stop pi-voice${detail ? `: ${detail}` : ""}`, "warn");
                    return;
                }

                rmSync(VOICE_FOCUS_FILE, { force: true });
                ctx.ui.setWidget("voice-recording", undefined);
                ctx.ui.notify("pi-voice daemon stopped and voice focus cleared", "info");
                return;
            }

            if (action === "status") {
                const daemon = getDaemonStatus();
                const focusedSessionFile = readFocusSessionFile();
                const sessionFile = ctx.sessionManager.getSessionFile();

                const daemonLine = `pi-voice: ${daemon.running ? "running" : "not running"}`;
                const focusLine = focusedSessionFile
                    ? `focus: ${focusedSessionFile === sessionFile ? "this session" : focusedSessionFile}`
                    : "focus: none";
                const details = [daemonLine, focusLine, daemon.message].filter(Boolean).join("\n");
                ctx.ui.notify(details, "info");
                return;
            }

            const sessionFile = ctx.sessionManager.getSessionFile();
            if (!sessionFile) {
                ctx.ui.notify("This session is ephemeral. Use /resume on a saved session first.", "warn");
                return;
            }

            if (!ensureDaemonRunning(ctx)) {
                return;
            }

            mkdirSync(VOICE_DIR, { recursive: true });
            writeFileSync(
                VOICE_FOCUS_FILE,
                JSON.stringify(
                    {
                        sessionFile,
                        cwd: process.cwd(),
                        claimedAt: new Date().toISOString(),
                        pid: process.pid,
                    },
                    null,
                    2,
                ),
                "utf-8",
            );

            activeSessionFile = sessionFile;
            startDraftPolling(ctx);

            ctx.ui.notify(`Voice focus claimed by this session`, "info");
        },
    });
}
