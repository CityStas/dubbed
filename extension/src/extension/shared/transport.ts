import { type AnyObject, MARK, TYPE_XHR_EVENT } from "./constants";

type BridgeMarkedMessage = AnyObject & { [MARK]: true };

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer;
}

function getTransferables(payload: AnyObject): Transferable[] {
  if (payload.type !== TYPE_XHR_EVENT) return [];

  const eventPayload = payload.payload as AnyObject | undefined;
  const progressChunk = eventPayload?.progress?.chunk;
  const responseBody = eventPayload?.response?.response;

  if (!isArrayBuffer(progressChunk)) {
    return isArrayBuffer(responseBody) ? [responseBody] : [];
  }

  if (!isArrayBuffer(responseBody) || responseBody === progressChunk) {
    return [progressChunk];
  }

  return [progressChunk, responseBody];
}

export function toBridgeMessage(payload: AnyObject): BridgeMarkedMessage {
  // Always force the marker at the final write position.
  return { ...payload, [MARK]: true };
}

/**
 * Origin, который нельзя передать в `postMessage` как targetOrigin.
 *
 * `"null"` — about:blank / about:srcdoc / sandboxed frames.
 * `"file://"` — документы `file://`: `location.origin` сериализуется как
 * строка `"file://"`, а реальный (opaque) origin окна — `"null"`. Передача
 * `"file://"` в качестве targetOrigin бросает DOMException
 * («target origin provided ('file://') does not match the recipient window's
 * origin ('null')»), сообщение не уходит вообще — и на локальных видео все
 * GM-запросы прелюда падали в таймаут. Единственный валидный таргет — `"*"`;
 * получатель всё равно проверяет event.source и приватный маркер.
 */
function isUnusableTargetOrigin(origin: string | undefined): boolean {
  return !origin || origin === "null" || origin === "file://";
}

export function getSameWindowPostMessageTargetOrigin(): string {
  const origin = globalThis.location?.origin;

  return isUnusableTargetOrigin(origin) ? "*" : (origin as string);
}

export function isSameWindowBridgeEvent(event: MessageEvent): boolean {
  if (event.source !== globalThis.window) return false;

  const origin = globalThis.location?.origin;
  if (isUnusableTargetOrigin(origin)) {
    // На file:// окно сообщает origin "null", а location.origin — "file://",
    // поэтому прямое сравнение ниже не сработало бы и мост отверг бы
    // собственные сообщения страницы.
    return event.origin === "null" || event.origin === origin;
  }

  return event.origin === origin;
}

export function toPageMessage(payload: AnyObject): {
  message: BridgeMarkedMessage;
  transfer: Transferable[];
} {
  const message = toBridgeMessage(payload);
  return {
    message,
    transfer: getTransferables(payload),
  };
}
