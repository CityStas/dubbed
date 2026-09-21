# Kinogo-патч — добавление поддержки kinoGo средствами Яндекс Dubbed

Ветка 1.0.0 + патч (по образцу `REZKA-PATCH.md`), добавляющий поддержку сайтов
**kinoGo** (`kinogo.ec`, `kinogo.biz` и региональные поддомены вида `lv.kinogo.ec`).

## Как устроен kinogo (что выяснили живыми пробами 2026-09-11)

1. Страница фильма **не содержит** `<video>`. Плеер живёт в **lazy-iframe** — три
   вкладки `ul.video-tabs`, у каждой `li[data-src]`:
   - **«Смотреть онлайн»** → `cinemar.cc/embed/...` — **мёртв** (404) для этого фильма;
   - **«Плеер 1»** → `api.ortified.ws/embed/movie/<id>` — **рабочий**, его и используем;
   - **«Плеер 3»** → `vid*.sevstar*.com/.../iframe?d=kinogo.ec` — отдельный CDN.
2. Плеер `api.ortified.ws` делает `<video>` с **blob-src** (player-venom / MSE),
   за которым — HLS `…/master.m3u8` на CDN **interkh.com**.
   **Проверено**: CDN отдаёт и `master.m3u8`, и цепочку `index-v2/index-a1.m3u8`
   и `.ts`-сегменты без строгого hotlink (200/206) — аналог voidboost у rezka.
3. Поэтому кнопка Dubbed появляется **внутри iframe-плеера** (на `api.ortified.ws`),
   а не на самой странице kinoGo. Это нормально для iframe-плееров.

## Урок 2026-09-12 (v2): «Возникла ошибка при переводе» — причина была НЕ в multi-audio

> ⚠️ Первоначальный вывод «Яндекс не переваривает multi-audio HLS, нужен
> media-proxy» **опровергнут** прямым A/B-замером. Ниже — то, что реально было.

Симптом: кнопка «Перевести видео» появляется, клик запускает перевод, идут
статусы («Подготавливаем…» → «Вот-вот! Осталась буквально минутка»), затем
через ~40–120 с «Возникла ошибка при переводе, попробуйте позже».

**Настоящая причина.** Helper отдавал Яндексу заглушку
`https://kinogo.invalid/placeholder.mp4`. DEBUG-лог показал ровно это:
`{translationHelp: null, isStream: false, duration: 1332.081, videoId: cinemar.cc,
url: "https://kinogo.invalid/placeholder.mp4"}`. Сборщик ссылок не находил
медиа-URL, потому что:
1. regex в инжектируемом `<script>` был **переэкранирован**
   (`/\\\\.(m3u8|mp4)/` вместо `/\.(m3u8|mp4)/`) — матчил литеральный бэкслеш,
   т.е. не матчил вообще ничего;
2. ротатор `cinemar.cc` вставляет `master.m3u8` **только из JS** — в HTML его нет,
   поэтому fallback-скан разметки тоже не помогал.

**Исправление (архитектурное).** Ссылку теперь собирает
`src/kinogoEarlyHook.ts` через **Performance Resource Timing** — это
транспорт-агностик: видит любой запрос (XHR/fetch/`<link>`/MSE), включая
ротирующиеся поддомены CDN (`cfnd.`, `host.`, `minos.host.`,
`potassium.host.cinemap.cc`). Плюс MAIN-world патч `fetch`/`XMLHttpRequest`
(content script уже в `world: MAIN`, инжект не нужен). Ссылки копятся в своей
rolling-коллекции `window.__dubbedKinogoPerf` (лимит 120 URL) — буфер
resource-timing вытесняется, своя коллекция нет.

**A/B (реальный путь Яндекса через расширение, `window.__dubbedDebugTranslate`):**

| Транспорт | Результат |
|---|---|
| прямой `master.m3u8` (host.cinemap.cc) | `status 5 (PART_CONTENT)` → `status 1`, `translated: true` за ~57 с |
| тот же манифест через `media-proxy.toil.cc/v1/proxy/m3u8` | `FAILED` через 157 с |

Вывод: **прямой манифест Яндекс забирает сам, прокси только ломает.**
`USE_M3U8_PROXY = false` (оставлен как страховка для CDN, которые Яндекс не достаёт).

**Урок про media-proxy-роут.** У `media-proxy.toil.cc` рабочий роут для
плейлистов — `/v1/proxy/m3u8?all=yes&format=base64&url=<base64>` (переписывает
и вариант-плейлисты, и `.ts`-сегменты в `/v1/proxy/video.ts?url=…`).
Роут `/v1/proxy/video.mp4` для http(s)-URL всегда отвечает
`400 {"error":"Unknown video format"}` — не использовать.

## Урок 2026-09-13 (v2, ИСПРАВЛЕНО): «классическая ошибка» — это сервер Яндекса, а не плеер

### ✅ ИТОГ (проверено 13.09 ~01:55, два прогона подряд)

**«Плеер 1» переводится.** `probe-ab-player.cjs TABS=1`:

```
run1: 2/rt46 → 2/rt5 (unknown0=10) → 1 FINISHED, duration=1332.128798, language="en"   (t≈115 c)
run2: 2/rt46 → 2/rt5 → 5 PART_CONTENT (duration=600, language="de")
                      → 1 FINISHED (duration=1332.128798, language="en")               (t≈119 c)
UI:   Ready! Press "Play"     (mp3 с vtrans.s3-private.mds.yandex.net/tts/prod/<hash>.mp3)
```

Отсюда два важных следствия, отменяющих прежние планы:

1. **Яндекс скачал сегменты interkh.** Значит 410 отдаётся не «всем серверным
   клиентам», а нашему sandbox-IP (anti-bot по репутации/TLS). **Remux-прокси для
   «Плеера 1» НЕ нужен** — идея со своим Cloudflare Worker снимается.
2. **«Классическая ошибка» была временной деградацией Яндекса** (~00:35–01:14 все
   НОВЫЕ URL падали `FAILED` + `shouldRetry`, включая свежий публичный mp4).
   К 01:52 сервис сам восстановился.

`shouldRetry` в обоих успешных прогонах не срабатывал — Яндекс сам дошёл до
`FINISHED`. Ретраи нужны именно на окно деградации.

---

## Урок 2026-09-13 (v3): «озвучка уже есть, а статусы менялись» — гейт PART_CONTENT

Жалоба пользователя: оба плеера дали озвучку, но «озвучка уже есть, но статусы менялись».

Причина найдена в `retry3.log` (videoId 74823, «Плеер 1»):

```
1) 2/rt46  WAITING                        → «Almost there! Just a minute left»
2) 2/rt5   WAITING                        → «Hang on a sec... I'm working hard!»
3) 5/rt5   PART_CONTENT: translated=TRUE, url=…a2298….mp3, duration=600   ← ОЗВУЧКА УЖЕ ЕСТЬ
   [Translation] translateVideoImpl response {status: 5, translated: true, remainingTime: 5}
   [Translation] scheduling translation retry {retryAttempt: 2, retryDelayMs: 30000}
4) 1/rt-   FINISHED, url=…3e902….mp3, duration=1332   → UI «Ready! Press "Play"»   (t=119 c)
```

`@vot.js/core` помечает `PART_CONTENT` как `translated: true` и **обязан** отдать `url`
(иначе кидает ошибку). Но наш гейт `if (res.translated && res.remainingTime < 1)`
требовал ещё и `remainingTime < 1`, а Яндекс отдаёт там `remainingTime: 5` → готовый
url выбрасывался, шёл следующий поллинг (при `retryAttempt > 0` — через 30 c, т.к.
`getRetryDelayMs` игнорирует `remainingTime`). Итого Ready приходил на ~30 c позже,
чем появлялось рабочее аудио. В апстриме `remainingTime` не проверяется нигде — гейт наш.

