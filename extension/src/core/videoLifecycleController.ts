import type { VideoDataSubtitle } from "@vot.js/core/types/client";
import type { ServiceConf, VideoService } from "@vot.js/ext/types/service";
import type { RequestLang, ResponseLang } from "@vot.js/shared/types/data";

import type { StorageData } from "../types/storage";
import debug from "../utils/debug";
import { containsCrossShadow } from "../utils/dom";
import type { VideoData } from "../videoHandler/shared";
import { findConnectedContainerBySelector } from "./containerResolution";
import {
  hideLifecycleOverlay,
  type LifecycleOverlayViewLike,
  resetAndHideLifecycle,
} from "./lifecycleShared";

interface LifecycleOverlayView extends LifecycleOverlayViewLike {
  dubbedButton: { container: HTMLElement; opacity: number };
  dubbedMenu: { container: HTMLElement; hidden: boolean };
}

interface LifecycleUIManager {
  dubbedOverlayView: LifecycleOverlayView;
}

const YOUTUBE_TIMESTAMP_PARAMS = ["t", "start", "time_continue"];

export function getYouTubeSourceKey(url: URL, hasSrcObject: "1" | "0"): string {
  const stableUrl = new URL(url);
  for (const param of YOUTUBE_TIMESTAMP_PARAMS) {
    stableUrl.searchParams.delete(param);
  }
  return `${stableUrl.origin}${stableUrl.pathname}${stableUrl.search}||${hasSrcObject}`;
}

export interface VideoLifecycleHost {
  video: HTMLVideoElement;
  site: ServiceConf<VideoService>;
  container: HTMLElement;
  firstPlay: boolean;
  stopTranslation(): void | Promise<void>;
  resetSubtitlesWidget(): void;
  uiManager: LifecycleUIManager;
  getVideoData(): Promise<VideoData | undefined>;
  /**
   * Переприменить готовый перевод из кэша без сети. Нужен после
   * `resetAndHideLifecycle` в `handleSrcChanged`: на rezka первый Play лишь
   * подставляет `video.src` (до него он пуст), из-за чего источник «меняется» и
   * готовый перевод выбрасывается — пользователь вынужден жать кнопку второй раз.
   */
  restoreTranslationFromCache?(): Promise<boolean>;
  /**
   * Есть ли перевод, который нельзя терять при смене `video.src`.
   *
   * Жалоба 2026-09-13 (rezka): «нажал „Перевести видео“, нажал Play — кнопка
   * перезапустилась, надо жать снова». Первый Play на rezka лишь подставляет
   * `video.src` (до Play его нет) / переводит плеер на `blob:` того же файла, а
   * на MSE-плеерах src вообще мигает при смене качества. Раньше это выглядело
   * как «сменилось видео» → `resetAndHideLifecycle()` выбрасывал и готовый
   * перевод, и НЕЗАВЕРШЁННЫЙ запрос (его abort-или), поэтому кнопка
   * возвращалась в «Перевести видео».
   */
  hasTranslationToPreserve?(): boolean;
  /**
   * Идёт ли прямо сейчас цепочка перевода (запрос в Яндекс / поллинг очереди),
   * даже если `videoData` ещё не запомнился в `previousVideoIdForPreserve`.
   *
   * Нужен для первого в жизни сеанса `setCanPlay`: на kinogo кнопка «Перевести
   * видео» появляется ДО первого Play, пользователь жмёт её, и только потом
   * плеер отдаёт источник → `setCanPlay` → раньше это был «первый запуск», и
   * `resetAndHideLifecycle()` убивал уже улетевший в Яндекс запрос (жалоба
   * 2026-09-13: «кнопка есть без Play, нажал — перевода нет»).
   */
  hasTranslationInFlight?(): boolean;
  cacheManager: {
    getSubtitles(key: string): VideoDataSubtitle[] | undefined;
  };
  updateSubtitlesLangSelect(): Promise<void>;
  setSelectMenuValues(from: RequestLang, to: ResponseLang): void;
  translateToLang: ResponseLang | string;
  data: Partial<StorageData>;
  subtitles: VideoDataSubtitle[];
  subtitlesCacheKey: string | null;
  videoData?: VideoData;
  actionsAbortController?: AbortController;
  resetActionsAbortController?(reason?: unknown): void;
  getSubtitlesCacheKey(
    videoId: string,
    detectedLanguage: RequestLang,
    subtitleLanguage: string,
  ): string;
  getPreferredSubtitlesLanguage(
    detectedLanguage?: string,
    responseLanguage?: string,
  ): string | undefined;
  translationOrchestrator: {
    reset(): void;
    runAutoTranslationIfEligible(): Promise<void>;
  };
  enableSubtitlesForCurrentLangPair(): Promise<unknown>;
  queueOverlayAutoHide?(): void;
}

