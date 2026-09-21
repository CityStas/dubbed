/**
 * Канонизация медиа-URL.
 *
 * Зачем. Подпись CDN пересоздаётся на КАЖДУЮ загрузку страницы. На interkh это
 * `?fckz2=…&ha=…&hc=…&hi=…&ht=…&hu=…&hui=…&t=…`, причём `t` = «сейчас + 10 дней»
 * и меняется при каждом открытии фильма (проверено: один и тот же файл
 * `…/JK6LCPXU.mp4/master.m3u8` встречался с `t=1790186280` и `t=1790187912`).
 *
 * Последствия волатильности:
 *   1. `getTranslationCacheKey()` хеширует `translationHelp` вместе с `targetUrl`
 *      → ключ нашего кэша менялся при каждом открытии страницы → готовый перевод
 *      НЕ поднимался из кэша, хотя TTL кэша 2 часа.
 *   2. `restoreTranslationFromCache()` (ветка «Play подменил src на blob») строит
 *      ключ по СВЕЖЕМУ `targetUrl` → ключ не совпадал с сохранённым → озвучка не
 *      восстанавливалась, пользователь жал кнопку второй раз.
 *   3. Яндекс кэширует перевод по URL видео → новый URL = новая очередь (~10 мин).
 *
 * Что делаем. Для хостов, где подпись живёт ЦЕЛИКОМ в query и проверено, что
 * цепочка отдаётся без неё, оставляем `origin + pathname`.
 *
 * Проверено (`dubbed-test/probe-bare-chain.cjs`, 13.09.2026): у `*.interkh.com`
 * master.m3u8, `index-v1.m3u8`, `index-a1.m3u8`, `index-a2.m3u8` отдаются
 * `http=200` и БЕЗ query, и с протухшим `t`; структура плейлиста идентична
 * подписанному (4 аудио-дорожки, 4 варианта, 657/661 сегментов).
 *
 * ⚠️ rezka НЕ канонизируем: там подпись в ПУТИ, а не в query — обрезать нечего.
 * Для остальных хостов URL возвращается как есть (безопасный дефолт).
 */

/** Хосты, у которых query — чистая подпись, а путь самодостаточен. */
const QUERY_IS_SIGNATURE_ONLY_HOST_RE = /(^|\.)interkh\.com$/i;

/**
 * Каноническая форма медиа-URL (для ключей кэша и сравнения источников).
 * Неизвестные хосты и невалидные URL возвращаются без изменений.
 */
export function canonicalMediaUrl(rawUrl: unknown): string {
  if (typeof rawUrl !== "string" || !rawUrl) {
    return typeof rawUrl === "string" ? rawUrl : "";
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return rawUrl;
  }

  if (!QUERY_IS_SIGNATURE_ONLY_HOST_RE.test(parsed.hostname)) {
    return rawUrl;
  }

  // Сбрасываем и query, и hash: hash в подписи не участвует.
  return `${parsed.origin}${parsed.pathname}`;
}

/** Поля `translationHelp`, которые могут нести подписанный медиа-URL. */
const MEDIA_URL_FIELDS = ["targetUrl", "url", "video_url", "videoUrl"] as const;

/**
 * Канонизирует все медиа-URL внутри `translationHelp` (рекурсивно, по массивам и
 * объектам). Возвращает НОВУЮ структуру — исходный объект не мутируется, чтобы не
 * подменить ссылку, реально уходящую Яндексу.
 */
export function canonicalizeTranslationHelp<T>(translationHelp: T): T {
  if (translationHelp === null || translationHelp === undefined) {
    return translationHelp;
  }

  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(walk);
    }
    if (value && typeof value === "object") {
      const src = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(src)) {
        const child = src[key];
        out[key] = (MEDIA_URL_FIELDS as readonly string[]).includes(key)
          ? canonicalMediaUrl(child)
          : walk(child);
      }
      return out;
    }
    return value;
  };

  return walk(translationHelp) as T;
}
