import { contentUrl } from "../config/config";
import type { FlatPhrases, LangOverride, Phrase } from "../types/localization";
import type { LocaleStorageKey } from "../types/storage";
import debug from "../utils/debug";
import { GM_fetch } from "../utils/gm";
import { lang } from "../utils/localization";
import { dubbedStorage } from "../utils/storage";
import { getTimestamp, toFlatObj } from "../utils/utils";
import rawDefaultLocale from "./locales/en.json";
import rawRuLocale from "./locales/ru.json";

export type { LangOverride } from "../types/localization";

const LOCALE_STORAGE_KEYS: readonly LocaleStorageKey[] = [
  "localePhrases",
  "localeLang",
  "localeHash",
  "localeVersion",
  "localeUpdatedAt",
  "localeLangOverride",
];
const DEFAULT_LOCALE: FlatPhrases = toFlatObj(rawDefaultLocale);

const repoBranch =
  typeof REPO_BRANCH !== "undefined" && REPO_BRANCH ? REPO_BRANCH : "master";
const availableLocales: readonly LangOverride[] = ["ru", "en"];

export function resolveRuntimeLocaleVersion(
  buildVersion: string,
  scriptVersion: string,
) {
  return buildVersion || scriptVersion || "unknown";
}

function getRuntimeLocaleVersion() {
  const buildVersion =
    typeof Dubbed_VERSION === "undefined" ? "" : String(Dubbed_VERSION || "");
  const scriptVersion =
    typeof GM_info === "undefined"
      ? ""
      : String(GM_info?.script?.version || "");

  return resolveRuntimeLocaleVersion(buildVersion, scriptVersion);
}

class LocalizationProvider {
  /**
   * Language used before page was reloaded
   */
  lang: string;
  /**
   * Locale phrases with current language
   */
  locale: Partial<FlatPhrases>;
  readonly defaultLocale: FlatPhrases = DEFAULT_LOCALE;
  readonly localesUrl = `${contentUrl}/${repoBranch}/src/localization/locales`;
  readonly hashesUrl =
    `${contentUrl}/${repoBranch}/src/localization/hashes.json`;

  private readonly warnedMissingKeys = new Set<string>();
  private _langOverride: LangOverride = "ru";

  constructor() {
    this.lang = this.getLang();
    this.locale = {};
  }

  async init() {
    const [langOverride, phrases] = await Promise.all([
      dubbedStorage.get<LangOverride>("localeLangOverride", "ru"),
      dubbedStorage.get<string>("localePhrases", ""),
    ]);
    this._langOverride = langOverride === 'auto' ? 'ru' : langOverride;
    this.lang = this.getLang();
    this.setLocaleFromJsonString(phrases);
    // Если сохранённых фраз нет — сразу берём вшитый словарь выбранного языка.
    // Так бывает, когда интерфейс рисуется внутри iframe-плеера (kinogo →
    // cinemar/ortified), а верхний фрейм рантайм не активирует: на самой
    // странице нет <video>, поэтому update() не вызывается нигде и все строки
    // остаются на английском фолбэке (кнопка «Translate video» при русских
    // настройках и хардкодном «Подготавливаем видео к переводу...»).
    if (!phrases) {
      this.applyBundledLocale();
    }
    return this;
  }

  /**
   * Применяет вшитый словарь для текущего языка (self-contained сборка, без
   * внешнего CDN). `en` — это и есть встроенный фолбэк: для него достаточно
   * очистить словарь, `get()` подставит defaultLocale.
   */
  private applyBundledLocale(): void {
    if (this.lang.startsWith("ru")) {
      this.setLocaleFromJsonString(JSON.stringify(rawRuLocale));
    } else {
      this.setLocaleFromJsonString("");
    }
  }

  get langOverride() {
    return this._langOverride;
  }

  getLang(): string {
    return this.langOverride === "auto" ? lang : this.langOverride;
  }

  getAvailableLangs(): LangOverride[] {
    return [...availableLocales];
  }

  async reset() {
    await Promise.all(LOCALE_STORAGE_KEYS.map((key) => dubbedStorage.delete(key)));
    return this;
  }

  private buildUrl(baseUrl: string, path = "", force = false) {
    const query = force ? `?timestamp=${getTimestamp()}` : "";
    return `${baseUrl}${path}${query}`;
  }

  async changeLang(newLang: LangOverride) {
    const oldLang = this.langOverride;
    if (oldLang === newLang) {
      return false;
    }

    await dubbedStorage.set("localeLangOverride", newLang);
    this._langOverride = newLang;
    this.lang = this.getLang();
    await this.update(true);
    return true;
  }

