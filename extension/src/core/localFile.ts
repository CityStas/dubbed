/**
 * [localfile] Локальные видео, открытые в браузере как `file:///…/video.mp4`.
 *
 * Зачем отдельный модуль. Обычный путь (хелпер сайта → прямая ссылка → Яндекс
 * скачивает сам) для `file://` невозможен: сервер Яндекса физически не может
 * достать файл с диска зрителя. Единственная работающая схема — та же, что уже
 * отлажена для YouTube: создать сессию перевода, дождаться `AUDIO_REQUESTED`
 * (status 6) и **самим залить аудио** в Яндекс.
 *
 * Здесь лежат три вещи:
 *  1. распознавание локальной страницы и сервис-конф (`custom`, rawResult);
 *  2. чтение байтов файла — через скрытый <iframe> со страницей расширения,
 *     потому что контент-скрипту `file://` недоступен вообще
 *     (проверено стендом: fetch → «Failed to fetch», XHR → status 0; а страница
 *     origin расширения отдаёт 95 МБ за ~150 мс);
 *  3. нарезка файла на куски для загрузки в Яндекс.
 *
 * ⚠️ Требование окружения: у расширения должен быть включён доступ к `file://`
 * («Разрешить доступ к файлам» в chrome://extensions, либо разрешение
 * `file:///*` в Firefox). Без него ридер не отдаст ни одного байта.
 */

import { VideoService } from "@vot.js/ext/types/service";
import type { ServiceConf } from "@vot.js/ext/types/service";
import { MARK, TYPE_REQ, TYPE_RES } from "../extension/shared/constants";
import { getSameWindowPostMessageTargetOrigin } from "../extension/shared/transport";
import debug from "../utils/debug";
import { makeAbortError } from "../utils/errors";

/**
 * Хост-«сервис» локального файла. Берём штатный `custom` («прямая ссылка») из
 * vot.js: для него SDK возвращает `videoId = url.href` без хелпера, то есть нам
 * не нужно патчить `@vot.js/ext`. Всё локальное поведение ниже включается по
 * `location.protocol === "file:"`, а не по хосту, — на другие сайты это не влияет.
 */
export const LOCAL_FILE_HOST = VideoService.custom;