export class VideoLifecycleController {
  private readonly host: VideoLifecycleHost;
  private lifecycleGeneration = 0;
  private lastSetCanPlaySourceKey = "";
  private activeSetCanPlaySourceKey = "";
  private setCanPlayRequested = false;
  private setCanPlayLoopPromise?: Promise<void>;
  /**
   * `videoId`, который был известен ДО последнего перечитывания `videoData`.
   * Нужен, чтобы отличить «источник мигнул внутри того же видео» (Play на
   * rezka, смена качества) от настоящего перехода на другое видео (YouTube SPA,
   * смена серии): сохранять перевод можно только в первом случае.
   */
  private previousVideoIdForPreserve = "";

  constructor(host: VideoLifecycleHost) {
    this.host = host;
  }

  private isStale(generation: number) {
    return generation !== this.lifecycleGeneration;
  }

  private resetActions(reason: string): void {
    if (typeof this.host.resetActionsAbortController === "function") {
      this.host.resetActionsAbortController(reason);
      return;
    }
    this.host.actionsAbortController?.abort(reason);
  }

  private invalidateActiveSession(reason: string): void {
    if (this.lifecycleGeneration === 0) return;
    this.lifecycleGeneration += 1;
    this.resetActions(`[VideoLifecycle] ${reason}`);
    debug.log(
      `[VideoLifecycle] cancelled active session (active: ${this.lifecycleGeneration})`,
      { reason },
    );
  }

  private startSession(reason: string): number {
    this.lifecycleGeneration += 1;
    const sessionId = this.lifecycleGeneration;
    this.resetActions(`[VideoLifecycle][session:${sessionId}] ${reason}`);
    debug.log(`[VideoLifecycle][session:${sessionId}] started`, { reason });
    return sessionId;
  }

  private shouldAbortHandleSrcChanged(callId: number, stage: string): boolean {
    if (!this.isStale(callId)) {
      return false;
    }

    debug.log(
      `[VideoLifecycle][session:${callId}] handleSrcChanged aborted at ${stage} (active: ${this.lifecycleGeneration})`,
    );
    return true;
  }

  private showOverlayButton(overlayView: LifecycleOverlayView): void {
    overlayView.dubbedButton.container.hidden = false;
    overlayView.dubbedButton.opacity = 1;
    this.host.queueOverlayAutoHide?.();
  }

  teardown() {
    this.setCanPlayRequested = false;
    this.invalidateActiveSession("teardown");
  }

  private getCurrentSourceKey(): string {
    const hasSrcObject = this.host.video.srcObject ? "1" : "0";
    if (this.host.site.host === "youtube") {
      // YouTube can rotate media src values without changing the logical video:
      // Shorts often swap blob URLs, and regular pages can do the same on quality changes.
      // Ignore seek parameters so URL timestamper extensions do not reset state.
      return getYouTubeSourceKey(
        new URL(globalThis.location.href),
        hasSrcObject,
      );
    }

    const src = this.host.video.currentSrc || this.host.video.src || "";
    return `${globalThis.location.href}||${src}||${hasSrcObject}`;
  }

