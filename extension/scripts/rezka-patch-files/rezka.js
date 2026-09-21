import Logger from "@vot.js/shared/utils/logger";
import { proxyMedia } from "@vot.js/shared/utils/utils";
import { BaseHelper } from "./base.js";
/**
 * [rezka-patch] Последняя серия (film:season:episode), для которой мы резолвили
 * ссылки. ВАЖНО: состояние модульное, а НЕ поле класса — vot.js создаёт новый
 * экземпляр хелпера на каждый вызов getVideoData (helpers/index.js: getHelper()
 * возвращает `new availableHelpers[host]()`), поэтому поля экземпляра не живут
 * между вызовами.
 */
let rezkaLastEpisodeKey = "";

/**
 * [rezka-patch] Серия, которой принадлежит ИНЛАЙН-конфиг `"streams"` страницы.
 *
 * Конфиг статичен для документа и описывает ровно ту серию, которая была
 * открыта при загрузке страницы. Раньше его отдавали при ЛЮБОМ вызове, кроме
 * первого после смены серии (флаг `episodeChanged`), поэтому второй и
 * последующие вызовы для НОВОЙ серии снова возвращали ссылку СТАРОЙ — Яндекс
 * отдавал её озвучку, и казалось, что «перевод остался от предыдущей серии»
 * (жалоба 13.09.2026). Теперь помним эту серию и доверяем конфигу только ей.
 */
let rezkaInlineStreamsEpisodeKey = "";

/**
 * [rezka-patch] Разбирает тело запроса get_cdn_series, сохранённое хуком.
 * Тело — urlencoded-строка (`id=..&season=..&episode=..&translator_id=..`).
 * Нужен, чтобы понять, какой серии принадлежит пойманный ответ.
 */
export function parseRezkaCdnRequest(raw) {
    const out = {};
    if (typeof raw !== "string" || !raw) {
        return out;
    }
    try {
        const params = new URLSearchParams(raw);
        for (const key of ["id", "season", "episode", "translator_id"]) {
            const value = params.get(key);
            if (value) {
                out[key] = value;
            }
        }
    }
    catch (err) { /* ignore: тело могло быть не urlencoded */ }
    return out;
}

export default class RezkaHelper extends BaseHelper {
    API_ORIGIN = this.origin ?? window.location.origin;
    HOOK_FLAG = "__dubbedRezkaHook";
    DATA_KEY = "dubbedRezkaCdn";
    HOOK_MAX_AGE = 15 * 60 * 1000;

    // MAIN-world hook: ловим ответы плеера rezka на get_cdn_series и сохраняем их в DOM
    injectCdnHook() {
        if (window[this.HOOK_FLAG]) {
            return;
        }
        try {
            window[this.HOOK_FLAG] = true;
            const script = document.createElement("script");
            script.textContent = `(()=>{const K='${this.DATA_KEY}';const save=(t,req)=>{try{const j=JSON.parse(t);if(j&&(j.links||j.url)){document.documentElement.dataset[K]=JSON.stringify({ts:Date.now(),req:req||null,j});}}catch(e){}};const bodyOf=(b)=>{try{if(typeof b==='string')return b;if(b&&typeof b.toString==='function')return String(b);}catch(e){}return '';};const of=window.fetch;window.fetch=function(...a){const u=typeof a[0]==='string'?a[0]:((a[0]&&a[0].url)||'');const req=bodyOf(a[1]&&a[1].body);const p=of.apply(this,a);if(u.includes('get_cdn_series')){try{p.then(r=>r.clone().text()).then(s=>save(s,req)).catch(()=>{});}catch(e){}}return p;};const oo=XMLHttpRequest.prototype.open,os=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.open=function(m,u,...r){this.__dubbedU=u;return oo.call(this,m,u,...r);};XMLHttpRequest.prototype.send=function(...r){try{this.__dubbedB=bodyOf(r[0]);}catch(e){}this.addEventListener('load',()=>{try{if(String(this.__dubbedU||'').includes('get_cdn_series'))save(this.responseText,this.__dubbedB);}catch(e){}});return os.apply(this,r);};})();`;
            (document.head || document.documentElement).appendChild(script);
            script.remove();
        }
        catch (err) {
            Logger.error("RezkaHelper: failed to inject cdn hook", err?.message);
        }
    }

