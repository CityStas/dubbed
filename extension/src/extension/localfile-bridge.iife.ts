/**
 * [localfile] Мост расширения для `file://`-страниц — standalone IIFE.
 *
 * Зачем отдельная точка входа. На обычных сайтах мост поднимает CRXJS-лоадер
 * (`assets/bridge.ts-<hash>.js`), который внутри делает
 * `import(chrome.runtime.getURL(...))`. На `file://`-документе это НЕ работает:
 * ISOLATED-мир получает opaque origin, и динамический импорт ресурса
 * расширения падает —
 *
 *   TypeError: Failed to fetch dynamically imported module:
 *     chrome-extension://<id>/assets/bridge.ts-<hash>.js
 *   (в сети — net::ERR_ABORTED)
 *
 * → мост не поднимается → GM-запросы прелюда уходят в 15-секундный таймаут →
 * рантайм не активируется → кнопки «Перевести видео» на локальном видео нет.
 *
 * При этом CLASSIC-скрипт из того же origin грузится на `file://` без проблем
 * (проверено стендом: `<script src="chrome-extension://<id>/localfile-reader.js">`
 * → LOADED). Поэтому мост для `file://` собирается как IIFE: CRXJS эмитит
 * файлы `*.iife.ts` отдельным бандлом с инлайном импортов и БЕЗ loader-обёртки
 * (тем же механизмом собирается `prelude.iife.ts`), а манифест объявляет
 * `src/extension/localfile-bridge.iife.js` вместо `bridge.js` только для
 * `file:///*` — см. `vite/lib/extension/manifest-helpers.ts`.
 *
 * Остальные сайты продолжают использовать обычный лоадер: правка адресная.
 */
import { bootstrapExtensionBridge } from "./bridge/index";

bootstrapExtensionBridge();