  private resolveContainer(): HTMLElement {
    const { site, video, container } = this.host;

    if (!site.selector) {
      return video.parentElement ?? container;
    }

    const matched = findConnectedContainerBySelector(video, site.selector);
    if (matched) {
      return matched;
    }

    // Selector mismatch should not force an arbitrary container jump.
    if (container.isConnected && containsCrossShadow(container, video)) {
      return container;
    }

    return video.parentElement ?? container;
  }

  async setCanPlay() {
    this.setCanPlayRequested = true;
    if (this.setCanPlayLoopPromise !== undefined) {
      const incomingSourceKey = this.getCurrentSourceKey();
      if (
        this.activeSetCanPlaySourceKey &&
        incomingSourceKey !== this.activeSetCanPlaySourceKey
      ) {
        this.invalidateActiveSession(
          "setCanPlay source changed while previous trigger is running",
        );
      } else {
        debug.log("[VideoLifecycle] setCanPlay deduplicated for same source", {
          sourceKey: incomingSourceKey,
        });
      }
      return await this.setCanPlayLoopPromise;
    }

    const loopPromise = (async () => {
      while (this.setCanPlayRequested) {
        this.setCanPlayRequested = false;
        await this.runSetCanPlayOnce();
      }
    })();

    this.setCanPlayLoopPromise = loopPromise;
    try {
      await loopPromise;
    } finally {
      if (this.setCanPlayLoopPromise === loopPromise) {
        this.setCanPlayLoopPromise = undefined;
      }
    }
  }

  private async runSetCanPlayOnce(
    force = false,
    options: { preserveTranslation?: boolean } = {},
  ) {
    const sourceKey = this.getCurrentSourceKey();
    if (
      !force &&
      this.host.videoData?.videoId &&
      sourceKey === this.lastSetCanPlaySourceKey
    ) {
      debug.log("[VideoLifecycle] setCanPlay deduplicated for same source", {
        sourceKey,
      });
      return;
    }

    let nextVideoData: VideoData | undefined;
    const previousVideoId = this.host.videoData?.videoId ?? "";
    try {
      nextVideoData = await this.host.getVideoData();
    } catch (err) {
      debug.log(
        `[VideoLifecycle] getVideoData failed for source ${sourceKey}`,
        err,
      );
      this.host.videoData = undefined;
      // [rezka-patch] Не прячем кнопку: на rezka getVideoData может упасть на
      // анти-фроде ("Время сессии истекло"/"unauthorized"), пока плеер ещё не
      // запросил ссылки. Кнопка остаётся видимой и работает как retry: клик →
      // повторный getVideoData (RezkaHelper сам запустит play и подхватит ответ).
      const view = this.host.uiManager?.dubbedOverlayView;
      if (view?.dubbedButton) {
        this.showOverlayButton(view);
      }
      return;
    }

    if (this.getCurrentSourceKey() !== sourceKey) {
      debug.log(
        "[VideoLifecycle] discarded stale getVideoData result after source change",
        { sourceKey },
      );
      return;
    }

    this.host.videoData = nextVideoData;
    this.previousVideoIdForPreserve = previousVideoId;
    this.activeSetCanPlaySourceKey = sourceKey;
    const currentId = this.startSession(`setCanPlay (source: ${sourceKey})`);
    debug.log(`[VideoLifecycle][session:${currentId}] setCanPlay started`, {
      sourceKey,
    });

    try {
      await this.handleSrcChanged(currentId, sourceKey, options);

      if (this.isStale(currentId)) {
        debug.log(
          `[VideoLifecycle][session:${currentId}] setCanPlay aborted after src change (active: ${this.lifecycleGeneration})`,
        );
        return;
      }

      const autoSubtitlesPromise = this.runAutoSubtitlesIfEnabled(currentId);

      await this.host.translationOrchestrator.runAutoTranslationIfEligible();
      if (this.isStale(currentId)) {
        debug.log(
          `[VideoLifecycle][session:${currentId}] auto-translation result ignored (stale session)`,
        );
        return;
      }

      await autoSubtitlesPromise;
      if (this.isStale(currentId)) {
        debug.log(
          `[VideoLifecycle][session:${currentId}] auto-subtitles result ignored (stale session)`,
        );
        return;
      }
      debug.log(`[VideoLifecycle][session:${currentId}] setCanPlay finished`);
    } finally {
      if (this.activeSetCanPlaySourceKey === sourceKey) {
        this.activeSetCanPlaySourceKey = "";
      }
    }
  }

