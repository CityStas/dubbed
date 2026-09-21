import debug from "../../utils/debug";
import type { AnyObject } from "../shared/constants";
import { installPageGmPolyfills, request } from "./gm-polyfills";
import { wireMessageHandlers } from "./message-handlers";

const PRELUDE_BOOT_KEY = "__Dubbed_EXT_PRELUDE_BOOTED__";

/**
 * Returns true when the content script is running inside an
 * about:blank / about:srcdoc iframe injected via match_about_blank.
 *
 * In those contexts the async handshake should not fire because
 * the iframe is not a runnable page — it exists only as a transient
 * container.  Keeping the synchronous polyfill install is fine (the
 * content script may still need GM globals), but the background
 * handshake would produce a duplicate UUID and pollute the message
 * channel.
 */
function shouldSkipFrame(): boolean {
  try {
    const href = globalThis.location?.href;
    if (href === "about:blank" || href?.startsWith("about:srcdoc")) {
      return true;
    }
    const isIframe = globalThis.self !== globalThis.top;
    if (isIframe && globalThis.location?.origin === "null") {
      return true;
    }
  } catch {
    // cross-origin access to .top may throw — treat as top frame
  }
  return false;
}

/**
 * Installs GM polyfills and message handlers **synchronously**.
 *
 * In CRXJS builds the prelude is an IIFE emitted as a standalone bundle
 * (prelude.iife.ts). Chrome runs it synchronously at document_start, so
 * GM_* / GM.* globals are on globalThis before any MAIN-world content
 * script evaluates.
 *
 * In Firefox builds the bridge injects prelude.module.js as a
 * <script type="module"> before content.module.js, giving the same
 * ordering guarantee.
 */
export function installPreludeSynchronous(): void {
  const preludeGlobal = globalThis as Record<string, unknown>;
  if (preludeGlobal[PRELUDE_BOOT_KEY]) {
    debug.log("[Dubbed EXT][prelude] already initialized");
    return;
  }

  preludeGlobal[PRELUDE_BOOT_KEY] = true;

  installPageGmPolyfills();
  wireMessageHandlers();
}

/**
 * Best-effort async handshake to populate GM_info with real manifest
 * metadata. Called fire-and-forget after synchronous init.
 */
async function performHandshake(): Promise<void> {
  try {
    const { manifest } = await request<{ manifest: AnyObject }>("handshake");
    const gmInfo = (globalThis as any).GM_info as AnyObject;
    if (manifest?.name) gmInfo.script.name = manifest.name;
    if (manifest?.version) {
      gmInfo.script.version = manifest.version;
      gmInfo.version = manifest.version;
    }
  } catch {
    // ignore — non-fatal
  }
}

/**
 * Main entry-point called at module top-level.
 *
 * Polyfill installation is **synchronous** so that GM globals are
 * available before the content script module starts evaluating.
 * The handshake is fire-and-forget async.
 */
export function bootstrapExtensionPrelude(): void {
  installPreludeSynchronous();

  // [rezka-patch] Ставим hook на перехват get_cdn_series с самого начала (document_start),
  // пока плеер rezka ещё не успел запросить ссылки. Плеер получает URL CDN и играет
  // через blob MediaSource; перехватив его ответ, мы получаем прямые mp4/m3u8-ссылки.
  installRezkaCdnHook();

  // Skip the async handshake in about:blank / about:srcdoc iframes.
  // The polyfills are still installed synchronously above so the
  // content script can use GM globals if it needs them, but the
  // handshake would just produce a duplicate UUID in a transient frame.
  if (shouldSkipFrame()) {
    debug.log("[Dubbed EXT][prelude] skipping handshake in transient frame");
    return;
  }

  void performHandshake();
}

/**
 * [rezka-patch] Ставит перехват ответов плеера rezka на /ajax/get_cdn_series/
 * в MAIN world (через inline <script>), НА document_start — до того, как
 * плеер сделает свой первый запрос ссылок.
 *
 * КРИТИЧНО: патчить window.fetch напрямую из content script БЕСПОЛЕЗНО —
 * content script живёт в isolated world, у него свой window.fetch, а плеер
 * rezka работает в MAIN world. Инжект <script> выполняется в MAIN world
 * и перехватывает РЕАЛЬНЫЕ запросы плеера.
 * Условно: только на rezka-доменах.
 */
function installRezkaCdnHook(): void {
  const REZKA_HOST_RE = /(^|\.)(rezka|hdrezka|standby-rezka)\./i;
  const DATA_KEY = "dubbedRezkaCdn";
  const FLAG = "__dubbedRezkaMainHookInjected";
  try {
    const host = globalThis.location?.hostname || "";
    if (!REZKA_HOST_RE.test(host)) return;
    const g = globalThis as Record<string, unknown>;
    if (g[FLAG]) return;
    g[FLAG] = true;
    const script = document.createElement("script");
    script.textContent = `(function(){
      var K='${DATA_KEY}';
      var save=function(t){try{var j=JSON.parse(t);if(j&&(j.links||j.url)){document.documentElement.dataset[K]=JSON.stringify({ts:Date.now(),j});}}catch(e){}};
      var of=window.fetch;
      window.fetch=function(){
        var u=typeof arguments[0]==='string'?arguments[0]:((arguments[0]&&arguments[0].url)||'');
        var p=of.apply(this,arguments);
        if(u.indexOf('get_cdn_series')>=0){try{p.then(function(r){return r.clone().text();}).then(save).catch(function(){});}catch(e){}}
        return p;
      };
      var oo=XMLHttpRequest.prototype.open,os=XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open=function(m,u){this.__dubbedU=u;return oo.apply(this,arguments);};
      XMLHttpRequest.prototype.send=function(){var self=this;this.addEventListener('load',function(){try{if(String(self.__dubbedU||'').indexOf('get_cdn_series')>=0)save(self.responseText);}catch(e){}});return os.apply(this,arguments);};
    })();`;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  } catch { /* non-fatal */ }
}

// Auto-init in non-CRXJS builds (Firefox extension).
// CRXJS (Chrome) uses prelude.iife.ts which calls bootstrapExtensionPrelude()
// directly as a synchronous IIFE — no loader, no race condition.
if (import.meta.env.VITE_CRXJS_BUILD !== "true") {
  bootstrapExtensionPrelude();
}
