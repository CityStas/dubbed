import { openAuthWindow } from "../core/authWindow";
import { localizationProvider } from "../localization/localizationProvider";
import type { Status } from "../types/components/dubbedButton";
import { deleteExpiredAccount } from "../utils/account";
import debug from "../utils/debug";
import { isAbortError } from "../utils/errors";
import type { VideoHandler } from "../VideoHandler";
import DubbedLocalizedError from "../DubbedLocalizedError";

type TranslationButtonCommandDeps = {
  videoHandler?: VideoHandler;
  currentStatus: Status;
  currentLoading: boolean;
  transformBtn(status: Status, text: string): void;
};

async function getVideoDataForTranslation(videoHandler: VideoHandler) {
  if (!videoHandler.videoData?.videoId) {
    // [rezka-patch] Retry: lifecycle мог остаться без videoData после ошибки
    // анти-фрода rezka ("Время сессии истекло"/"unauthorized"). Повторный
    // setCanPlay заново вызывает getVideoData — RezkaHelper сам запустит play
    // и подхватит легитимный ответ плеера.
    try {
      await videoHandler.setCanPlay();
    } catch (err) {
      debug.log("[handleTranslationBtnClick] setCanPlay retry failed", err);
    }
  }

  if (!videoHandler.videoData?.videoId) {
    throw new DubbedLocalizedError("DubbedNoVideoIDFound");
  }

  // [rezka-patch] Для rezka: серия попыток получить РЕАЛЬНЫЕ ссылки, а не
  // заглушку. RezkaHelper сам кликает по play-кнопке плеера и ждёт ответ
  // hook. Пока ссылок нет — повторяем (до ~5 раз, ~2 сек между ними, итого
  // до ~10 сек). Только если так и не получилось — понятная ошибка.
  if (shouldRefreshVideoDataBeforeTranslation(videoHandler)) {
    // [kinogo-patch] Кнопка теперь появляется ДО нажатия Play (VideoObserver
    // больше не ждёт HAVE_CURRENT_DATA), поэтому пользователь может нажать
    // «Перевести видео», пока плеер ещё не запросил манифест: у ortified <video>
    // стоит в `player-paused` с readyState 0 и пустым perf-коллектором. Нужно
    // дать плееру стартовать, иначе свежую ссылку взять неоткуда.
    //
    // ЖАЛОБА 2026-09-13: «нажимаю Перевести видео — ролик сам начинает играть».
    // Раньше мы делали `video.play()` и ОСТАВЛЯЛИ плеер играть. Теперь пинаем
    // плеер ТОЛЬКО если манифеста ещё нет, и сразу возвращаем паузу, как только
    // ссылка попала в perf-коллектор (или истёк короткий таймаут). Если манифест
    // уже есть — Play не трогаем вообще.
    const releaseNudge = await nudgeKinogoPlayerForManifest(videoHandler);

    let fresh;
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          fresh = await videoHandler.getVideoData();
        } catch (err) {
          debug.log("[handleTranslationBtnClick] videoData refresh failed", err);
          fresh = undefined;
        }
        if (fresh?.videoId && !isPlaceholderVideoData(fresh)) {
          videoHandler.videoData = fresh;
          break;
        }
        if (attempt < 4) {
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    } finally {
      // Возвращаем паузу, даже если ссылку так и не получили.
      releaseNudge();
    }
    if (fresh?.videoId && !isPlaceholderVideoData(fresh)) {
      return videoHandler.videoData!;
    }
    throw new Error(
      "Не удалось получить ссылку на видео. Воспроизведите ролик на плеере обычным нажатием и повторите.",
    );
  }

  if (!videoHandler.videoData?.videoId) {
    throw new DubbedLocalizedError("DubbedNoVideoIDFound");
  }

  return videoHandler.videoData;
}

function isPlaceholderVideoData(videoData: { url?: string; _placeholder?: boolean } | undefined): boolean {
  if (!videoData) return false;
  if (videoData._placeholder) return true;
  const u = videoData.url || "";
  return (
    u.includes("rezka.invalid") ||
    u.includes("kinogo.invalid") ||
    u.includes("placeholder")
  );
}

/** Сколько ждём появления манифеста после «пинка» плеера. */
const KINOGO_NUDGE_WAIT_MS = 4000;
/** Как часто проверяем perf-коллектор во время «пинка». */
const KINOGO_NUDGE_POLL_MS = 150;

/** Ключ коллектора из `src/kinogoEarlyHook.ts`. */
function kinogoPerfStore(): { urls?: unknown } | undefined {
  try {
    return (globalThis as Record<string, unknown>).__dubbedKinogoPerf as
      | { urls?: unknown }
      | undefined;
  } catch {
    return undefined;
  }
}