/** Расширения, которые браузер открывает как медиа-документ. */
const LOCAL_MEDIA_EXT_RE =
  /\.(mp4|m4v|webm|mkv|mov|ogv|ogg|avi|flv|wmv|mpg|mpeg|m2ts|ts|3gp)([?#].*)?$/i;

/** Имя страницы-ридера (web_accessible_resource в корне расширения). */
const READER_PAGE = "localfile-reader.html";
const READER_READY_FLAG = "__dubbedLocalFileReady";
const READER_REQUEST_FLAG = "__dubbedLocalFileReq";
const READER_RESPONSE_FLAG = "__dubbedLocalFileRes";

const READER_READY_TIMEOUT_MS = 15_000;
const READER_READ_TIMEOUT_MS = 180_000;
const BRIDGE_TIMEOUT_MS = 20_000;

/**
 * Размер куска, уходящего в Яндекс. Совпадает с `MIN_CHUNK_SIZE` YouTube-пути
 * (`mseProxyHandler`): именно такие порции сервер уже умеет принимать.
 */
export const LOCAL_FILE_CHUNK_SIZE = 5_295_308;

const YOUTUBE_ID_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// ------------------------------------------------------------------
// Определение локальной страницы
// ------------------------------------------------------------------

function currentHref(): string {
  try {
    return String(globalThis.location?.href ?? "");
  } catch {
    return "";
  }
}

/** Локальная страница, открытая браузером как медиа-документ. */
export function isLocalFilePage(): boolean {
  let protocol = "";
  let pathname = "";
  try {
    protocol = String(globalThis.location?.protocol ?? "");
    pathname = String(globalThis.location?.pathname ?? "");
  } catch {
    return false;
  }

  if (protocol !== "file:") {
    return false;
  }

  return LOCAL_MEDIA_EXT_RE.test(pathname) || LOCAL_MEDIA_EXT_RE.test(currentHref());
}

/** Ссылка на локальный файл в том виде, в каком её понимает `fetch`. */
export function getLocalFileUrl(): string {
  return currentHref();
}

/**
 * Сервис-конф для `bindObserverListeners`. `rawResult: true` → SDK вернёт
 * `{ url: <file://…>, videoId: <file://…> }` без обращения к хелперу.
 * Селектор не задаём: `findContainer` возьмёт `video.parentElement` (монтировать
 * оверлей внутрь `<video>` нельзя).
 */
export function getLocalFileService(): ServiceConf | null {
  if (!isLocalFilePage()) {
    return null;
  }

  return {
    host: LOCAL_FILE_HOST,
    url: "stub",
    rawResult: true,
  };
}

// ------------------------------------------------------------------
// Синтетический таргет для Яндекса
// ------------------------------------------------------------------

function fnv1a(input: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Стабильный 11-символьный id в алфавите YouTube для конкретного пути файла.
 * Нужен, чтобы Яндекс завёл сессию с URL, по которому у него уже есть
 * отработанный сценарий «клиент сам пришлёт аудио» (`AUDIO_REQUESTED`), а не
 * пытался скачать `file://`. Один и тот же файл → один и тот же id → попадание
 * в кэш Яндекса при повторном переводе.
 */
export function buildLocalFileVideoId(fileUrl: string): string {
  const high = BigInt(fnv1a(fileUrl, 0x811c9dc5));
  const low = BigInt(fnv1a(`dubbed:localfile:${fileUrl}`, 0x01000193));
  let value = (high << 32n) | low;

  let id = "";
  for (let index = 0; index < 11; index += 1) {
    id += YOUTUBE_ID_ALPHABET[Number(value & 63n)];
    value >>= 6n;
  }
  return id;
}

/** Пара `url`/`videoId`, которую увидят Яндекс и весь остальной пайплайн. */
export function buildLocalFileApiTarget(fileUrl: string): {
  url: string;
  videoId: string;
} {
  const videoId = buildLocalFileVideoId(fileUrl);
  return { url: `https://youtu.be/${videoId}`, videoId };
}

// ------------------------------------------------------------------
// Мост MAIN → ISOLATED (только чтобы узнать URL ридера)
// ------------------------------------------------------------------

type BridgePending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

const bridgePending = new Map<string, BridgePending>();
let bridgeSeq = 0;
let bridgeListenerInstalled = false;

function installBridgeListener(): void {
  if (bridgeListenerInstalled) {
    return;
  }
  bridgeListenerInstalled = true;

  globalThis.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as Record<string, unknown> | null;
    if (!data || data[MARK] !== true || data.type !== TYPE_RES) {
      return;
    }

    const id = String(data.id ?? "");
    const pending = bridgePending.get(id);
    if (!pending) {
      return;
    }

    bridgePending.delete(id);
    clearTimeout(pending.timeoutId);

    if (data.ok) {
      pending.resolve(data.result);
    } else {
      pending.reject(new Error(String(data.error ?? "Dubbed bridge request failed")));
    }
  });
}

function bridgeRequest<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  installBridgeListener();

  const id = `dubbed-localfile-${Date.now().toString(36)}-${(bridgeSeq += 1).toString(36)}`;

  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      bridgePending.delete(id);
      reject(new Error(`Dubbed bridge timeout for ${action}`));
    }, BRIDGE_TIMEOUT_MS);

    bridgePending.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
      timeoutId,
    });

    globalThis.postMessage(
      { [MARK]: true, type: TYPE_REQ, id, action, payload },
      getSameWindowPostMessageTargetOrigin(),
    );
  });
}

let readerUrlPromise: Promise<string | null> | null = null;

async function getReaderUrl(): Promise<string | null> {
  if (!readerUrlPromise) {
    readerUrlPromise = bridgeRequest<{ url?: string | null }>("localFileReaderUrl")
      .then((result) =>
        typeof result?.url === "string" && result.url ? result.url : null,
      )
      .catch((error) => {
        debug.warn("[localfile] не удалось получить URL ридера", error);
        return null;
      });
  }

  const url = await readerUrlPromise;
  // ⚠️ Неудачу НЕ кэшируем. Раньше `??=` запоминал `null` на всю жизнь документа:
  // один таймаут моста (20 c) на старте — и все последующие попытки читать файл
  // падали мгновенно, без шанса восстановиться до перезагрузки страницы.
  if (!url) {
    readerUrlPromise = null;
  }
  return url;
}

