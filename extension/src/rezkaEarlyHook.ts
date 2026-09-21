/**
 * [rezka-patch] Ранний инжект MAIN-world перехватчика ответов
 * /ajax/get_cdn_series/ на страницах rezka.
 *
 * Плеер rezka запрашивает ссылки сразу после нажатия Play — если hook
 * инжектится позже (в момент getVideoData), ответ уже потерян, а fallback
 * ajax-запрос rezka отбивает антифродом ("Время сессии истекло").
 * Инжект выполняется при бутстрапе контент-скрипта, до любых действий плеера.
 */

const DATA_KEY = "dubbedRezkaCdn";
const HOOK_FLAG = "__dubbedRezkaEarlyHook";

export function injectRezkaCdnHook(): void {
    const w = globalThis as unknown as Record<string, unknown>;
    if (w[HOOK_FLAG]) {
        return;
    }
    w[HOOK_FLAG] = true;
    try {
        const script = document.createElement("script");
        script.textContent = `(()=>{const K='${DATA_KEY}';const save=(t,req)=>{try{const j=JSON.parse(t);if(j&&(j.links||j.url)){document.documentElement.dataset[K]=JSON.stringify({ts:Date.now(),req:req||null,j});}}catch(e){}};const bodyOf=(b)=>{try{if(typeof b==='string')return b;if(b&&typeof b.toString==='function')return String(b);}catch(e){}return '';};const of=window.fetch;window.fetch=function(...a){const u=typeof a[0]==='string'?a[0]:((a[0]&&a[0].url)||'');const req=bodyOf(a[1]&&a[1].body);const p=of.apply(this,a);if(u.includes('get_cdn_series')){try{p.then(r=>r.clone().text()).then(s=>save(s,req)).catch(()=>{});}catch(e){}}return p;};const oo=XMLHttpRequest.prototype.open,os=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.open=function(m,u,...r){this.__dubbedU=u;return oo.call(this,m,u,...r);};XMLHttpRequest.prototype.send=function(...r){try{this.__dubbedB=bodyOf(r[0]);}catch(e){}this.addEventListener('load',()=>{try{if(String(this.__dubbedU||'').includes('get_cdn_series'))save(this.responseText,this.__dubbedB);}catch(e){}});return os.apply(this,r);};})();`;
        (document.head || document.documentElement).appendChild(script);
        script.remove();
    } catch {
        // ignore: hook уже мог быть инжектирован helper'ом
    }
}
