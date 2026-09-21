import {
  VideoTranslationStatus,
  type VideoTranslationResponse,
} from "@vot.js/core/types/yandex";
import type { RequestLang, ResponseLang } from "@vot.js/shared/types/data";

import type { CacheTranslationSuccess } from "../../types/core/cacheManager";
import type { VideoData } from "../shared";
import type { ActionContext } from "./translationTypes";

export type TranslationAudioResult = {
  url: string;
  usedLivelyVoice: boolean;
  /**
   * `true`, если Яндекс отдал только ЧАСТЬ озвучки (`status 5 PART_CONTENT`):
   * аудио уже можно играть, но оно короче видео (наблюдали duration 600 при
   * полной 1332). Такую озвучку не кэшируем как финальную и догружаем полную
   * версию в фоне, подменяя источник на ходу.
   */
  isPartial: boolean;
};

type TranslationRequester = {
  translateVideoImpl(
    videoData: VideoData,
    requestLang: RequestLang,
    responseLang: ResponseLang,
    translationHelp: VideoData["translationHelp"],
    shouldSendFailedAudio: boolean,
    signal: AbortSignal,
    options?: { silent?: boolean },
  ): Promise<(VideoTranslationResponse & { usedLivelyVoice: boolean }) | null>;
};

export function normalizeTranslationHelp(
  translationHelp: VideoData["translationHelp"] | undefined,
): VideoData["translationHelp"] {
  return translationHelp ?? null;
}

export async function requestTranslationAudio(
  requester: TranslationRequester,
  options: {
    videoData: VideoData;
    requestLang: RequestLang;
    responseLang: ResponseLang;
    translationHelp: VideoData["translationHelp"] | undefined;
    useAudioDownload?: boolean;
    signal: AbortSignal;
    /** Фоновый запрос: не показывать статусы/ошибки в UI. */
    silent?: boolean;
  },
): Promise<TranslationAudioResult | null> {
  const response = await requester.translateVideoImpl(
    options.videoData,
    options.requestLang,
    options.responseLang,
    normalizeTranslationHelp(options.translationHelp),
    !options.useAudioDownload,
    options.signal,
    { silent: options.silent },
  );

  if (!response || !response.translated) {
    return null;
  }

  return {
    url: response.url,
    usedLivelyVoice: Boolean(response.usedLivelyVoice),
    isPartial: response.status === VideoTranslationStatus.PART_CONTENT,
  };
}

export function buildTranslationCacheValue(options: {
  videoId: string;
  requestLang: string;
  responseLang: string;
  fallbackUrl: string;
  downloadTranslationUrl?: string | null;
  usedLivelyVoice: boolean;
}): CacheTranslationSuccess {
  return {
    videoId: options.videoId,
    from: options.requestLang,
    to: options.responseLang,
    url: options.downloadTranslationUrl ?? options.fallbackUrl,
    useLivelyVoice: options.usedLivelyVoice,
  };
}

/**
 * Executes an async action with staleness guards before and after.
 * Returns true if the action completed without becoming stale.
 *
 * Centralizes the "check stale -> act -> re-check stale" pattern that was
 * previously duplicated across updateTranslationIfFresh and
 * requestAndApplyTranslation.
 */
export async function withStaleGuard(
  actionContext: ActionContext | undefined,
  isActionStale: (ctx?: ActionContext) => boolean,
  action: () => Promise<void>,
): Promise<boolean> {
  if (isActionStale(actionContext)) return false;
  await action();
  return !isActionStale(actionContext);
}

export async function updateTranslationIfFresh(options: {
  url: string;
  actionContext?: ActionContext;
  usedLivelyVoice?: boolean;
  isActionStale(actionContext?: ActionContext): boolean;
  updateTranslation(
    url: string,
    actionContext?: ActionContext,
    usedLivelyVoice?: boolean,
  ): Promise<void>;
}): Promise<boolean> {
  return withStaleGuard(options.actionContext, options.isActionStale, () =>
    options.updateTranslation(
      options.url,
      options.actionContext,
      options.usedLivelyVoice,
    ),
  );
}

export function setTranslationCacheValue(options: {
  cacheKey: string;
  setTranslation(key: string, value: CacheTranslationSuccess): void;
  videoId: string;
  requestLang: string;
  responseLang: string;
  fallbackUrl: string;
  downloadTranslationUrl?: string | null;
  usedLivelyVoice: boolean;
}): void {
  options.setTranslation(
    options.cacheKey,
    buildTranslationCacheValue({
      videoId: options.videoId,
      requestLang: options.requestLang,
      responseLang: options.responseLang,
      fallbackUrl: options.fallbackUrl,
      downloadTranslationUrl: options.downloadTranslationUrl,
      usedLivelyVoice: options.usedLivelyVoice,
    }),
  );
}
