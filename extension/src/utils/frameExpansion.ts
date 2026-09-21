/**
 * Разворот iframe-плеера на время открытия окна настроек.
 *
 * Проблема (замер на kinogo, плеер в iframe 641x400):
 *   — окно настроек рисуется ВНУТРИ iframe плеера;
 *   — фрейм физически не может быть выше самого себя, поэтому диалог
 *     упирается в `innerHeight` (доступно 368px при контенте 656px)
 *     и превращается в узкую прокручиваемую полоску;
 *   — «развернуть» его средствами CSS невозможно: iframe всегда обрезает
 *     содержимое по своим границам.
 *
 * Решение: на время открытия настроек просим родительский фрейм растянуть
 * наш iframe на весь viewport (`position: fixed; inset: 0; 100vw x 100vh`).
 * Внутри фрейма `innerHeight` становится равен высоте окна, и диалог
 * разворачивается целиком без внутреннего скролла. При закрытии возвращаем
 * исходный inline-style — страница остаётся ровно такой, какой была.
 *
 * Связь между фреймами — обычный `postMessage` (кросс-доменный iframe
 * плеера не даёт доступа к DOM родителя напрямую).
 */

const MESSAGE_MARK = "__dubbedFrameExpansion";
const EXPANDED_ATTR = "data-dubbed-frame-expanded";

type FrameExpansionMessage = {
  [MESSAGE_MARK]: true;
  type: "expand" | "collapse";
};

function isFrameExpansionMessage(data: unknown): data is FrameExpansionMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as Record<string, unknown>)[MESSAGE_MARK] === true &&
    ((data as FrameExpansionMessage).type === "expand" ||
      (data as FrameExpansionMessage).type === "collapse")
  );
}

// #region [Client] код внутри iframe плеера

let clientInitialized = false;

function postToAncestors(message: FrameExpansionMessage): void {
  const targets = new Set<Window>();
  try {
    if (globalThis.top) targets.add(globalThis.top);
  } catch {
    /* cross-origin access to `top` can throw in exotic sandboxes */
  }
  try {
    if (globalThis.parent) targets.add(globalThis.parent);
  } catch {
    /* ignore */
  }

  for (const target of targets) {
    try {
      target.postMessage(message, "*");
    } catch {
      /* ignore: родитель недоступен — настройки просто останутся в размере фрейма */
    }
  }
}

/**
 * Просит родительский фрейм развернуть (или вернуть) наш iframe.
 * В верхнем фрейме — no-op: там разворачивать нечего.
 */
export function requestFrameExpansion(expanded: boolean): void {
  if (globalThis.self === globalThis.top) {
    return;
  }

  if (!clientInitialized) {
    clientInitialized = true;
    // Страховка: если фрейм выгружается, страница не должна остаться
    // с растянутым плеером.
    globalThis.addEventListener("pagehide", () => {
      postToAncestors({ [MESSAGE_MARK]: true, type: "collapse" });
    });
  }

  postToAncestors({
    [MESSAGE_MARK]: true,
    type: expanded ? "expand" : "collapse",
  });
}

// #endregion

// #region [Host] код в родительском фрейме

const EXPANDED_STYLE: Record<string, string> = {
  position: "fixed",
  inset: "0",
  // Проценты (а не 100vw/100vh) — чтобы не вылезать за вьюпорт на ширину
  // скроллбара и не плодить горизонтальную прокрутку на самой странице.
  width: "100%",
  height: "100%",
  maxWidth: "none",
  maxHeight: "none",
  margin: "0",
  border: "0",
  zIndex: "2147482000",
  backgroundColor: "#000",
};

let hostInitialized = false;
let expandedFrame: HTMLIFrameElement | null = null;
let savedStyleAttribute: string | null = null;

function findFrameBySource(
  source: MessageEventSource | null,
): HTMLIFrameElement | null {
  if (!source) {
    return null;
  }

  for (const frame of document.querySelectorAll("iframe")) {
    if (frame.contentWindow === source) {
      return frame;
    }
  }

  return null;
}

function collapseExpandedFrame(): void {
  const frame = expandedFrame;
  expandedFrame = null;
  if (!frame) {
    return;
  }

  frame.removeAttribute(EXPANDED_ATTR);
  for (const prop of Object.keys(EXPANDED_STYLE)) {
    frame.style.removeProperty(prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));
  }

  if (savedStyleAttribute === null) {
    frame.removeAttribute("style");
  } else {
    frame.setAttribute("style", savedStyleAttribute);
  }
  savedStyleAttribute = null;
}

function expandFrame(frame: HTMLIFrameElement): void {
  if (expandedFrame === frame) {
    return;
  }

  // Одновременно развёрнутым может быть только один плеер.
  collapseExpandedFrame();

  savedStyleAttribute = frame.getAttribute("style");
  for (const [prop, value] of Object.entries(EXPANDED_STYLE)) {
    frame.style.setProperty(
      prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`),
      value,
      "important",
    );
  }
  frame.setAttribute(EXPANDED_ATTR, "true");
  expandedFrame = frame;
}

/**
 * Слушает запросы дочерних фреймов и разворачивает/возвращает их iframe.
 * Регистрируется в каждом фрейме: сработает только тот, у которого есть
 * iframe-элемент с подходящим `contentWindow`.
 */
export function initFrameExpansionHost(): void {
  if (hostInitialized) {
    return;
  }
  hostInitialized = true;

  globalThis.addEventListener("message", (event) => {
    if (!isFrameExpansionMessage(event.data)) {
      return;
    }

    const frame = findFrameBySource(event.source);
    if (!frame) {
      return;
    }

    if (event.data.type === "expand") {
      expandFrame(frame);
    } else if (expandedFrame === frame) {
      collapseExpandedFrame();
    }
  });
}

// #endregion