Почему ждать всё-таки имело смысл: `PART_CONTENT`-аудио **частичное** — `duration: 600`
против полных `1332` (10 из 22 минут).

**Решение (по выбору пользователя — играть частичную сразу):**
гейт стал `if (res.translated)`; частичная озвучка включается немедленно, а полная
добирается в фоне `schedulePartialTranslationUpgrade()` (тик 10 c, `silent: true` —
UI не трогается, ошибки фона не перезаписывают «Ready»); на `FINISHED` источник
подменяется через `updateTranslation`, позиция сохраняется за счёт `lipSync`.
Частичную озвучку **не кэшируем** (иначе при следующем открытии полная не подгрузится).
Подробности — в `README-DUBBED.md` и в памятке `.workbuddy-ai/skills/dubbed-site-debug`.

### Отдельная находка: на одной странице kinogo живёт НЕ ОДИН плеер

`probe-frames.cjs`: клик по вкладке «Смотреть онлайн» (её `data-src` ведёт на
`cinemar.cc/embed/100834/…`) в реальности может дать фрейм
**`api.ortified.ws/embed/movie/74823`** — сайт ротирует/подменяет плеер.
В прогоне `vs-tab0.log` сначала перевёлся cinemar (`videoId 100834`, Ready на t=103 c,
аудио скачано), а затем расширение обнаружило ВТОРОЕ видео (`videoId 74823`, ortified)
и запустило для него отдельный перевод — его статусы и шли дальше по времени.

Вывод: статус в UI может относиться к **другому** плееру, чем уже готовая озвучка.
Это вторая причина, по которой «озвучка уже есть, а статусы менялись».

---

### Разбор (как это выяснялось)

Симптом: на вкладке **«Плеер 1»** (`api.ortified.ws`) перевод падает в
«Возникла ошибка при переводе, попробуйте позже», на вкладке **«Смотреть онлайн»**
(`cinemar.cc`) — работает.

Первая версия этого раздела объясняла всё **demuxed HLS**. Это оказалось **неверно**.
Реальная причина — другая.

### Что доказано контролем (2026-09-13, 01:xx)

Взяли **свежий публичный mp4, которого Яндекс никогда не видел**
(`ForBiggerBlazes.mp4?cb=<random>`, 15 c) и прогнали через реальный путь
расширения (`window.__dubbedDebugTranslate`, DEBUG-сборка):

```
#0  status 2 (WAITING) remainingTime 25
#1  status 2 (WAITING) remainingTime 15   <- прогресс идёт
#2  status 0 (FAILED)  message "Возникла ошибка при переводе, попробуйте позже" shouldRetry=1
```

То же самое на `BigBuckBunny.mp4` и на `master.m3u8` interkh. **Яндекс сейчас
не переводит ни один новый URL** — плеер и формат тут ни при чём.

Почему cinemar «работает»: его результат лежит в **кэше Яндекса** — ответ приходит
с `translationId: 466908374` (создан раньше) и `status 1 FINISHED` + готовый mp3
`vtrans.s3-private.mds.yandex.net/tts/prod/<hash>.mp3`, `duration 1332.096`.
Кэш-хит отдаётся мгновенно, поэтому кажется, что «плеер рабочий».

### Второй факт: сегменты interkh закрыты TLS-фингерпринтом

Не «hotlink по Referer» (как думали раньше) — блок не по заголовкам:

| клиент | master / варианты / аудио-плейлисты | сегменты `.ts` |
|---|---|---|
| браузер (in-frame fetch) | 200 | **200** (836 600 b) |
| node 22 `fetch` (undici — `HTTP_PROXY` **не** читает) | 200 | **410** |
| node + UA | — | 410 |
| node + UA + `Referer`(embed/kinogo/playlist) + `Origin` | — | 410 |
| node + UA + `Referer` + `Sec-Fetch-*` + `Range` | — | 410 |
| curl `--http1.1` / `--http2` | — | 410 (0 b, ~40 мс) |

Куки interkh не ставит вообще (`ctx.cookies()` → 0). Значит отсекают по
**TLS/HTTP2 ClientHello (JA3/JA4)**. Отсюда: `curl`-версия «410 Gone» из прошлого
раздела — **не артефакт системного прокси**, блок реален.

Практический смысл: Яндекс качает медиа своим серверным клиентом → получает 410 на
каждый сегмент. Но в текущий момент это **не главная** причина падения (см. контроль
выше — падает даже публичный mp4). Это латентная проблема, которая проявится, когда
Яндекс выздоровеет.

### Что пробовали как обход (результаты)

- **`fail-audio-js`** (`PUT /video-translation/fail-audio-js`, путь YouTube) для
  не-YouTube URL → `{"status":0}` (ожидается 1). Яндекс **отказывает** переводить
  задачу в режим `AUDIO_REQUESTED(6)` — клиентское аудио для произвольных URL не
  принимается.
- **Загрузка аудио из браузера** (`PUT /video-translation/audio`):
  браузер выкачал **все 134** аудио-сегмента `index-a1.m3u8` (16.86 МБ за 38.7 с,
  суммарная длительность 1332 c = ровно длительность фильма, magic `47 40 00 10` —
  валидный MPEG-TS). Одиночный аплоад (`audioInfo`) → **принят**:
  `{"status":2,"remainingChunks":[]}`. Чанкованный (как YouTube: `chunkId` +
  `partialAudioInfo{audioPartsLength,fileId,version}`) → **HTTP 400**
  `(error_id:…-BAL)`. Проверить, оживляет ли аплоад задачу, нельзя, пока Яндекс
  валит все новые задачи — но это единственный клиентский обход, который стоит
  доразобрать.
- **`media-proxy.toil.cc`** remux не умеет: `/v1/proxy/video.mp4` требует прямой
  видеофайл (`400 Unknown video format` на m3u8 и на `.ts`), а `/v1/proxy/m3u8`
  переписывает только `#EXT-X-STREAM-INF`; `#EXT-X-MEDIA` оставляет прямыми на
  interkh, а относительные сегменты (`seg-1-v1.ts?...`) ломает — превращает в
  `…/SJQI6IZP.mp4/?hi=…` (файл теряется) → `400`.

### Что сделано в коде (фикс)

`VideoTranslationResponse.shouldRetry` (поле 12, наблюдали 1 и 7 — секунды) **нигде
не читалось**: на любой `FAILED` расширение сразу показывало ошибку, хотя сервер сам
просил повторить.

- `src/core/translationErrors.ts` — новый `getTranslationShouldRetry(value)`
  (читает `err.data.shouldRetry`, возвращает секунды или 0).
- `src/core/translationHandler.ts` — в `catch` у `translateVideoImpl` перед
  показом ошибки: если `shouldRetry > 0` и попыток меньше
  `SHOULD_RETRY_MAX_ATTEMPTS` (4) — не показывать ошибку, выставить статус
  «Перевод займёт несколько минут» и уйти в `scheduleRetry` с задержкой
  `clamp(shouldRetry*1000, 10 c, 60 c)`. Auth-ошибки исключены.
- `src/VideoHandler.ts` — DEBUG-мост теперь отдаёт ещё
  `__dubbedDebugProvider` и `__dubbedDebugClient` (для проб аудио-пути).

### История: первая (неверная) версия — demuxed HLS

Оставляю как справочник по формату interkh, вывод «переводится только muxed HLS»
**опровергнут** контролем выше.

CDN interkh отдаёт **полностью раздельные** видео и аудио:

