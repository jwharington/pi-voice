import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface VoiceFocus {
    sessionFile: string;
    cwd?: string;
    claimedAt?: string;
}

export interface VoiceDraft {
    id: string;
    sessionFile: string;
    text: string;
    createdAt: string;
}

export interface VoiceActivity {
    recording: boolean;
    updatedAt: string;
}

const VOICE_FOCUS_FILE = join(homedir(), ".pi-voice", "voice-focus.json");
const VOICE_INPUT_FILE = join(homedir(), ".pi-voice", "voice-input.json");
const VOICE_ACTIVITY_FILE = join(homedir(), ".pi-voice", "voice-activity.json");

function ensureVoiceDir(): void {
    mkdirSync(join(homedir(), ".pi-voice"), { recursive: true });
}

export function getVoiceFocusPath(): string {
    return VOICE_FOCUS_FILE;
}

export function getVoiceInputPath(): string {
    return VOICE_INPUT_FILE;
}

export function getVoiceActivityPath(): string {
    return VOICE_ACTIVITY_FILE;
}

export function readVoiceFocus(): VoiceFocus | null {
    if (!existsSync(VOICE_FOCUS_FILE)) return null;

    try {
        const raw = readFileSync(VOICE_FOCUS_FILE, "utf-8");
        const parsed = JSON.parse(raw) as Partial<VoiceFocus>;
        if (!parsed.sessionFile || typeof parsed.sessionFile !== "string") {
            return null;
        }
        return {
            sessionFile: parsed.sessionFile,
            cwd: parsed.cwd,
            claimedAt: parsed.claimedAt,
        };
    } catch {
        return null;
    }
}

export function publishVoiceDraft(text: string): VoiceFocus | null {
    const focus = readVoiceFocus();
    if (!focus?.sessionFile) return null;

    ensureVoiceDir();

    const draft: VoiceDraft = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        sessionFile: focus.sessionFile,
        text,
        createdAt: new Date().toISOString(),
    };

    writeFileSync(VOICE_INPUT_FILE, JSON.stringify(draft, null, 2), "utf-8");
    return focus;
}

export function publishVoiceActivity(recording: boolean): void {
    ensureVoiceDir();
    const activity: VoiceActivity = {
        recording,
        updatedAt: new Date().toISOString(),
    };
    writeFileSync(VOICE_ACTIVITY_FILE, JSON.stringify(activity, null, 2), "utf-8");
}

export function readVoiceActivity(): VoiceActivity | null {
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
