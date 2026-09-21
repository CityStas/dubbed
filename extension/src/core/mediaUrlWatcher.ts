import VideoHelper from "@vot.js/ext/helpers";
import type { ServiceConf } from "@vot.js/ext/types/service";

import type { VideoData } from "../videoHandler/shared";
import debug from "../utils/debug";
import { GM_fetch } from "../utils/gm";

/**
 * Наблюдатель за медиа-ссылкой плеера.
 *
 * ПРОБЛЕМА (жалоба 2026-09-13): «выбираешь серию, а играет озвучка предыдущей
 * серии; лечится только полной перезагрузкой страницы».
 *
 * Почему так: смена серии внутри плеера на HLS/MSE (kinogo «Плеер 1» →
 * ortified, rezka с сегментами) НЕ меняет `video.src` — там один blob-URL на
 * всю сессию hls.js. Поэтому:
 *   — `VideoLifecycleController.getCurrentSourceKey()` не меняется;
 *   — `emptied` либо не приходит, либо отсекается по неизменившемуся videoId
 *     (у ortified id фильма 74823 одинаков для всех серий).
 * Итог: расширение не замечает смену серии, кнопка остаётся в состоянии
 * «Готово» со старой озвучкой, а новая серия вообще не переводится.
 *
 * РЕШЕНИЕ: дешёвый (без сети) опрос реальной медиа-ссылки, которую тянет
 * плеер. Хелперы kinogo/rezka умеют отдать её через `peekMediaUrl()`
 * (у kinogo — самый свежий master.m3u8 из performance-коллектора, у rezka —
 * свежий ответ get_cdn_series). Как только ПУТЬ файла (см. `mediaIdentity`)
 * перестал совпадать с путём той ссылки, что ушла в `translationHelp` текущего
 * перевода — считаем, что сменился медиа-источник, и перезапускаем жизненный
 * цикл (кнопка возвращается в «Перевести видео», старая озвучка
 * останавливается, videoData перечитывается).
 *
 * Наблюдатель подключается ТОЛЬКО если хелпер сайта умеет `peekMediaUrl` —
 * остальные сайты (youtube и т.д.) работают ровно как раньше.
 */

type PeekableHelper = {
  peekMediaUrl?: () => string | undefined;
  /**
   * «Личность» текущей серии/переводчика из разметки плеера (если хелпер умеет).
   * Надёжнее сравнения URL: подпись ссылки может переписываться, а у rezka она
   * вообще лежит в ПУТИ. Используется, когда хелпер не может отдать медиа-ссылку
   * (например плеер rezka не звал get_cdn_series и ссылки лежат инлайн).
   */
  peekEpisodeKey?: () => string | undefined;
};

export type MediaUrlWatcherHost = {
  video: HTMLVideoElement;
  site: ServiceConf;
  getVideoData: () => VideoData | undefined;
  onMediaSourceChanged: (details: {
    previousUrl: string;
    nextUrl: string;
  }) => void | Promise<void>;
};

/** Как часто проверяем ссылку (чекер тикает чаще, внутри — свой троттлинг). */
const POLL_INTERVAL_MS = 2000;
/**
 * Сколько подряд одинаковых наблюдений нужно, чтобы признать смену серии.
 * Защита от «мерцания»: плеер может мигнуть промежуточной ссылкой.
 */
const CONFIRMATIONS_REQUIRED = 2;

function normalizeMediaUrl(url: string): string {
  return url.trim();
}

/**
 * «Личность» медиа-файла: путь без query-подписи и без хоста.
 *
 * Сравнивать полные URL нельзя. Подписанные ссылки CDN (interkh:
 * `?t=…&ha=…&hc=…&hi=…`) переподписываются на каждый запрос, а зеркала отдают
 * тот же файл с другого хоста — тогда смена подписи или уход на failover-хост
 * выглядит как «новая серия» и расширение бесконечно перезапускает перевод
 * (симптом «озвучка не появляется»). Настоящая смена серии меняет ПУТЬ
 * (`…/08_21_26/08/21/09/GKOG4QHP/DHQWBP3T.mp4/master.m3u8` → другой хеш-каталог).
 */
