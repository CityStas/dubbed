import Logger from "@vot.js/shared/utils/logger";
import { BaseHelper } from "./base.js";

/**
 * [kinogo-patch] Хелпер для kinoGo (kinogo.ec / kinogo.biz и зеркала).
 *
 * На странице kinoGo нет <video> — плеер живёт в lazy-iframe (cinemar.cc,
 * api.ortified.ws, vid*.sevstar*.com). Реальный <video> появляется внутри
 * iframe-плеера, а за ним — HLS-манифест на стороннем CDN.
 *
 * ГДЕ БЕРЁМ ССЫЛКУ (по приоритету):
 *   0) ПЛЕЙЛИСТ САМОЙ EMBED-СТРАНИЦЫ — «Плеер 1» (ortified, VenomPlayer).
 *      `makePlayer({ playlist:{ id, current:{season,episode}, seasons:[{episodes:[{
 *      episode,id,videoKey,dash,dasha,hls,audio:{names,order},cc,duration,title }]}]} })`
 *      лежит прямо в HTML iframe, а глобал `id` = id ТЕКУЩЕЙ серии (обновляется
 *      плеером при переключении). См. `parseOrtifiedPlaylist` — это единственный
 *      точный источник: переключение серии идёт через DASH (`/x-en-x/<token>`),
 *      `master.m3u8` при этом больше не запрашивается, поэтому коллекторы ниже
 *      навсегда запоминают ссылку ПЕРВОЙ серии (проверено 2026-09-14: коллектор
 *      отдавал файл на 1617.17 c при играющей серии 1332.08 c — это s2e12).
 *   1) `performance`-коллектор из `src/kinogoEarlyHook.ts`
 *      (`window.__dubbedKinogoPerf.urls`) — Performance Resource Timing видит
 *      ЛЮБОЙ транспорт и все ротирующиеся поддомены CDN
 *      (cfnd./host./minos.host./potassium.host.cinemap.cc).
 *   2) MAIN-world перехват fetch/XHR (тот же модуль) → dataset.
 *   3) Скан HTML плеера (на случай, если плеер вшил ссылку в разметку).
 *
 * ВАЖНО (2026-09-12): прежняя версия собирала ссылки ТОЛЬКО перехватом
 * fetch/XHR, причём regex в инжектируемой строке был переэкранирован
 * (`/\\\\.(m3u8|mp4)/` вместо `/\\.(m3u8|mp4)/`) и не матчил ни одного URL.
 * В итоге helper отдавал заглушку `kinogo.invalid/placeholder.mp4`, и Яндекс
 * отвечал "Yandex couldn't translate video". Теперь источник №1 не зависит ни
 * от транспорта, ни от экранирования.
 */

