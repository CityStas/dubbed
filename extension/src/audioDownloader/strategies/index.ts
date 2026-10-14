import { AudioDownloadType } from "@vot.js/core/types/yandex";

import { getAudioFromLocalFile, LOCAL_FILE_STRATEGY } from "./localFile";
import { getAudioFromWebMseProxy } from "./webMseProxy";

export const WEB_MSE_PROXY_STRATEGY = AudioDownloadType.WEB_MSE_PROXY;

export { LOCAL_FILE_STRATEGY };

export const strategies = {
  [WEB_MSE_PROXY_STRATEGY]: getAudioFromWebMseProxy,
  // [localfile] file:///…/video.mp4 — байты отдаёт ридер расширения.
  [LOCAL_FILE_STRATEGY]: getAudioFromLocalFile,
} as const;

export type AvailableAudioDownloadType = keyof typeof strategies;