- `master.m3u8` объявляет аудио через `#EXT-X-MEDIA` (`rus0` DEFAULT=YES
  LANGUAGE="ru", `eng1` LANGUAGE="en") + failover-группа `failover-audio-0` на
  втором хосте; `#EXT-X-STREAM-INF` ведут на **video-only** `index-v1.m3u8` /
  `index-v2.m3u8` (1280x720 / 640x360, `AUDIO="audio0"`);
- PMT сегмента `index-v1.m3u8` → `H.264 (pid 256) + ID3` — **аудио-стрима нет**;
- PMT сегмента `index-a1.m3u8` → `AAC ADTS (pid 256) + ID3` — **видео-стрима нет**.

Манифест при этом **стандартный** (`AUDIO="audio0"` связан с `#EXT-X-MEDIA`
корректно), просто Яндекс его не тянет. Для сравнения cinemar
(`host.cinemap.cc` → `hls.m3u8`) — мастер из одних `#EXT-X-STREAM-INF` без
`#EXT-X-MEDIA`, варианты muxed (`./720.mp4:hls:manifest.m3u8`).

### Побочные наблюдения (пригодятся)

- **`window.__dubbedDebugTranslate` рвётся при активации рантайма.** На ortified
  бутстрап ленивый: при детекте `<video>` рантайм фрейма перезапускается и
  `MessagePort` к background отваливается — in-flight XHR аборчен
  (`abort requested` → `net::ERR_ABORTED` → `port disconnected`).
  Синтетический вызов сразу после Play получает «Failed to request create session».
  Лечение в пробах: пауза ~8–12 c после Play + ретрай таких ошибок.
- **Playwright не видит тело запросов Яндекса.** Расширение шлёт их из background
  (`GM_xmlhttpRequest` → service worker), поэтому `request.postDataBuffer()` = `null`.
  Ответы ловятся через `ctx.on('response')` и декодируются
  `VideoTranslationResponse.decode` из
  `node_modules/@vot.js/shared/dist/protos/yandex.js` (импорт по абсолютному
  `file://`-пути — package exports сабпат `./dist/protos/*` не отдаёт).
- **`countryCode`** берётся из `cloudflare-dns.com/cdn-cgi/trace`; прокси-провайдер
  (`vot-worker.eu.cc`) включается только для `UA/LV/LT`. У нас запросы шли прямо на
  `api.browser.yandex.ru`.


## Урок 2026-09-13 (v4, ИСПРАВЛЕНО): «Плеер 1 в Original не выдаёт озвучку»

Симптом (со слов пользователя): на kinogo вкладка **«Плеер 1»** с выбранным
переводчиком **«Original»** — «не выдаёт озвучку в расширении», при этом
«Смотреть онлайн» переводится прекрасно.

### Что показывает анатомия плеера (`probe-player1-why.cjs`)

Ortified держит `<video>` в состоянии **`player-paused`** и `readyState: 0`
(цепочка предков: `video → div.video_9Xh → div.player-paused.player_1JR →
div#player`), пока пользователь не нажмёт Play. Замеры:

| момент | readyState | paused | dubbed-элементов | perf-коллектор |
|---|---|---|---|---|
| 10 c | 0 | true | 0 | пуст |
| 16 c (появился `blob:`) | 0 | true | 0 | пуст |
| 24 c (**после Play**) | 4 | false | 2 хоста | master.m3u8 |

То есть до Play **расширения в кадре не было вообще**. Причина — `VideoObserver`:
`onVideoAdded` диспатчился только при `readyState >= HAVE_CURRENT_DATA` (2) или
по событию `play`, причём валидация была одноразовой (`once: true`): если первая
проверка не прошла, видео попадало в `seenVideos` и **игнорировалось навсегда**.
Селектор тут ни при чём — `#player` матчится (`selectorHits: #player → true`).

### Фикс

`src/utils/VideoObserver.ts`:
- валидируем, если у `<video>` **есть источник** (`blob:`/`srcObject`/`src`) или
  хотя бы метаданные (`HAVE_METADATA`), а не только `HAVE_CURRENT_DATA`;
- вместо `once: true` — перепроверка на
  `loadstart/loadedmetadata/loadeddata/canplay/canplaythrough/durationchange/
  play/playing/volumechange/progress/suspend`.

Проверка — `probe-player1-noplay.cjs` (Play НЕ нажимаем):
```
[11s] стартовое состояние: {"readyState":0,"paused":true,"src":""}
[12s] ✅ кнопка появилась БЕЗ нажатия Play
      состояние видео: {"readyState":0,"paused":true,"src":"blob:...77ed5155-c9"}
      текст кнопки: "Перевести видео"
```

Побочный эффект (закрыт сразу): раз кнопка теперь есть до Play, пользователь
может нажать её раньше, чем плеер запросит манифест, и получить «воспроизведите
ролик обычным нажатием». Поэтому `src/ui/translationCommands.ts` перед циклом
refresh'а для kinogo делает `video.play()` (клик по кнопке расширения —
пользовательский жест).

### Почему «озвучки нет» бывает и ПОСЛЕ успешной кнопки — это Яндекс, не плеер

`probe-player1-audio.cjs`: кнопка есть, перевод стартовал, но Яндекс ответил
`status 0` + `server asked to retry {shouldRetrySeconds: 7, serverMessage:
"Возникла ошибка при переводе, попробуйте позже"}` — знакомый `FAILED+shouldRetry`.
В соседнем прогоне (`probe-player1-why.cjs`) ТА ЖЕ вкладка прошла:
`status 1`, `duration 1698.54644`, mp3 с `vtrans.s3-private.mds.yandex.net`,
кнопка «Готово! Нажмите "Play"», `video.volume` опущен до 0.43.

Вывод: на ortified Яндекс отказывает **по конкретному URL** чаще, чем на cinemar
(там ссылки кэшируются). Поэтому лимит повторов `shouldRetry` поднят с 4 до 6
(10→20→40→80→120→120 c, ~6.5 мин) — успешная озвучка приходит с 3–5 попытки.
Судить «плеер сломан» по одному прогону нельзя.

### Успешный прогон «Плеера 1» целиком (13.09.2026, `episode-reset3.log`)

```
[ 24s] перевод пошёл
[104s] [Translation] translation finished {isPartial: true,  status: 5, translated: true}
[104s] [AudioPlayer] lipsync mode is playing / sync play called / play called   ← играет сразу
[135s] [Translation] translation finished {isPartial: false, status: 1, translated: true}
[135s] [AudioPlayer] lipsync mode is playing                                     ← полная подменена
[146s] ложных срабатываний watcher до подмены: 0
[146s] статус: Готово! Нажмите "Play"
```

То есть «Плеер 1 в Original» озвучку выдаёт: сначала частичная (`status 5`), потом
полная (`status 1`), позиция не сбивается (`lipSync`). Если у пользователя «нет
озвучки» — смотреть §3.5 контроля Яндекса (`status 0` + `shouldRetry`) и не забывать,
что кнопка теперь появляется ДО Play.

### Watcher не должен ложно срабатывать на переподписи ссылки

Первая версия `MediaUrlWatcher` сравнивала полные URL → на ~79 c (переподпись
`?t/ha/hc` или уход на failover-хост) он видел «смену серии» и перезапускал перевод.
Сравнение переведено на `mediaIdentity` (pathname без query и без хоста). Проверка
с длинным окном: `OBSERVE_MS=120000 node probe-episode-reset.cjs` → **0 ложных за 146 c**,
реальная подмена серии ловится; `node unit-media-identity.cjs` → 8/8.

## Урок 2026-09-12: кнопка не появляется на первом Play

Симптом: нажал Play — кнопки нет; отмотал, нажал Play снова — появилась.

Причина: `MEDIA_WAIT_MS = 12000` — `getVideoData()` синхронно ждал манифест
до 12 с, блокируя монтирование кнопки (на rezka кнопка появляется сразу).

