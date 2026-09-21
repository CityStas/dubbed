# Rezka-патч — закадровый перевод hdrezka/rezka средствами Яндекс Dubbed

Ветка 1.0.0 + патч, добавляющий поддержку сайтов Rezka (`rezka.ag`, `hdrezka.ag`,
`hdrezka-home.tv`, `hdrezka.me`, `hdrezka.fi`, `rezka.tv`, `standby-rezka.tv` и зеркала)
в оригинальное расширение **Voice Over Translation**.

## Что изменилось

1. `src/headers.json` — добавлены домены Rezka в `match` (из него генерируется
   манифест: `content_scripts` + host-перманенты).
2. `node_modules/@vot.js/ext` — добавлен сервис `rezka` и helper `helpers/rezka.js`
   (логика из локального расширения Doc: POST `/ajax/get_cdn_series/` с cookies
   страницы → выбор максимального качества `type=link` → прямая ссылка mp4/m3u8).
3. Ссылка отдаётся Яндексу через механизм `translationHelp: [{target:"video_file_url",
   targetUrl: bestUrl}]` — прямая ссылка CDN Rezka (как для YouTube), БЕЗ медиа-прокси.
   Проверено: CDN Rezka (voidslam.org) отдаёт и манифест, и сегменты .ts напрямую (HTTP 200)
   без hotlink-защиты, поэтому сервер Яндекса может скачать ролик напрямую.
   Использование `media-proxy` (`transly.eu.cc` — мёртв, `toil.cc` — часто недоступен с серверов
   Яндекса) было причиной "Failed to request video translation".

## Установка в Chrome

1. `npm install` (Node 20+)
2. `node scripts/apply-rezka-patch.mjs` — пропатчит `@vot.js/ext` (идемпотентно)
3. `npm run build:chrome`
4. `chrome://extensions` → «Режим разработчика» → «Загрузить распакованное» →
   папка `dist-ext/chrome`
5. Открой фильм на hdrezka, нажми Play → над плеером появится кнопка Dubbed →
   «Перевести видео».

## Обновление/пересборка

```powershell
node scripts/apply-rezka-patch.mjs   # если делал npm install заново
npm run build:chrome
```

## Замечания

- Для сериалов берётся выбранное в плеере Rezka озвучивание (`translator_id` из DOM)
  и текущая серия. **Смена серии больше не требует перезагрузки страницы** — см. ниже.
- Если Rezka вернёт «Премиум»-ссылки, они не используются — берётся лучшее
  доступное качество.
- Файлы патча хранятся в `scripts/rezka-patch-files/` (rezka.js / rezka.d.ts),
  вся правка применяется скриптом `scripts/apply-rezka-patch.mjs`.

## Фикс 13.09.2026: смена серии играла озвучку предыдущей

Симптом: переключил серию без перезагрузки — играет озвучка ПРЕДЫДУЩЕЙ серии
(то же было и на kinogo). Три причины:

1. **Хук не знал, к какой серии относится ответ.** `get_cdn_series` — POST с
   urlencoded-телом (`id`, `season`, `episode`, `translator_id`); в
   `dataset.dubbedRezkaCdn` лежал только ответ с TTL 15 мин. Инжектируемый хук
   (`scripts/rezka-patch-files/rezka.js` + `src/rezkaEarlyHook.ts`) теперь пишет
   и тело запроса (`bodyOf()` для `fetch`/`XHR`), а
   `parseRezkaCdnRequest(raw)` разбирает его в `{id, season, episode, translator_id}`.
2. **`readHookedData(expect)`** отбраковывает ответ, у которого записанные
   `season`/`episode` не совпадают с ожидаемыми.