// ------------------------------------------------------------------
// Чтение файла через iframe ридера
// ------------------------------------------------------------------

const FILE_ACCESS_HINT =
  "Не удалось прочитать локальный файл. Включите у расширения «Разрешить доступ к файлам» (chrome://extensions → карточка расширения → Подробнее) и перезагрузите страницу.";

type ReaderWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

const readyWaiters = new Set<ReaderWaiter>();
const readWaiters = new Map<
  string,
  {
    resolve: (buffer: ArrayBuffer) => void;
    reject: (error: Error) => void;
    timeoutId: ReturnType<typeof setTimeout>;
  }
>();

let readerFrame: HTMLIFrameElement | null = null;
let readerReadyPromise: Promise<void> | null = null;
let readerListenerInstalled = false;
let readSeq = 0;

function installReaderListener(): void {
  if (readerListenerInstalled) {
    return;
  }
  readerListenerInstalled = true;

  globalThis.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as Record<string, unknown> | null;
    if (!data || typeof data !== "object") {
      return;
    }

    if (data[READER_READY_FLAG] === true) {
      for (const waiter of readyWaiters) {
        clearTimeout(waiter.timeoutId);
        waiter.resolve();
      }
      readyWaiters.clear();
      return;
    }

    if (data[READER_RESPONSE_FLAG] !== true) {
      return;
    }

    const id = String(data.id ?? "");
    const waiter = readWaiters.get(id);
    if (!waiter) {
      return;
    }

    readWaiters.delete(id);
    clearTimeout(waiter.timeoutId);

    if (data.ok === true && data.buffer instanceof ArrayBuffer) {
      waiter.resolve(data.buffer);
    } else {
      waiter.reject(new Error(String(data.error ?? FILE_ACCESS_HINT)));
    }
  });
}

/**
 * Сносит кадр ридера и все ожидания на нём. Нужен, потому что «кадр есть, но
 * не поднялся» — это отдельное состояние: `readerReadyPromise` остаётся
 * rejected-промисом, и любой следующий `ensureReaderFrame` падал бы на нём
 * мгновенно, уже без таймаута. Плюс висящие `readWaiters` держали бы вызов
 * `readLocalFileBuffer` до `READER_READ_TIMEOUT_MS` (3 мин) на пустом месте.
 */
function teardownReaderFrame(reason: Error = new Error(FILE_ACCESS_HINT)): void {
  for (const waiter of readyWaiters) {
    clearTimeout(waiter.timeoutId);
    waiter.reject(reason);
  }
  readyWaiters.clear();

  for (const waiter of readWaiters.values()) {
    clearTimeout(waiter.timeoutId);
    waiter.reject(reason);
  }
  readWaiters.clear();

  try {
    readerFrame?.remove();
  } catch {
    // ignore
  }
  readerFrame = null;
  readerReadyPromise = null;
}

/**
 * Сброс состояния ридера перед повторной попыткой загрузки аудио. Байты файла
 * (`fileBufferCache`) намеренно НЕ трогаем: 150 МБ читаются заново незачем.
 */
export function resetLocalFileReaderState(): void {
  readerUrlPromise = null;
  teardownReaderFrame();
}

async function ensureReaderFrame(): Promise<HTMLIFrameElement> {
  if (readerFrame?.isConnected && readerReadyPromise) {
    try {
      await readerReadyPromise;
      return readerFrame;
    } catch {
      teardownReaderFrame();
    }
  }

  installReaderListener();

  const readerUrl = await getReaderUrl();
  if (!readerUrl) {
    throw new Error(FILE_ACCESS_HINT);
  }

  const frame = document.createElement("iframe");
  frame.src = readerUrl;
  frame.setAttribute("aria-hidden", "true");
  frame.setAttribute("tabindex", "-1");
  frame.style.cssText =
    "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;border:0";

  readerFrame = frame;
  const readyPromise = new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      teardownReaderFrame(new Error(FILE_ACCESS_HINT));
    }, READER_READY_TIMEOUT_MS);

    readyWaiters.add({ resolve, reject, timeoutId });
  });
  readerReadyPromise = readyPromise;

  (document.body ?? document.documentElement)?.appendChild(frame);

  try {
    await readyPromise;
  } catch (error) {
    // Кадр не поднялся — убираем его, иначе следующая попытка упадёт на уже
    // rejected-промисe, не дав ридеру ни единого шанса.
    teardownReaderFrame();
    throw error instanceof Error ? error : new Error(FILE_ACCESS_HINT);
  }

  debug.log("[localfile] ридер готов", { readerUrl });
  return frame;
}

