# pi-voice

Voice interface for the [Pi Coding Agent](https://github.com/badlogic/pi-mono). Toggle recording with a shortcut, speak, and pi executes your instructions — optionally with voice feedback.

#### Demo using ElevenLabs provider (make sure unmuted)

https://github.com/user-attachments/assets/76adb941-83cf-4394-b8d2-f6d73a1df8bc

## Requirements

- [pi coding agent](https://github.com/badlogic/pi-mono) (peer dependency)
- [`sox`](http://sox.sourceforge.net/) — for microphone capture and PCM playback
  - macOS: `brew install sox`
  - Linux: `apt install sox` / `dnf install sox`

## Installation

Install pi-voice as a pi package:

```bash
pi install npm:pi-voice
```

Or for a specific project only, add it to `.pi/pi-voice.json` and install locally:

```bash
cd /your/project
pi install npm:pi-voice
```

## Usage

pi-voice runs entirely inside pi — no background daemon needed. Once installed, a push-to-talk shortcut is available whenever pi is running.

1. Press and hold the shortcut (default `f12`) to **start** recording. A spinner and VU meter appear in the status bar.
2. Release the shortcut to **stop** recording. The transcript is sent to the active pi session.
3. On terminals without key-release events, pi-voice falls back to press-to-toggle behavior.
3. pi-voice plays a short click when recording starts and another when recording stops.
4. If TTS is enabled, pi-voice speaks the agent's response back to you when the turn completes.

### Commands

| Command | Description |
| --- | --- |
| `/voice` | Show current pi-voice status and configuration |
| `/voice stop` | Cancel an in-progress recording |
| `/voice config` | Print the resolved configuration |
| `/voice enable` | Enable voice hotkey handling |
| `/voice disable` | Disable voice hotkey handling |
| `/voice set <shortcut\|provider\|tts\|enabled> <value>` | Edit and persist pi-voice settings |
| `/voice set shortcut <value>` | Update shortcut (restart pi to rebind) |

## Configuration

Configure pi-voice in `.pi/pi-voice.json` (project-level) or `~/.pi/pi-voice.json` (global fallback):

```json
{
  "shortcut": "f12",
  "provider": "openai",
  "enabled": true,
  "tts": true
}
```

| Key | Description |
| --- | --- |
| `shortcut` | Toggle-to-record shortcut. Use a supported key or modifier combo. Examples: `"f12"`, `"ctrl+t"`, `"alt+space"`. Default: `"f12"`. |
| `provider` | Speech provider for STT & TTS. `"local"`, `"gemini"` (Vertex AI or Gemini API), `"openai"`, or `"elevenlabs"`. Default: `"local"`. |
| `enabled` | Enables or disables voice shortcut handling. Default: `true`. |
| `tts` | Enable text-to-speech for agent responses. Default: `false`. |

### Environment variables

| Provider | Required variables |
| --- | --- |
| `local` | None (model is auto-downloaded on first launch). Optional: `WHISPER_MODEL_PATH` (custom model path), `WHISPER_MODEL` (model name, default `medium-q5_0`), `SAY_VOICE` (macOS `say` voice name, e.g. `"Kyoko"`). |
| `gemini` | **Vertex AI:** `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` (optional, default `us-central1`). **Gemini API:** `GEMINI_API_KEY` or `GOOGLE_API_KEY`. If `GOOGLE_CLOUD_PROJECT` is set, Vertex AI is used; set `GOOGLE_GENAI_USE_VERTEXAI=false` to force API key mode. |
| `openai` | `OPENAI_API_KEY`. Optional: `OPENAI_BASE_URL` (shared STT/TTS base URL), `OPENAI_STT_BASE_URL` (STT-only URL, overrides `OPENAI_BASE_URL`), `OPENAI_TTS_BASE_URL` (TTS-only URL, overrides `OPENAI_BASE_URL`), `OPENAI_STT_MODEL` (default `whisper-1`), `OPENAI_STT_RESPONSE_FORMAT` (default `json`), `OPENAI_STT_PROMPT`, `OPENAI_STT_LANGUAGE`, `OPENAI_STT_TEMPERATURE`, `OPENAI_TTS_MODEL` (default `gpt-4o-mini-tts`), `OPENAI_TTS_VOICE` (default `alloy`). |
| `elevenlabs` | `ELEVENLABS_API_KEY`. Optional: `ELEVENLABS_VOICE_ID` (TTS voice, default `CwhRBWXzGAHq8TQ4Fs17`), `ELEVENLABS_TTS_MODEL` (default `eleven_flash_v2_5`). |

### Logging

Logs are written to `$XDG_CONFIG_HOME/pi-voice/pi-voice.log` (falls back to `~/.config/pi-voice/pi-voice.log`).

To override the log file path:

```bash
export PI_VOICE_LOG_PATH=/path/to/custom.log
```

### Local OpenAI-compatible servers (Kokoro TTS + Whisper STT)

When running local OpenAI-compatible audio services (e.g. Kokoro FastAPI for TTS, hwdsl2/whisper-server for STT), you can point pi-voice at them using separate STT and TTS base URLs:

```bash
export OPENAI_STT_BASE_URL=http://localhost:8010
export OPENAI_TTS_BASE_URL=http://localhost:8011
export OPENAI_TTS_VOICE=af_heart    # Kokoro voice
export OPENAI_TTS_MODEL=kokoro
```

Set `"provider": "openai"` in your pi-voice config. No API key is needed — pi-voice auto-detects localhost URLs and uses a dummy key.

You can also use a single shared URL if both services run on the same host:

```bash
export OPENAI_BASE_URL=http://localhost:8000
```

### Whisper model (local provider)

The `local` provider uses [Whisper](https://github.com/openai/whisper) for STT and the `sox` play command for TTS playback. On first launch, a ggml-format Whisper model (`medium-q5_0`, ~514 MB) is automatically downloaded to `~/.pi-agent/whisper/` and cached for subsequent runs.

To use a different model, set `WHISPER_MODEL`:

```bash
export WHISPER_MODEL=base     # smaller & faster
```

Or point to your own model file directly:

```bash
export WHISPER_MODEL_PATH=/path/to/ggml-custom.bin
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, build commands, and release workflow.
