import {
  type TranslationHelp,
  type VideoTranslationResponse,
  VideoTranslationStatus,
} from "@vot.js/core/types/yandex";
import type { RequestLang, ResponseLang } from "@vot.js/shared/types/data";
import { AudioDownloader } from "../audioDownloader";
import { STREAM_TIMEOUT_MS } from "../audioDownloader/strategies/webMseProxy";
import { localizationProvider } from "../localization/localizationProvider";
import type {
  DownloadedAudioData,
  DownloadedPartialAudioData,
} from "../types/audioDownloader";
import {
  createAbortableDelay,
  createAbortableWaiter,
  NEVER_ABORTED_SIGNAL,
  throwIfAborted,
} from "../utils/abort";
import { deleteAccount, hasAccountToken } from "../utils/account";
import debug from "../utils/debug";
import { getErrorMessage, isAbortError, safeNestedGet } from "../utils/errors";
import type { VideoHandler } from "../VideoHandler";
import DubbedLocalizedError from "../DubbedLocalizedError";
import type { VideoData } from "../videoHandler/shared";
import { openAuthWindow } from "./authWindow";
import {
  getTranslationAuthErrorKind,
  getTranslationServerErrorMessage,
  isTranslationAuthError,
} from "./translationAuthError";
import {
  getTranslationShouldRetry,
  notifyTranslationFailureIfNeeded,
} from "./translationErrors";
import { TranslationEtaCountdown } from "./translationEtaCountdown";

/**
 * Historically we used `patch-package` to make `@vot.js/core` throw
 * `DubbedLocalizedError` for a few common failure cases.
 *
 * We now keep the dependency unpatched and instead map known error messages
 * coming from the Dubbed client to the corresponding localized UI errors.
 */
function mapDubbedClientErrorForUi(
  error: unknown,
  hasProvidedAccountToken = false,
): unknown {
  const authErrorKind = getTranslationAuthErrorKind(error, {
    hasAccountToken: hasProvidedAccountToken,
  });
  if (authErrorKind) {
    return new DubbedLocalizedError(
      authErrorKind === "session-expired"
        ? "DubbedYandexTokenExpired"
        : "DubbedAccountRequired",
    );
  }

  // Only Dubbed client errors (objects with name === "DubbedJSError") need mapping.
  if (!error || typeof error !== "object") {
    return error;
  }

  const errName = safeNestedGet(error, ["name"]);
  if (errName !== "DubbedJSError") {
    return error;
  }

  const message =
    typeof safeNestedGet(error, ["message"]) === "string"
      ? (safeNestedGet(error, ["message"]) as string)
      : "";
  const serverMessage = safeNestedGet(error, ["data", "message"]);
  const hasServerMessage =
    typeof serverMessage === "string" && serverMessage.length > 0;

  // Keep server-provided messages when available.
  if (message === "Yandex couldn't translate video" && !hasServerMessage) {
    return new DubbedLocalizedError("requestTranslationFailed");
  }

  if (message === "Failed to request video translation") {
    return new DubbedLocalizedError("requestTranslationFailed");
  }

  if (
    message === "Audio link wasn't received" ||
    message === "Audio link wasn't received from Dubbed response"
  ) {
    return new DubbedLocalizedError("audioNotReceived");
  }

  return error;
}

type TranslateVideoImplOptions = {
  disableLivelyVoice?: boolean;
  retryAttempt?: number;
  /**
   * Wall-clock начала цепочки `shouldRetry`. Бюджет повторов считается ПО ВРЕМЕНИ,
   * а не по числу попыток: сервер отдаёт `shouldRetry: 1..7`, то есть просит
   * возвращаться каждые 1–7 c, и «24 попытки» выгорают за ~3 минуты — заметно
   * раньше, чем заканчивается очередь Яндекса (~10 минут).
   */
  retryStartedAt?: number;
  /**
   * Фоновый режим: не трогать UI (кнопка, ETA) и не запускать внутренние
   * ретраи. Нужен для догрузки ПОЛНОЙ озвучки, когда частичная уже играет:
   * пользователь видит «Ready», и перезаписывать это прогрессом нельзя.
   */
  silent?: boolean;
};

