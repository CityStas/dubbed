/**
 * [kinogo-patch] Ранний сбор медиа-ссылок на страницах iframe-плееров kinoGo
 * (ortified / cinemar / sevstar-хосты).
 *
 * ПОЧЕМУ ТАК. Плееры kinoGo (Playerjs + hls.js) собирают URL манифеста в JS:
 * в HTML его нет вообще (`document.documentElement.innerHTML` не содержит
 * `.m3u8`), а поддомены CDN ротируются (`cfnd.` / `host.` / `minos.host.` /
 * `potassium.host.cinemap.cc`). Поэтому:
 *
 *   1) Источник №1 — Performance Resource Timing: `performance.getEntriesByType
 *      ("resource")` + `PerformanceObserver({buffered:true})` видят ЛЮБОЙ
 *      транспорт (XHR/fetch/<video>/MSE) и все поддомены. Никакого инжекта в
 *      страницу, никаких проблем с CSP и с экранированием regex внутри строки
 *      (прежняя версия хука теряла все ссылки из-за переэкранированного
 *      `/\\.(m3u8|mp4)/` — она не матчила ни одного URL).
 *   2) Источник №2 (страховка) — прямой MAIN-world перехват fetch/XHR.
 *      Контент-скрипт уже исполняется в MAIN world (manifest: world=MAIN),
 *      поэтому патчим напрямую, без `<script>`-трюка.
 *
 * Найденные ссылки складываются в `window.__dubbedKinogoPerf.urls` (свой
 * массив, а не resource-буфер браузера — буфер вытесняет master.m3u8 у
 * длинных фильмов с тысячами сегментов).
 */

const PERF_KEY = "__dubbedKinogoPerf";
const HOOK_FLAG = "__dubbedKinogoEarlyHook";
const DATA_KEY = "dubbedKinogoMedia";

/** .m3u8 / .mp4 / .webm — сегменты .ts намеренно не собираем. */
const MEDIA_RE = /\.(m3u8|mp4|webm)([?#]|$)/i;
const MAX_URLS = 120;
/** Буфер resource timing по умолчанию 250 записей — мало для длинного HLS. */
const RESOURCE_BUFFER_SIZE = 1000;

type KinogoPerfStore = {
  ts: number;
  urls: string[];
};

type KinogoWindow = Record<string, unknown> & {
  [PERF_KEY]?: KinogoPerfStore;
  [HOOK_FLAG]?: boolean;
};

export function collectKinogoPerfMedia(): void {
  const w = globalThis as unknown as KinogoWindow;
  if (w[PERF_KEY]) {
    return;
  }

  const store: KinogoPerfStore = { ts: Date.now(), urls: [] };
  w[PERF_KEY] = store;

  const push = (raw: unknown): void => {
    if (typeof raw !== "string" || !MEDIA_RE.test(raw)) {
      return;
    }
    if (store.urls.includes(raw)) {
      return;
    }
    store.urls.push(raw);
    if (store.urls.length > MAX_URLS) {
      store.urls.shift();
    }
    store.ts = Date.now();
  };

  try {
    performance.setResourceTimingBufferSize?.(RESOURCE_BUFFER_SIZE);
  } catch {
    // не критично: работаем с тем, что есть
  }

  // Уже загруженные ресурсы (если контент-скрипт догнал позже плеера).
  try {
    for (const entry of performance.getEntriesByType("resource")) {
      push(entry.name);
    }
  } catch {
    // ignore
  }

  // Новые ресурсы, включая появившиеся до старта observer'а.
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        push(entry.name);
      }
    });
    observer.observe({ type: "resource", buffered: true });
  } catch {
    // ignore
  }

  // Страховка: плеер мог использовать транспорт, не попадающий в resource
  // timing (нестандартный/обёрнутый). Дублируем перехватом fetch/XHR.
  installTransportHook(push, w);
}

function installTransportHook(
  push: (url: unknown) => void,
  w: KinogoWindow,
): void {
  if (w[HOOK_FLAG]) {
    return;
  }
  w[HOOK_FLAG] = true;

  try {
    const originalFetch = globalThis.fetch;
    if (typeof originalFetch === "function") {
      globalThis.fetch = function patchedFetch(
        this: unknown,
        input: RequestInfo | URL,
        init?: RequestInit,
      ) {
        try {
          const url =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : (input as Request)?.url;
          push(url);
        } catch {
          // ignore
        }
        return originalFetch.call(this as typeof globalThis, input, init);
      } as typeof fetch;
    }
  } catch {
    // ignore
  }

  try {
    const proto = XMLHttpRequest.prototype as XMLHttpRequest & {
      __dubbedUrl?: string;
    };
    const originalOpen = proto.open;
    const originalSend = proto.send;

    proto.open = function patchedOpen(
      this: XMLHttpRequest & { __dubbedUrl?: string },
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ): void {
      try {
        this.__dubbedUrl = typeof url === "string" ? url : url?.href;
      } catch {
        // ignore
      }
      return (originalOpen as (...a: unknown[]) => void).call(
        this,
        method,
        url,
        ...rest,
      );
    } as typeof proto.open;

    proto.send = function patchedSend(
      this: XMLHttpRequest & { __dubbedUrl?: string },
      ...args: unknown[]
    ): void {
      try {
        this.addEventListener("load", () => push(this.__dubbedUrl));
      } catch {
        // ignore
      }
      return (originalSend as (...a: unknown[]) => void).call(this, ...args);
    } as typeof proto.send;
  } catch {
    // ignore
  }
}

/** Сохраняет одиночную ссылку в dataset — обратная совместимость с хелпером. */
export function rememberKinogoMedia(url: unknown): void {
  if (typeof url !== "string" || !MEDIA_RE.test(url)) {
    return;
  }
  try {
    document.documentElement.dataset[DATA_KEY] = JSON.stringify({
      ts: Date.now(),
      url,
    });
  } catch {
    // ignore
  }
}

export function injectKinogoMediaHook(): void {
  collectKinogoPerfMedia();
}
