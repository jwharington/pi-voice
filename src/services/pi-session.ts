import {
  createAgentSession,
  SessionManager,
  type AgentSession,
} from "@mariozechner/pi-coding-agent";
import { existsSync } from "node:fs";
import logger from "./logger.js";
import { readVoiceFocus } from "./voice-focus.js";

let session: AgentSession | null = null;
let sessionKey = "";
let sessionCwd: string = process.cwd();

function resolveSessionTarget():
  | { key: string; mode: "in-memory" }
  | { key: string; mode: "file"; sessionFile: string } {
  const focus = readVoiceFocus();
  if (focus?.sessionFile && existsSync(focus.sessionFile)) {
    return {
      key: `file:${focus.sessionFile}`,
      mode: "file",
      sessionFile: focus.sessionFile,
    };
  }

  return { key: "in-memory", mode: "in-memory" };
}

/**
 * Set the working directory used when creating the agent session.
 * Must be called before the first getOrCreateSession() call.
 */
export function setSessionCwd(cwd: string): void {
  sessionCwd = cwd;
}

/**
 * Initialize (or reuse) a pi coding agent session.
 * Uses default discovery for skills, extensions, tools, context files.
 */
export async function getOrCreateSession(): Promise<AgentSession> {
  const target = resolveSessionTarget();
  if (session && sessionKey === target.key) return session;

  if (session && sessionKey !== target.key) {
    logger.info({ from: sessionKey, to: target.key }, "Switching agent session target");
    session.dispose();
    session = null;
    sessionKey = "";
  }

  logger.info({ cwd: sessionCwd, mode: target.mode }, "Creating new agent session");
  const result = await createAgentSession({
    cwd: sessionCwd,
    sessionManager:
      target.mode === "file"
        ? SessionManager.open(target.sessionFile)
        : SessionManager.inMemory(),
  });
  session = result.session;
  sessionKey = target.key;
  logger.info("Agent session created");
  return session;
}

export interface PromptOptions {
  /** Called each time a text block completes (text_end event). */
  onTextEnd?: (segment: string) => void | Promise<void>;
}

/**
 * Send a prompt to pi.
 * `onTextEnd` is called for each completed text segment so callers can
 * start TTS incrementally without waiting for the full response.
 */
export async function prompt(
  text: string,
  options?: PromptOptions,
): Promise<void> {
  const s = await getOrCreateSession();

  const unsubscribe = s.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_end"
    ) {
      const content = event.assistantMessageEvent.content.trim();
      if (content.length > 0) {
        logger.info({ content }, "Agent response");
        options?.onTextEnd?.(content);
      }
    }
  });

  try {
    await s.prompt(text);
  } finally {
    unsubscribe();
  }
}

/**
 * Dispose the current session.
 */
export function dispose(): void {
  if (session) {
    session.dispose();
    session = null;
    sessionKey = "";
    logger.info("Agent session disposed");
  }
}