3. **Инлайн-конфиг страницы (`"streams":"[360p]…"`) — от ПРЕДЫДУЩЕЙ серии.**
   Rezka подменяет его через JS, а `document` остаётся старым.

   ⚠️ **Первая версия фикса была недостаточной (исправлено 13.09.2026).** Она
   опиралась на флаг «серия изменилась с прошлого вызова»:
   ```js
   // БЫЛО И НЕ РАБОТАЛО:
   const episodeChanged = Boolean(rezkaLastEpisodeKey) && rezkaLastEpisodeKey !== episodeKey;
   let data = !episodeChanged && typeof streamsStr === "string" ? { url: streamsStr } : undefined;
   ```
   Флаг защищал ровно ОДИН вызов. `getVideoData()` зовётся по несколько раз на
   серию (init → refresh при клике), поэтому уже на втором вызове
   `episodeChanged` снова `false`, подставлялся инлайн-конфиг СТАРОЙ серии — и
   Яндекс получал её ссылку. Симптом: **«переключил серию, а перевод остался от
   предыдущей»** (кнопка при этом сбрасывалась правильно).

   Теперь запоминаем, какой серии принадлежит инлайн-конфиг, и доверяем ему
   только ей:
   ```js
   // СТАЛО:
   if (!rezkaInlineStreamsEpisodeKey) {
       rezkaInlineStreamsEpisodeKey = episodeKey;   // первый вызов за документ
   }
   const inlineMatchesEpisode = rezkaInlineStreamsEpisodeKey === episodeKey;
   const streamsStr = inlineMatchesEpisode ? this.getStreamsFromPage() : undefined;
   let data = typeof streamsStr === "string" ? { url: streamsStr } : undefined;
   ```

   Проверка (прод-сборка, зеркало `standby-rezka.tv`): при переключении
   4 → 5 → 4 → 2 Яндексу уходили РАЗНЫЕ ссылки
   (`2a4c4e48…` / `3e106496…` / `2a4c4e48…` / `a74fcbfe…`), и в логе появлялись
   две разные озвучки. В логе признак:
   `RezkaHelper: инлайн-конфиг страницы от другой серии (88931:1:4 != 88931:1:5) — игнорирую`.
   Критерий в `probe-rezka.cjs` — **смена самой ссылки Яндексу**, а не mp3
   (mp3 может законно совпасть из-за кэша Яндекса, если серию уже переводили).

**Важно:** `rezkaLastEpisodeKey` — переменная МОДУЛЯ, а не поле класса:
vot.js `VideoHelper.getHelper(service)` возвращает `new availableHelpers[host](…)`
на КАЖДЫЙ вызов, поэтому поля инстанса не переживают между `getVideoData()`.

4. **Главное — плеер вообще не менял `video.src`.** Rezka играет через hls.js/MSE,
   `video.src` остаётся `blob:` на всю сессию, поэтому
   `VideoLifecycleController.getCurrentSourceKey()` не менялся и расширение
   не замечало смену серии. См. общий `MediaUrlWatcher` в `README-DUBBED.md`
   (каждые 2 c опрашивает `peekMediaUrl()`, 2 подтверждения → принудительный
   `runSetCanPlayOnce(true)` → кнопка возвращается в «Перевести видео»).
   У rezka-хелпера для этого добавлен `peekMediaUrl()`.

---

## v6 (13.09.2026, вечер): Play больше не сбрасывает перевод + диагностика «бесконечного перевода»

Жалоба: «открываешь сериал — кнопка „Перевести видео“ есть, нажал Play — кнопка
перезапускается, надо жать снова» и «на 88931 бесконечный перевод».

**Причина №1 (исправлена).** Первый Play меняет `video.src` (плеер уходит на `blob:`
того же файла) → `getCurrentSourceKey()` меняется → `canplay` → `setCanPlay()` →
`handleSrcChanged()` → `resetAndHideLifecycle()` → `stopTranslate()`: готовая озвучка
выброшена, незавершённый запрос в Яндекс `abort`-нут. Фикс — `preserveTranslation`
в `src/core/videoLifecycleController.ts` (+ `hasTranslationToPreserve()` в
`VideoHandler`). Принудительный сброс сохранён для `handleMediaSourceChanged()`
(смена серии/переводчика, подтверждённая `MediaUrlWatcher`) и для `emptied` с
изменившимся `videoId`.

**Эталон прогона** (`probe-e2e-play-preserve.cjs`, `PROFILE_DIR=pw-rezka`):
```
[69s] [VideoLifecycle][session:2] src changed {sourceKey: …rezka.ag/76a4c403-…||0}
[69s] [VideoLifecycle][session:2] src changed, translation preserved {videoId: 88931:1:2}
[409s] ← Яндекс: status=1 duration=940.79 id=467184897
[412s] кнопка="Готово! Нажмите "Play""  аудио=1
ресетов кнопки в idle после старта: 0 ✅   уникальных translationId: 1 ✅
```

**Причина №2 «бесконечного перевода» (не наш баг).** Контроль показал: Яндекс отдаёт
очередь ~5–7 минут даже на 15-секундный ролик (`status 2`, `remainingTime` 315 → 159
за 3.5 мин). На 15-минутной серии ETA был ~420 c и перевод закончился за **409 c**
одной сессией (`translationId` один). То есть «20+ минут» — это очередь Яндекса плюс
наши редкие поллинги. Поллинг ускорен: `clamp(eta/4, 10 c, 45 c)` вместо «спать ровно
eta при eta <= 180» (см. `getRetryDelayMs` в `src/core/translationHandler.ts`).