function mediaIdentity(url: string): string {
  const raw = url.trim();
  if (raw.length === 0) {
    return "";
  }

  try {
    const parsed = new URL(raw, "https://placeholder.invalid");
    return parsed.pathname.replace(/\/+$/, "");
  } catch {
    return raw.split("?")[0].replace(/\/+$/, "");
  }
}

function extractTranslationTargetUrl(
  videoData: VideoData | undefined,
): string | undefined {
  const help = videoData?.translationHelp;
  if (!Array.isArray(help)) {
    return undefined;
  }

  for (const item of help) {
    const target = (item as { target?: unknown })?.target;
    const targetUrl = (item as { targetUrl?: unknown })?.targetUrl;
    if (
      (target === "video_file_url" || target === undefined) &&
      typeof targetUrl === "string" &&
      targetUrl.length > 0
    ) {
      return targetUrl;
    }
  }

  return undefined;
}

export class MediaUrlWatcher {
  private readonly host: MediaUrlWatcherHost;
  private helper: PeekableHelper | null | undefined;
  private lastPollAt = 0;
  private pendingUrl: string | null = null;
  private pendingCount = 0;
  private lastLoggedUrl: string | null = null;
  /** Последняя известная «личность» серии (см. peekEpisodeKey). */
  private lastEpisodeKey: string | null = null;
  private pendingEpisodeKey: string | null = null;
  private pendingEpisodeCount = 0;
  private readonly unsubscribe: () => void;

  constructor(
    host: MediaUrlWatcherHost,
    checker: { subscribe: (cb: () => void) => () => void },
  ) {
    this.host = host;
    this.unsubscribe = checker.subscribe(() => {
      this.onTick();
    });
  }

  release(): void {
    this.unsubscribe();
    this.pendingUrl = null;
    this.pendingCount = 0;
    this.lastEpisodeKey = null;
    this.pendingEpisodeKey = null;
    this.pendingEpisodeCount = 0;
  }

  private resolveHelper(): PeekableHelper | null {
    if (this.helper !== undefined) {
      return this.helper;
    }

    this.helper = null;
    try {
      const service = this.host.site?.host;
      if (service) {
        // Опции хелпера в типах vot.js беднее, чем принимает рантайм
        // (video/language прокидываются так же, как в getVideoData).
        const helper = new VideoHelper({
          fetchFn: GM_fetch,
          video: this.host.video,
        } as never).getHelper(service as never) as PeekableHelper;
        if (
          typeof helper?.peekMediaUrl === "function" ||
          typeof helper?.peekEpisodeKey === "function"
        ) {
          this.helper = helper;
        }
      }
    } catch (err) {
      debug.log("[mediaWatcher] helper peek недоступен", err);
    }

    return this.helper;
  }

  /** Дешёвое чтение текущей медиа-ссылки плеера (без сети). */
  private peekMediaUrl(): string | undefined {
    const helper = this.resolveHelper();
    if (!helper?.peekMediaUrl) {
      return undefined;
    }

    try {
      const url = helper.peekMediaUrl();
      return typeof url === "string" && url.length > 0 ? url : undefined;
    } catch (err) {
      debug.log("[mediaWatcher] peekMediaUrl failed", err);
      return undefined;
    }
  }

  /** Дешёвое чтение «личности» текущей серии (без сети), если хелпер умеет. */
  private peekEpisodeKey(): string | undefined {
    const helper = this.resolveHelper();
    if (!helper?.peekEpisodeKey) {
      return undefined;
    }

    try {
      const key = helper.peekEpisodeKey();
      return typeof key === "string" && key.length > 0 ? key : undefined;
    } catch (err) {
      debug.log("[mediaWatcher] peekEpisodeKey failed", err);
      return undefined;
    }
  }