    readHookedData(expect) {
        try {
            const raw = document.documentElement?.dataset?.[this.DATA_KEY];
            if (!raw) {
                return undefined;
            }
            const parsed = JSON.parse(raw);
            if (parsed?.ts && Date.now() - parsed.ts <= this.HOOK_MAX_AGE && parsed?.j && (parsed.j.links || parsed.j.url)) {
                // [rezka-patch] БАГ «играет озвучка предыдущей серии» (2026-09-13):
                // при переключении серии плеер ещё не успел запросить
                // get_cdn_series, а в dataset лежит ответ ПРЕДЫДУЩЕЙ серии
                // (живёт до HOOK_MAX_AGE = 15 минут). Раньше такой ответ
                // принимался как актуальный → расширение отправляло Яндексу
                // ссылку прошлой серии и играла её озвучка (лечилось только
                // полной перезагрузкой). Теперь сверяем серию/сезон из тела
                // запроса, сохранённого хуком.
                if (expect) {
                    const req = parseRezkaCdnRequest(parsed.req);
                    if (req.season && expect.season && req.season !== expect.season) {
                        Logger.log(`RezkaHelper: hook-ответ от другой серии (season ${req.season} != ${expect.season}) — игнорирую`);
                        return undefined;
                    }
                    if (req.episode && expect.episode && req.episode !== expect.episode) {
                        Logger.log(`RezkaHelper: hook-ответ от другой серии (episode ${req.episode} != ${expect.episode}) — игнорирую`);
                        return undefined;
                    }
                }
                return parsed.j;
            }
        }
        catch (err) { }
        return undefined;
    }