  async checkUpdates(force = false): Promise<false | null | string> {
    if (!contentUrl) {
      // Self-contained build: bundled locales only, no remote phrase CDN.
      return null;
    }
    debug.log("Check locale updates...");
    try {
      const runtimeLocaleVersion = getRuntimeLocaleVersion();
      if (!force) {
        const storedLocaleVersion = await dubbedStorage.get<string>(
          "localeVersion",
          "",
        );
        // Locale files are versioned with the extension build. If the runtime
        // version has not changed, the cached locale hash is still valid.
        if (
          runtimeLocaleVersion !== "unknown" &&
          storedLocaleVersion === runtimeLocaleVersion
        ) {
          return false;
        }
      }

      const res = await GM_fetch(this.buildUrl(this.hashesUrl, "", force));
      if (!res.ok) throw res.status;

      const hashes = await res.json();
      if (!hashes || typeof hashes !== "object") {
        throw new Error("Invalid locale hashes payload");
      }

      const nextHash = (hashes as Record<string, unknown>)[this.lang];
      if (typeof nextHash !== "string" || !nextHash) {
        return false;
      }

      const currentHash = await dubbedStorage.get<string>("localeHash", "");
      return currentHash === nextHash ? false : nextHash;
    } catch (err) {
      console.error(
        "[Dubbed] [localizationProvider] Failed to get locales hash:",
        err,
      );
      return null;
    }
  }

  async update(force = false) {
    if (!contentUrl) {
      // Self-contained build: no remote locale CDN — serve the bundled locale.
      this.applyBundledLocale();
      if (this.lang.startsWith('ru')) {
        await dubbedStorage.set('localePhrases', JSON.stringify(rawRuLocale));
      }
      return this;
    }

    const runtimeLocaleVersion = getRuntimeLocaleVersion();
    const storedLocaleVersion = await dubbedStorage.get<string>(
      "localeVersion",
      "",
    );

    const hash = await this.checkUpdates(force);
    if (hash === null) {
      // Do not update localeUpdatedAt on transient failures.
      // This allows a near-term retry instead of waiting for cache TTL.
      return this;
    }

    if (!hash) {
      if (storedLocaleVersion !== runtimeLocaleVersion) {
        await dubbedStorage.set("localeVersion", runtimeLocaleVersion);
      }
      return this;
    }

    const timestamp = getTimestamp();
    debug.log("Updating locale...");
    try {
      const res = await GM_fetch(
        this.buildUrl(this.localesUrl, `/${this.lang}.json`, force),
      );
      if (!res.ok) throw res.status;

      // Use `.text()` to keep a single storage format for GM_Storage/localStorage.
      const text = await res.text();
      this.setLocaleFromJsonString(text);
      await Promise.all([
        dubbedStorage.set("localePhrases", text),
        dubbedStorage.set("localeHash", hash),
        dubbedStorage.set("localeLang", this.lang),
        dubbedStorage.set("localeVersion", runtimeLocaleVersion),
        dubbedStorage.set("localeUpdatedAt", timestamp),
      ]);
    } catch (err) {
      console.error("[Dubbed] [localizationProvider] Failed to get locale:", err);
      this.setLocaleFromJsonString(await dubbedStorage.get("localePhrases", ""));
    }

    return this;
  }

  setLocaleFromJsonString(json: string) {
    const trimmed = json.trim();
    if (!trimmed) {
      this.locale = {};
      this.warnedMissingKeys.clear();
      return this;
    }

    try {
      const locale = JSON.parse(trimmed);
      if (!locale || typeof locale !== "object" || Array.isArray(locale)) {
        throw new Error("Locale payload should be a JSON object");
      }

      this.locale = toFlatObj(locale as Record<string, unknown>);
    } catch (err) {
      console.error("[Dubbed] [localizationProvider]", err);
      this.locale = {};
    }

    this.warnedMissingKeys.clear();
    return this;
  }

  private getFromLocale(
    locale: Partial<FlatPhrases>,
    key: Phrase,
    source: "default" | "locale" = "locale",
  ) {
    const phrase = locale[key];
    return phrase ?? this.warnMissingKey(locale, key, source);
  }

  private warnMissingKey(
    locale: Partial<FlatPhrases>,
    key: Phrase,
    source: "default" | "locale",
  ) {
    const warningKey = `${source}:${key}`;
    if (this.warnedMissingKeys.has(warningKey)) {
      return undefined;
    }

    this.warnedMissingKeys.add(warningKey);
    console.warn(
      "[Dubbed] [localizationProvider] locale",
      locale,
      "doesn't contain key",
      key,
    );
    return undefined;
  }

  getDefault(key: Phrase) {
    return this.getFromLocale(this.defaultLocale, key, "default") ?? key;
  }

  get(key: Phrase) {
    return this.getFromLocale(this.locale, key) ?? this.getDefault(key);
  }

  getLangLabel(lang: string) {
    const key = `langs.${lang}` as Phrase;
    if (key in this.defaultLocale) {
      const label = this.get(key);
      if (label) {
        return label;
      }
    }
    return lang.toUpperCase();
  }
}

export const localizationProvider = new LocalizationProvider();
/**
 * In the userscript build, SystemJS wrapping allowed a top-level await.
 * For the extension build we bootstrap through loader scripts and keep the
 * runtime initialization explicit, so avoid top-level await and expose a lazy
 * ready Promise instead.
 */
let localizationProviderReadyPromise: Promise<LocalizationProvider> | null =
  null;

export function ensureLocalizationProviderReady(): Promise<LocalizationProvider> {
  localizationProviderReadyPromise ??= localizationProvider.init();
  return localizationProviderReadyPromise;
}
