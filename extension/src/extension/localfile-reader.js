/*
 * Dubbed: ридер локальных файлов.
 *
 * Запускается в origin расширения (chrome-extension:// / moz-extension://), куда
 * попадает как web_accessible_resource из скрытого <iframe> на `file://`-странице
 * с видео. Только этот контекст имеет право читать `file://` (нужен включённый
 * тумблер «Разрешить доступ к файлам» / file:// host permission).
 *
 * Протокол (все сообщения — через `postMessage`):
 *   reader → parent : { __dubbedLocalFileReady: true }
 *   parent → reader : { __dubbedLocalFileReq: true, id, url }
 *   reader → parent : { __dubbedLocalFileRes: true, id, ok, size, buffer }  // buffer трансфером
 *                   | { __dubbedLocalFileRes: true, id, ok: false, error }
 *
 * Файл читается целиком за один запрос и передаётся БЕЗ копирования
 * (transferable ArrayBuffer): 95 МБ локального mp4 — ~150 мс.
 */
(() => {
  const REQ = "__dubbedLocalFileReq";
  const RES = "__dubbedLocalFileRes";
  const READY = "__dubbedLocalFileReady";

  // Больше 4 ГБ всё равно не влезет в ArrayBuffer, а для видео это заведомо
  // не наш случай — лучше внятная ошибка, чем OOM.
  const MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024;

  function post(target, payload, transfer) {
    const receiver = target || window.parent;
    try {
      receiver.postMessage(payload, "*", transfer || []);
    } catch (error) {
      try {
        receiver.postMessage(payload, "*");
      } catch (fallbackError) {
        console.error("[Dubbed][localFileReader] postMessage failed", fallbackError);
      }
    }
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || typeof data !== "object" || data[REQ] !== true) {
      return;
    }

    const reply = event.source || window.parent;
    const id = data.id;

    (async () => {
      try {
        const response = await fetch(String(data.url));
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText || ""}`.trim());
        }

        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > MAX_FILE_BYTES) {
          throw new Error(`File is too large (${buffer.byteLength} bytes)`);
        }

        post(reply, { [RES]: true, id, ok: true, size: buffer.byteLength, buffer }, [buffer]);
      } catch (error) {
        const message = (error && error.message) || String(error);
        console.warn("[Dubbed][localFileReader] read failed", data.url, message);
        post(reply, { [RES]: true, id, ok: false, error: message });
      }
    })();
  });

  // Готовность сообщаем и сразу, и после загрузки — родитель может подключиться
  // как до, так и после нашего скрипта.
  post(null, { [READY]: true, href: location.href });
  window.addEventListener("DOMContentLoaded", () => {
    post(null, { [READY]: true, href: location.href });
  });
})();