Исправление: `MEDIA_WAIT_MS = 2500` + `POLL_MS = 250`. Реальные ссылки
добираются **при клике** (`translationCommands.ts` →
`shouldRefreshVideoDataBeforeTranslation()` → для `host === "kinogo"` всегда
возвращает `true`: токен `:2026091223` короткоживущий, pod-домены ротируются).
Замер: кнопка появляется через **0.3 с** (ortified) / **1.8 с** (cinemar).

## Урок 2026-09-12: язык исходной дорожки

`detectDefaultAudioLang(mediaUrl)` читает `master.m3u8` и берёт язык дорожки с
`DEFAULT=YES` — ровно ту, которую Яндекс реально скачает. Если блока
`#EXT-X-MEDIA` нет (одиночная дорожка) — возвращает `undefined`, и Яндекс
определяет язык сам (`auto`).

Почему не «язык выбранной в плеере дорожки»: у hls.js загрузка плейлистов идёт
**внутри Web Worker**, такие запросы не видны в Performance Resource Timing —
активную дорожку оттуда не достать. Плюс детект по подписи в UI давал рассинхрон
(Яндекс берёт `DEFAULT=YES`, а не то, что подсвечено в меню).

**Честное ограничение:** перевести НЕ-дефолтную дорожку (напр. «Original
english», когда `DEFAULT=YES` стоит на ru-дубляже) «как есть» нельзя — нужен
прокси, переписывающий плейлист с переносом `DEFAULT=YES` на нужную дорожку.
Сейчас переводится дефолтная (ru-дубляж).

## Урок 2026-09-12: кнопка не была видна (0×0) — причина в селекторе `video`
Симптом: расширение бутстрапилось, кнопка `dubbed-segmented-button` была в DOM,
но геометрия 0×0, `getComputedStyle` пустой — пользователь кнопку не видел.

Причина: в селекторе сервиса kinogo был **голый `video`**
(`"#player, .player, .venom, video"`). `closestCrossShadow` начинается с самого
`<video>`, поэтому контейнером становилась сама видеонода, и оверлей монтировался
**внутрь `<video>`**. Дети `<video>` — fallback-контент: во время воспроизведения
они не рендерятся → кнопка невидима.

Исправление (в обоих местах, страховка):
1. `scripts/kinogo-patch-files/kinogo-site.js` — селектор `"#player, .player, .venom"` (без `video`).
2. `src/index.ts findContainer()` — страховка: если контейнер совпал с самим `<video>`,
   берём `video.parentElement` (никогда не монтируем внутрь видео).
3. `scripts/apply-kinogo-patch.mjs` — шаг 7 «синхронизация селектора»: патч-скрипт
   идемпотентный и при повторном запуске НЕ перезаписывает уже вставленный блок
   kinogo — правки селектора надо вносить отдельным шагом замены строки.

Проверено E2E (Playwright-Chromium, `api.ortified.ws/embed/movie/15447`): кнопка
`w=312×h=34, opacity=1, display:flex, inViewport=true`; auto-hide работает
(скрывается при простое мыши, возвращается при наведении).

## Что изменилось

1. `src/headers.json` — домены `kinogo.ec`/`kinogo.biz` (+`*.` и регион-поддомены)
   и `*.ortified.ws` (генерирует `content_scripts` + host-перманенты из манифеста).
2. `scripts/kinogo-patch-files/kinogo.js` — helper `kinogo`:
   - `getVideoId(url)`: на kinoGo-странице — id из `/NNN--slug.html`;
     на `api.ortified.ws` — id из `/embed/movie/NNN`;
   - `getVideoData()`: достаёт подписанный `master.m3u8` из хука/DOM плеера и отдаёт
     Яндексу через `translationHelp: [{target:"video_file_url", targetUrl}]`
     (прямая ссылка CDN interkh, БЕЗ медиа-прокси);
   - если манифест ещё не готов — возвращает заглушку `_placeholder: true`,
     не пряча кнопку (поведение как у rezka).
3. `scripts/kinogo-patch-files/kinogo-site.js` — блок `sites.js`
   (host/match: kinoGo-домены + `api.ortified.ws`; selector `#player, .player, .venom, video`).
4. `src/kinogoEarlyHook.ts` + вызов в `src/index.ts` — ранний инжект MAIN-world
   перехватчика `.m3u8` на `api.ortified.ws` (ловит манифест, который плеер
   запрашивает сам, до клика «Перевести»).
5. `scripts/apply-kinogo-patch.mjs` — идемпотентная накатка в `node_modules/@vot.js/ext`
   (enum `ExtVideoService.kinogo`, `helpers/kinogo.js`/`index`, `data/sites.js`).

## Установка / пересборка

```powershell
cd F:\Pets\Cursor\dubbed\dubbed_dev\dubbed
node scripts\apply-rezka-patch.mjs     # сначала rezka (её helper нужен для якорей)
node scripts\apply-kinogo-patch.mjs    # затем kinogo
npm run build:chrome
# chrome://extensions → обновить расширение
```
Для отладочных проб нужна сборка с логами:
`$env:DUBBED_DEBUG=1 ; npm run build:chrome` (появляется мост
`window.__dubbedDebugTranslate`; в проде его быть не должно).

## Честные ограничения (читай!)

- **HLS, а не mp4.** kinogo отдаёт HLS-манифесты (`master.m3u8` → сегменты `.ts`),
  а не единый mp4. Яндекс переваривает HLS хуже, чем mp4 (см. уроки rezka).
- **Подписанные токены.** URL содержит `t=…&ha=…&hc=…` — если токен протухнет до
  загрузки сервером Яндекса, перевод упадёт.
- **Мультизвук.** В `master.m3u8` аудио-дорожка отдельная (`index-a1`). Для перевода
  нужен ОРИГИНАЛЬНЫЙ трек; на файлах «только с дубляжом» переводить нечего
  («варианты без перевода»).
- **UX.** Кнопка появляется в iframe-плеере, а не на странице kinoGo.
- **Cloudflare.** kinoGo стоит за CF Turnstile — для пользователя один-два клика,
  не влияет на загрузку CDN interkh сервером Яндекса.
- **robots.txt** kinoGo: `User-agent: Yandex → Disallow: /` (сигнал, что сайт не
  хочет краулинга Yandex; на прямую видеозагрузку через CDN не влияет).
- Домены-«подделки» (клонны kinoGo с вирусами) в манифест **не** добавляем —
  только подтверждённые сайтом `kinogo.ec`/`kinogo.biz` (+ регион-поддомены).

## E2E

```powershell
cd F:\Pets\Cursor\dubbed\dubbed-test
node probe-kinogo.cjs        # открывает api.ortified.ws с расширением; лог kinogo.log
$env:TEST_URL='https://api.ortified.ws/embed/movie/15447' ; node probe-kinogo.cjs
```
Проверка на самой странице kinoGo (плеер-вкладка «Плеер 1»):
`$env:TEST_URL='https://lv.kinogo.ec/44853--amerikanskaja-fabrika.html' ; node probe-kinogo.cjs`

Ключевые пробы «Плеера 1» (см. `dubbed-test/TEST-BROWSER.md`):
- `node probe-player1-noplay.cjs` — кнопка должна быть ДО Play (`paused`, `readyState<=1`);
- `node probe-player1-why.cjs` — анатомия плеера (предки `<video>`, mute/loop, аудиодорожки);
- `node probe-player1-audio2.cjs` — есть ли озвучка (`new Audio()` перехватывается хуком);
- `node unit-pick-media.cjs` / `node unit-media-identity.cjs` — офлайн-проверки выбора
  манифеста и сравнения медиа-ссылок.

## ✅ ЭТАЛОН: рабочий прогон «Плеер 1» + Original (2026-09-13, ~05:00)