  private async runAutoSubtitlesIfEnabled(sessionId: number): Promise<void> {
    if (!this.host.data.autoSubtitles || !this.host.videoData?.videoId) {
      return;
    }

    try {
      await this.host.enableSubtitlesForCurrentLangPair();
    } catch (err) {
      debug.log(
        `[VideoLifecycle][session:${sessionId}] auto-subtitles failed`,
        err,
      );
    }
  }

  /**
   * Смена медиа-источника — принудительный сброс (смена серии/файла).
   *
   * Отличие от обычного `canplay`: здесь смена подтверждена `MediaUrlWatcher`
   * («личность» серии/переводчика или путь файла), поэтому перевод надо выбросить
   * даже если он ещё идёт. Обычный `canplay`-путь перевод НАОБОРОТ сохраняет
   * (см. `hasTranslationToPreserve`).
   */
  async handleMediaSourceChanged(): Promise<void> {
    debug.log("[VideoLifecycle] media source changed, forcing re-resolve");
    // Дожидаемся текущего прогона, чтобы не читать videoData дважды параллельно.
    if (this.setCanPlayLoopPromise !== undefined) {
      await this.setCanPlayLoopPromise.catch(() => undefined);
    }
    await this.runSetCanPlayOnce(true, { preserveTranslation: false });
  }