function summarizeTranslationResponse(
  response: VideoTranslationResponse,
): Record<string, unknown> {
  return {
    status: response.status,
    translated: response.translated,
    remainingTime: response.remainingTime,
    translationId: response.translationId,
  };
}

export class DubbedTranslationHandler {
  readonly videoHandler: VideoHandler;
  readonly audioDownloader: AudioDownloader;
  downloading: boolean;
  private readonly downloadSettlers = new Set<{
    resolve: () => void;
    reject: (error: Error) => void;
  }>();
  private readonly etaCountdown: TranslationEtaCountdown;

  // Avoid spamming the fail-audio-js fallback for the same video URL.
  // In normal operation we should upload audio through the MSE proxy path.
  private readonly requestedFailAudio = new Set<string>();

  constructor(videoHandler: VideoHandler) {
    this.videoHandler = videoHandler;
    this.audioDownloader = new AudioDownloader();
    this.downloading = false;
    this.etaCountdown = new TranslationEtaCountdown(
      (message, signal, options) =>
        this.videoHandler.updateTranslationErrorMsg(message, signal, options),
    );

    this.audioDownloader
      .addEventListener("downloadedAudio", this.onDownloadedAudio)
      .addEventListener("downloadedPartialAudio", this.onDownloadedPartialAudio)
      .addEventListener("downloadAudioError", this.onDownloadAudioError);
  }

  private readonly onDownloadedAudio = async (
    translationId: string,
    data: DownloadedAudioData,
  ) => {
    debug.log("downloadedAudio", data);
    if (!this.downloading) {
      debug.log("skip downloadedAudio");
      return;
    }

    const { videoId, fileId, audioData } = data;
    const videoUrl = this.getCanonicalUrl(videoId);
    try {
      await this.retryAudioUpload(() =>
        this.videoHandler.dubbedClient.provider.requestVtransAudio(
          videoUrl,
          translationId,
          {
            audioFile: audioData,
            fileId,
          },
        ),
      );
    } catch (error) {
      debug.error("Failed to upload downloaded audio", error);
      this.finishDownloadFailure(
        error instanceof Error
          ? error
          : new Error("Audio downloader failed while uploading full audio"),
      );
      return;
    }
    this.finishDownloadSuccess();
  };

  private readonly onDownloadedPartialAudio = async (
    translationId: string,
    data: DownloadedPartialAudioData,
  ) => {
    debug.log("downloadedPartialAudio", data);
    if (!this.downloading) {
      debug.log("skip downloadedPartialAudio");
      return;
    }

    const { audioData, fileId, videoId, amount, version, index } = data;
    const videoUrl = this.getCanonicalUrl(videoId);
    try {
      await this.retryAudioUpload(() =>
        this.videoHandler.dubbedClient.provider.requestVtransAudio(
          videoUrl,
          translationId,
          {
            audioFile: audioData,
            chunkId: index,
          },
          {
            audioPartsLength: amount ?? 0,
            fileId,
            version,
          },
        ),
      );
    } catch (error) {
      debug.error("Failed to upload downloaded audio chunk", error);
      this.finishDownloadFailure(
        new Error("Audio downloader failed while uploading chunk"),
      );
      return;
    }

    if (amount !== undefined && index === amount - 1) {
      this.finishDownloadSuccess();
    }
  };

