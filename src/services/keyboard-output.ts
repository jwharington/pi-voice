import { spawnSync } from "node:child_process";

type KeyboardBackend = "auto" | "wtype" | "xdotool" | "ydotool";

function hasCommand(command: string): boolean {
  const result = spawnSync("which", [command], {
    stdio: "ignore",
    env: process.env,
  });
  return result.status === 0;
}

function preferredAutoOrder(): Array<Exclude<KeyboardBackend, "auto">> {
  const isWayland =
    process.env["XDG_SESSION_TYPE"] === "wayland" ||
    !!process.env["WAYLAND_DISPLAY"];

  return isWayland
    ? ["wtype", "ydotool", "xdotool"]
    : ["xdotool", "wtype", "ydotool"];
}

function resolveBackend(preferred: KeyboardBackend): Exclude<KeyboardBackend, "auto"> {
  if (preferred !== "auto") {
    if (!hasCommand(preferred)) {
      throw new Error(`Keyboard backend '${preferred}' not found in PATH`);
    }
    return preferred;
  }

  for (const backend of preferredAutoOrder()) {
    if (hasCommand(backend)) return backend;
  }

  throw new Error("No keyboard backend available. Install one of: wtype, xdotool, ydotool");
}

export async function typeTextIntoFocusedApp(
  text: string,
  preferredBackend: KeyboardBackend,
  typeDelayMs: number,
): Promise<{ backend: Exclude<KeyboardBackend, "auto"> }> {
  const backend = resolveBackend(preferredBackend);

  const args = backend === "wtype"
    ? [text]
    : backend === "xdotool"
      ? ["type", "--clearmodifiers", "--delay", String(typeDelayMs), text]
      : ["type", text];

  const result = spawnSync(backend, args, {
    env: process.env,
    encoding: "utf-8",
  });

  if (result.status !== 0) {
    const errText = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`Failed to type text using ${backend}${errText ? `: ${errText}` : ""}`);
  }

  return { backend };
}