Подтверждён пользователем как **рабочий вариант** — использовать как точку отсчёта
при разборе жалоб «на Плеере 1 не грузится озвучка».

```
TEST_URL="https://lv.kinogo.ec/112126--shiny.html" TAB_LABEL="Плеер 1" \
  WAIT_VIDEO_MS=90000 HOLD_MS=150000 node probe-player1-why.cjs
```
(DUBBED_DEBUG=1 сборка; свежий временный профиль → переводчик по умолчанию = Original)

Что должно быть в логе (иначе это НЕ эталон, а регрессия/отказ Яндекса):

| Что | Значение |
|---|---|
| Фрейм плеера | `api.ortified.ws/embed/movie/74823` |
| `videoId` | `74823` |
| Цепочка предков `<video>` | `video` → `div.video_9Xh` → `div.player_1JR.user-active` → `div#player` → `body` |
| `selectorHits` | `#player` = **true**, `.player` = false, `.venom` = false |
| Медиа (последняя в `__dubbedKinogoPerf.urls`) | `https://hye1eaipby4w.interkh.com/06_05_25/06/05/11/VVAUOD3O/SH25VKCN.mp4/master.m3u8?fckz2=…&ha=…&hc=…&hi=…&ht=…&hu=…&hui=…&t=…` (demuxed HLS, master) |
| `duration` | `1332.083008` |
| `captureAudioTracks` | `1` (то есть видео НЕ отбрасывается как «декоративно-тихое») |
| Признаки расширения | `hookFlag: true`, `debugClient: true`, `dubEls: [DUBBED-SHADOW-HOST ×2]` |

Тайминг перевода (статусы Яндекса):

```
[ 52s] status 2, remainingTime 43  → UI «Вот-вот! Осталась буквально минутка»
[ 95s] status 2, remainingTime  5  → UI «Вот-вот!»  (retryAttempt 1)
[125s] status 1, translated true   → mp3 https://vtrans.s3-private.mds.yandex.net/tts/prod/…  (duration 1129.047075)
[127s] [scheduleTranslationRefresh] translation cache expired after resume → повтор с requestLang: auto
```

Вывод: «Плеер 1» + Original на `lv.kinogo.ec` переводится **штатно, без прокси и без
remux** — Яндекс сам скачивает demuxed-манифест interkh. Первые два ответа — `status 2`
(в работе), а не `status 0`, то есть это НЕ отказ по URL. Если у пользователя «не грузится» —
сначала проверить, что пришёл `status 2` (просто ждать), и только потом искать регрессию.

## Урок 2026-09-13 (v5): «сам нажимает Play», «долгая загрузка», «перемотка сбрасывает перевод»

Разбор четырёх жалоб пользователя (фильм `44853` → ortified `movie/15447`,
`duration 6602.9` = 1 ч 50 мин). Проба: `probe-kinogo-noplay-seek.cjs`
(`PHASE1_ONLY=1` — быстрый прогон только по автоплею).

### 1. «Нажимаю Перевести видео — ролик сам начинает играть» — ИСПРАВЛЕНО

Причина: `translationCommands.ts` для kinogo делал `await video.play()` и **оставлял
плеер играть** (без этого ortified не отдаёт master.m3u8 — см. v4).

Фикс: `nudgeKinogoPlayerForManifest()` — Play вызывается ТОЛЬКО если манифеста ещё
нет, и воспроизведение гасится при первом признаке старта:
`playing`-событие / появление HLS-ссылки в perf-коллекторе / резолв промиса
`play()`. Последнее важно: у ortified источника до Play нет, и промис резолвится
ПОЗЖЕ нашего таймаута (первая версия фикса из-за этого оставляла ролик играть).

Замер стендом: `playCount 0`, `paused: true` через 8 c после клика; «блип»
воспроизведения ≤ ~0.5 c (в поле `blipMs` пробы). Если манифест уже в коллекторе —
Play не трогается вообще.

### 2. «Долгая загрузка» — из чего складывается время

| Источник задержки | Было | Стало |
|---|---|---|
| Поллинг Яндекса при большом ETA (длинный фильм) | `LONG_WAIT_MS = 120 c` | **45 c** (`translationHandler.ts`) |
| Повторные попытки по `shouldRetry` | 10→20→40→80→120→120 c (~6.5 мин) | без изменений (это ответ сервера) |
| `detectDefaultAudioLang` заново качал master.m3u8 на КАЖДЫЙ `getVideoData()` (до 8 c, а вызовов до 5) | 8 c × N | **кэш по pathname на 60 c**, таймаут 4 c (`kinogo.js`) |
| Повторный перевод после seek (см. п. 4) | новый `translationId`, статусы заново | не запускается |
| Полная озвучка для длинного фильма | 40 попыток × 10 c (~7 мин) | масштабируется по длительности (1 попытка/мин, потолок 180 = 30 мин) |

⚠️ Отдельно: у Яндекса бывают окна деградации — ЛЮБОЙ свежий URL (включая публичный
mp4) даёт `status 2 → status 0 + shouldRetry`. Замер 13.09.2026 ~18:00: `ru→ru`,
`auto→ru`, `en→ru` на одном и том же свежем mp4 ведут себя **одинаково**
(`probe-langpair-ab.cjs`) — то есть отказ не зависит от языка, это сервер.
Не «лечить» это правкой пары языков.

### 3. «Длинный фильм, Плеер 1 + Eng.Original: либо ошибка, либо готово, а перевода нет»

Что реально уходит в Яндекс (лог прогона):

```
[Translation] translateVideoImpl start {videoId: 15447, duration: 6602.9,
  requestLang: ru, requestLangForApi: ru, responseLang: ru}
KinogoHelper: исходная аудио-дорожка "ru" (rus0)
```

`detectDefaultAudioLang()` читает `DEFAULT=YES` из master.m3u8 — у этого фильма
дефолтная дорожка **русская** (`rus0`), поэтому расширение просит Яндекс перевести
**ru → ru**. Для пользователя, который в плеере выбрал «Eng.Original», это значит:
Яндекс скачает НЕ ту дорожку, которую он слышит. Это ровно то ограничение, которое
описано в «Урок 2026-09-12: язык исходной дорожки» (нужен прокси, переписывающий
`#EXT-X-MEDIA`/`DEFAULT=YES`), и оно воспроизводится на `44853`.

#### ❌ ИСПРАВЛЕНО 13.09 (вечер): причина падения — НЕ `ru→ru`, а деградация Яндекса

Первая версия диагноза («ru→ru отвергается») **опровергнута** двумя контролями.

**Контроль 1 — состав дорожек** (`probe-kinogo-renditions.cjs`, master 44853):

```
аудио-дорожек: 4; видео-вариантов: 4
  ★DEFAULT lang=ru name=rus0 group=audio0        uri=.../JK6LCPXU.mp4/index-a1.m3u8?...
           lang=en name=eng1 group=audio0        uri=.../JK6LCPXU.mp4/index-a2.m3u8?...
  ★DEFAULT lang=ru name=rus0 group=failover-audio-0  uri=https://x-bc.interkh.com/.../index-a1.m3u8
           lang=en name=eng1 group=failover-audio-0  uri=https://x-bc.interkh.com/.../index-a2.m3u8
```

Английская дорожка ЕСТЬ и у неё свой URI (`index-a2.m3u8`) — значит вопрос «что
переводить» решаем (см. ниже), но это не причина текущего отказа.

**Контроль 2 — по чему Яндекс выбирает дорожку** (`probe-kinogo-track-choice.cjs`,
один и тот же master, distinct-URL через `_dbg=<lang>`, дедупа сессий нет —
`translationId` разные):

```
--- requestLang: en -> ru ---   #0 status=2 remainingTime=228 → #1 status=0 shouldRetry=7
--- requestLang: ru -> ru ---   #0 status=2 remainingTime=225 → #1 status=0 shouldRetry=7
```