  private readonly onDownloadAudioError = async (
    translationId: string,
    videoId: string,
  ) => {
    if (!this.downloading) {
      debug.log("skip downloadAudioError");
      return;
    }

    debug.log(`Failed to download audio ${videoId}`);
    const videoUrl = this.getCanonicalUrl(videoId);

    // The fail-audio-js endpoint is a rare fallback. Keep its usage minimal and
    // only call it for YouTube when the audio downloader is enabled.
    const shouldUseFallback =
      this.videoHandler.site.host === "youtube" &&
      Boolean(this.videoHandler.data?.useAudioDownload);

    if (!shouldUseFallback) {
      this.finishDownloadFailure(
        new DubbedLocalizedError("DubbedFailedDownloadAudio"),
      );
      return;
    }

    try {
      if (this.requestedFailAudio.has(videoUrl)) {
        debug.log("fail-audio-js request already sent for this video");
      } else {
        debug.log("Sending fail-audio-js request");
        await this.videoHandler.dubbedClient.provider.requestVtransFailAudio(
          videoUrl,
        );
        await this.videoHandler.dubbedClient.provider.requestVtransAudio(
          videoUrl,
          translationId,
          {
            audioFile: new Uint8Array(0),
            fileId: `fallback-empty-audio:video-translation:${videoId}`,
          },
        );

        this.requestedFailAudio.add(videoUrl);
      }

      this.finishDownloadSuccess();
    } catch (error) {
      debug.error("fail-audio-js request failed", error);
      this.finishDownloadFailure(
        new DubbedLocalizedError("DubbedFailedDownloadAudio"),
      );
    }
  };

  private finishDownloadSuccess() {
    this.downloading = false;
    this.settleDownloadWaiters();
  }

  private finishDownloadFailure(error: Error) {
    this.downloading = false;
    this.settleDownloadWaiters(error);
  }

  private getCanonicalUrl(videoId: string) {
    return `https://youtu.be/${videoId}`;
  }

  private static readonly AUDIO_UPLOAD_MAX_RETRIES = 2;
  private static readonly AUDIO_UPLOAD_RETRY_DELAY_MS = 1500;