    // Парсит url-строку rezka: "[360p]url or url or url,[480p]...".
    // Возвращает { mp4, m3u8, quality } — лучший (макс.) НЕ-премиум вариант каждого типа.
    parseUrlString(urlStr) {
        if (!urlStr || typeof urlStr !== "string") {
            return undefined;
        }
        let best = null;
        for (const block of urlStr.split(",")) {
            const bracketOpen = block.indexOf("[");
            if (bracketOpen === -1) continue;
            const bracketClose = block.indexOf("]", bracketOpen);
            if (bracketClose === -1) continue;
            const qualityLabel = block.slice(bracketOpen + 1, bracketClose);
            if (/ultra|prem|<|span|img/i.test(qualityLabel)) continue;
            const qMatch = /(\d{3,4})\s*p/i.exec(qualityLabel);
            const q = qMatch ? parseInt(qMatch[1], 10) : 0;
            let mp4 = null;
            let m3u8 = null;
            for (const candidate of block.slice(bracketClose + 1).split(" or ")) {
                const u = candidate.trim();
                if (!/^https?:\/\//.test(u)) continue;
                if (/\.m3u8/i.test(u)) { m3u8 = m3u8 || u; }
                else if (/\.mp4/i.test(u)) { mp4 = mp4 || u; }
            }
            if ((mp4 || m3u8) && q > (best?.quality || -1)) {
                best = { quality: q, mp4, m3u8 };
            }
        }
        return best;
    }

    selectBestLink(data) {
        // Приоритет — mp4: Яндекс нативно и надёжно переваривает единый mp4-файл.
        // CDN Rezka отдаёт mp4 напрямую без Referer (проверено, 206 на Range).
        const parsed = this.parseUrlString(data?.url);
        if (parsed?.mp4) return parsed.mp4;
        if (parsed?.m3u8) return parsed.m3u8;
        if (data?.links) {
            let bestMp4;
            let bestQuality = -1;
            for (const [quality, info] of Object.entries(data.links)) {
                if (info?.type !== "link" || !/^https?:\/\//.test(info.url)) continue;
                const qn = parseInt(quality, 10) || 0;
                if (qn > bestQuality) { bestQuality = qn; bestMp4 = info.url; }
            }
            if (bestMp4) return bestMp4;
        }
        return parsed?.mp4;
    }

    /**
     * [rezka-patch] Дешёвое (без сети) чтение текущей медиа-ссылки для
     * наблюдателя расширения (src/core/mediaUrlWatcher.ts).
     *
     * Зачем: при смене серии внутри плеера rezka `video.src` не меняется (MSE),
     * поэтому ни `emptied`, ни смена source-key не срабатывают — расширение
     * продолжало играть озвучку предыдущей серии до полной перезагрузки.
     * Берём САМЫЙ СВЕЖИЙ ответ плеера на get_cdn_series: он относится к той
     * серии, которую плеер сейчас грузит. Сверку с videoId здесь НЕ делаем
     * намеренно — на момент смены videoId ещё старый, и совпадение не выйдет.
     */
    peekMediaUrl() {
        try {
            const hooked = this.readHookedData();
            if (hooked) {
                const url = this.selectBestLink(hooked);
                if (url) {
                    return url;
                }
            }
        }
        catch (err) { /* ignore */ }
        return undefined;
    }

    /**
     * [rezka-patch] «Личность» текущей серии — для наблюдателя смены серии
     * (src/core/mediaUrlWatcher.ts).
     *
     * ПОЧЕМУ НЕ ПО МЕДИА-ССЫЛКЕ. На части страниц rezka плеер НЕ зовёт
     * get_cdn_series (ссылки лежат инлайн в конфиге "streams"), поэтому
     * peekMediaUrl() возвращает undefined → наблюдатель молчит → при
     * переключении серии кнопка остаётся в «Готово» и играет озвучка
     * ПРЕДЫДУЩЕЙ серии до полной перезагрузки страницы. Плюс у rezka подпись и
     * срок лежат В ПУТИ ссылки (voidcrystal.org/<hash>:<expiry>:<sig>), поэтому
     * сравнение URL по пути ненадёжно.
     *
     * Берём прямо разметку плеера: активные сезон/серия/переводчик. Значение
     * меняется ровно тогда, когда пользователь переключил серию.
     */
    peekEpisodeKey() {
        try {
            const ep = this.activeEpisode
                || Array.from(document.querySelectorAll(".b-simple_episode__item, .b-simple-episode__item"))
                    .find((el) => /active|selected/i.test(el.className || ""));
            const seasonId = this.activeSeason?.getAttribute("data-id")
                || ep?.getAttribute("data-season_id")
                || ep?.getAttribute("data-season");
            const episodeId = ep?.getAttribute("data-episode_id")
                || ep?.getAttribute("data-episode")
                || ep?.getAttribute("data-id");
            if (!seasonId && !episodeId) {
                return undefined;
            }
            const translatorId = this.activeTranslator?.getAttribute("data-translator_id");
            return `s${seasonId || "?"}:e${episodeId || "?"}:t${translatorId || "?"}`;
        }
        catch (err) { /* ignore */ }
        return undefined;
    }

    // Активные элементы плеера rezka (новый формат: сезон/серия/переводчик раздельно)
    get activeEpisode() {
        return document.querySelector(
            ".b-simple-episode__item.active, .b-simple_episode__item.active, .b-simple-episode__item.selected, .b-simple_episode__item.selected, .b-simple_episode.active, .episodes-item.active, [class*='episode'][class*='active'][data-id]"
        );
    }
    get activeSeason() {
        return document.querySelector(
            ".b-simple-season__item.active, .b-simple_season__item.active, .b-simple-season__item.selected, [class*='season'][class*='active'][data-id]"
        );
    }
    get activeTranslator() {
        return document.querySelector(
            ".b-translator__item.active, #translators-list li.active, [class*='translator'][class*='active'][data-translator_id]"
        );
    }
    get ctrlFavs() {
        return document.getElementById("ctrl_favs")?.value || "";
    }
    get ctrlToken() {
        return document.getElementById("ctrl_token_id")?.value || "";
    }

    getVideoId(url) {
        const filmId = /\/(\d+)-[^/]*\.html/.exec(url.pathname)?.[1];
        if (!filmId) {
            return undefined;
        }
        const se = /-sezon-(\d+)-seriya-(\d+)/.exec(url.pathname);
        if (se) {
            return `${filmId}:${se[1]}:${se[2]}`;
        }
        // Новый формат rezka: season/episode отдельными полями. Берём активную серию.
        const ep = this.activeEpisode
            || document.querySelector(".b-simple-episode__item, .b-simple_episode__item, [data-episode_id]");
        const seasonId = this.activeSeason?.getAttribute("data-id")
            || ep?.getAttribute("data-season_id")
            || ep?.getAttribute("data-season");
        const episodeId = ep?.getAttribute("data-episode_id")
            || ep?.getAttribute("data-episode")
            || ep?.getAttribute("data-id");
        if (seasonId && episodeId) {
            return `${filmId}:${seasonId}:${episodeId}`;
        }
        return filmId;
    }

    // Кликаем по реальным play-кнопкам плеера rezka — это запускает его JS,
    // он запросит get_cdn_series с валидной сессией, а наш hook поймает ответ.
    // video.play() не помогает: у <video> вообще нет src, пока плеер не инициализирован.
    // Клик делается ОДИН РАЗ за страницу: повторные клики во время retry
    // раздражают пользователя (видео постоянно стартует заново).
    triggerRezkaPlay() {
        // Глобальный флаг на окно (а не на инстанс helper): при retry VideoHandler
        // пересоздаётся, и флаг на инстансе сбрасывался — из-за этого расширение
        // заново запускало видео после того, как пользователь поставил Pause.
        if (window.__dubbedRezkaPlayTriggeredGlobal) {
            return "already";
        }
        window.__dubbedRezkaPlayTriggeredGlobal = true;
        this.__playTriggered = true;
        const PLAY_SELECTORS = [
            ".b-player .b-start-btn",
            ".b-player .b-hidden_play",
            ".b-player .b-player__btn_play",
            ".b-player__btn_play",
            ".vjs-big-play-button",
            ".jw-icon-display",
            "#player .b-start-btn",
            "#videoplayer .b-start-btn",
            ".b-start-btn",
            ".initializator > .b-player__btn_play",
        ];
        try {
            for (const sel of PLAY_SELECTORS) {
                const el = document.querySelector(sel);
                if (el && el.style.display !== "none" && el.style.visibility !== "hidden") {
                    el.click();
                    return sel;
                }
            }
        } catch (err) { /* ignore */ }

        // Fallback: если нашли video со src — пробуем play
        try {
            const v = this.video;
            if (v && (v.src || v.currentSrc)) {
                v.play?.()?.catch?.(() => {});
                return "video.play";
            }
        } catch (err) { /* ignore */ }
        return null;
    }

    // [rezka-patch] На некоторых страницах (напр. фильмы с одним переводчиком)
    // плеер rezka НЕ вызывает get_cdn_series — CDN-строка лежит прямо в
    // инлайн-конфиге страницы: "streams":"[360p]https://...mp4 or ...m3u8,...".
    // Формат идентичен полю url из ответа get_cdn_series.
    getStreamsFromPage() {
        try {
            const html = document.documentElement.innerHTML;
            const m = /["']streams["']\s*:\s*"([^"]+)"/.exec(html);
            if (m?.[1] && /\[\d{3,4}p\]/i.test(m[1])) {
                // строка в HTML экранирована (\/, \") — разворачиваем
                return m[1].replace(/\\([/"'])/g, "$1");
            }
        }
        catch (err) { /* ignore */ }
        return undefined;
    }

    async getVideoData(videoId) {
        const [filmId, season, episode] = videoId.split(":");
        this.injectCdnHook();

        const hasItems = (d) => d && (d.links || (typeof d.url === "string" && d.url.length > 0));
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

        // 0) Сначала пробуем инлайн-конфиг страницы — он есть даже ДО Play.
        //    НО он статичен для документа и относится ровно к ОДНОЙ серии — той,
        //    что была открыта при загрузке страницы. Поэтому запоминаем эту серию
        //    (`rezkaInlineStreamsEpisodeKey`) и доверяем конфигу только ей.
        //
        //    Прежняя версия опиралась на флаг `episodeChanged` («серия изменилась
        //    с прошлого вызова»), и он защищал лишь ОДИН вызов: на следующем же
        //    вызове для той же новой серии флаг сбрасывался, снова подставлялся
        //    инлайн-конфиг СТАРОЙ серии — и Яндекс получал её ссылку. Симптом
        //    пользователя: «переключил серию, а перевод остался от предыдущей».
        const episodeKey = season && episode ? `${filmId}:${season}:${episode}` : filmId;
        const episodeChanged = Boolean(rezkaLastEpisodeKey) && rezkaLastEpisodeKey !== episodeKey;
        rezkaLastEpisodeKey = episodeKey;
        if (episodeChanged) {
            Logger.log(`RezkaHelper: серия сменилась (${episodeKey})`);
        }

        if (!rezkaInlineStreamsEpisodeKey) {
            // Первый вызов за документ — инлайн-конфиг описывает именно эту серию.
            rezkaInlineStreamsEpisodeKey = episodeKey;
        }
        const inlineMatchesEpisode = rezkaInlineStreamsEpisodeKey === episodeKey;
        if (!inlineMatchesEpisode) {
            Logger.log(`RezkaHelper: инлайн-конфиг страницы от другой серии (${rezkaInlineStreamsEpisodeKey} != ${episodeKey}) — игнорирую`);
        }
        const streamsStr = inlineMatchesEpisode ? this.getStreamsFromPage() : undefined;
        let data = typeof streamsStr === "string" ? { url: streamsStr } : undefined;

        // 1) Если плеер rezka уже сам запросил ссылки — берём его свежий ответ
        if (!hasItems(data)) {
            data = this.readHookedData({ season, episode });
        }

        // 1.5) Если hook пуст — кликаем по play-кнопке плеера (один раз за
        //      страницу, см. глобальный флаг) и ждём ответа hook.
        if (!hasItems(data)) {
            this.triggerRezkaPlay();
            for (let i = 0; i < 10 && !hasItems(data); i++) {
                await sleep(500);
                data = this.readHookedData({ season, episode });
            }
        }

        // 2) Последний fallback — родной ajax rezka (схема из РАБОЧЕГО бандла
        //    F:\Pets\Cursor\dubbed\chrome\assets\index.ts-C9OZT9kb.js):
        //    id = filmId, отдельные season/episode, ОБЯЗАТЕЛЬНЫЙ favs
        //    (ctrl_favs) + заголовок X-CSRF-Token: favs, referrer /series/.
        //    Без favs rezka отвечает "Время сессии истекло". Пул переводчиков
        //    из DOM: активный первым, затем остальные, затем "0".
        if (!hasItems(data)) {
            const favs = this.ctrlFavs;
            const trSet = Array.from(
                document.querySelectorAll("[data-translator_id], .b-translator__item"),
            )
                .map((el) => el.getAttribute?.("data-translator_id"))
                .filter((t) => t)
                .reduce((acc, id) => (acc.includes(id) ? acc : [...acc, id]), []);
            const activeTrId = this.activeTranslator?.getAttribute?.("data-translator_id");
            const pool = activeTrId
                ? [activeTrId, ...trSet.filter((t) => t !== activeTrId)]
                : trSet;
            if (!pool.length) {
                pool.push("0");
            }
            for (const translatorId of pool) {
                const body = new URLSearchParams({
                    id: filmId,
                    translator_id: translatorId,
                    action: "get_stream",
                });
                if (season && episode) {
                    body.set("season", season);
                    body.set("episode", episode);
                }
                if (favs) {
                    body.set("favs", favs);
                }
                try {
                    const res = await fetch(`${this.API_ORIGIN}/ajax/get_cdn_series/?t=${Date.now()}`, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                            "X-Requested-With": "XMLHttpRequest",
                            ...(favs ? { "X-CSRF-Token": favs } : {}),
                        },
                        body: body.toString(),
                        credentials: "include",
                        referrer: `${this.API_ORIGIN}/series/`,
                    });
                    const candidate = await res.json().catch(() => null);
                    if (hasItems(candidate)) {
                        data = candidate;
                        break;
                    }
                    Logger.error(`RezkaHelper: tr=${translatorId} пусто (message=${candidate?.message ?? "none"} url=${typeof candidate?.url}, links=${!!candidate?.links})`);
                }
                catch (err) {
                    Logger.error(`RezkaHelper: failed request tr=${translatorId} (id: ${videoId})`, err?.message);
                }
            }
            if (!hasItems(data)) {
                Logger.error(`RezkaHelper: no links (id: ${videoId} favs=${favs ? "yes" : "no"} pool=${pool.join(",")})`);
            }
        }

        if (!hasItems(data)) {
            // ВАЖНО для UX: НЕ возвращаем undefined, даже если CDN-ссылок пока нет
            // (плеер ещё не запросил их / сессия rezka временно упала). Иначе
            // lifecycle спрячет кнопку и она "то появляется, то нет".
            // videoId уже привязан из URL — кнопка появляется СРАЗУ на любой
            // странице с видео. Реальные ссылки добираются при клике
            // (getVideoDataForTranslation → refresh для rezka) — к тому моменту
            // плеер обычно уже запросил get_cdn_series и hook поймал ответ.
            const src = this.video?.currentSrc || this.video?.src || "";
            const url = /^https?:/i.test(src) ? src : "https://rezka.invalid/placeholder.mp4";
            Logger.log(`RezkaHelper: ссылок нет (id: ${videoId}), кнопка будет активна, ссылки добьются при клике`);
            return {
                url,
                video_url: url,
                duration: this.video?.duration || undefined,
                _placeholder: true,
            };
        }
        const bestUrl = this.selectBestLink(data);
        if (!bestUrl) {
            Logger.error(`RezkaHelper: url строка не распарсилась → нет mp4 (id: ${videoId})\nurl=${typeof data?.url === "string" ? data.url.slice(0, 200) : data?.url}`);
            return undefined;
        }
        const duration = this.video?.duration || undefined;
        // ВАЖНО (проверено live-пробами 2026-09-10):
        // - CDN Rezka (voidslam.org / stream.voidboost.one) отдаёт mp4 и m3u8-сегменты
        //   ЛЮБОМУ клиенту без Referer/Origin (200/206 на Range).
        // - Прокси media-proxy.toil.cc НЕ может достучаться до voidslam (таймаут/ECONNRESET
        //   на /v1/proxy/video.ts), поэтому перевод через targetUrl-прокси падает с
        //   "Yandex couldn't translate video". Прокси убран: targetUrl = прямая ссылка.
        // - Приоритет — mp4: Яндекс нативно переваривает единый mp4-файл надёжнее,
        //   чем HLS-манифест с сегментами вида "58fq2.mp4:hls:seg-N-v1-a1.ts".
        const isHls = /\.m3u8/i.test(bestUrl);
        Logger.log(`RezkaHelper: передаю Яндексу напрямую ${isHls ? "m3u8" : "mp4"} (${bestUrl.slice(0, 90)}...)`);
        return {
            url: bestUrl,
            video_url: bestUrl,
            translationHelp: [
                {
                    target: "video_file_url",
                    targetUrl: bestUrl,
                },
            ],
            duration,
        };
    }
}