/** Есть ли в perf-коллекторе хоть один HLS-манифест (реклама — это mp4). */
function hasKinogoManifest(): boolean {
  const urls = kinogoPerfStore()?.urls;
  if (!Array.isArray(urls)) {
    return false;
  }
  return urls.some(
    (url) => typeof url === "string" && /\.m3u8([?#]|$)/i.test(url),
  );
}

/**
 * [kinogo-patch] Плееры kinogo (ortified/Playerjs) запрашивают master.m3u8
 * ТОЛЬКО после Play: до него perf-коллектор пуст, и мы показали бы
 * «воспроизведите ролик обычным нажатием». Но нажимать Play за пользователя
 * нельзя — жалоба 2026-09-13: «нажимаю Перевести видео, ролик сам играет».
 *
 * Поэтому: если манифеста ещё нет — коротко пинаем плеер (`play()`) и гасим
 * воспроизведение при первом же признаке старта:
 *   — событие `playing` у <video> (самый ранний момент, когда картинка пошла);
 *   — либо появление HLS-ссылки в perf-коллекторе;
 *   — либо резолв промиса `play()` (он резолвится ровно в момент реального
 *     старта, в т.ч. отложенного: у ortified источника до Play нет).
 * Замер стендом: до фикса ролик играл до конца сессии, после — видимый «блип»
 * порядка 0.2–0.5 c и сразу пауза.
 *
 * Если манифест уже есть либо пользователь сам смотрит видео — не трогаем ничего.
 *
 * @returns функция «вернуть паузу» — вызывать в `finally`; безопасна к повторным
 *   вызовам и не мешает, если пользователь сам нажал Play после старта.
 */
async function nudgeKinogoPlayerForManifest(
  videoHandler: VideoHandler,
): Promise<() => void> {
  const noop = () => undefined;
  if (videoHandler.site.host !== "kinogo") {
    return noop;
  }

  const video = videoHandler.video;
  // Пользователь уже смотрит — не мешаем воспроизведению.
  if (!video || !video.paused || hasKinogoManifest()) {
    return noop;
  }

  debug.log(
    "[handleTranslationBtnClick] kinogo: пинок плееру за манифестом (Play вернём в паузу)",
  );

  // «Мы начали это воспроизведение» — флаг снимается только тогда, когда пауза
  // реально возвращена. Нельзя тратить его на «видео ещё на паузе»: у ortified
  // источника до Play нет, и `play()` резолвится ПОЗЖЕ нашего таймаута.
  let nudgedActive = true;
  const pauseIfPlaying = () => {
    if (!nudgedActive || video.paused) {
      return;
    }
    nudgedActive = false;
    try {
      video.pause();
      debug.log(
        "[handleTranslationBtnClick] kinogo: пауза возвращена (пользователь Play не нажимал)",
      );
    } catch (err) {
      debug.log("[handleTranslationBtnClick] kinogo: pause() не удался", err);
    }
  };
  const onPlaying = () => pauseIfPlaying();
  video.addEventListener("playing", onPlaying, { passive: true });

  const releaseNudge = () => {
    video.removeEventListener("playing", onPlaying);
    pauseIfPlaying();
  };

  let playPromise: Promise<void> | undefined;
  try {
    playPromise = video.play();
  } catch (err) {
    debug.log("[handleTranslationBtnClick] kinogo: play() не удался", err);
    releaseNudge();
    return noop;
  }

  // `play()` резолвится только когда воспроизведение РЕАЛЬНО началось. Если у
  // <video> ещё не было источника (типично для ortified до Play), старт приходит
  // позже нашего таймаута — и плеер оставался играть. Поэтому вешаемся и на
  // промис: как только воспроизведение пошло — сразу возвращаем паузу.
  void playPromise?.then(pauseIfPlaying).catch(() => undefined);

  const deadline = Date.now() + KINOGO_NUDGE_WAIT_MS;
  while (Date.now() < deadline) {
    if (hasKinogoManifest()) {
      break;
    }
    await new Promise((r) => setTimeout(r, KINOGO_NUDGE_POLL_MS));
  }

  // Слушатель `playing` НЕ снимаем: он должен погасить и отложенный старт,
  // пока идёт получение свежей ссылки (вызов releaseNudge — в `finally`).
  pauseIfPlaying();
  return releaseNudge;
}

function shouldRefreshVideoDataBeforeTranslation(videoHandler: VideoHandler) {
  return (
    (videoHandler.site.host === "vk" &&
      videoHandler.site.additionalData === "clips") ||
    videoHandler.site.host === "douyin" ||
    // [rezka-patch] Ссылки CDN rezka короткоживущие — всегда берём свежие
    // (hook подхватит актуальный ответ плеера) перед каждым переводом.
    videoHandler.site.host === "rezka" ||
    // [kinogo-patch] CDN киноплееров (cinemap/interkh) раздаёт манифест с
    // короткоживущим токеном в пути (`:2026091223`) и ротирует поддомены.
    // К моменту клика ссылка могла протухнуть, а на первом setCanPlay медиа
    // ещё не было вовсе (плеер грузит манифест после Play) — поэтому берём
    // свежую ссылку из performance-коллектора прямо перед переводом.
    videoHandler.site.host === "kinogo"
  );
}

async function prepareAuthStateForTranslation(
  videoHandler: VideoHandler,
): Promise<void> {
  // Missing account and expired session are different states. Live voices may be
  // requested without an account, but an expired saved session should be shown to
  // the user explicitly instead of falling through to a generic login-required
  // backend response.
  const expired = await deleteExpiredAccount(videoHandler);
  if (!expired) {
    return;
  }

  openAuthWindow();
  throw new DubbedLocalizedError("DubbedYandexTokenExpired");
}

export async function handleTranslationButtonCommand(
  deps: TranslationButtonCommandDeps,
) {
  const videoHandler = deps.videoHandler;
  if (!videoHandler) {
    return;
  }

  debug.log("[handleTranslationBtnClick] click translationBtn");

  // Кнопка хочет начать новый перевод только в idle-состоянии («Перевести видео»).
  const wantsNewTranslation =
    deps.currentStatus === "none" && !deps.currentLoading;

  if (videoHandler.hasActiveSource() && !wantsNewTranslation) {
    // Готовая озвучка / активный перевод — клик = остановить (toggle off).
    debug.log("[handleTranslationBtnClick] video has active source");
    await videoHandler.stopTranslation();
    return;
  }

  if (videoHandler.hasActiveSource() && wantsNewTranslation) {
    // [series-fix] Кнопка уже сброшена в «Перевести видео» (смена серии
    // перезапустила жизненный цикл / сбросила UI), но в аудио-плеере остался
    // источник от ПРЕДЫДУЩЕЙ серии. Раньше `hasActiveSource()` тут просто
    // останавливал и выходил — пользователю приходилось нажимать кнопку
    // ВТОРОЙ раз. Чистим «зависший» источник и продолжаем тем же кликом:
    // новая серия запускается сразу, без лишнего нажатия.
    debug.log(
      "[handleTranslationBtnClick] clearing stale source before new translation",
    );
    await videoHandler.stopTranslation();
  }

  if (deps.currentStatus === "error" && !deps.currentLoading) {
    deps.transformBtn("none", localizationProvider.get("translateVideo"));
  }

  if (deps.currentStatus !== "none" || deps.currentLoading) {
    debug.log("[handleTranslationBtnClick] translationBtn isn't in none state");
    videoHandler.actionsAbortController.abort();
    await videoHandler.stopTranslation();
    return;
  }

  try {
    await prepareAuthStateForTranslation(videoHandler);

    debug.log("[handleTranslationBtnClick] trying execute translation");
    // [rezka-patch] Показываем загрузку на время получения ссылок (retry) —
    // иначе кнопка "висит" без обратной связи до ~10 секунд.
    //
    // ⚠️ Текст — ТОТ ЖЕ единый статус ожидания, что и у счётчика очереди
    // (`TranslationEtaCountdown.createEtaMessage`). Раньше здесь была
    // захардкоженная русская строка «Подготавливаем видео к переводу...», из-за
    // чего после клика пользователь видел ДВА разных текста подряд (сначала
    // «Подготавливаем...», потом «Ещё примерно N минут»). Запрос 13.09.2026 —
    // один статус от клика до «Готово! Нажмите "Play"». Заодно это чинит
    // локализацию: строка больше не русская для всех языков интерфейса.
    deps.transformBtn(
      "loading",
      localizationProvider.get("translationWaitingForAudio"),
    );
    const videoData = await getVideoDataForTranslation(videoHandler);
    await videoHandler.videoManager.ensureDetectedLanguageForTranslation(
      videoData,
    );

    debug.log(
      "[handleTranslationBtnClick] Run translateFunc",
      videoData.videoId,
    );
    await videoHandler.translateFunc(
      videoData.videoId,
      videoData.isStream,
      videoData.detectedLanguage,
      videoData.responseLanguage,
      videoData.translationHelp,
    );
  } catch (err) {
    if (isAbortError(err)) {
      deps.transformBtn("none", localizationProvider.get("translateVideo"));
      return;
    }

    console.error("[Dubbed]", err);
    if (!(err instanceof Error)) {
      deps.transformBtn("error", String(err));
      return;
    }

    const message =
      err.name === "DubbedLocalizedError"
        ? (err as DubbedLocalizedError).localizedMessage
        : err.message;
    deps.transformBtn("error", message);
  }
}