const fileBufferCache = new Map<string, Promise<ArrayBuffer>>();

/** Байты локального файла. Повторные вызовы переиспользуют уже прочитанное. */
export async function readLocalFileBuffer(fileUrl = getLocalFileUrl()): Promise<ArrayBuffer> {
  const cached = fileBufferCache.get(fileUrl);
  if (cached) {
    return await cached;
  }

  const promise = (async () => {
    await ensureReaderFrame();
    const frame = readerFrame;
    if (!frame?.contentWindow) {
      throw new Error(FILE_ACCESS_HINT);
    }

    const id = `dubbed-read-${Date.now().toString(36)}-${(readSeq += 1).toString(36)}`;

    const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        readWaiters.delete(id);
        reject(new Error(FILE_ACCESS_HINT));
      }, READER_READ_TIMEOUT_MS);

      readWaiters.set(id, { resolve, reject, timeoutId });

      try {
        frame.contentWindow?.postMessage(
          { [READER_REQUEST_FLAG]: true, id, url: fileUrl },
          "*",
        );
      } catch (error) {
        readWaiters.delete(id);
        clearTimeout(timeoutId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    debug.log("[localfile] файл прочитан", {
      bytes: buffer.byteLength,
      fileUrl,
    });
    return buffer;
  })();

  fileBufferCache.set(fileUrl, promise);
  try {
    return await promise;
  } catch (error) {
    // Не кэшируем ошибку: пользователь мог включить доступ к файлам и обновить
    // страницу — повторная попытка должна сработать.
    fileBufferCache.delete(fileUrl);
    throw error;
  }
}

/**
 * Куски файла для загрузки в Яндекс. Отдаём ровно тот же формат, что и
 * YouTube-стратегия (`{buffer, isLastChunk}`), поэтому вся остальная логика
 * (протобуф, ретраи, ожидание готовности) не меняется.
 */
export async function* getLocalFileChunks(
  chunkSize: number = LOCAL_FILE_CHUNK_SIZE,
  signal?: AbortSignal,
): AsyncGenerator<{ buffer: Uint8Array; isLastChunk: boolean }> {
  const fileUrl = getLocalFileUrl();
  const buffer = await readLocalFileBuffer(fileUrl);
  const total = buffer.byteLength;
  const parts = Math.max(1, Math.ceil(total / chunkSize));

  debug.log("[localfile] нарезка файла", { total, parts, chunkSize });

  for (let index = 0; index < parts; index += 1) {
    if (signal?.aborted) {
      // Отмена (повторный клик по кнопке, смена видео) — это НЕ сбой загрузки.
      // `runAudioDownload` ловит любое исключение и докладывает
      // `downloadAudioError`, а для `file://` это превращалось в тупиковое
      // «Failed to download audio» без причины.
      const reason = signal.reason;
      throw makeAbortError(reason instanceof Error ? reason.message : undefined);
    }

    const start = index * chunkSize;
    const end = Math.min(total, start + chunkSize);
    yield {
      buffer: new Uint8Array(buffer.slice(start, end)),
      isLastChunk: index === parts - 1,
    };
  }
}

/** Сколько кусков будет у текущего файла (для прогресса и диагностики). */
export async function getLocalFilePartCount(
  chunkSize: number = LOCAL_FILE_CHUNK_SIZE,
): Promise<{ parts: number; size: number }> {
  const buffer = await readLocalFileBuffer();
  return {
    size: buffer.byteLength,
    parts: Math.max(1, Math.ceil(buffer.byteLength / chunkSize)),
  };
}
