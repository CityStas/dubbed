import {
  VideoTranslationStatus,
  type VideoTranslationResponse,
} from "@vot.js/core/types/yandex";
import type { RequestLang, ResponseLang } from "@vot.js/shared/types/data";

import { isTranslationDownloadHost } from "../../core/hostPolicies";
import { notifyTranslationFailureIfNeeded } from "../../core/translationErrors";
import { localizationProvider } from "../../localization/localizationProvider";
import debug from "../../utils/debug";
import { toErrorMessage } from "../../utils/errors";
import type { VideoHandler } from "../../VideoHandler";
import DubbedLocalizedError from "../../DubbedLocalizedError";
import type { VideoData } from "../shared";
import { applyTranslationPlaybackVolume } from "../translationVolume";
import {
  isYandexAudioUrlOrProxy,
  proxifyYandexAudioUrl,
  unproxifyYandexAudioUrl,
} from "./proxyShared";
import {
  getIndexedSubtitleDescriptors,
  pickBestSubtitlesIndex,
} from "./subtitlesShared";
import {
  normalizeTranslationHelp,
  requestTranslationAudio,
  setTranslationCacheValue,
  type TranslationAudioResult,
  updateTranslationIfFresh,
  withStaleGuard,
} from "./translationShared";
import type {
  ActionContext,
  ApplyTranslationSourceResult,
} from "./translationTypes";

async function resumePlayerAudioContextIfNeeded(
  handler: VideoHandler,
): Promise<"not-needed" | "resumed" | "timeout" | "failed"> {
  const ctx = handler.audioPlayer?.audioContext;
  if (ctx?.state !== "suspended") return "not-needed";

  const RESUME_TIMEOUT_MS = 1500;

  const resumePromise = (async (): Promise<"resumed" | "failed"> => {
    try {
      await ctx.resume();
      return "resumed";
    } catch (err) {
      debug.log("[updateTranslation] Failed to resume AudioContext", err);
      return "failed";
    }
  })();

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timeoutId = setTimeout(() => resolve("timeout"), RESUME_TIMEOUT_MS);
  });

  const result = await Promise.race([resumePromise, timeoutPromise]);
  if (timeoutId !== undefined) {
    clearTimeout(timeoutId);
  }

  if (result === "resumed") {
    debug.log("[updateTranslation] AudioContext resumed");
  } else if (result === "timeout") {
    debug.log("[updateTranslation] AudioContext resume timeout");
  }

  return result;
}

async function rollbackStaleAppliedSourceIfStillCurrent(
  handler: VideoHandler,
  appliedSourceUrl: string | null,
): Promise<void> {
  if (!appliedSourceUrl || !handler.audioPlayer) return;

  const player = handler.audioPlayer.player;
  const currentSource = String(player.currentSrc || player.src || "");
  const normalizedCurrentUrl = handler.proxifyAudio(
    handler.unproxifyAudio(currentSource),
  );
  const normalizedAppliedUrl = handler.proxifyAudio(
    handler.unproxifyAudio(appliedSourceUrl),
  );
  if (normalizedCurrentUrl !== normalizedAppliedUrl) return;

  try {
    await player.clear();
    player.src = "";
    debug.log("[updateTranslation] cleared stale partially-applied source");
  } catch (err) {
    debug.log("[updateTranslation] failed to clear stale source", err);
  }
}

export async function validateAudioUrl(
  this: VideoHandler,
  audioUrl: string,
  actionContext?: ActionContext,
): Promise<string> {
  if (this.isActionStale(actionContext)) return audioUrl;
  return audioUrl;
}

export function scheduleTranslationRefresh(this: VideoHandler): void {
  if (!this.videoData || this.videoData.isStream) {
    return;
  }
  if (!this.hasActiveSource()) return;
  void this.refreshTranslationAudio().catch((error) => {
    debug.log("[scheduleTranslationRefresh] refresh failed", error);
  });
}

