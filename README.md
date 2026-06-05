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
| `/voice set <shortcut\|provider\|tts\|enabled\|sttModel\|ttsModel\|ttsVoice\|sttBaseUrl\|ttsBaseUrl> <value>` | Edit and persist pi-voice settings |
| `/voice set shortcut <value>` | Update shortcut (restart pi to rebind) |

## Configuration

Configure pi-voice in `.pi/pi-voice.json` (project-level) or `~/.pi/pi-voice.json` (global fallback):

```json
{
  "shortcut": "f12",
  "provider": "openai",
  "enabled": true,
  "tts": true,
  "sttBaseUrl": "http://localhost:8010",
  "ttsBaseUrl": "http://localhost:8011",
  "sttModel": "whisper-1",
  "ttsModel": "kokoro",
  "ttsVoice": "af_heart"
}
```

| Key | Description |
| --- | --- |
| `shortcut` | Toggle-to-record shortcut. Use a supported key or modifier combo. Examples: `"f12"`, `"ctrl+t"`, `"alt+space"`. Default: `"f12"`. |
| `provider` | Speech provider for STT & TTS. `"local"`, `"gemini"` (Vertex AI or Gemini API), `"openai"`, or `"elevenlabs"`. Default: `"local"`. |
| `enabled` | Enables or disables voice shortcut handling. Default: `true`. |
| `tts` | Enable text-to-speech for agent responses. Default: `false`. |
| `sttBaseUrl` | OpenAI-compatible base URL for STT (e.g. `http://localhost:8010`). Falls back to `OPENAI_STT_BASE_URL` env, then `OPENAI_BASE_URL` env. |
| `ttsBaseUrl` | OpenAI-compatible base URL for TTS (e.g. `http://localhost:8011`). Falls back to `OPENAI_TTS_BASE_URL` env, then `OPENAI_BASE_URL` env. |
| `sttModel` | STT model name. Default: `"whisper-1"`. |
| `ttsModel` | TTS model name. Default: `"gpt-4o-mini-tts"`. |
| `ttsVoice` | TTS voice name. Default: `"alloy"`.

### Environment variables (optional fallbacks)

All `openai` provider settings can be set via `pi-voice.json` config (preferred). Environment variables act as fallbacks when config fields are not set:

| Variable | Config Field | Description |
| --- | --- | --- |
| `OPENAI_API_KEY` | — | API key. Not needed for localhost URLs — auto-detected. |
| `OPENAI_STT_BASE_URL` | `sttBaseUrl` | STT base URL |
| `OPENAI_TTS_BASE_URL` | `ttsBaseUrl` | TTS base URL |
| `OPENAI_BASE_URL` | — | Shared STT/TTS base URL (fallback for both) |
| `OPENAI_STT_MODEL` | `sttModel` | STT model (default: `whisper-1`) |
| `OPENAI_TTS_MODEL` | `ttsModel` | TTS model (default: `gpt-4o-mini-tts`) |
| `OPENAI_TTS_VOICE` | `ttsVoice` | TTS voice (default: `alloy`) |

For `gemini` and `elevenlabs` providers, env vars remain as the primary config:

| Provider | Required variables |
| --- | --- |
| `local` | None (model is auto-downloaded on first launch). Optional: `WHISPER_MODEL_PATH`, `WHISPER_MODEL` (default `medium-q5_0`), `SAY_VOICE` (macOS `say` voice name, e.g. `"Kyoko"`). |
| `gemini` | **Vertex AI:** `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` (optional, default `us-central1`). **Gemini API:** `GEMINI_API_KEY` or `GOOGLE_API_KEY`. If `GOOGLE_CLOUD_PROJECT` is set, Vertex AI is used; set `GOOGLE_GENAI_USE_VERTEXAI=false` to force API key mode. |
| `elevenlabs` | `ELEVENLABS_API_KEY`. Optional: `ELEVENLABS_VOICE_ID` (TTS voice, default `CwhRBWXzGAHq8TQ4Fs17`), `ELEVENLABS_TTS_MODEL` (default `eleven_flash_v2_5`). |

### Local OpenAI-compatible servers (Kokoro TTS + Whisper STT)

Point pi-voice at local OpenAI-compatible audio services by setting the config fields directly in `pi-voice.json`:

```json
{
  "provider": "openai",
  "sttBaseUrl": "http://localhost:8010",
  "ttsBaseUrl": "http://localhost:8011",
  "sttModel": "whisper-1",
  "ttsModel": "kokoro",
  "ttsVoice": "af_heart"
}
```

No API key is needed — pi-voice auto-detects localhost URLs and uses a dummy key.

If both services share a single URL, omit `sttBaseUrl`/`ttsBaseUrl` and use `OPENAI_BASE_URL` instead.

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
