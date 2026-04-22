/**
 * Centralized pino logger for pi-voice.
 *
 * Log file location (in order of precedence):
 *   1. PI_VOICE_LOG_PATH environment variable
 *   2. $XDG_CONFIG_HOME/pi-voice/pi-voice.log  (if XDG_CONFIG_HOME is set)
 *   3. ~/.config/pi-voice/pi-voice.log          (default)
 */

import { join } from "node:path";
import { homedir } from "node:os";
import pino from "pino";

function resolveLogPath(): string {
  const envPath = process.env["PI_VOICE_LOG_PATH"];
  if (envPath) return envPath;

  const configHome =
    process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config");
  return join(configHome, "pi-voice", "pi-voice.log");
}

const logPath = resolveLogPath();

const logger = pino(
  {
    level: "info",
  },
  pino.destination({ dest: logPath, mkdir: true, sync: true }),
);

export default logger;

/**
 * Return the resolved log file path (useful for status/diagnostics).
 */
export function getLogPath(): string {
  return logPath;
}