export async function handlePlaybackResumedTranslationRefresh(
  this: VideoHandler,
): Promise<void> {
  if (!this.videoData || this.videoData.isStream) {
    return;
  }
  if (!this.hasActiveSource()) {
    return;
  }

  const videoId = this.videoData.videoId;
  if (!videoId) {
    return;
  }

  // Если перевод УЖЕ идёт (в т.ч. цепочка ретраев shouldRetry), повторный запрос
  // после перемотки создаёт ВТОРУЮ сессию перевода у Яндекса (наблюдали новый
  // `translationId` через 2 c после seek) — пользователь видит, что прогресс
  // «сбросился». Ничего не делаем, пока активна текущая попытка.
  if (this.activeTranslation || this.isRefreshingTranslation) {
    debug.log(
      "[scheduleTranslationRefresh] translation already in flight, skipping resume refresh",
    );
    return;
  }

  // Жалоба 2026-09-13: «перевёл длинный фильм, сам перематываю — перевод и
  // озвучка слетают». Перемотка у большинства плееров = pause → play, а это
  // событие дергает этот обработчик. Частичная озвучка (status 5) в кэш не
  // пишется по замыслу (иначе никогда не доберём полную), поэтому кэш выглядел
  // «протухшим» и мы заново шли в Яндекс — не в silent-режиме: на любой отказ
  // (а на «Плеере 1»/ortified это часто) UI уезжал в «Возникла ошибка…» и
  // «Ready» пропадал. Пока играет частичная озвучка — не трогаем её вообще:
  // полную версию добирает schedulePartialTranslationUpgrade.
  if (this.partialAudioActive) {
    debug.log(
      "[scheduleTranslationRefresh] partial audio is playing, skipping resume refresh",
    );
    return;
  }

  const normalizedTranslationHelp = normalizeTranslationHelp(
    this.videoData.translationHelp,
  );
  const cacheKey = this.getTranslationCacheKey(
    videoId,
    this.translateFromLang,
    this.translateToLang,
    normalizedTranslationHelp,
  );
  const cachedEntry = this.cacheManager.getTranslation(cacheKey);

  if (!cachedEntry?.url) {
    debug.log(
      "[scheduleTranslationRefresh] translation cache expired after resume, refreshing now",
    );
    try {
      await this.refreshTranslationAudio();
    } catch (error) {
      // Фон, а не пользовательская команда: ошибку только логируем, чтобы не
      // перезаписать уже показанное «Ready»/играющую озвучку.
      debug.log("[scheduleTranslationRefresh] background refresh failed", error);
    }
  }
}

type ApplyAndCacheOptions = {
  videoData: VideoData;
  requestLang: RequestLang;
  responseLang: ResponseLang;
  translationHelp: VideoData["translationHelp"] | undefined;
  actionContext: ActionContext;
  cacheKey: string;
  cacheVideoId: string;
  cacheRequestLang: string;
  cacheResponseLang: string;
  /**
   * Фоновый запрос: не трогать UI (статусы, ошибки). Используется
   * resume-refresh'ем после перемотки/паузы — там любая ошибка не должна
   * перезаписывать «Ready» и убивать уже играющую озвучку.
   */
  silent?: boolean;
  onBeforeCache?: (result: TranslationAudioResult) => Promise<void> | void;
};

/** Как часто в фоне спрашиваем у Яндекса полную версию озвучки. */
const PARTIAL_UPGRADE_INTERVAL_MS = 10_000;
/** Предохранитель: ~7 минут ожидания полной версии, потом остаёмся на частичной. */
const PARTIAL_UPGRADE_MAX_ATTEMPTS = 40;
/** Жёсткий потолок ожидания полной озвучки — 30 минут. */
const PARTIAL_UPGRADE_HARD_CAP_ATTEMPTS = 180;

/**
 * Сколько раз поллить полную озвучку для конкретного видео.
 *
 * Жалоба 2026-09-13: «перевёл длинный фильм (1 ч 50 мин) — перевода нет».
 * Для длинных фильмов Яндекс отдаёт PART_CONTENT с коротким `duration`
 * (наблюдали 600 c при полных 1332 c), то есть озвучка заканчивается на 10-й
 * минуте, а жёсткие 40 попыток × 10 c (~7 мин) истекали раньше, чем Яндекс
 * успевал досчитать остаток: пользователь до конца фильма оставался с
 * 10-минутной озвучкой. Масштабируем окно по длительности видео
 * (1 попытка на минуту материала) с потолком в 30 минут.
 */