`requestLang` **не влияет** → гипотеза «Яндекс берёт дорожку по `requestLang`»
отвергнута; объявлять язык не-дефолтной дорожки бессмысленно (Яндекс всё равно
возьмёт `DEFAULT=YES`, и ASR пойдёт по неверной модели — поэтому
`detectDefaultAudioLang` возвращает язык ИМЕННО дефолтной дорожки, это правильно).

**Контроль 3 — свежий публичный mp4** (`probe-langpair-ab.cjs`, `ForBiggerBlazes.mp4`,
15 c, киного не участвует): `status 2 → 2 → status 0 + shouldRetry 1`.

Итог: `status 2 → status 0 + shouldRetry` — **подпись окна деградации Яндекса**, а не
свойство фильма/языка/пары. В этом окне падает ЛЮБОЙ источник, включая 15-секундный
публичный mp4. `probe-yandex-session.cjs` при этом отдаёт `status 6` (AUDIO_REQUESTED,
`session/create` 200) — то есть API жив, а пайплайн обработки видео — нет.

Что из этого следует для `44853`:
- (а) **текущий** отказ = окно деградации; кода в расширении он не касается;
- (б) «очень долгая загрузка» в этом окне = наша цепочка `shouldRetry`
  (10+20+40+80+120+120 = **390 c**) поверх серверного «ждите»; в UI всё это время
  висит «Почти готово — ещё пару минут», а потом приходит ошибка. Цепочку СОЗНАТЕЛЬНО
  не трогаем: в комментарии `getShouldRetryDelayMs` зафиксировано, что на ortified
  успешная озвучка приходит только с 3–5 попытки — сокращение сломает рабочий кейс;
- (в) **латентный** дефект: выбранная в плеере дорожка ≠ дефолтная. Лечится только
  тем, что Яндексу отдают не master, а нужную дорожку. Кандидат без прокси — отдавать
  URI аудио-рендишена (`index-a2.m3u8`, audio-only HLS) с `requestLang: en`;
  **не проверено** (в окне деградации любой URL даёт `status 0`).

### 4. «Перевёл длинный фильм, сам перематываю — перевод и озвучка слетают» — ИСПРАВЛЕНО

Механика: перемотка у плеера = `pause → play`, а на `playing` после `pause` висит
`bindPlaybackRefreshOnResume` (`events.ts`) → `handlePlaybackResumedTranslationRefresh`
(`translationPlayback.ts`). Он проверял кэш: у **частичной** озвучки (status 5)
кэша нет по замыслу → «кэш протух» → **новый не-silent запрос в Яндекс**. Замер:
через 2 c после seek появился НОВЫЙ `translationId` и статусы пошли заново с нуля.
При отказе Яндекса (`status 0`) это заканчивалось `transformBtn("error", …)` —
«Ready» и озвучка пропадали. Тот же след есть и в эталонном логе:
`[127s] [scheduleTranslationRefresh] translation cache expired after resume`.

Фикс (`translationPlayback.ts`):
- флаг `partialAudioActive` (в `VideoHandler`) — пока играет частичная озвучка,
  resume-refresh не запускается вообще (полную добирает `schedulePartialTranslationUpgrade`);
- `refreshTranslationAudio()` теперь `silent: true` (в `translateVideoImpl` через
  `requestTranslationAudio`) и глотает ошибки — фон не перезаписывает UI;
- если перевод уже в полёте (`activeTranslation` / `isRefreshingTranslation`) —
  повторный запрос не отправляется (иначе Яндекс получает ВТОРУЮ сессию перевода).

Проверка стендом: три seek'а (10 c, +600 c, −300 c) — новых `translationId` нет,
в логе только `[VideoLifecycle] setCanPlay deduplicated for same source`, статус
«Почти готово — ещё пару минут» сохраняется.

## ⏸ ОТЛОЖЕНО: «Плеер 3» (sevstar) — разбор сделан, фикс не внедрён

По просьбе пользователя (13.09.2026) «Плеер 3» пока не поддерживаем, но разведка
выполнена — чтобы не начинать с нуля:

**Что это за плеер.** Вкладка `data-src` ведёт на
`https://vid1789264202.sevstar933krop.com/serial/<hash>/iframe?d=kinogo.ec&p=…`.
Хост **стабилен** между загрузками (3 прогона подряд дали один и тот же
`vid1789264202.sevstar933krop.com`; меняется только кажущийся «таймстампным» префикс
`vid<число>`, поэтому в манифест нужен `*://*.sevstar933krop.com/*` — wildcard по
поддомену, Chrome не умеет `vid*.sevstar*.com`).

**Почему кнопки нет (две независимые причины):**

1. **Content script не инжектился** — хоста не было в `src/headers.json` (`match`).
   Проверка: `probe-frames.cjs` печатал `ext: {"hook":false,"perf":0,"blocks":0}`.
   После добавления `*://*.sevstar933krop.com/*` стало `{"hook":true,"perf":4,…}`.
2. **`findContainer()` возвращал `null`** — селектор сервиса `kinogo`
   `"#player, .player, .venom"` не совпадает с контейнерами sevstar. Реальная цепочка:
   `video → hdvbplayer → hdvbplayer#oframeplayer-<hash> → div#player-<hash> → body`
   (в анатомии `probe-player1-why.cjs`: `selectorHits` → `#player` false, `.player`
   false, `.venom` false). А в `videoObserverBinding.handleVideoAdded()` есть
   `if (!match) return;` → **кнопка не создаётся вообще**. Лечение — добавить в
   `scripts/kinogo-patch-files/kinogo-site.js` селектор
   `hdvbplayer, [id^='player-']`.

**Что ещё обязательно проверить при внедрении (иначе будет хуже, чем без поддержки):**

- В том же фрейме живёт **рекламное `<video>`**: `…/content/stream/agl/fonbet_by_roll_zeus_hades.mp4`
  на `cdn-t.b5c1d2e8c9982e3b965a27ac72ru7284cc.com` / `cdn21.…` (играет, dur 15 c).
  `isAdMediaUrl()` эти хосты **не** отсекает (`AD_HOST_RE` их не знает), а расширение
  монтируется к первому видео, занявшему контейнер, — легко зацепиться за рекламу.
- Реальный поток в коллекторе выглядит «грязно»: строка начинается с
  `…/error%20code:%20521https://b-401.sevstar933krop.com/stream2/b-401/<hash>/<blob>/index.m3u8:1789269425:78.140.252.13:<sig>:by:=<…>/index.m3u8`
  (в неё вклеено сообщение об ошибке 521). `pickBestMedia` вытащит `https://…` по
  `MEDIA_RE`, но это `index.m3u8` (вариант, не master) и в подписи видно IP клиента.
- `captureAudioTracks: 0`, `readyState: 0`, `vw/vh: 0` — как у ortified до Play,
  `VideoObserver` такое принимает (источник `blob:` есть), это не блокер.

**Уже сделанные и откаченные правки** (не входят в текущую сборку):
`src/headers.json` (`*://*.sevstar933krop.com/*`), `kinogo-site.js`
(`selector: "…, hdvbplayer, [id^='player-']"`). Разведка: `recon-kinogo-hosts.cjs`,
`probe-frames.cjs TAB_LABEL="Плеер 3"`.

Побочно осталась **полезная правка пайплайна** (в сборке): шаг 7
`apply-kinogo-patch.mjs` теперь принудительно синхронизирует `selector:` из
`kinogo-site.js` в `sites.js`. Раньше он правил только легаси-строку, поэтому на
повторных прогонах изменения селектора в сборку не попадали.
---