  private async retryAudioUpload<T>(fn: () => Promise<T>): Promise<T> {
    const maxRetries = DubbedTranslationHandler.AUDIO_UPLOAD_MAX_RETRIES;
    const delayMs = DubbedTranslationHandler.AUDIO_UPLOAD_RETRY_DELAY_MS;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (attempt === maxRetries) {
          throw error;
        }
        debug.log(
          `[AudioUpload] retry ${attempt + 1}/${maxRetries} after ${delayMs}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw lastError;
  }

  // Cancellation helpers live in utils/abort.ts.

  /**
   * Detector for cases when server rejects the request because
   * "Lively/Live voices" are unavailable (unsupported language pair).
   */
  private isLivelyVoiceUnavailableError(value: unknown): boolean {
    if (isTranslationAuthError(value)) {
      return false;
    }

    const msg = getErrorMessage(value);
    return !!msg && msg.toLowerCase().includes("обычная озвучка");
  }

  private async scheduleRetry<T>(
    fn: () => Promise<T>,
    delayMs: number,
    signal: AbortSignal,
  ): Promise<T> {
    await createAbortableDelay(delayMs, signal, {
      onScheduled: (timeoutId) => {
        this.videoHandler.autoRetry = timeoutId;
      },
    });
    return await fn();
  }

  private static readonly MAX_INITIAL_WAIT_SEC = 180;
  /**
   * Верхняя граница паузы между поллингами, когда Яндекс назвал большой ETA
   * (длинный фильм). Было 120 c: на 1 ч 50 мин `remainingTime` регулярно
   * превышает `MAX_INITIAL_WAIT_SEC`, и готовность обнаруживалась только через
   * две минуты — это и выглядело как «очень долгая загрузка перевода»
   * (жалоба 2026-09-13). 45 c заметно ускоряют выдачу, не спамя Яндекс.
   * (Константа оставлена для совместимости и ориентира «большой ETA».)
   */
  private static readonly LONG_WAIT_MS = 45_000;
  /**
   * Нижняя граница паузы между поллингами. Контроль 13.09.2026: Яндекс отдаёт
   * `remainingTime` 300+ c даже на 15-секундный ролик (это очередь, а не
   * длительность материала), но фактически заканчивает раньше — поэтому
   * «спать ровно ETA» означало систематически ждать лишние минуты.
   */
  private static readonly MIN_POLL_MS = 10_000;
  private static readonly RETRY_INTERVAL_MS = 30_000;

  /**
   * Яндекс отвечает `FAILED` + `shouldRetry` (секунды), когда его пайплайн
   * временно не смог обработать видео. Раньше мы показывали «Возникла ошибка
   * при переводе, попробуйте позже» сразу; теперь повторяем сами.
   *
   * ⚠️ Бюджет повторов пересмотрен 2026-09-13 (вечер). Наблюдения того же окна:
   *   • контроль на ПУБЛИЧНОМ 15-секундном mp4 даёт ту же подпись
   *     `status 0 + shouldRetry=1` и `message: «Возникла ошибка при переводе…»`,
   *     что и боевые ссылки, — то есть это не «плохая ссылка», а состояние
   *     сервиса;
   *   • `remainingTime` при этом 600+ c и убывает в ~10 раз медленнее реального
   *     времени, т.е. очередь длиной порядка 10 минут;
   *   • старая цепочка 10+20+40+80+120+120 = 390 c заканчивалась РАНЬШЕ, чем
   *     сервис успевал взяться за материал, и пользователь получал ошибку на
   *     живом по сути переводе.
   * Поэтому: не экспонента, а ровный опрос (сервер сам просит «повтори через 1 c»),
   * и суммарный бюджет ~12 минут.
   *
   * ⚠️ Бюджет считается ПО ВРЕМЕНИ (`SHOULD_RETRY_MAX_TOTAL_MS`), не по числу
   * попыток. Замер 2026-09-13 (прогон `probe-matrix.cjs`): сервер стабильно
   * отвечает `shouldRetry: 7`, поэтому 24 попытки выгорали за ~3 минуты
   * (`retryAttempt: 17` на 202-й секунде) и мы сдавались ровно тогда, когда
   * очередь Яндекса ещё шла. `SHOULD_RETRY_MAX_ATTEMPTS` оставлен только как
   * страховка от бесконечного цикла.
   */
  private static readonly SHOULD_RETRY_MAX_TOTAL_MS = 12 * 60 * 1000;
  private static readonly SHOULD_RETRY_MAX_ATTEMPTS = 180;
  private static readonly SHOULD_RETRY_MIN_DELAY_MS = 5_000;
  private static readonly SHOULD_RETRY_MAX_DELAY_MS = 30_000;

  /**
   * Пауза до повтора после `FAILED + shouldRetry`. `shouldRetry` от Яндекса
   * (секунды) берём как ориентир и зажимаем в [5 c, 30 c]: чаще — лишний трафик,
   * реже — теряем момент, когда сервис освободился.
   */
  private static getShouldRetryDelayMs(
    shouldRetrySeconds: number,
    _retryAttempt: number,
  ): number {
    const serverHintMs = Math.max(
      shouldRetrySeconds * 1000,
      DubbedTranslationHandler.SHOULD_RETRY_MIN_DELAY_MS,
    );
    return Math.min(
      serverHintMs,
      DubbedTranslationHandler.SHOULD_RETRY_MAX_DELAY_MS,
    );
  }

  /**
   * Пауза до следующего поллинга, пока Яндекс ещё не отдал озвучку.
   *
   * Жалоба 2026-09-13: «длинный фильм — статусы с минутами, потом ошибка»,
   * «15-минутные серии всегда грузились за 1–2 минуты, а теперь 20+ минут нет
   * результата». Поллинг — ЕДИНСТВЕННЫЙ способ узнать, что озвучка готова,
   * поэтому «спать ровно столько, сколько назвал сервер» — прямая потеря
   * времени: `remainingTime` у Яндекса это оценка очереди, а не дедлайн.
   * Контроль 13.09.2026 (`probe-langpair-ab.cjs`, 15-секундный mp4): сервер
   * назвал 315 c, но отвечал заметно раньше — старая формула (`eta <= 180` →
   * ждать `eta` секунд) давала «спящие» простои до трёх минут.
   *
   * Теперь опрашиваем по `eta / 4`, зажатому в [10 c, 45 c]: при длинном ETA это
   * те же 45 c, что и раньше (Яндекс не спамим), при коротком — быстрая реакция.
   */
  private getRetryDelayMs(
    retryAttempt: number,
    remainingTimeSeconds: number | null = 0,
  ): number {
    if (retryAttempt > 0) {
      return DubbedTranslationHandler.RETRY_INTERVAL_MS;
    }

    const eta = remainingTimeSeconds ?? 0;
    if (eta <= 0) {
      return DubbedTranslationHandler.RETRY_INTERVAL_MS;
    }

    return Math.min(
      DubbedTranslationHandler.LONG_WAIT_MS,
      Math.max(DubbedTranslationHandler.MIN_POLL_MS, Math.round((eta * 1000) / 4)),
    );
  }

  private async handleTranslationUiError(uiError: unknown): Promise<void> {
    if (!(uiError instanceof DubbedLocalizedError)) return;

    if (uiError.unlocalizedMessage === "DubbedYandexTokenExpired") {
      await deleteAccount(this.videoHandler);
      openAuthWindow();
    } else if (uiError.unlocalizedMessage === "DubbedAccountRequired") {
      openAuthWindow();
    }
  }

  async translateVideoImpl(
    videoData: VideoData,
    requestLang: RequestLang,
    responseLang: ResponseLang,
    translationHelp: TranslationHelp[] | null = null,
    shouldSendFailedAudio = false,
    signal = NEVER_ABORTED_SIGNAL,
    options: TranslateVideoImplOptions = {},
  ): Promise<
    (VideoTranslationResponse & { usedLivelyVoice: boolean }) | null
  > {
    const { disableLivelyVoice = false, retryAttempt = 0, silent = false } = options;
    clearTimeout(this.videoHandler.autoRetry);
    this.finishDownloadSuccess();
    const requestLangForApi = this.videoHandler.getRequestLangForTranslation(
      requestLang,
      responseLang,
    );
    debug.log("[Translation] translateVideoImpl start", {
      videoId: videoData.videoId,
      duration: videoData.duration,
      requestLang,
      requestLangForApi,
      responseLang,
      retryAttempt,
      disableLivelyVoice,
      shouldSendFailedAudio,
      translationHelpCount: translationHelp?.length ?? 0,
    });
    debug.log(
      videoData,
      `Translate video (requestLang: ${requestLang}, requestLangForApi: ${requestLangForApi}, responseLang: ${responseLang})`,
    );

    let livelyDisabled = disableLivelyVoice;
    let translationResponse: VideoTranslationResponse | undefined;

    try {
      throwIfAborted(signal);

      const livelyVoiceAllowed = this.videoHandler.isLivelyVoiceAllowed(
        requestLangForApi,
        responseLang,
      );
      const translationAttempt =
        await this.requestTranslationWithLivelyFallback({
          videoData,
          requestLangForApi,
          responseLang,
          translationHelp,
          shouldSendFailedAudio,
          livelyDisabled,
          livelyVoiceAllowed,
        });
      livelyDisabled = translationAttempt.livelyDisabled;
      const useLivelyVoice = translationAttempt.useLivelyVoice;
      const res = translationAttempt.response;
      translationResponse = res;

      if (!res) {
        throw new Error("Failed to get translation response");
      }

      if (
        isTranslationAuthError(res, {
          hasAccountToken: hasAccountToken(this.videoHandler.data?.account),
        })
      ) {
        throw mapDubbedClientErrorForUi(
          res,
          hasAccountToken(this.videoHandler.data?.account),
        );
      }

      debug.log("[Translation] translateVideoImpl response", {
        videoId: videoData.videoId,
        useLivelyVoice,
        ...summarizeTranslationResponse(res),
      });
      throwIfAborted(signal);

      // `translated: true` означает, что Яндекс УЖЕ отдал рабочий url озвучки —
      // это status 1 (FINISHED) или 5 (PART_CONTENT). Раньше мы вдобавок
      // требовали `remainingTime < 1` и поэтому выбрасывали готовый url от
      // PART_CONTENT (там remainingTime обычно 5) и продолжали поллинг: в UI
      // статусы продолжали меняться, хотя озвучка уже существовала. Теперь
      // отдаём результат сразу; если он частичный (PART_CONTENT), вызывающая
      // сторона включает озвучку и в фоне догружает полную версию.
      if (res.translated) {
        this.etaCountdown.stop();
        debug.log("[Translation] translation finished", {
          videoId: videoData.videoId,
          useLivelyVoice,
          isPartial: res.status === VideoTranslationStatus.PART_CONTENT,
          ...summarizeTranslationResponse(res),
        });
        return { ...res, usedLivelyVoice: useLivelyVoice };
      }

      // Фоновая догрузка: UI уже показывает «Ready», поэтому отдаём ответ как
      // есть — без сообщений, без ETA и без внутренних ретраев (темпом
      // управляет вызывающий).
      if (silent) {
        return { ...res, usedLivelyVoice: useLivelyVoice };
      }

      // ЕДИНЫЙ статус ожидания: «минутные» оценки из ответа сервера больше не
      // показываем — до готовности пользователь видит одну строку (см.
      // `TranslationEtaCountdown.createEtaMessage`). Текст сервера остаётся в
      // debug-логе, чтобы не потерять диагностику.
      const serverMessage = res.message;
      const message = localizationProvider.get("translationWaitingForAudio");
      debug.log("[Translation] translation still processing", {
        videoId: videoData.videoId,
        useLivelyVoice,
        ...summarizeTranslationResponse(res),
        message,
        serverMessage,
      });
      if (res.remainingTime > 0) {
        await this.etaCountdown.sync(res.remainingTime, signal, {
          countLongWaitOnFirstRender: true,
        });
      } else {
        this.etaCountdown.stop();
        await this.videoHandler.updateTranslationErrorMsg(message, signal);
      }

      if (
        res.status === VideoTranslationStatus.AUDIO_REQUESTED &&
        this.videoHandler.isYouTubeHosts()
      ) {
        this.videoHandler.hadAsyncWait = true;

        debug.log("[Translation] audio download started", {
          videoId: videoData.videoId,
          translationId: res.translationId,
        });
        this.downloading = true;

        debug.log("[Translation] waiting for audio download completion", {
          videoId: videoData.videoId,
          translationId: res.translationId,
          timeoutMs: STREAM_TIMEOUT_MS,
        });
        await Promise.all([
          this.waitForAudioDownloadCompletion(signal, STREAM_TIMEOUT_MS),
          this.audioDownloader.runAudioDownload(
            videoData.videoId,
            res.translationId,
            signal,
          ),
        ]);

        // for get instant result on download end
        return await this.translateVideoImpl(
          videoData,
          requestLang,
          responseLang,
          translationHelp,
          true,
          signal,
          {
            disableLivelyVoice: livelyDisabled,
            retryAttempt,
          },
        );
      }
    } catch (err) {
      if (isAbortError(err)) {
        this.etaCountdown.stop();
        debug.log("[Translation] translation aborted", {
          videoId: videoData.videoId,
          retryAttempt,
        });
        return null;
      }

      this.etaCountdown.stop();

      // Фоновая догрузка полной озвучки: частичная уже играет, UI показывает
      // «Ready». Любую ошибку здесь просто логируем и тихо остаёмся на частичной
      // версии — перезаписывать успешный статус сообщением нельзя.
      if (silent) {
        debug.log("[partialUpgrade] silent request failed, keeping partial audio", {
          videoId: videoData.videoId,
          error: err,
        });
        return null;
      }

      // Яндекс просит повторить (FAILED + shouldRetry). Не показываем ошибку,
      // пока не исчерпаем попытки: сервер сам сообщил, что сбой временный.
      const shouldRetrySeconds = getTranslationShouldRetry(err);
      const retryStartedAt = options.retryStartedAt ?? Date.now();
      const retryElapsedMs = Date.now() - retryStartedAt;
      if (
        shouldRetrySeconds > 0 &&
        retryAttempt < DubbedTranslationHandler.SHOULD_RETRY_MAX_ATTEMPTS &&
        retryElapsedMs < DubbedTranslationHandler.SHOULD_RETRY_MAX_TOTAL_MS &&
        !isTranslationAuthError(err, {
          hasAccountToken: hasAccountToken(this.videoHandler.data?.account),
        })
      ) {
        const shouldRetryDelayMs =
          DubbedTranslationHandler.getShouldRetryDelayMs(
            shouldRetrySeconds,
            retryAttempt,
          );
        debug.log("[Translation] server asked to retry", {
          videoId: videoData.videoId,
          retryAttempt,
          retryElapsedMs,
          shouldRetrySeconds,
          shouldRetryDelayMs,
          serverMessage: getTranslationServerErrorMessage(err),
        });

        // Повтор ТОЙ ЖЕ ссылкой на подписанном CDN (kinogo/interkh, rezka) почти
        // всегда падает так же: Яндекс уходит в `status 2`, а через минуты
        // отвечает `status 0` — к этому моменту ссылка уже нерабочая. Поэтому
        // перед повтором пробуем взять СВЕЖУЮ ссылку у хелпера (если он умеет) и
        // повторяем уже с ней. Ссылка не изменилась — повторяем как раньше.
        const refreshedVideoData =
          await this.videoHandler.refreshVideoDataForRetry?.();
        const retryVideoData = refreshedVideoData ?? videoData;
        const retryTranslationHelp = refreshedVideoData
          ? (refreshedVideoData.translationHelp ?? translationHelp)
          : translationHelp;

        this.videoHandler.hadAsyncWait = true;
        // ЕДИНЫЙ статус ожидания — тот же текст, что и у счётчика (см.
        // `TranslationEtaCountdown.createEtaMessage`). Кнопка не «метается»
        // между формулировками, пока сервер просит вернуться: бюджет повторов
        // считается ПО ВРЕМЕНИ (SHOULD_RETRY_MAX_TOTAL_MS), а не по попыткам.
        await this.videoHandler.updateTranslationErrorMsg(
          localizationProvider.get("translationWaitingForAudio"),
          signal,
        );
        return this.scheduleRetry(
          () =>
            this.translateVideoImpl(
              retryVideoData,
              requestLang,
              responseLang,
              retryTranslationHelp,
              shouldSendFailedAudio,
              signal,
              {
                disableLivelyVoice: livelyDisabled,
                retryAttempt: retryAttempt + 1,
                retryStartedAt,
              },
            ),
          shouldRetryDelayMs,
          signal,
        );
      }

      const uiError = mapDubbedClientErrorForUi(
        err,
        hasAccountToken(this.videoHandler.data?.account),
      );
      debug.error("[Translation] translation failed", {
        videoId: videoData.videoId,
        retryAttempt,
        error: err,
        mappedError: uiError,
      });

      await this.handleTranslationUiError(uiError);

      await this.videoHandler.updateTranslationErrorMsg(
        getTranslationServerErrorMessage(uiError) ?? uiError,
        signal,
      );

      // Most translation errors are handled inside the translation handler and
      // returned as `null` to the caller. This means higher-level try/catch
      // blocks won't see a rejected promise. Send the failure notification here
      // so users still get a desktop alert (respecting user settings).
      this.videoHandler.hadAsyncWait = notifyTranslationFailureIfNeeded({
        aborted: Boolean(
          this.videoHandler.actionsAbortController?.signal?.aborted,
        ),
        translateApiErrorsEnabled: Boolean(
          this.videoHandler.data?.translateAPIErrors,
        ),
        hadAsyncWait: this.videoHandler.hadAsyncWait,
        videoId: videoData.videoId,
        error: err,
        notify: (params) =>
          this.videoHandler.notifier.translationFailed(params),
      });
      return null;
    }

    this.videoHandler.hadAsyncWait = true;

    const retryDelayMs = this.getRetryDelayMs(
      retryAttempt,
      translationResponse?.remainingTime ?? null,
    );
    debug.log("[Translation] scheduling translation retry", {
      videoId: videoData.videoId,
      retryAttempt,
      retryDelayMs,
      remainingTime: translationResponse?.remainingTime,
    });

    return this.scheduleRetry(
      () =>
        this.translateVideoImpl(
          videoData,
          requestLang,
          responseLang,
          translationHelp,
          shouldSendFailedAudio,
          signal,
          {
            disableLivelyVoice: livelyDisabled,
            retryAttempt: retryAttempt + 1,
          },
        ),
      retryDelayMs,
      signal,
    );
  }

  stopTranslationEtaCountdown(): void {
    this.etaCountdown.stop();
  }

  private async requestTranslationWithLivelyFallback({
    videoData,
    requestLangForApi,
    responseLang,
    translationHelp,
    shouldSendFailedAudio,
    livelyDisabled,
    livelyVoiceAllowed,
  }: {
    videoData: VideoData;
    requestLangForApi: RequestLang;
    responseLang: ResponseLang;
    translationHelp: TranslationHelp[] | null;
    shouldSendFailedAudio: boolean;
    livelyDisabled: boolean;
    livelyVoiceAllowed: boolean;
  }): Promise<{
    response?: VideoTranslationResponse;
    useLivelyVoice: boolean;
    livelyDisabled: boolean;
  }> {
    let useLivelyVoice =
      !livelyDisabled &&
      livelyVoiceAllowed &&
      this.videoHandler.data?.useLivelyVoice !== false;

    debug.log("[Translation] requesting translation from Dubbed client", {
      videoId: videoData.videoId,
      requestLangForApi,
      responseLang,
      shouldSendFailedAudio,
      livelyDisabled,
      livelyVoiceAllowed,
      useLivelyVoice,
      translationHelpCount: translationHelp?.length ?? 0,
    });

    while (true) {
      try {
        debug.log("[Translation] dubbedClient.translateVideo call", {
          videoId: videoData.videoId,
          requestLangForApi,
          responseLang,
          useLivelyVoice,
          shouldSendFailedAudio,
          translationHelpCount: translationHelp?.length ?? 0,
        });
        const response = await this.videoHandler.dubbedClient.translateVideo({
          videoData,
          requestLang: requestLangForApi,
          responseLang,
          translationHelp,
          extraOpts: {
            useLivelyVoice,
            videoTitle: this.videoHandler.videoData?.title,
          },
          shouldSendFailedAudio,
        });

        if (!useLivelyVoice || !this.isLivelyVoiceUnavailableError(response)) {
          debug.log("[Translation] dubbedClient.translateVideo resolved", {
            videoId: videoData.videoId,
            useLivelyVoice,
            ...summarizeTranslationResponse(response),
          });
          return { response, useLivelyVoice, livelyDisabled };
        }

        debug.warn("[Translation] lively voice unavailable in response", {
          videoId: videoData.videoId,
          useLivelyVoice,
          ...summarizeTranslationResponse(response),
        });
      } catch (err) {
        if (!useLivelyVoice || !this.isLivelyVoiceUnavailableError(err)) {
          throw err;
        }

        debug.warn("[Translation] lively voice unavailable in error", {
          videoId: videoData.videoId,
          useLivelyVoice,
          error: err,
        });
      }

      livelyDisabled = true;
      useLivelyVoice = false;
      debug.log("[Translation] retrying translation without lively voice", {
        videoId: videoData.videoId,
        requestLangForApi,
        responseLang,
      });
    }
  }

  private waitForAudioDownloadCompletion(
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<void> {
    if (!this.downloading) {
      return Promise.resolve();
    }

    const { promise, settle } = createAbortableWaiter(signal, timeoutMs);
    this.downloadSettlers.add(settle);
    return promise;
  }

  private settleDownloadWaiters(error?: Error) {
    if (!this.downloadSettlers.size) {
      return;
    }

    const settlers = Array.from(this.downloadSettlers);
    this.downloadSettlers.clear();
    for (const settle of settlers) {
      if (error) {
        settle.reject(error);
      } else {
        settle.resolve();
      }
    }
  }
}
