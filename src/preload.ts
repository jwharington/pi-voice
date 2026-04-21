import { contextBridge, ipcRenderer } from "electron";
import {
  IPC,
  type PiVoiceAPI,
  type AudioStreamMeta,
  type RecordingFormat,
  type StartRecordingOptions,
} from "./shared/types.js";

const api: PiVoiceAPI = {
  onStartRecording: (callback) => {
    ipcRenderer.on(
      IPC.START_RECORDING,
      (_event, payload: StartRecordingOptions | RecordingFormat) => {
        if (typeof payload === "string") {
          callback({
            format: payload ?? "webm",
            chunkRolloverMs: 30000,
            rolloverClickGain: 0.005,
          });
          return;
        }

        callback({
          format: payload?.format ?? "webm",
          chunkRolloverMs: payload?.chunkRolloverMs ?? 30000,
          rolloverClickGain: payload?.rolloverClickGain ?? 0.005,
        });
      },
    );
  },
  onStopRecording: (callback) => {
    ipcRenderer.on(IPC.STOP_RECORDING, () => callback());
  },
  onPlayAudioStreamStart: (callback) => {
    ipcRenderer.on(
      IPC.PLAY_AUDIO_STREAM_START,
      (_event, meta: AudioStreamMeta) => callback(meta)
    );
  },
  onPlayAudioStreamChunk: (callback) => {
    ipcRenderer.on(
      IPC.PLAY_AUDIO_STREAM_CHUNK,
      (_event, pcmData: ArrayBuffer) => callback(pcmData)
    );
  },
  onPlayAudioStreamEnd: (callback) => {
    ipcRenderer.on(IPC.PLAY_AUDIO_STREAM_END, () => callback());
  },
  sendRecordingData: (data) => {
    ipcRenderer.send(IPC.RECORDING_DATA, data);
  },
  sendRecordingError: (error) => {
    ipcRenderer.send(IPC.RECORDING_ERROR, error);
  },
  sendPlaybackDone: () => {
    ipcRenderer.send(IPC.PLAYBACK_DONE);
  },
};

contextBridge.exposeInMainWorld("piVoice", api);