// Редиректоры-обёртки вида dlr.showvid.ws/x-px?m=... — отдают 403.
const WRAPPER_HOST_RE = /(^|\.)(showvid|dlr)\./i;
const WRAPPER_PATH_RE = /\/x-px$/i;
const MEDIA_RE = /\.(m3u8|mp4|webm)([?#]|$)/i;
const HLS_RE = /\.m3u8([?#]|$)/i;

/**
 * Рекламные вставки в iframe-плеере: в начале показа может крутиться
 * рекламный ролик (mp4 с cdn.jsdelivr.net) поверх фильма. Если отдать такую
 * ссылку Яндексу, он переведёт рекламу, а не фильм.
 */
const AD_HOST_RE = /(jsdelivr|doubleclick|googlesyndication|googleadservices|adservice|adsystem|adnxs|taboola|outbrain|adfox|an\.yandex|betweendigital|trafficfactory|exoclick|juicyads|popads|propellerads|onclickads|hilltopads|adsterra|mgid|zog\.link|rawgit|temptcdn|metrics\.)/i;

/** Отбрасываем рекламные и служебные ссылки. */
export function isAdMediaUrl(url) {
    if (!url || typeof url !== "string") {
        return true;
    }
    try {
        const host = new URL(url).hostname;
        return AD_HOST_RE.test(host);
    }
    catch (err) {
        return true;
    }
}

/**
 * Разворачивает ссылку-обёртку в прямой медиа-URL.
 *
 * Умеет:
 *  - `https://dlr.showvid.ws/x-px?m=<urlencoded http(s) URL>` → сам URL;
 *  - любой query-параметр, значение которого — абсолютный http(s)-URL
 *    с расширением .m3u8/.mp4.
 *
 * Возвращает `undefined`, если ссылка заведомо мертва (известный редиректор,
 * который не удалось развернуть) — лучше не отдавать такое Яндексу вообще.
 * Обычные прямые ссылки возвращаются как есть (обратная совместимость).
 */
export function unwrapMediaUrl(raw) {
    if (!raw || typeof raw !== "string") {
        return undefined;
    }
    const trimmed = raw.trim();
    if (!/^https?:/i.test(trimmed)) {
        return undefined;
    }
    let parsed;
    try {
        parsed = new URL(trimmed);
    }
    catch (err) {
        return trimmed;
    }
    // Прямая ссылка на медиафайл — ничего разворачивать не нужно.
    if (MEDIA_RE.test(parsed.pathname) && !WRAPPER_PATH_RE.test(parsed.pathname)) {
        return trimmed;
    }
    const candidates = [];
    for (const [, value] of parsed.searchParams) {
        if (/^https?:\/\//i.test(value)) {
            candidates.push(value);
        }
    }
    const direct = candidates.find((u) => MEDIA_RE.test(u)) || candidates[0];
    if (direct) {
        // Внутри может быть ещё один уровень обёртки.
        return direct === trimmed ? undefined : unwrapMediaUrl(direct);
    }
    if (WRAPPER_HOST_RE.test(parsed.hostname) || WRAPPER_PATH_RE.test(parsed.pathname)) {
        return undefined;
    }
    return trimmed;
}

/** base64 от UTF-8 строки без deprecated unescape/btoa-хак. */
function toBase64(value) {
    try {
        const bytes = new TextEncoder().encode(value);
        let binary = "";
        for (const byte of bytes) {
            binary += String.fromCharCode(byte);
        }
        return btoa(binary);
    }
    catch (err) {
        return undefined;
    }
}

/** pathname ссылки (для сопоставления дорожек между разными CDN-хостами). */
function urlPath(value) {
    try {
        return new URL(value).pathname;
    }
    catch (err) {
        return "";
    }
}

/**
 * Кэш текста манифеста для `detectDefaultAudioLang`.
 *
 * `getVideoData()` вызывается НЕСКОЛЬКО раз на один перевод (setCanPlay,
 * refresh перед кликом, повторные попытки в цикле `getVideoDataForTranslation`),
 * и каждый вызов заново скачивал master.m3u8 (до 8 c). На медленном CDN это
 * добавляло десятки секунд к «Подготавливаем видео к переводу…».
 * Ключ — pathname без query (подпись переписывается на каждый запрос).
 */
const MANIFEST_CACHE_TTL_MS = 60 * 1000;
const manifestCache = new Map();
function readManifestCache(key) {
    const entry = manifestCache.get(key);
    if (!entry) {
        return undefined;
    }
    if (Date.now() - entry.ts > MANIFEST_CACHE_TTL_MS) {
        manifestCache.delete(key);
        return undefined;
    }
    return entry.text;
}
function writeManifestCache(key, text) {
    if (!key || typeof text !== "string" || !text) {
        return;
    }
    manifestCache.set(key, { ts: Date.now(), text });
    if (manifestCache.size > 8) {
        const oldest = manifestCache.keys().next();
        if (!oldest.done) {
            manifestCache.delete(oldest.value);
        }
    }
}

/** Режет строку атрибутов HLS по запятым ВНЕ кавычек. */
function splitHlsAttributes(line) {
    const parts = [];
    let current = "";
    let quoted = false;
    for (const char of line) {
        if (char === '"') {
            quoted = !quoted;
        }
        if (char === "," && !quoted) {
            parts.push(current);
            current = "";
            continue;
        }
        current += char;
    }
    if (current) {
        parts.push(current);
    }
    return parts;
}

/** Разбирает строку атрибутов HLS в объект (значения без кавычек). */
function parseHlsAttributes(line) {
    const attrs = {};
    for (const part of splitHlsAttributes(line)) {
        const eq = part.indexOf("=");
        if (eq === -1) {
            continue;
        }
        const key = part.slice(0, eq).trim();
        const value = part.slice(eq + 1).trim().replace(/^"|"$/g, "");
        if (key) {
            attrs[key] = value;
        }
    }
    return attrs;
}

/**
 * Аудио-дорожки из master.m3u8:
 * `#EXT-X-MEDIA:TYPE=AUDIO,...,NAME="eng1",DEFAULT=NO,LANGUAGE="en",URI="…"`
 */
export function parseAudioRenditions(manifest) {
    if (typeof manifest !== "string" || !manifest) {
        return [];
    }
    const renditions = [];
    for (const rawLine of manifest.split("\n")) {
        const line = rawLine.trim();
        if (!line.startsWith("#EXT-X-MEDIA:") || !/TYPE=AUDIO/i.test(line)) {
            continue;
        }
        const attrs = parseHlsAttributes(line.slice("#EXT-X-MEDIA:".length));
        const lang = (attrs.LANGUAGE || "").toLowerCase().slice(0, 5);
        if (!lang) {
            continue;
        }
        renditions.push({
            lang,
            name: attrs.NAME || "",
            // `GROUP-ID` нужен, чтобы отделить основную группу (`audio0`) от
            // failover-дубля (`failover-audio-0`) с ДРУГИХ хостов: там те же
            // дорожки с теми же `NAME`, но иными подписанными URI. Без этого
            // фильтра индекс дорожки в меню плеера попадал бы на failover-URL.
            group: attrs["GROUP-ID"] || "",
            uri: attrs.URI || "",
            path: attrs.URI ? urlPath(attrs.URI) : "",
            isDefault: (attrs.DEFAULT || "").toUpperCase() === "YES",
        });
    }
    return renditions;
}

/**
 * Выбор аудио-рендишена по УЖЕ скачанному манифесту (без сети).
 *
 * Вынесено из `pickSelectedAudioRendition`, потому что тот же выбор нужен
 * СИНХРОННО в `peekMediaUrl()` — наблюдатель смены медиа (`mediaUrlWatcher`)
 * дёргает его каждые 2 c и не может ждать сеть.
 */
function pickRenditionFromManifest(manifest, dropdown) {
    if (!manifest || !dropdown) {
        return undefined;
    }
    const withUri = parseAudioRenditions(manifest).filter((r) => r.uri);
    if (withUri.length < 2) {
        return undefined;
    }
    // Только основная группа: `failover-audio-0` — те же дорожки с других
    // хостов (порядок совпадает, но URL «чужие» для текущего манифеста).
    const group = withUri[0].group;
    const renditions = withUri.filter((r) => r.group === group);
    if (renditions.length < 2) {
        return undefined;
    }
    const defaultIndex = renditions.findIndex((r) => r.isDefault);
    const selectedIndex = dropdown.items.indexOf(dropdown.current);
    let target;
    if (selectedIndex >= 0 && renditions.length === dropdown.items.length) {
        // Порядок пунктов меню совпадает с порядком `#EXT-X-MEDIA` в master —
        // так их и строит сайт (сверено: names[0] «Рус. Люб. одноголосый» ↔
        // rus0, names[1] «Original» ↔ eng1).
        target = renditions[selectedIndex];
    }
    else if (/original|оригинал/i.test(dropdown.current)) {
        const def = renditions[defaultIndex] || renditions[0];
        target = renditions.find((r) => r.lang !== def.lang);
    }
    if (!target || target.isDefault) {
        return undefined;
    }
    return {
        url: target.uri,
        lang: target.lang,
        name: target.name,
        label: dropdown.current,
    };
}

/**
 * Ранжирование найденных медиа-ссылок. Приоритет:
 *   master/HLS-плейлист верхнего уровня → любой .m3u8 → .mp4/.webm.
 * Варианты вида `720.mp4:hls:manifest.m3u8` и `:hls:`-сегменты — ниже master.
 *
 * ВАЖНО (баг «играет озвучка предыдущей серии», 2026-09-13): входной массив
 * идёт в ХРОНОЛОГИЧЕСКОМ порядке (старые ссылки → новые), а коллектор
 * `performance` накапливает ссылки за всю жизнь страницы. Прежняя версия
 * брала ПЕРВОЕ совпадение по классу, то есть master.m3u8 ПРЕДЫДУЩЕЙ серии —
 * Яндекс переводил старую серию, и в плеере звучала её озвучка (лечилось
 * только полной перезагрузкой страницы, которая чистит буфер).
 * Поэтому внутри каждого класса берём САМУЮ СВЕЖУЮ (последнюю) ссылку.
 */
export function pickBestMedia(urls) {
    const unique = [...new Set((urls || []).filter((u) => typeof u === "string" && MEDIA_RE.test(u)))];
    if (!unique.length) {
        return undefined;
    }
    // Последнее (самое свежее) совпадение по предикату.
    const lastOf = (pred) => {
        for (let i = unique.length - 1; i >= 0; i--) {
            if (pred(unique[i])) {
                return unique[i];
            }
        }
        return undefined;
    };
    const isHls = (u) => HLS_RE.test(u);
    const master = lastOf((u) => isHls(u) && /master\.m3u8/i.test(u))
        || lastOf((u) => isHls(u) && !/manifest/i.test(u) && !/:hls:/i.test(u))
        || lastOf(isHls);
    if (master) {
        return master;
    }
    return lastOf((u) => /\.(mp4|webm)([?#]|$)/i.test(u));
}

/* ─────────────────── плейлист ortified («Плеер 1») ─────────────────── */

/**
 * [kinogo-patch] Кэш разобранного плейлиста. Ключ живёт на `globalThis`, то есть
 * привязан к документу (новая навигация = новый global) — ровно то, что нужно:
 * разметка embed-страницы статична на всю жизнь документа, а её разбор стоит
 * ~77 КБ regexp-сканов, которые нельзя делать на каждый `peekMediaUrl()` (его
 * дергает наблюдатель каждые 2 с).
 */
const ORTIFIED_PLAYLIST_KEY = "__dubbedKinogoOrtifiedPlaylist";

/**
 * [kinogo-patch] Последний выбранный аудио-рендишен (трек ≠ `DEFAULT=YES`).
 * Ключ тоже на `globalThis` (жизнь документа). Нужен, чтобы `peekMediaUrl()`
 * возвращал РОВНО ту ссылку, которая ушла в `translationHelp` перевода:
 * наблюдатель смены медиа сравнивает пути этих двух URL и на расхождении
 * перезапускает жизненный цикл (убивая перевод в полёте).
 */
const ORTIFIED_RENDITION_KEY = "__dubbedKinogoAudioRendition";

/** Сбалансированный блок (`[…]` или `{…}`) с `start` — с учётом строк и экранирования. */
function readBalancedBlock(text, start) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
        const char = text[i];
        if (inString) {
            if (escaped) {
                escaped = false;
            }
            else if (char === "\\") {
                escaped = true;
            }
            else if (char === '"') {
                inString = false;
            }
            continue;
        }
        if (char === '"') {
            inString = true;
            continue;
        }
        if (char === "[" || char === "{") {
            depth += 1;
            continue;
        }
        if (char === "]" || char === "}") {
            depth -= 1;
            if (depth === 0) {
                return text.slice(start, i + 1);
            }
        }
    }
    return undefined;
}

/** JSON-массив из разметки; `undefined` вместо исключения. */
function safeJsonArray(raw) {
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
    }
    catch (err) {
        return [];
    }
}

/**
 * `source:{…}` из `makePlayer` — ОДИНОЧНЫЙ файл (фильм, а не сериал).
 *
 * У фильма нет `playlist.seasons`, зато `opts.source` содержит прямую `hls`-ссылку
 * (`probe` 2026-09-14: `api.ortified.ws/embed/movie/15447` →
 * `source.hls = https://cdnr.interkh.com/…/JK6LCPXU.mp4/master.m3u8?…`).
 * Она свежая по определению документа, в отличие от накопительного
 * perf-коллектора.
 */
export function parseOrtifiedSingleSource(html) {
    if (typeof html !== "string" || !html.includes("makePlayer(")) {
        return undefined;
    }
    const marker = html.indexOf("source:");
    if (marker === -1) {
        return undefined;
    }
    const start = html.indexOf("{", marker);
    if (start === -1) {
        return undefined;
    }
    const block = readBalancedBlock(html, start);
    if (!block) {
        return undefined;
    }
    const hls = /\bhls\s*:\s*"([^"]+)"/.exec(block);
    if (!hls || !HLS_RE.test(hls[1])) {
        return undefined;
    }
    const audio = /"names"\s*:\s*(\[[^\]]*\])/.exec(block);
    return {
        hls: hls[1],
        audioNames: audio ? safeJsonArray(audio[1]) : [],
    };
}

/**
 * Разбирает `seasons:[…]` из HTML embed-страницы ortified.
 *
 * ПОЧЕМУ ЭТО ГЛАВНЫЙ ИСТОЧНИК (разбор 2026-09-14, `probe-ortified-state.cjs`):
 * iframe плеера — `api.ortified.ws/embed/movie/<id>`, ОДИН И ТОТ ЖЕ на все серии
 * (`id` = `franchiseID` = id сериала). Переключение серии идёт через DASH
 * (обфусцированные `/x-en-x/<token>` → `application/dash+xml`, one-shot), а
 * `master.m3u8` при этом НЕ перезапрашивается вовсе — поэтому perf-коллектор
 * навсегда запоминает ссылку ПЕРВОЙ серии. Отсюда обе жалобы: «переводит не то»
 * и «звуковая дорожка не соответствует» (плюс ключ кэша перевода совпадал, и
 * `restoreTranslationFromCache` возвращал озвучку первой серии после каждого
 * `canplay`).
 *
 * А сама embed-страница отдаёт ПОЛНЫЙ плейлист всех сезонов с прямой `hls`-ссылкой
 * на каждую серию (muxed master.m3u8, отдаётся CDN без рантайм-токена —
 * проверено: HTTP 200 и без `&<token>`, который страница дописывает в `add()`).
 */
export function parseOrtifiedPlaylist(html) {
    if (typeof html !== "string" || !html) {
        return undefined;
    }
    // Маркер именно ortified-обвязки (VenomPlayer). Без него разбор не запускаем:
    // у cinemar («Смотреть онлайн») свой PlayerJS-плейлист, и случайное `seasons:`
    // из чужого кода не должно подменить источник.
    if (!html.includes("makePlayer(")) {
        return undefined;
    }
    let searchFrom = 0;
    for (;;) {
        const marker = html.indexOf("seasons:", searchFrom);
        if (marker === -1) {
            return undefined;
        }
        searchFrom = marker + 1;
        const start = html.indexOf("[", marker);
        if (start === -1) {
            return undefined;
        }
        const slice = readBalancedBlock(html, start);
        if (!slice) {
            continue;
        }
        let seasons;
        try {
            seasons = JSON.parse(slice);
        }
        catch (err) {
            continue;
        }
        if (!Array.isArray(seasons) || !seasons.length) {
            continue;
        }
        const episodes = [];
        for (const season of seasons) {
            if (!season || !Array.isArray(season.episodes)) {
                continue;
            }
            const seasonNumber = Number(season.season);
            for (const entry of season.episodes) {
                if (!entry || typeof entry !== "object") {
                    continue;
                }
                // Только HLS: `.mpd` (dash/dasha) Яндекс не умеет.
                if (typeof entry.hls !== "string" || !HLS_RE.test(entry.hls)) {
                    continue;
                }
                episodes.push({
                    season: Number.isFinite(seasonNumber) ? seasonNumber : 1,
                    episode: entry.episode == null ? "" : String(entry.episode),
                    id: entry.id == null ? undefined : String(entry.id),
                    duration: Number(entry.duration) || undefined,
                    title: typeof entry.title === "string" ? entry.title : undefined,
                    audioNames: Array.isArray(entry.audio?.names)
                        ? entry.audio.names.filter((n) => typeof n === "string")
                        : [],
                    hls: entry.hls,
                });
            }
        }
        if (episodes.length) {
            const playlistId = /id:\s*(\d+)\s*,\s*current/.exec(html);
            return {
                id: playlistId?.[1],
                episodes,
            };
        }
    }
}

export default class KinogoHelper extends BaseHelper {
    HOOK_FLAG = "__dubbedKinogoHook";
    DATA_KEY = "dubbedKinogoMedia";
    PERF_KEY = "__dubbedKinogoPerf";
    HOOK_MAX_AGE = 20 * 60 * 1000;

    // Сколько ждём появления манифеста, если сейчас в HTML только реклама.
    // ВАЖНО: короткий таймаут — кнопка «Перевести видео» появляется после
    // getVideoData(), и прежние 12 сек блокировали UI (симптом «кнопка не
    // появляется сразу после Play»). Реальные ссылки добираются при клике
    // (см. shouldRefreshVideoDataBeforeTranslation → kinogo).
    MEDIA_WAIT_MS = 2500;
    POLL_MS = 250;

    // [kinogo-patch] Отдавать ли Яндекс HLS через media-proxy.
    // A/B-замер (2026-09-12, реальный путь Яндекса через расширение):
    //   прямой m3u8 (host.cinemap.cc) -> status 5 (PART_CONTENT), translated=true за 57 c;
    //   тот же манифест через media-proxy.toil.cc/v1/proxy/m3u8 -> FAILED через 157 c.
    // Вывод: прямой манифест Яндекс забирает сам, прокси только мешает.
    // Оставляем выключенным как страховку для CDN, которые Яндекс не достаёт.
    USE_M3U8_PROXY = false;
    M3U8_PROXY_HOST = "media-proxy.toil.cc";
    PROXY_PROBE_TIMEOUT_MS = 4000;

    /** Коллектор из kinogoEarlyHook: список увиденных медиа-URL (свежие — в конце). */
    readPerfMedia() {
        try {
            const store = globalThis?.[this.PERF_KEY];
            const urls = Array.isArray(store?.urls) ? store.urls : [];
            if (!urls.length) {
                return [];
            }
            const age = store?.ts ? Date.now() - store.ts : 0;
            if (age > this.HOOK_MAX_AGE) {
                return [];
            }
            const resolved = [];
            for (const candidate of urls) {
                const url = unwrapMediaUrl(candidate);
                if (!url || isAdMediaUrl(url) || resolved.includes(url)) {
                    continue;
                }
                resolved.push(url);
            }
            return resolved;
        }
        catch (err) {
            return [];
        }
    }

    readHookedMedia() {
        try {
            const raw = document.documentElement?.dataset?.[this.DATA_KEY];
            if (!raw) {
                return undefined;
            }
            const parsed = JSON.parse(raw);
            if (parsed?.ts && Date.now() - parsed.ts <= this.HOOK_MAX_AGE && parsed?.url) {
                const url = unwrapMediaUrl(parsed.url);
                return url && !isAdMediaUrl(url) ? url : undefined;
            }
        }
        catch (err) { }
        return undefined;
    }

    /**
     * [kinogo-patch] Разметка embed-страницы ortified, разобранная один раз на
     * жизнь документа (без сети). См. `parseOrtifiedPlaylist` (сериал) и
     * `parseOrtifiedSingleSource` (фильм).
     *
     * Мемоизируем ТОЛЬКО успешный разбор: если хелпер позвали слишком рано
     * (HTML ещё не достроен), следующий вызов попробует снова.
     */
    ortifiedEmbed() {
        try {
            const cached = globalThis?.[ORTIFIED_PLAYLIST_KEY];
            if (cached) {
                return cached;
            }
            const html = document.documentElement?.innerHTML;
            const parsed = {
                playlist: parseOrtifiedPlaylist(html),
                source: parseOrtifiedSingleSource(html),
            };
            if (parsed.playlist || parsed.source) {
                try {
                    globalThis[ORTIFIED_PLAYLIST_KEY] = parsed;
                }
                catch (err) { }
            }
            return parsed;
        }
        catch (err) {
            return { playlist: undefined, source: undefined };
        }
    }

    /** Плейлист сериала из разметки embed (или `undefined` для фильма). */
    ortifiedPlaylist() {
        return this.ortifiedEmbed().playlist;
    }

    /** Подписи дропдаунов плеера («1 сезон», «3 серия», «Рус. Люб. одноголосый»). */
    readPlayerHeads() {
        const heads = [];
        try {
            for (const el of document.querySelectorAll('[class^="head_"],[class*=" head_"]')) {
                const text = (el.textContent || "").replace(/\s+/g, " ").trim();
                if (text) {
                    heads.push(text);
                }
            }
        }
        catch (err) { }
        return heads;
    }

    /**
     * Номера сезона/серии из подписей плеера — СТРОГО по полному совпадению
     * (`/^\d+ серия$/`). Широкая маска ловит виджет «Следующая серияШины (1 сезон)
     * - 2 серия» и подсовывает ЧУЖУЮ серию.
     */
    readEpisodeLabels() {
        let season;
        let episode;
        for (const text of this.readPlayerHeads()) {
            if (season === undefined) {
                const s = /^(\d+)\s*сезон$/i.exec(text);
                if (s) {
                    season = Number(s[1]);
                }
            }
            if (episode === undefined) {
                const e = /^(\d+)\s*серия$/i.exec(text);
                if (e) {
                    episode = Number(e[1]);
                }
            }
        }
        return { season, episode };
    }

    /**
     * ТЕКУЩАЯ серия (сезон/серия/запись плейлиста).
     *
     * Три независимых сигнала, по убыванию точности:
     *   1) глобал `id` embed-страницы = id ТЕКУЩЕЙ серии (обновляется плеером при
     *      переключении; проверено живьём: «1 серия» → `id` 773845, «3 серия» →
     *      773843 при неизменном `franchiseID` 74823);
     *   2) `video.duration` (у каждой серии своя длительность, ±3 c);
     *   3) подписи дропдаунов «N сезон» / «N серия».
     *
     * ⚠️ Хелпер исполняется в MAIN world (manifest: `world=MAIN`), поэтому глобалы
     * страницы ему видны.
     */
    currentEpisode() {
        const playlist = this.ortifiedPlaylist();
        if (!playlist?.episodes?.length) {
            return undefined;
        }
        const episodes = playlist.episodes;

        const pageId = globalThis?.id;
        if (pageId !== undefined && pageId !== null && typeof pageId !== "object") {
            const byId = episodes.find((x) => x.id !== undefined && x.id === String(pageId));
            if (byId) {
                return byId;
            }
        }

        const duration = Number(this.video?.duration);
        if (Number.isFinite(duration) && duration > 0) {
            let best;
            for (const entry of episodes) {
                if (!entry.duration) {
                    continue;
                }
                const diff = Math.abs(entry.duration - duration);
                if (diff <= 3 && (!best || diff < best.diff)) {
                    best = { entry, diff };
                }
            }
            if (best) {
                return best.entry;
            }
        }

        const { season, episode } = this.readEpisodeLabels();
        if (season !== undefined && episode !== undefined) {
            const byLabel = episodes.find((x) => x.season === season && Number(x.episode) === episode);
            if (byLabel) {
                return byLabel;
            }
        }
        return undefined;
    }

    /** `s<сезон>:e<серия>` текущей серии — «личность» для наблюдателя смены серии. */
    peekEpisodeKey() {
        const current = this.currentEpisode();
        if (!current) {
            return undefined;
        }
        return `s${current.season}:e${current.episode}`;
    }

    /** Прямая HLS-ссылка ТЕКУЩЕЙ серии из плейлиста ortified (без сети). */
    ortifiedEpisodeMedia() {
        const current = this.currentEpisode();
        return current?.hls;
    }

    /** Прямая HLS-ссылка одиночного файла (фильм) из `source:{…}` embed-страницы. */
    ortifiedSingleMedia() {
        return this.ortifiedEmbed().source?.hls;
    }

    /**
     * Прямая медиа-ссылка со страницы плеера (последний рубеж).
     * Приоритет: master.m3u8 → любой .m3u8 → .mp4.
     */
    mediaFromPage() {
        try {
            const html = document.documentElement.innerHTML;
            const matches = html.match(/https?:[^"'\s\\]*\.(?:m3u8|mp4|webm)[^"'\s\\]*/gi) || [];
            const resolved = [];
            for (const candidate of matches) {
                const url = unwrapMediaUrl(candidate);
                if (!url || isAdMediaUrl(url) || resolved.includes(url)) {
                    continue;
                }
                resolved.push(url);
            }
            return pickBestMedia(resolved);
        }
        catch (err) { }
        return undefined;
    }

    /** Все известные медиа-ссылки, по убыванию приоритета. */
    collectMedia() {
        // ── Приоритет №1: разметка СВОЕГО embed-документа ──────────────────
        // «Плеер 1» (ortified): ссылка точная и свежая. Всё, что ниже, — коллекторы
        // за всю жизнь документа, и после смены серии там остаётся master.m3u8
        // ДРУГОЙ серии (переключение идёт через DASH, `master.m3u8` больше не
        // запрашивается) → Яндекс переводил не ту серию, а ключ кэша перевода
        // совпадал → `restoreTranslationFromCache` возвращал её озвучку.
        // Проверено 2026-09-14: коллектор отдавал файл на 1617.17 c (s2e12) при
        // играющей s1e1 (1332.08 c).
        const embed = this.ortifiedEmbed();
        if (embed.playlist) {
            const episodeMedia = this.ortifiedEpisodeMedia();
            if (episodeMedia) {
                return episodeMedia;
            }
            // Плейлист ЕСТЬ, а текущую серию опознать не удалось (нет `window.id`,
            // не сошлась длительность, не нашлись подписи). Откатываться к
            // коллекторам НЕЛЬЗЯ: там гарантированно чужая серия. Лучше отдать
            // заглушку — кнопка останется рабочей, а `getVideoData` перечитается
            // при клике (`shouldRefreshVideoDataBeforeTranslation`).
            Logger.error("KinogoHelper: плейлист есть, но текущая серия не опознана — ссылку не отдаю");
            return undefined;
        }
        if (embed.source) {
            return embed.source.hls;
        }

        // Порядок массива = хронология «старые → новые»: pickBestMedia берёт
        // САМУЮ СВЕЖУЮ ссылку внутри класса, поэтому накопительный коллектор
        // performance (свежие — в конце) обязан идти последним, а статичная
        // разметка страницы (может содержать ссылку серии, открытой при
        // загрузке страницы) — первой.
        const candidates = [
            this.mediaFromPage(),
            this.readHookedMedia(),
            ...this.readPerfMedia(),
        ].filter(Boolean);
        const best = pickBestMedia(candidates);
        if (!best) {
            return undefined;
        }
        return best;
    }

    /**
     * [kinogo-patch] Дешёвое (без сети) чтение текущей медиа-ссылки.
     *
     * Нужно наблюдателю расширения (src/core/mediaUrlWatcher.ts): на HLS/MSE
     * плеерах (ortified/cinemar) при смене серии `video.src` НЕ меняется —
     * там один blob-URL на всю сессию hls.js, поэтому расширение не видит
     * смену серии и продолжает играть озвучку предыдущей. Сравнивая «какую
     * ссылку тянет плеер сейчас» с той, что ушла в translationHelp, watcher
     * понимает, что серия другая, и перезапускает кнопку перевода.
     *
     * Для ortified возвращается HLS ТЕКУЩЕЙ серии из плейлиста (см.
     * `ortifiedEpisodeMedia`), поэтому путь файла реально меняется при
     * переключении. Для остальных плееров — прежний приоритет коллекторов.
     */
    peekMediaUrl() {
        const media = this.collectMedia();
        if (!media || !HLS_RE.test(media)) {
            return media;
        }
        // ⚠️ Ссылка для Яндекса может быть НЕ master'ом, а аудио-рендишеном
        // выбранной дорожки (`pickSelectedAudioRendition`). Наблюдатель смены
        // медиа сравнивает `mediaIdentity(translationHelp.targetUrl)` с
        // `mediaIdentity(peekMediaUrl())` и на расхождении форсит re-resolve →
        // `resetAndHideLifecycle()` → перевод в полёте отменяется, кнопка
        // возвращается в «Перевести видео».
        //
        // ЖАЛОБА 2026-09-14: «длинный фильм на „Плеере 1“: начинается перевод
        // („Дождитесь окончания загрузки“) и сразу сбрасывается». Ровно этот цикл:
        // в `translationHelp` лежал `…/JK6LCPXU.mp4/index-a2.m3u8`, а `peekMediaUrl`
        // отдавал `…/JK6LCPXU.mp4/master.m3u8` → каждые 2 c «media source changed»
        // (в логе счётчик сессий дошёл до 44).
        //
        // У сериала дефект не проявлялся: там раньше срабатывает сигнал №1
        // `peekEpisodeKey()` и до сравнения URL дело не доходит. У фильма
        // `currentEpisode()` пуст → сигнал №1 молчит → уходило в сигнал №2.
        return this.rememberedTargetUrl(media);
    }

    /** Запомненная ссылка для Яндекса, если она относится к ТЕКУЩЕМУ файлу. */
    rememberedTargetUrl(media) {
        try {
            const saved = globalThis?.[ORTIFIED_RENDITION_KEY];
            if (!saved || !saved.url) {
                return media;
            }
            // Сменилась серия/файл — путь master другой, запись неактуальна.
            return saved.masterPath === urlPath(media) ? saved.url : media;
        }
        catch (err) {
            return media;
        }
    }

    /**
     * Ждём появления HLS-манифеста. Плеер может сначала показать рекламный
     * ролик, а манифест фильма запросить чуть позже — поэтому короткий poll.
     */
    async resolveMedia() {
        const deadline = Date.now() + this.MEDIA_WAIT_MS;
        let fallback;
        for (;;) {
            const media = this.collectMedia();
            if (media && HLS_RE.test(media)) {
                return media;
            }
            if (!fallback && media) {
                fallback = media;
            }
            if (Date.now() >= deadline) {
                return fallback;
            }
            await new Promise((r) => setTimeout(r, this.POLL_MS));
        }
    }

    /** URL прокси для HLS-манифеста (media-proxy.toil.cc, роут m3u8). */
    m3u8ProxyUrl(media) {
        const encoded = toBase64(media);
        if (!encoded) {
            return undefined;
        }
        return `https://${this.M3U8_PROXY_HOST}/v1/proxy/m3u8?all=yes&format=base64&url=${encodeURIComponent(encoded)}`;
    }

    /** Проверяем, что прокси реально отдаёт плейлист. */
    async probeProxyUrl(url) {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), this.PROXY_PROBE_TIMEOUT_MS);
            const res = await fetch(url, { signal: controller.signal });
            clearTimeout(timer);
            if (!res.ok) {
                return false;
            }
            const type = res.headers.get("content-type") || "";
            return /mpegurl|m3u8|octet-stream|text\/plain/i.test(type) || type === "";
        }
        catch (err) {
            return false;
        }
    }

    /** Итоговый URL для Яндекса. */
    async resolveTargetUrl(media) {
        if (!media) {
            return media;
        }
        if (!this.USE_M3U8_PROXY || !HLS_RE.test(media)) {
            return media;
        }
        const proxied = this.m3u8ProxyUrl(media);
        if (proxied && await this.probeProxyUrl(proxied)) {
            Logger.log("KinogoHelper: HLS через media-proxy");
            return proxied;
        }
        Logger.error("KinogoHelper: media-proxy недоступен, отдаю прямой m3u8");
        return media;
    }

    async fetchManifestText(mediaUrl) {
        const cacheKey = urlPath(mediaUrl);
        const cached = readManifestCache(cacheKey);
        if (cached) {
            return cached;
        }
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 4000);
            const res = await fetch(mediaUrl, { signal: controller.signal, redirect: "follow" });
            clearTimeout(timer);
            if (!res.ok) {
                return undefined;
            }
            const text = await res.text();
            writeManifestCache(cacheKey, text);
            return text;
        }
        catch (err) {
            return undefined;
        }
    }

    /**
     * Текущая выбранная АУДИО-дорожка плеера.
     *
     * Третий дропдаун ortified — это дорожка (первые два: сезон и серия). Классы
     * — CSS-modules с хешем (`dropdown_2sa`, `headText_1b`, `menu_3x`, `item_2mH`),
     * поэтому матчим по ПРЕФИКСУ. Дорожка опознаётся по совпадению пунктов меню с
     * `audio.names` из плейлиста embed-страницы; фолбэк — последний дропдаун,
     * пункты которого НЕ «N сезон»/«N серия» (виджет «Следующая серия» ловим
     * узкими масками, см. `readEpisodeLabels`).
     *
     * Проверено живьём 2026-09-14 (74823/s1e1): `"Original"` из
     * `[Рус. Люб. одноголосый | Original]`.
     */
    readSelectedAudioTrack(expectedNames) {
        let dropdowns = [];
        try {
            for (const el of document.querySelectorAll('div[class*=dropdown_]')) {
                const head = el.querySelector('[class*=headText_]');
                if (!head) {
                    continue;
                }
                const items = Array.from(el.querySelectorAll('div[class*=menu_] > div[class*=item_]'))
                    .map((x) => (x.textContent || "").replace(/\s+/g, " ").trim())
                    .filter(Boolean);
                if (!items.length) {
                    continue;
                }
                dropdowns.push({
                    current: (head.textContent || "").replace(/\s+/g, " ").trim(),
                    items,
                });
            }
        }
        catch (err) {
            return undefined;
        }
        if (!dropdowns.length) {
            return undefined;
        }
        if (Array.isArray(expectedNames) && expectedNames.length) {
            const byNames = dropdowns.find((d) => d.items.length === expectedNames.length &&
                d.items.every((t, i) => t === expectedNames[i]));
            if (byNames) {
                return byNames;
            }
        }
        const episodeOnly = (d) => d.items.every((t) => /^\d+\s*(сезон|серия)$/i.test(t));
        for (let i = dropdowns.length - 1; i >= 0; i--) {
            if (!episodeOnly(dropdowns[i])) {
                return dropdowns[i];
            }
        }
        return undefined;
    }

    /**
     * Аудио-рендишен ВЫБРАННОЙ в плеере дорожки — если она НЕ дефолтная.
     *
     * Зачем. Яндекс получает от нас master.m3u8 и всегда берёт дорожку с
     * `DEFAULT=YES` — у interkh это РУССКИЙ дубляж (`rus0`). Пользователь, который
     * в плеере выбрал «Original» (английская дорожка, `eng1`, `DEFAULT=NO`),
     * слышит английский звук, а Яндекс переводит русский дубляж → `ru → ru`
     * (лог `[Translation] translateVideoImpl start {requestLang: ru, responseLang: ru}`).
     * Это и есть жалоба «переводит не то / дорожка не соответствует».
     *
     * Решение без прокси: отдать Яндексу URI нужного аудио-рендишена
     * (`index-a2.m3u8`, audio-only HLS). Проверено 2026-09-14 через debug-мост:
     * Яндекс ПРИНИМАЕТ audio-only плейлист — своя сессия (`translationId`
     * 467297393 ≠ 467297365 у master), `status 2` («в работе»).
     *
     * Возвращаем `undefined`, когда менять нечего (дефолтная дорожка / одна
     * дорожка / дропдаун не прочитан) — тогда поведение ровно прежнее.
     */
    async pickSelectedAudioRendition(mediaUrl, audioNames) {
        const dropdown = this.readSelectedAudioTrack(audioNames);
        if (!dropdown) {
            return undefined;
        }
        const manifest = await this.fetchManifestText(mediaUrl);
        return pickRenditionFromManifest(manifest, dropdown);
    }

    /**
     * Запомнить ИТОГОВУЮ ссылку, которая уходит Яндексу (уже после
     * `resolveTargetUrl`, то есть с возможным media-proxy).
     *
     * Зачем: наблюдатель смены медиа сравнивает `mediaIdentity()` от
     * `translationHelp.targetUrl` и от `peekMediaUrl()`. Если они разойдутся,
     * наблюдатель каждые 2 c форсит re-resolve → `resetAndHideLifecycle()` →
     * перевод в полёте отменяется и кнопка возвращается в «Перевести видео»
     * (жалоба 2026-09-14: длинный фильм на «Плеере 1» — старт перевода и сразу
     * сброс). Поэтому «что ушло Яндексу» и «что видит наблюдатель» — одно поле.
     */
    rememberTargetUrl(media, targetUrl) {
        try {
            if (media && targetUrl) {
                globalThis[ORTIFIED_RENDITION_KEY] = {
                    masterPath: urlPath(media),
                    url: targetUrl,
                };
            }
            else {
                delete globalThis[ORTIFIED_RENDITION_KEY];
            }
        }
        catch (err) { }
    }

    /**
     * Язык ИСХОДНОЙ дорожки — той, которую Яндекс реально скачает.
     *
     * Яндекс получает master.m3u8 и берёт из него аудио-дорожку с
     * `DEFAULT=YES`. Значит объявлять надо ровно её: если заявить язык
     * выбранной в плеере дорожки (например «Original»/eng1, где DEFAULT стоит
     * на ru-дубляже), ASR пойдёт по неверной модели.
     *
     * Отсюда же и ограничение: перевести НЕ-дефолтную дорожку (оригинальную
     * озвучку) «как есть» нельзя — нужен прокси, который переписывает
     * плейлист, перенося DEFAULT=YES на нужную дорожку. См. KINOGO-PATCH.md.
     */
    async detectDefaultAudioLang(mediaUrl) {
        const manifest = await this.fetchManifestText(mediaUrl);
        if (!manifest) {
            return undefined;
        }
        const renditions = parseAudioRenditions(manifest);
        const track = renditions.find((r) => r.isDefault) || renditions[0];
        if (track) {
            Logger.log(`KinogoHelper: исходная аудио-дорожка "${track.lang}" (${track.name})`);
        }
        // Одиночная дорожка без #EXT-X-MEDIA — язык не объявляем, пусть Яндекс
        // определит сам ("auto"): угадывание по подписи в UI плеера давало
        // рассинхрон между объявленным языком и реальным аудио.
        return track?.lang;
    }

    getVideoId(url) {
        const host = String(url.hostname || "").toLowerCase();
        if (host.includes("kinogo")) {
            const film = /\/(\d+)-[^/]*\.html/.exec(url.pathname);
            if (film) {
                return film[1];
            }
        }
        // cinemar.cc/embed/<id>/+<token>
        const cinemar = /\/embed\/(\d+)/.exec(url.pathname);
        if (cinemar) {
            return cinemar[1];
        }
        if (host.includes("ortified")) {
            const movie = /\/embed\/movie\/(\d+)/.exec(url.pathname);
            const base = movie?.[1] || "ortified";
            // [kinogo-patch] id СЕРИИ в `videoId`. Iframe у ortified один и тот же
            // на все серии, поэтому без суффикса `videoId` не менялся НИКОГДА, и
            // «смена серии» для preserve-логики (`sameVideoId` в
            // videoLifecycleController) и для ключей кэша перевода/субтитров
            // выглядела как «то же самое видео» → после переключения серии
            // поднималась озвучка предыдущей.
            const current = this.currentEpisode();
            return current ? `${base}/s${current.season}e${current.episode}` : base;
        }
        // vid*.sevstar*.com/serial/<hash>/iframe
        const sevstar = /\/serial\/([a-f0-9]{8,})/i.exec(url.pathname);
        if (sevstar) {
            return sevstar[1].slice(0, 16);
        }
        return host || "kinogo";
    }

    async getVideoData(videoId) {
        const media = await this.resolveMedia();

        if (media) {
            const currentEpisode = this.currentEpisode();
            let targetUrl = await this.resolveTargetUrl(media);
            let detectedLanguage;
            if (HLS_RE.test(media)) {
                detectedLanguage = await this.detectDefaultAudioLang(media);
                // Выбранная в плеере НЕ-дефолтная дорожка («Original») → Яндекс всё
                // равно возьмёт `DEFAULT=YES` (ru-дубляж) из master, поэтому отдаём
                // ему URI нужного аудио-рендишена и объявляем ЕГО язык. Иначе
                // получается ru→ru: Яндекс переводит русский дубляж, пока
                // пользователь слушает оригинал.
                const picked = await this.pickSelectedAudioRendition(media, currentEpisode?.audioNames);
                if (picked) {
                    targetUrl = await this.resolveTargetUrl(picked.url);
                    detectedLanguage = picked.lang;
                    Logger.log(`KinogoHelper: дорожка "${picked.label}" (${picked.name}, ${picked.lang}) — Яндексу уходит аудио-рендишен, не master`);
                }
            }
            // Что ушло Яндексу — то же должен видеть наблюдатель смены медиа
            // (`mediaUrlWatcher` → `peekMediaUrl`). Иначе расхождение master vs
            // аудио-рендишен даёт цикл re-resolve каждые 2 c и сброс перевода.
            this.rememberTargetUrl(media, targetUrl);
            const duration = this.video?.duration || undefined;
            if (currentEpisode) {
                Logger.log(`KinogoHelper: текущая серия s${currentEpisode.season}:e${currentEpisode.episode} (id ${currentEpisode.id}), "${currentEpisode.title}"`);
            }
            Logger.log(`KinogoHelper: передаю Яндексу ${HLS_RE.test(targetUrl) ? "m3u8" : "mp4"} (${targetUrl.slice(0, 90)}...)`);
            return {
                url: targetUrl,
                video_url: targetUrl,
                translationHelp: [
                    {
                        target: "video_file_url",
                        targetUrl,
                    },
                ],
                duration,
                detectedLanguage,
            };
        }

        // Заглушка: кнопка остаётся активной, реальные ссылки добираются при
        // клике (translationCommands → shouldRefreshVideoDataBeforeTranslation).
        const src = this.video?.currentSrc || this.video?.src || "";
        const url = /^https:/i.test(src) ? src : "https://kinogo.invalid/placeholder.mp4";
        Logger.log(`KinogoHelper: медиа-ссылка не готова (id: ${videoId}), доберётся при клике`);
        return {
            url,
            video_url: url,
            duration: this.video?.duration || undefined,
            _placeholder: true,
        };
    }
}