## v6 (13.09.2026, вечер): Play не сбрасывает перевод; отказ Яндекса по interkh — НЕ наш ресет

**1. «Нажал Play — кнопка перезапустилась» (исправлено).** Общий фикс
`preserveTranslation` в `src/core/videoLifecycleController.ts`: если перевод уже есть
(в полёте / готовый / частичный) и `videoId` не изменился — «мигнувший» `video.src`
больше НЕ вызывает `resetAndHideLifecycle()`. Проверено на `44853` (Плеер 1):
`ресетов кнопки в idle после старта: 0`, `translationId` один.

**2. «1 ч 50 мин, статусы с минутами, потом ошибка» (воспроизведено).**
`probe-e2e-play-preserve.cjs` на `44853` / «Плеер 1» / **Eng.Original**:
```
[26s] ← Яндекс: status=2 id=467188147 rt=616
[103s] ← Яндекс: status=0  (shouldRetry: 1, serverMessage: «Возникла ошибка при переводе…»)
[146s] status=0   [226s] status=0
[462s] кнопка="Возникла ошибка при переводе, попробуйте позже"
медиа: https://hye1eaipby4w.interkh.com/04_27_21/…/JK6LCPXU.mp4/master.m3u8?fckz2=…&ha=…&hc=…&hi=…
```
То есть Яндекс САМ отказывает по этому потоку: уходит в `status 2`, а через ~30–200 c
отдаёт `status 0` + `shouldRetry`. Все 6 повторов с ТОЙ ЖЕ ссылкой падают одинаково.
В том же окне rezka 88931 закончился успешно (`status 1`) → это НЕ глобальное «окно
деградации» и НЕ наш сброс, а отказ по конкретной ссылке.

Что добавлено:
- **повтор со свежей ссылкой** — в ветке `shouldRetry` спрашиваем у хелпера
  `getVideoData()` заново (`VideoHandler.refreshVideoDataForRetry()`, только хосты
  `kinogo`/`rezka`). ⚠️ На практике внутри одной сессии страницы master.m3u8 НЕ
  меняется (`translationId` остаётся тем же) — фикс срабатывает только когда хелпер
  реально отдаёт новую ссылку. В соседнем прогоне (то есть после перезагрузки
  страницы) тот же плеер проходит штатно — значит лечится перезагрузкой/сменой плеера,
  а не ретраями.
- **поллинг ETA ускорен**: `clamp(eta/4, 10 c, 45 c)` вместо «спать ровно eta».

**3. Стенд: выбор ОРИГИНАЛА.** У «Плеера 1» (ortified) дропдаун озвучки —
CSS-modules внутри iframe: `div[class*=dropdown_]` → `[class*=headText_]` + опции
`div[class*=menu_] > div[class*=item_]` (по умолчанию `WestFilm`, нужен `Eng.Original`).
У cinemar («Смотреть онлайн») — PlayerJS-playlist: `.playlist-title` +
`.playlist-dropdown button` (по умолчанию `Дубляж (Dubляж)`, нужен `English (Original)`).
Реализовано в `dubbed-test/lib/stand.cjs` (`selectOriginalVoiceover`).
Проверка: `node probe-voiceover-check.cjs`.

---

## v7 (14.09.2026): «Плеер 1» — серия, дорожка, озвучка после Play

Три независимых дефекта, все воспроизведены и закрыты. Подтверждено пользователем в
живом браузере (сериал + нужная серия переводятся).

### 1. «Переводит не ту серию / дорожка не соответствует» — ИСПРАВЛЕНО

`getVideoId()` возвращал `/embed/movie/(\d+)` — **константу для всех серий** (74823).
Из-за этого:
- ни `emptied`-гард, ни `MediaUrlWatcher` не видели смены серии;
- ключ кэша перевода (`videoId` + языки + `translationHelp.targetUrl`) не менялся →
  `restoreTranslationFromCache()` после каждого `canplay` возвращал озвучку ПЕРВОЙ серии.

Отдельно: коллектор `mediaFromPage()` сканирует HTML документа, а там **все 30** `master.m3u8`
сериала; `pickBestMedia` берёт ПОСЛЕДНИЙ. Замер: коллектор отдавал файл на **1617.17 c**
(это s2e12) при играющей s1e1 (**1332.08 c**) — то есть Яндекс переводил другую серию.

**Фикс.** Приоритет №0 в `collectMedia()` — разметка СВОЕГО embed-документа
(`makePlayer({playlist:{…}})`). Если плейлист есть, а текущая серия не опознана — ссылку
НЕ отдаём (коллекторы гарантированно содержат чужую серию). `videoId` = `74823/s<сезон>e<серия>`.

Проверка (`probe-kinogo-episode-url.cjs`, сумма `#EXTINF` против `video.duration`):
s1e1 → 1332.09 vs 1332.08; s1e4 → 1121.79 vs 1121.79; s1e5 → 1289.37 vs 1289.37.
Юнит `unit-ortified-playlist.cjs` — 19/19.

⚠️ `MediaUrlWatcher` на ortified **не тикает** (плеер пересоздаёт `<video>` → teardown),
поэтому фикс работает через `canplay`/`setCanPlay` с меняющимся `videoId`.

### 2. «Статус Готово, а после Play озвучки нет» — ИСПРАВЛЕНО

`applyTranslationSource()` вызывал `player.lipSync("play")`. В chaimu `lipSync(mode)` — это
`switch` по ИМЕНАМ СОБЫТИЙ видео:

```js
case "playing": … syncPlay()   // AudioPlayer
case "seeked":  …
case "pause": case "waiting": case "ended": … pause()
default: return this;          // ← сюда попадал "play"
```

Режима `"play"` там НЕТ → синхронизировался только `currentTime`, озвучка не стартовала.
Сценарий: Яндекс отдаёт частичную озвучку (`status 5`, играем сразу), пользователь жмёт Play,
приходит ПОЛНАЯ версия → `updateTranslation` создаёт НОВЫЙ `<audio>` (по умолчанию `paused`),
`lipSync("play")` его не запускает, видео уже играет → повторного `playing` нет → тишина.

**Фикс:** `lipSync("playing")`. Ровно тот инвариант, который обещан в комментарии
`schedulePartialTranslationUpgrade` («звук продолжается с того же места»).

### 3. «Переводит не то»: выбранная дорожка ≠ `DEFAULT=YES` — ИСПРАВЛЕНО

**Корень.** `requestLang` берётся НЕ из настройки «Авто → Русский», а из
`videoData.detectedLanguage` (`translationCommands.ts`):
```js
await videoHandler.translateFunc(videoData.videoId, videoData.isStream,
  videoData.detectedLanguage,     // ← requestLang
  videoData.responseLanguage, …); // ← responseLang
```
а `detectedLanguage` — это `KinogoHelper.detectDefaultAudioLang()` = язык дорожки
`DEFAULT=YES` в master.m3u8. У interkh `DEFAULT=YES` стоит на **русском дубляже**:

```
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio0",NAME="rus0",DEFAULT=YES,LANGUAGE="ru",URI="…/index-a1.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio0",NAME="eng1",DEFAULT=NO, LANGUAGE="en",URI="…/index-a2.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="failover-audio-0",…   (те же дорожки с x-bc.interkh.com)
```
(одинаково для сериала 74823 и фильма 15447)

Итог: пользователь, выбравший в плеере «Original», слышит английский звук, а расширение
просит Яндекс `ru → ru` — то есть переводит русский дубляж. Это и есть жалоба
«переводит не то / звуковая дорожка не соответствует».

