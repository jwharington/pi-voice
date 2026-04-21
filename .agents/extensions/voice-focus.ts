import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const VOICE_DIR = join(homedir(), ".pi-voice");
const VOICE_FOCUS_FILE = join(VOICE_DIR, "voice-focus.json");
const VOICE_INPUT_FILE = join(VOICE_DIR, "voice-input.json");

type VoiceDraft = {
    id: string;
    sessionFile: string;
    text: string;
    createdAt: string;
};

let pollTimer: ReturnType<typeof setInterval> | null = null;
let activeSessionFile: string | undefined;
let lastSeenDraftId: string | undefined;

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

function startDraftPolling(ctx: any) {
    if (pollTimer) return;

    const initialDraft = readDraft();
    if (initialDraft?.id) {
        lastSeenDraftId = initialDraft.id;
    }

    pollTimer = setInterval(() => {
        if (!activeSessionFile) return;
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

export default function (pi: ExtensionAPI) {
    pi.on("session_start", async (_event, ctx) => {
        activeSessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
        startDraftPolling(ctx);
    });

    pi.on("session_shutdown", async () => {
        stopDraftPolling();
        activeSessionFile = undefined;
    });

    pi.registerCommand("voice", {
        description: "Claim or clear pi-voice routing focus (usage: /voice [off|status])",
        handler: async (args, ctx) => {
            const action = args.trim().toLowerCase();

            if (action === "off") {
                rmSync(VOICE_FOCUS_FILE, { force: true });
                ctx.ui.notify("Voice focus cleared", "info");
                return;
            }

            if (action === "status") {
                const sessionFile = ctx.sessionManager.getSessionFile();
                if (!sessionFile) {
                    ctx.ui.notify("Session is ephemeral; cannot claim voice focus", "warn");
                    return;
                }
                ctx.ui.notify(`Voice candidate: ${sessionFile}`, "info");
                return;
            }

            const sessionFile = ctx.sessionManager.getSessionFile();
            if (!sessionFile) {
                ctx.ui.notify("This session is ephemeral. Use /resume on a saved session first.", "warn");
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