⚠️ Кэш Яндекса: серия, которую уже переводили (Le-Production), отдаётся за 1–2 минуты.
Переключение на «Оригинал (+субтитры)» = НОВАЯ ссылка → реальная очередь. Это и
выглядело как «раньше грузилось за 2 минуты, теперь 20».

Разведка UI озвучки: `.b-translator__item[data-translator_id]` в MAIN-фрейме
(`Le-Production` = 447, `Оригинал (+субтитры)` = 238). Стенд умеет переключать —
`S.selectOriginalVoiceover()` в `dubbed-test/lib/stand.cjs`.

## Аудит 14.09.2026: применим ли к rezka дефект v8 kinogo («сброс перевода в полёте»)?

После фикса kinogo (§v8 в `KINOGO-PATCH.md`) проверено, нет ли той же рассинхронизации на rezka.
Наблюдатель смены медиа (`src/core/mediaUrlWatcher.ts`) требует инварианта:

> `mediaIdentity(translationHelp.targetUrl)` == `mediaIdentity(peekMediaUrl())`
> для ОДНОГО И ТОГО ЖЕ текущего медиа-источника.

Иначе каждые 2 c `media source changed` → `resetAndHideLifecycle()` → перевод в полёте умирает,
кнопка возвращается в «Перевести видео» (симптом «стартовал и сразу сбросился»).

**Вывод: дефект kinogo к rezka НЕ применим.** Обе ссылки берутся одной и той же функцией
`selectBestLink()`:

| Откуда | Что читает |
|---|---|
| `getVideoData()` → `targetUrl` | `readHookedData({season, episode})` (с фильтром) → `selectBestLink()` |
| `peekMediaUrl()` | `readHookedData()` (БЕЗ фильтра) → `selectBestLink()` |

Разделения «master vs рендишен», которое всё сломало на kinogo, у rezka нет: ссылка одна и та же
(приоритет mp4, `selectBestLink` детерминирован). Совпадение представления ⇒ совпадение
`mediaIdentity` ⇒ ложных срабатываний нет.

**Асимметрия «с фильтром / без фильтра» — намеренная и НЕУДАЛЯЕМАЯ.** Именно она и есть детектор
смены серии: сразу после переключения `videoId` ещё старый, поэтому `peekMediaUrl()` (без фильтра)
отдаёт ссылку НОВОЙ серии из свежего hook-ответа → расхождение с `targetUrl` → 2 подтверждения →
reset → re-resolve уже с правильным `season/episode`. Поэтому приём v8 (`rememberTargetUrl`,
«заморозить то, что ушло Яндексу») для rezka применять НЕЛЬЗЯ — он бы отключил детектор смены
серии, то есть вернул баг «переключил серию — играет озвучка предыдущей».

**Теоретический риск (не наблюдался).** Вечный цикл возможен, если hook хранит ответ для серии
X, а `getVideoId()`/`getVideoData()` разрешают серию Y ≠ X: тогда `peekMediaUrl()` (без фильтра)
всегда отдаёт X, `targetUrl` — Y, расхождение не снимется никогда. Условие: плеер запросил
`get_cdn_series` не для той серии, что выбрана в разметке (prefetch следующей серии, лаг DOM).
Как проверить в логе за 5 секунд:

```bash
grep -c "mediaWatcher" <лог>                      # должно быть 0 в покое
grep -c "VideoLifecycle\]\[session:" <лог>        # не должен расти после старта перевода
```

Если счётчик сессий растёт — смотреть в логе пары
`RezkaHelper: hook-ответ от другой серии (season N != M) — игнорирую` вместе с
`peekEpisodeKey`; это укажет, что hook и разметка расходятся.

**Ещё одна находка (kinogo, но общий механизм).** `refreshVideoDataForRetry()` (VideoHandler)
обещает «повтор со свежей ссылкой», но `fetchManifestText` в kinogo-хелпере кэширует текст
манифеста 60 c по pathname. Пауза между повторами ~7 c ⇒ первые ~8 повторов получают ТУ ЖЕ
ссылку, и только после истечения кэша приходит свежая подпись. Измерено по логу: за 23 повтора
URL менялся лишь несколько раз. НЕ правил намеренно: в окне деградации Яндекса эффект не
измерить, а менять поведение повторов вслепую — риск. Кандидат на следующий раз: сброс
manifest-кэша в начале `refreshVideoDataForRetry` (опциональный метод хелпера).