  private onTick(): void {
    const now = Date.now();
    if (now - this.lastPollAt < POLL_INTERVAL_MS) {
      return;
    }
    this.lastPollAt = now;

    if (!this.host.video?.isConnected) {
      return;
    }

    const videoData = this.host.getVideoData();
    if (!videoData?.videoId) {
      this.resetPending();
      return;
    }

    // ── Сигнал №1 (приоритетный): «личность» серии из разметки плеера ──
    // Он надёжнее сравнения URL: подпись ссылки переписывается, а у rezka она
    // вообще лежит в ПУТИ. Главное — он работает и там, где хелпер не может
    // отдать медиа-ссылку (плеер rezka не звал get_cdn_series, ссылки инлайн):
    // раньше в этом случае наблюдатель молчал, кнопка оставалась в «Готово» и
    // играла озвучка ПРЕДЫДУЩЕЙ серии до перезагрузки страницы.
    const episodeKey = this.peekEpisodeKey();
    if (episodeKey) {
      if (this.lastEpisodeKey === null) {
        // Первое наблюдение — просто запоминаем, это не «смена».
        this.lastEpisodeKey = episodeKey;
        this.pendingEpisodeKey = null;
        this.pendingEpisodeCount = 0;
        return;
      }

      if (episodeKey === this.lastEpisodeKey) {
        this.pendingEpisodeKey = null;
        this.pendingEpisodeCount = 0;
        return;
      }

      if (this.pendingEpisodeKey !== episodeKey) {
        this.pendingEpisodeKey = episodeKey;
        this.pendingEpisodeCount = 1;
        debug.log("[mediaWatcher] episode key differs, waiting for confirmation", {
          previous: this.lastEpisodeKey,
          peeked: episodeKey,
        });
        return;
      }

      this.pendingEpisodeCount += 1;
      if (this.pendingEpisodeCount < CONFIRMATIONS_REQUIRED) {
        return;
      }

      const previousKey = this.lastEpisodeKey;
      this.lastEpisodeKey = episodeKey;
      this.pendingEpisodeKey = null;
      this.pendingEpisodeCount = 0;
      debug.log("[mediaWatcher] episode changed, restarting lifecycle", {
        previous: previousKey,
        next: episodeKey,
      });
      void this.host.onMediaSourceChanged({
        previousUrl: previousKey,
        nextUrl: episodeKey,
      });
      return;
    }

    // ── Сигнал №2: сравнение медиа-ссылок (kinogo и прочие) ──
    const activeUrl = extractTranslationTargetUrl(videoData);
    const peekedUrl = this.peekMediaUrl();
    if (!activeUrl || !peekedUrl) {
      this.resetPending();
      return;
    }

    const active = normalizeMediaUrl(activeUrl);
    const peeked = normalizeMediaUrl(peekedUrl);

    // Сравниваем «личность» файла (путь), а не полный URL: подпись и хост
    // меняются на каждом запросе и не означают смену серии.
    if (mediaIdentity(active) === mediaIdentity(peeked)) {
      this.resetPending();
      return;
    }

    const peekedIdentity = mediaIdentity(peeked);
    if (this.pendingUrl !== peekedIdentity) {
      this.pendingUrl = peekedIdentity;
      this.pendingCount = 1;
      debug.log("[mediaWatcher] media url differs, waiting for confirmation", {
        active: active.slice(0, 120),
        peeked: peeked.slice(0, 120),
      });
      return;
    }

    this.pendingCount += 1;
    if (this.pendingCount < CONFIRMATIONS_REQUIRED) {
      return;
    }

    this.resetPending();
    if (this.lastLoggedUrl !== peekedIdentity) {
      this.lastLoggedUrl = peekedIdentity;
      debug.log("[mediaWatcher] media source changed, restarting lifecycle", {
        previous: active.slice(0, 120),
        next: peeked.slice(0, 120),
      });
    }

    void this.host.onMediaSourceChanged({ previousUrl: active, nextUrl: peeked });
  }

  private resetPending(): void {
    this.pendingUrl = null;
    this.pendingCount = 0;
  }
}