**Как определяется выбранная дорожка.** Третий дропдаун плеера — CSS-modules
(`div[class*=dropdown_]` → `[class*=headText_]` + `div[class*=menu_] > div[class*=item_]`),
его пункты совпадают с `audio.names` из embed-плейлиста и идут в том же порядке, что
`#EXT-X-MEDIA` в master (сверено: `names[0]` «Рус. Люб. одноголосый» ↔ rus0, `names[1]`
«Original» ↔ eng1). Плеер аудио-рендишен **не запрашивает** (переключение дорожки идёт через
DASH), поэтому дорожку читаем из UI — `probe-kinogo-track-net.cjs` это подтвердил.

**Фикс (без прокси).** `pickSelectedAudioRendition()`: если выбранная дорожка НЕ дефолтная —
Яндексу уходит URI её аудио-рендишена (`index-a2.m3u8`, audio-only HLS) и объявляется ЕГО язык.
Дефолтная дорожка / одна дорожка / дропдаун не прочитан → `undefined` (поведение прежнее).

Живой прогон:
```
KinogoHelper: дорожка "Original" (eng1, en) — Яндексу уходит аудио-рендишен, не master
KinogoHelper: передаю Яндексу m3u8 (…/SJQI6IZP.mp4/index-a2.m3u8?…)
[Translation] translateVideoImpl start {videoId: 74823/s1e1, requestLang: en, requestLangForApi: en, responseLang: ru}
```

**Яндекс принимает audio-only плейлист** (проверено через debug-мост,
`probe-kinogo-track-choice.cjs TEST_RENDITION=1`): своя сессия (`translationId` 467297393 ≠
467297365 у master), `status 2` («в работе»). Сквозной перевод в тот момент не снимался —
шло **окно деградации** (`status 2 → status 0 + shouldRetry` на любом источнике, включая
свежий публичный mp4; контроль `probe-langpair-ab.cjs`).

Юнит `unit-kinogo-track.cjs` — 15/15 (включая «русский дубляж → undefined», «одна дорожка →
undefined», «нет `#EXT-X-MEDIA` → undefined», «манифест не скачался → undefined»).
`unit-pick-media` / `unit-media-identity` / `unit-ortified-playlist` — по-прежнему зелёные.

### 4. Замеры, опровергшие прошлые гипотезы

- `master.m3u8` фильма 44853 **корректен**: сумма `#EXTINF` = 6602.96 c при
  `video.duration` 6602.92 (657 сегментов) → `status 0` это не «битая ссылка», а деградация.
- `probe-kinogo-perf-churn.cjs` на 44853: путь коллектора стабилен (1 уникальный путь за 80 c,
  0 маркеров `media source changed`) → «churn коллектора» для фильма отвергнут.
- Ретри-бюджет 12 мин / 180 попыток — by design; `retryAttempt: 51` в логе = норма.

### 5. Пробы: обязательное предусловие — Original

⚠️ Ad-hoc пробы (`probe-player1-audio2.cjs`, `probe-kinogo-play-after-ready.cjs`) **не выбирали
оригинальную дорожку** и тестировали `ru→ru`, что ничего не доказывает. Для «Плеера 1» теперь
есть `probe-kinogo-play-then-translate.cjs` — золотая последовательность (вкладка →
`S.selectOriginalVoiceover` → Play ДО перевода → клик → ловля подмены источника и проверка,
что новый `<audio>` играет). См. `dubbed-test/TEST-BROWSER.md` §«ЗОЛОТЫЕ ПРАВИЛА».

## v8 (14.09.2026): «Плеер 1», длинный фильм — перевод сбрасывался сразу после старта

Жалоба: *«выбираешь озвучку, нажимаешь play → перевести видео → начинается перевод
(„Дождитесь окончания загрузки“) — и сразу сбрасывается и снова „Перевести видео“»*.
Фильм 44853, `https://lv.kinogo.ec/44853--amerikanskaja-fabrika.html`, Плеер 1.

### Причина: `peekMediaUrl()` и `translationHelp` разошлись

Наблюдатель смены медиа (`src/core/mediaUrlWatcher.ts`, тик 2 c, 2 подтверждения) сравнивает
`mediaIdentity(translationHelp.targetUrl)` с `mediaIdentity(peekMediaUrl())`. После v7 (фикс
дорожки) `targetUrl` — это **аудио-рендишен** (`…/JK6LCPXU.mp4/index-a2.m3u8`), а
`peekMediaUrl()` продолжал отдавать **master** (`…/JK6LCPXU.mp4/master.m3u8`). Пути разные →
каждые 2 c «media source changed» → `resetAndHideLifecycle()` → перевод в полёте отменялся,
кнопка возвращалась в «Перевести видео». В логе счётчик сессий доходил до 44.

У сериала дефект не проявлялся: там раньше срабатывает сигнал №1 `peekEpisodeKey()` и до
сравнения URL дело не доходит. У фильма `currentEpisode()` пуст → сигнал №1 молчит → сигнал №2.

### Фикс

- `pickRenditionFromManifest(manifest, dropdown)` вынесен из метода — нужен и с холодным кэшем.
- `rememberTargetUrl(media, targetUrl)` / `rememberedTargetUrl(media)`: запись
  `{masterPath: urlPath(media), url: targetUrl}` в `globalThis.__dubbedKinogoAudioRendition`
  (тот же приём, что `__dubbedKinogoOrtifiedPlaylist` — жизнь документа).
- `getVideoData()` в конце HLS-ветки вызывает `this.rememberTargetUrl(media, targetUrl)` —
  запоминается **итоговый** URL (после `resolveTargetUrl`, то есть с учётом media-proxy).
- `peekMediaUrl()` возвращает `this.rememberedTargetUrl(media)`: если запись относится к
  текущему master'у — отдаёт ровно то, что ушло Яндексу; иначе (сменилась серия/файл) — master,
  как раньше. Совпадение по `masterPath` (pathname без query/хоста) — переподпись ссылки и
  уход на failover-хост запись не ломают.

### Проверка (золотая последовательность, `probe-kinogo-play-then-translate.cjs`)

```
[16s] вкладка: Плеер 1 ; [18s] оригинальная дорожка: "Eng.Original"
[33s] KinogoHelper: дорожка "Eng.Original" (eng1, en) — Яндексу уходит аудио-рендишен, не master
[36s] кнопка: "Дождитесь окончания загрузки..."     ← и БОЛЬШЕ НИ РАЗУ не вернулась
```
За весь прогон (5 мин) в логе **ноль** строк `[mediaWatcher] media url differs` и ноль
`[VideoLifecycle] media source changed` — цикл re-resolve устранён. Ретри-цикл при этом живёт
штатно (`retryAttempt` 1…23, каждый повтор со свежей подписью ссылки).

Юнит `unit-kinogo-track.cjs` расширен блоком `rememberTargetUrl / rememberedTargetUrl` — 21/21
(в т.ч. «переподпись query не сбивает запись», «другая серия → запись не применяется»).

### Что осталось — НЕ наш баг: окно деградации Яндекса

В том же прогоне Яндекс даёт `status 2` (в работе) → через ~12 c `status 0 + shouldRetry: 7`,
и так по кругу. Контроль (`probe-langpair-ab.cjs`, свежий публичный
`ForBiggerBlazes.mp4`, три пары подряд):

```
ru -> ru    [29s] status 2 (remainingTime 28) → [40s] status 2 (18) → [50s] status 0 + shouldRetry
auto -> ru  [50s] status 2 (28)               → [61s] status 2 (18) → [71s] status 0 + shouldRetry
en -> ru    [71s] status 2 (28)               → [81s] status 2 (18) → [92s] status 0 + shouldRetry
```

То есть **любой** источник и **любая** пара языков сейчас обрываются одинаково → это деградация
на стороне Яндекса, а не аудио-рендишен и не kinogo. Сквозную проверку «перевод доиграл»
сегодня получить нельзя; кнопка при этом корректно ждёт и ретраит (бюджет 12 мин), а не
сбрасывается.