function resolvePartialUpgradeAttempts(videoData: VideoData): number {
  const duration = Number(videoData.duration) || 0;
  if (!Number.isFinite(duration) || duration <= 0) {
    return PARTIAL_UPGRADE_MAX_ATTEMPTS;
  }
  const scaled = Math.ceil(duration / 60);
  return Math.min(
    PARTIAL_UPGRADE_HARD_CAP_ATTEMPTS,
    Math.max(PARTIAL_UPGRADE_MAX_ATTEMPTS, scaled),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Яндекс умеет отдавать ЧАСТИЧНУЮ озвучку (`status 5 PART_CONTENT`): url уже
 * рабочий, но аудио короче видео (наблюдали duration 600 при полной 1332).
 * Раньше мы её игнорировали и ждали FINISHED — из-за этого в UI продолжали
 * мелькать статусы, хотя озвучка уже существовала.
 *
 * Теперь частичную включаем сразу, а полную добираем здесь — в фоне и не трогая
 * UI (`silent`). Подмена источника безопасна: `updateTranslation` выставляет src
 * и делает lipSync, который синхронизирует `audio.currentTime` с позицией видео,
 * поэтому звук продолжается с того же места.
 */
function schedulePartialTranslationUpgrade(
  self: VideoHandler,
  options: ApplyAndCacheOptions,
): void {
  if (self.partialUpgradeKey === options.cacheKey) return;
  self.partialUpgradeKey = options.cacheKey;

  debug.log(
    "[partialUpgrade] partial audio applied, polling for the full version",
    { videoId: options.cacheVideoId, cacheKey: options.cacheKey },
  );

  void (async () => {
    try {
      const maxAttempts = resolvePartialUpgradeAttempts(options.videoData);
      debug.log("[partialUpgrade] waiting for the full version", {
        videoId: options.cacheVideoId,
        duration: options.videoData.duration,
        maxAttempts,
      });
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await sleep(PARTIAL_UPGRADE_INTERVAL_MS);
        if (self.isActionStale(options.actionContext)) return;

        let next:
          | (VideoTranslationResponse & { usedLivelyVoice: boolean })
          | null = null;
        try {
          // Зовём хендлер напрямую (а не requestTranslationAudio): в silent-режиме
          // он отдаёт и «ещё не готово», и готовый ответ, а нам нужно различать
          // «ждём дальше» и «ошибка/отмена».
          next = await self.translationHandler.translateVideoImpl(
            options.videoData,
            options.requestLang,
            options.responseLang,
            normalizeTranslationHelp(options.translationHelp),
            !self.data?.useAudioDownload,
            self.actionsAbortController.signal,
            { silent: true },
          );
        } catch (error) {
          debug.log(
            "[partialUpgrade] request failed, keeping partial audio",
            error,
          );
          return;
        }

        if (!next) {
          debug.log("[partialUpgrade] no response, keeping partial audio");
          return;
        }
        // Снова WAITING — ждём следующего тика.
        if (!next.translated) continue;
        // Всё ещё частичная — ждём.
        if (next.status === VideoTranslationStatus.PART_CONTENT) continue;

        const fullUrl = next.url;
        const usedLivelyVoice = Boolean(next.usedLivelyVoice);

        debug.log("[partialUpgrade] full audio received, swapping source", {
          videoId: options.cacheVideoId,
          attempt,
        });
        const swapped = await updateTranslationIfFresh({
          url: fullUrl,
          actionContext: options.actionContext,
          usedLivelyVoice,
          isActionStale: (ctx) => self.isActionStale(ctx),
          updateTranslation: (url, ctx, livelyVoice) =>
            self.updateTranslation(url, ctx, livelyVoice),
        });
        if (!swapped) return;
        self.partialAudioActive = false;

        setTranslationCacheValue({
          cacheKey: options.cacheKey,
          setTranslation: (key, value) =>
            self.cacheManager.setTranslation(key, value),
          videoId: options.cacheVideoId,
          requestLang: options.cacheRequestLang,
          responseLang: options.cacheResponseLang,
          fallbackUrl: fullUrl,
          downloadTranslationUrl: self.downloadTranslation?.url,
          usedLivelyVoice,
        });
        return;
      }

      debug.log("[partialUpgrade] attempts exhausted, keeping partial audio", {
        videoId: options.cacheVideoId,
      });
    } finally {
      if (self.partialUpgradeKey === options.cacheKey) {
        self.partialUpgradeKey = null;
      }
    }
  })();
}

async function requestApplyAndCacheTranslation(
  self: VideoHandler,
  options: ApplyAndCacheOptions,
): Promise<TranslationAudioResult | null> {
  const translateRes = await requestTranslationAudio(self.translationHandler, {
    videoData: options.videoData,
    requestLang: options.requestLang,
    responseLang: options.responseLang,
    translationHelp: options.translationHelp,
    useAudioDownload: Boolean(self.data?.useAudioDownload),
    signal: self.actionsAbortController.signal,
    silent: options.silent,
  });
  if (!translateRes) return null;

  const updated = await updateTranslationIfFresh({
    url: translateRes.url,
    actionContext: options.actionContext,
    usedLivelyVoice: translateRes.usedLivelyVoice,
    isActionStale: (ctx) => self.isActionStale(ctx),
    updateTranslation: (url, ctx, usedLivelyVoice) =>
      self.updateTranslation(url, ctx, usedLivelyVoice),
  });
  if (!updated) return null;

  if (options.onBeforeCache) {
    await options.onBeforeCache(translateRes);
  }

  // Частичную озвучку НЕ кэшируем как финальную: иначе при следующем открытии
  // видео расширение возьмёт её из кэша и никогда не доберёт полную версию.
  if (translateRes.isPartial) {
    self.partialAudioActive = true;
    schedulePartialTranslationUpgrade(self, options);
    return translateRes;
  }

  self.partialAudioActive = false;

  setTranslationCacheValue({
    cacheKey: options.cacheKey,
    setTranslation: (key, value) =>
      self.cacheManager.setTranslation(key, value),
    videoId: options.cacheVideoId,
    requestLang: options.cacheRequestLang,
    responseLang: options.cacheResponseLang,
    fallbackUrl: translateRes.url,
    downloadTranslationUrl: self.downloadTranslation?.url,
    usedLivelyVoice: translateRes.usedLivelyVoice,
  });

  return translateRes;
}

export async function refreshTranslationAudio(
  this: VideoHandler,
): Promise<void> {
  if (!this.videoData || this.videoData.isStream) {
    return;
  }
  if (!this.hasActiveSource()) return;
  if (this.isRefreshingTranslation) return;
  const videoId = this.videoData.videoId;
  if (!videoId) return;
  if (this.actionsAbortController?.signal?.aborted) {
    this.resetActionsAbortController("refreshTranslationAudio");
  }
  this.isRefreshingTranslation = true;
  const actionContext: ActionContext = { gen: this.actionsGeneration, videoId };
  const normalizedTranslationHelp = normalizeTranslationHelp(
    this.videoData.translationHelp,
  );
  try {
    const translateRes = await requestApplyAndCacheTranslation(this, {
      videoData: this.videoData,
      requestLang: this.translateFromLang,
      responseLang: this.translateToLang,
      translationHelp: normalizedTranslationHelp,
      actionContext,
      // Фоновый путь (pause → play / перемотка): не показываем статусы и ошибки,
      // иначе «Ready» и играющая озвучка «слетают» от любого отказа Яндекса.
      silent: true,
      cacheKey: this.getTranslationCacheKey(
        videoId,
        this.translateFromLang,
        this.translateToLang,
        normalizedTranslationHelp,
      ),
      cacheVideoId: videoId,
      cacheRequestLang: this.translateFromLang,
      cacheResponseLang: this.translateToLang,
    });
    if (!translateRes) return;
  } catch (error) {
    debug.log("[refreshTranslationAudio] background refresh failed", error);
  } finally {
    this.isRefreshingTranslation = false;
  }
}

/**
 * Переприменение УЖЕ ГОТОВОГО перевода из кэша — без сети.
 *
 * Жалоба 2026-09-13 (rezka): «кнопка „Перевести видео“ есть сразу, нажал, дождался
 * перевода, включил Play — перевода нет; нажал кнопку ещё раз — готовый перевод
 * подгрузился сразу и озвучка появилась».
 *
 * Механика. На rezka медиа-URL известен ДО Play (хелпер берёт его из инлайн-конфига
 * `"streams"` и `get_cdn_series`), поэтому перевод успевает завершиться на паузе.
 * Первый Play подставляет `video.src` (до него он пуст) → `getCurrentSourceKey()`
 * меняется (`href||||0` → `href||<cdn>||0`) → `canplay` → `setCanPlay()` →
 * `runSetCanPlayOnce()` → `handleSrcChanged()` → `resetAndHideLifecycle()` →
 * `stopTranslate()`: аудио-плеер очищается (`player.src = ""`, `clear()`), кнопка
 * возвращается в «Перевести видео», готовый перевод выброшен. Второй клик поднимает
 * запись из `cacheManager` (ветка `cachedEntry?.url` в `translateFunc`) и применяет
 * мгновенно — отсюда «со второго раза работает».
 *
 * `stopTranslate()` кэш НЕ чистит, поэтому после сброса достаточно переприменить
 * запись. Ключ кэша включает `videoId` + пару языков + `translationHelp.targetUrl`,
 * поэтому при НАСТОЯЩЕЙ смене серии/файла ключ не совпадёт, переприменения не будет
 * и поведение сброса (возврат кнопки в «Перевести видео») сохраняется.
 *
 * @returns `true`, если применили (или уже была применена) кэшированную озвучку.
 */
export async function restoreTranslationFromCache(
  this: VideoHandler,
): Promise<boolean> {
  if (!this.videoData || this.videoData.isStream) {
    return false;
  }
  const videoId = this.videoData.videoId;
  if (!videoId) {
    return false;
  }
  const normalizedTranslationHelp = normalizeTranslationHelp(
    this.videoData.translationHelp,
  );
  const cacheKey = this.getTranslationCacheKey(
    videoId,
    this.translateFromLang,
    this.translateToLang,
    normalizedTranslationHelp,
  );
  const cachedEntry = this.cacheManager.getTranslation(cacheKey);
  if (!cachedEntry?.url) {
    return false;
  }
  // Ровно эта озвучка уже в плеере — не дёргаем `updateTranslation` лишний раз
  // (иначе получим переприменение на каждом `setCanPlay`).
  if (
    this.audioPlayer?.player?.src ===
    normalizeManagedAudioUrl(this, cachedEntry.url)
  ) {
    return true;
  }
  // ВАЖНО: дожидаемся `stopTranslate()` ДО снятия `actionsGeneration`. Он вызван
  // из `resetAndHideLifecycle` без await, а его `cleanup()` в конце делает
  // `resetActionsAbortController()` — то есть МЕНЯЕТ поколение действий. Если снять
  // контекст раньше, `updateTranslation` (он сам ждёт тот же промис) получит
  // «протухший» контекст и выйдет на первой же проверке.
  await this.waitForPendingStopTranslate();
  try {
    await this.updateTranslation(
      cachedEntry.url,
      { gen: this.actionsGeneration, videoId },
      cachedEntry.useLivelyVoice,
    );
    debug.log("[VideoLifecycle] restored cached translation after src change", {
      videoId,
    });
    return true;
  } catch (error) {
    // Фоновое восстановление: UI уже в «Перевести видео», ошибку только логируем.
    debug.log("[VideoLifecycle] failed to restore cached translation", error);
    return false;
  }
}

export function proxifyAudio(this: VideoHandler, audioUrl: string): string {
  const proxiedAudioUrl = proxifyYandexAudioUrl(audioUrl, {
    translateProxyEnabled: this.data?.translateProxyEnabled,
    proxyWorkerHost: this.data?.proxyWorkerHost,
  });
  if (proxiedAudioUrl !== audioUrl) {
    debug.log(`[Dubbed] Audio proxied via ${proxiedAudioUrl}`);
  }
  return proxiedAudioUrl;
}

export function unproxifyAudio(this: VideoHandler, audioUrl: string): string {
  return unproxifyYandexAudioUrl(audioUrl);
}

export async function handleProxySettingsChanged(
  this: VideoHandler,
  reason = "proxySettingsChanged",
) {
  debug.log(`[Dubbed] ${reason}: clearing translation/subtitles cache`);
  try {
    this.cacheManager.clear();
    this.activeTranslation = null;
  } catch {
    // ignore
  }

  try {
    await this.stopTranslation();
  } catch {
    // ignore
  }

  await this.initDubbedClient();
}

export function isMultiMethodS3(this: VideoHandler, url: string): boolean {
  return isYandexAudioUrlOrProxy(url, {
    proxyWorkerHost: this.data?.proxyWorkerHost,
  });
}

function normalizeManagedAudioUrl(handler: VideoHandler, url: string): string {
  return handler.proxifyAudio(handler.unproxifyAudio(url));
}

async function applyTranslationSource(
  handler: VideoHandler,
  sourceUrl: string,
  actionContext?: ActionContext,
): Promise<ApplyTranslationSourceResult> {
  const currentSrc = handler.audioPlayer.player.src;
  const didSetSource = currentSrc !== sourceUrl;
  let appliedSourceUrl: string | null = null;

  if (didSetSource) {
    handler.audioPlayer.player.src = sourceUrl;
    appliedSourceUrl = sourceUrl;
  }

  try {
    if (didSetSource) {
      await handler.audioPlayer.init();
    }
    if (handler.isActionStale(actionContext)) {
      await rollbackStaleAppliedSourceIfStillCurrent(handler, appliedSourceUrl);
      return {
        status: "stale",
        didSetSource,
        appliedSourceUrl,
      };
    }

    const resumeResult = await resumePlayerAudioContextIfNeeded(handler);
    if (resumeResult === "timeout") {
      debug.log(
        "[updateTranslation] continuing after AudioContext resume timeout",
      );
    } else if (resumeResult === "failed") {
      debug.log(
        "[updateTranslation] AudioContext resume failed, continue without deferred resume",
      );
    }

    if (handler.isActionStale(actionContext)) {
      await rollbackStaleAppliedSourceIfStillCurrent(handler, appliedSourceUrl);
      return {
        status: "stale",
        didSetSource,
        appliedSourceUrl,
      };
    }

    // ⚠️ Режим строго `"playing"`, НЕ `"play"`. `lipSync` в chaimu — это
    // `switch (mode)` по ИМЕНАМ СОБЫТИЙ видео, и он понимает только
    // `playing | seeked | pause | waiting | ended`. Режима `"play"` там нет:
    // вызов уходил в `default: return this` — то есть синхронизировал
    // `currentTime`/`playbackRate`, но НЕ запускал озвучку.
    //
    // Симптом (жалоба 2026-09-14, kinogo «Плеер 1», 44853): Яндекс отдаёт
    // частичную озвучку (`status 5`), она играет; пользователь жмёт Play, и в
    // этот момент приходит ПОЛНАЯ версия — `updateTranslation` создаёт НОВЫЙ
    // `<audio>` (по умолчанию `paused`), а `lipSync("play")` его не запускал.
    // Видео уже играет, повторного `playing` нет → статус «Готово», звука нет.
    // Ровно этот инвариант обещан в комментарии `schedulePartialTranslationUpgrade`
    // («звук продолжается с того же места»).
    if (!handler.video.paused && handler.audioPlayer.player.src) {
      handler.audioPlayer.player.lipSync("playing");
    }

    return {
      status: "success",
      didSetSource,
      appliedSourceUrl,
    };
  } catch (error: unknown) {
    return {
      status: "error",
      didSetSource,
      appliedSourceUrl,
      error,
    };
  }
}

function getTranslationActiveVoiceLabel(usedLivelyVoice?: boolean): string {
  return localizationProvider.get(
    usedLivelyVoice ? "DubbedLiveVoicesTitle" : "DubbedStandardVoicesTitle",
  );
}

export async function updateTranslation(
  this: VideoHandler,
  audioUrl: string,
  actionContext?: ActionContext,
  usedLivelyVoice = this.data?.useLivelyVoice !== false,
): Promise<void> {
  await this.waitForPendingStopTranslate();
  if (this.isActionStale(actionContext)) return;
  if (!this.audioPlayer) {
    this.createPlayer();
  }
  if (this.audioPlayer.audioContext?.state === "closed") {
    debug.log("[updateTranslation] AudioContext is closed, recreating player");
    this.createPlayer();
  }

  const normalizedTargetUrl = normalizeManagedAudioUrl(this, audioUrl);
  if (this.isActionStale(actionContext)) return;
  const resolvedSource = await applyTranslationWithDirectFallback(
    this,
    normalizedTargetUrl,
    actionContext,
  );
  const resolvedAudioUrl = resolvedSource.nextAudioUrl;
  const applyResult = resolvedSource.applyResult;
  const appliedSourceUrl = applyResult.appliedSourceUrl;

  if (applyResult.status === "stale") return;

  if (applyResult.status === "error") {
    debug.log("this.audioPlayer.init() error", applyResult.error);
    await rollbackStaleAppliedSourceIfStillCurrent(this, appliedSourceUrl);
    const msg = toErrorMessage(applyResult.error);
    this.transformBtn("error", msg);
    return;
  }

  this.clearVolumeLinkState();
  this.setupAudioSettings();
  this.transformBtn("success", localizationProvider.get("translationReady"));
  this.afterUpdateTranslation(resolvedAudioUrl);
}

export function syncTranslationPlaybackVolume(this: VideoHandler): void {
  const player = this.audioPlayer?.player;
  const overlayView = this.uiManager.dubbedOverlayView;
  const nextVolume = overlayView?.translationVolumeSlider?.value;
  applyTranslationPlaybackVolume(player, nextVolume, this.data?.defaultVolume);
}

async function applyTranslationWithDirectFallback(
  handler: VideoHandler,
  audioUrl: string,
  actionContext?: ActionContext,
): Promise<{
  nextAudioUrl: string;
  applyResult: Awaited<ReturnType<typeof applyTranslationSource>>;
}> {
  const nextAudioUrl = audioUrl;
  const applyResult = await applyTranslationSource(
    handler,
    nextAudioUrl,
    actionContext,
  );

  if (
    !shouldRetryTranslationSource(
      handler,
      applyResult,
      actionContext,
      nextAudioUrl,
    )
  ) {
    return { nextAudioUrl, applyResult };
  }

  const retried = await retryTranslationWithDirectSource(
    handler,
    nextAudioUrl,
    applyResult.appliedSourceUrl,
    actionContext,
  );

  if (retried) {
    return retried;
  }

  return { nextAudioUrl, applyResult };
}

function shouldRetryTranslationSource(
  handler: VideoHandler,
  applyResult: Awaited<ReturnType<typeof applyTranslationSource>>,
  actionContext: ActionContext | undefined,
  audioUrl: string,
): boolean {
  return (
    applyResult.status === "error" &&
    applyResult.didSetSource &&
    !handler.isActionStale(actionContext) &&
    handler.unproxifyAudio(audioUrl) !== audioUrl
  );
}

async function retryTranslationWithDirectSource(
  handler: VideoHandler,
  audioUrl: string,
  appliedSourceUrl: string,
  actionContext?: ActionContext,
): Promise<
  | {
      nextAudioUrl: string;
      applyResult: Awaited<ReturnType<typeof applyTranslationSource>>;
    }
  | undefined
> {
  const directUrl = handler.unproxifyAudio(audioUrl);
  debug.log(
    "[updateTranslation] proxied audio init failed, retrying direct URL",
  );

  try {
    if (handler.isActionStale(actionContext)) {
      await rollbackStaleAppliedSourceIfStillCurrent(handler, appliedSourceUrl);
      return {
        nextAudioUrl: directUrl,
        applyResult: {
          status: "stale",
          didSetSource: true,
          appliedSourceUrl,
        },
      };
    }

    return {
      nextAudioUrl: directUrl,
      applyResult: await applyTranslationSource(
        handler,
        directUrl,
        actionContext,
      ),
    };
  } catch (fallbackErr) {
    return {
      nextAudioUrl: audioUrl,
      applyResult: {
        status: "error",
        didSetSource: true,
        appliedSourceUrl,
        error: fallbackErr,
      },
    };
  }
}

export async function translateFunc(
  this: VideoHandler,
  VIDEO_ID: string,
  _isStream: boolean,
  requestLang: string,
  responseLang: string,
  translationHelp?: VideoData["translationHelp"],
): Promise<void> {
  await this.waitForPendingStopTranslate();
  debug.log("Run videoValidator");
  await this.videoValidator();

  if (this.actionsAbortController?.signal?.aborted) {
    this.resetActionsAbortController("translateFunc");
  }
  const overlayView = this.uiManager.dubbedOverlayView;
  if (!overlayView?.dubbedButton) {
    debug.log("[translateFunc] Overlay view missing, skipping translation");
    return;
  }
  overlayView.dubbedButton.loading = true;
  this.hadAsyncWait = false;
  this.volumeOnStart = this.getVideoVolume();
  if (!VIDEO_ID) {
    debug.log("Skip translation - no VIDEO_ID resolved yet");
    await this.updateTranslationErrorMsg(
      new DubbedLocalizedError("DubbedNoVideoIDFound"),
      this.actionsAbortController.signal,
    );
    return;
  }
  const videoData = this.videoData;
  if (!videoData) {
    await this.updateTranslationErrorMsg(
      new DubbedLocalizedError("DubbedNoVideoIDFound"),
      this.actionsAbortController.signal,
    );
    return;
  }
  const normalizedTranslationHelp = normalizeTranslationHelp(translationHelp);
  const cacheKey = this.getTranslationCacheKey(
    VIDEO_ID,
    requestLang,
    responseLang,
    normalizedTranslationHelp,
  );
  const activeKey = `video_${cacheKey}`;

  if (this.activeTranslation?.key === activeKey) {
    debug.log("[translateFunc] Reusing in-flight translation");
    await this.activeTranslation.promise;
    return;
  }

  const actionContext: ActionContext = {
    gen: this.actionsGeneration,
    videoId: VIDEO_ID,
  };

  // Счётчик «цепочек перевода в полёте»: пока он > 0, «мигание» video.src не
  // должно выбрасывать перевод (см. VideoHandler.translationChainsInFlight).
  // Снимается ровно там же, где промис цепочки завершается (finally ниже).
  this.translationChainsInFlight += 1;

  const translationPromise = (async () => {
    if (this.isActionStale(actionContext)) {
      debug.log("[translateFunc] Stale translation task - skipping");
      return;
    }
    const reqLang = requestLang as RequestLang;
    const resLang = responseLang as ResponseLang;
    const applyTranslationUrl = async (
      url: string,
      usedLivelyVoice?: boolean,
    ) => await this.updateTranslation(url, actionContext, usedLivelyVoice);
    const cachedEntry = this.cacheManager.getTranslation(cacheKey);
    if (cachedEntry?.url) {
      const applied = await withStaleGuard(
        actionContext,
        (ctx) => this.isActionStale(ctx),
        () => applyTranslationUrl(cachedEntry.url, cachedEntry.useLivelyVoice),
      );
      if (!applied) return;
      debug.log("[translateFunc] Cached translation was received");
      return;
    }

    const translateRes = await requestApplyAndCacheTranslation(this, {
      videoData,
      requestLang: reqLang,
      responseLang: resLang,
      translationHelp: normalizedTranslationHelp,
      actionContext,
      cacheKey,
      cacheVideoId: VIDEO_ID,
      cacheRequestLang: requestLang,
      cacheResponseLang: responseLang,
      onBeforeCache: async () => {
        const preferredSubtitleLanguage = this.getPreferredSubtitlesLanguage(
          videoData.detectedLanguage,
          videoData.responseLanguage,
        );
        if (!preferredSubtitleLanguage) {
          return;
        }
        const subsCacheKey = this.videoData
          ? this.getSubtitlesCacheKey(
              VIDEO_ID,
              this.videoData.detectedLanguage,
              preferredSubtitleLanguage,
            )
          : null;
        const cachedSubs = subsCacheKey
          ? this.cacheManager.getSubtitles(subsCacheKey)
          : null;
        const hasMatchingSubtitle =
          Array.isArray(cachedSubs) &&
          pickBestSubtitlesIndex(
            getIndexedSubtitleDescriptors(cachedSubs),
            videoData.detectedLanguage,
            preferredSubtitleLanguage,
          ) != null;
        if (!hasMatchingSubtitle) {
          if (subsCacheKey) this.cacheManager.deleteSubtitles(subsCacheKey);
          this.subtitles = [];
          this.subtitlesCacheKey = null;
        }
      },
    });

    debug.log("[translateRes]", translateRes);

    if (!translateRes) {
      debug.log("Skip translation");
    }
  })();

  this.activeTranslation = {
    key: activeKey,
    promise: translationPromise,
  };

  try {
    return await translationPromise;
  } catch (err) {
    this.hadAsyncWait = notifyTranslationFailureIfNeeded({
      aborted: this.actionsAbortController.signal.aborted,
      translateApiErrorsEnabled: Boolean(this.data?.translateAPIErrors),
      hadAsyncWait: this.hadAsyncWait,
      videoId: VIDEO_ID,
      error: err,
      notify: (params) => this.notifier.translationFailed(params),
    });
    throw err;
  } finally {
    if (this.activeTranslation?.promise === translationPromise) {
      this.activeTranslation = null;
    }
    this.translationChainsInFlight = Math.max(
      0,
      this.translationChainsInFlight - 1,
    );
    const overlayBtn = this.uiManager.dubbedOverlayView?.dubbedButton;
    // ⚠️ Условие `!hasTranslationToPreserve()` обязательно. Без него эта ветка
    // гасила кнопку в «Перевести видео» в момент, когда ОДНА цепочка завершалась,
    // а другая (запущенная после Play/смены src) уже/ещё работала: кнопка
    // выглядела сброшенной, хотя запрос в Яндекс шёл (жалоба 2026-09-13).
    if (
      !this.activeTranslation &&
      overlayBtn?.loading &&
      !this.hasActiveSource() &&
      !this.hasTranslationToPreserve()
    ) {
      debug.log("[translateFunc] clearing stale loading state");
      this.transformBtn("none", localizationProvider.get("translateVideo"));
    }
  }
}

export function isYouTubeHosts(this: VideoHandler) {
  return isTranslationDownloadHost(this.site.host);
}
