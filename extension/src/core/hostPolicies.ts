import { LOCAL_FILE_HOST } from "./localFile";

export const EXTERNAL_VOLUME_HOSTS = new Set(["youtube", "googledrive"]);

export const YOUTUBE_LIKE_HOSTS = EXTERNAL_VOLUME_HOSTS;

export const MUTE_SYNC_DISABLED_HOSTS = new Set(["rutube", "ok"]);
/**
 * Хосты, для которых Яндекс не может скачать видео сам и ждёт от нас загрузку
 * аудио (`AUDIO_REQUESTED` → `requestVtransAudio`).
 *
 * `LOCAL_FILE_HOST` (`custom`) добавлен ради `file:///…/video.mp4`: сервер
 * физически не достанет файл с диска зрителя. Для обычных прямых http-ссылок
 * на mp4 (тот же `custom`) ничего не меняется — Яндекс их скачивает сам, до
 * ветки `AUDIO_REQUESTED` дело не доходит.
 */
export const TRANSLATION_DOWNLOAD_HOSTS = new Set([
  "youtube",
  "invidious",
  "piped",
  LOCAL_FILE_HOST,
]);

export function isExternalVolumeHost(host: string): boolean {
  return EXTERNAL_VOLUME_HOSTS.has(host);
}

export function isYouTubeLikeHost(host: string): boolean {
  return YOUTUBE_LIKE_HOSTS.has(host);
}

export function isMuteSyncDisabledHost(host: string): boolean {
  return MUTE_SYNC_DISABLED_HOSTS.has(host);
}

export function isDesktopYouTubeLikeSite(site: {
  host: string;
  additionalData?: string | null;
}): boolean {
  return isYouTubeLikeHost(site.host) && site.additionalData !== "mobile";
}

export function isTranslationDownloadHost(host: string): boolean {
  return TRANSLATION_DOWNLOAD_HOSTS.has(host);
}