  async handleSrcChanged(
    callId?: number,
    expectedSourceKey?: string,
    options: { preserveTranslation?: boolean } = {},
  ) {
    const sessionId =
      typeof callId === "number"
        ? callId
        : this.startSession("manual handleSrcChanged");
    const sourceKey =
      typeof expectedSourceKey === "string" && expectedSourceKey.length > 0
        ? expectedSourceKey
        : this.getCurrentSourceKey();

    if (this.shouldAbortHandleSrcChanged(sessionId, "before start")) {
      return;
    }

    debug.log(`[VideoLifecycle][session:${sessionId}] src changed`, {
      sourceKey,
    });

    const overlayView = this.host.uiManager.dubbedOverlayView;

    // ── Источник «мигнул», а перевод есть: НЕ сбрасываем ────────────────────
    // Жалоба 2026-09-13 (rezka, «сериал»): нажал «Перевести видео» → нажал Play
    // → кнопка перезапустилась и перевод пришлось запускать заново. Первый Play
    // подставляет `video.src` (до него его нет) либо переводит плеер на `blob:`
    // того же файла; на MSE-плеерах src мигает ещё и при смене качества. Всё это
    // раньше проходило как «сменилось видео»: `resetAndHideLifecycle()` →
    // `stopTranslate()` выбрасывал готовую озвучку и abort-ил НЕЗАВЕРШЁННЫЙ
    // запрос в Яндекс. Настоящую смену серии по-прежнему обрабатывает
    // `handleMediaSourceChanged()` (там `preserveTranslation: false`) и
    // обработчик `emptied` по изменившемуся `videoId`.
    //
    // Условие «тот же videoId» обязательно: без него переход на ДРУГОЕ видео в
    // SPA (YouTube) с уже играющей озвучкой не сбросил бы состояние.
    //
    // ВАЖНО: проверка стоит ДО `firstPlay = true`. Иначе «мигнувший» src
    // сбрасывал бы флаг первого запуска, и при включённом автопереводе
    // (`autoTranslate`) каждый Play заново запускал бы перевод — вторая сессия
    // у Яндекса и «прогресс с нуля» на ровном месте.
    //
    // Исключение — ПЕРВЫЙ `setCanPlay` сеанса, когда `previousVideoIdForPreserve`
    // ещё пуст (на kinogo кнопка «Перевести видео» есть ДО первого Play, перевод
    // запускают кнопкой, и только потом плеер отдаёт источник): если цепочка
    // перевода уже в полёте, тоже сохраняем — иначе запрос в Яндекс выбрасывается.
    const currentVideoId = this.host.videoData?.videoId;
    const sameVideoId =
      this.previousVideoIdForPreserve.length > 0
        ? this.previousVideoIdForPreserve === currentVideoId
        : currentVideoId !== undefined &&
          this.host.hasTranslationInFlight?.() === true;
    if (
      options.preserveTranslation !== false &&
      sameVideoId &&
      this.host.hasTranslationToPreserve?.()
    ) {
      debug.log(
        `[VideoLifecycle][session:${sessionId}] src changed, translation preserved`,
        { sourceKey, videoId: this.host.videoData?.videoId },
      );
      this.lastSetCanPlaySourceKey = sourceKey;
      this.activeSetCanPlaySourceKey = sourceKey;
      this.showOverlayButton(overlayView);
      return;
    }

    this.host.firstPlay = true;

    resetAndHideLifecycle(this.host, overlayView, { requireVideoData: true });

    const noSrc =
      !this.host.video.src &&
      !this.host.video.currentSrc &&
      !this.host.video.srcObject;
    if (noSrc) {
      hideLifecycleOverlay(overlayView, { hideMenu: true });
    }

    const nextContainer = this.resolveContainer();
    if (nextContainer !== this.host.container) {
      this.host.container = nextContainer;
    }

    if (this.shouldAbortHandleSrcChanged(sessionId, "before getVideoData")) {
      return;
    }

    this.showOverlayButton(overlayView);

    if (this.shouldAbortHandleSrcChanged(sessionId, "after getVideoData")) {
      return;
    }

    if (!this.host.videoData?.videoId) {
      debug.log(
        `[VideoLifecycle][session:${sessionId}] No videoId resolved, hiding overlay`,
      );
      hideLifecycleOverlay(overlayView, { hideMenu: true });
      return;
    }

    const subtitleLanguage = this.host.getPreferredSubtitlesLanguage(
      this.host.videoData.detectedLanguage,
      this.host.videoData.responseLanguage,
    );
    if (subtitleLanguage) {
      const cacheKey = this.host.getSubtitlesCacheKey(
        this.host.videoData.videoId,
        this.host.videoData.detectedLanguage,
        subtitleLanguage,
      );

      const cachedSubtitles = this.host.cacheManager.getSubtitles(cacheKey);
      this.host.subtitles = cachedSubtitles ?? [];
      this.host.subtitlesCacheKey =
        cachedSubtitles === undefined ? null : cacheKey;
    } else {
      this.host.subtitles = [];
      this.host.subtitlesCacheKey = null;
    }

    await this.host.updateSubtitlesLangSelect();
    if (this.shouldAbortHandleSrcChanged(sessionId, "after subtitles update")) {
      return;
    }

    this.host.translateToLang = this.host.data.responseLanguage ?? "ru";
    this.host.setSelectMenuValues(
      this.host.videoData.detectedLanguage,
      this.host.videoData.responseLanguage,
    );

    this.showOverlayButton(overlayView);
    this.lastSetCanPlaySourceKey = sourceKey;

    // Готовый перевод не должен теряться из-за того, что источник лишь «появился».
    // На rezka первый Play подставляет `video.src` (до Play он пуст) → sourceKey
    // меняется → мы здесь → `resetAndHideLifecycle` уже выбросил применённую
    // озвучку. Переприменяем её из кэша БЕЗ сети: ключ кэша включает
    // `translationHelp.targetUrl`, поэтому при реальной смене серии/файла он не
    // совпадёт и переприменения не будет (поведение сброса сохраняется).
    if (this.host.restoreTranslationFromCache) {
      await this.host.restoreTranslationFromCache();
      if (this.shouldAbortHandleSrcChanged(sessionId, "after cache restore")) {
        return;
      }
    }

    debug.log(`[VideoLifecycle][session:${sessionId}] src handling finished`);
  }
}
