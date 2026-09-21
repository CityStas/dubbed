import {
  actualCompatVersion,
  defaultAutoHideDelay,
  defaultAutoVolume,
  defaultDetectService,
  defaultTranslationService,
  m3u8ProxyHost,
  proxyOnlyCountries,
  proxyWorkerHost,
} from "../../config/config";
import debug from "../../utils/debug";
import { GM_fetch, isProxyOnlyExtension, isSupportGMXhr } from "../../utils/gm";
import { updateConfig, dubbedStorage } from "../../utils/storage";
import { calculatedResLang } from "../../utils/utils";
import type { VideoHandler } from "../../VideoHandler";
import { getCountryCode, setCountryCode } from "../shared";

let countryCodeRequestInFlight: Promise<void> | null = null;

async function ensureCountryCode(): Promise<void> {
  if (getCountryCode()) {
    return;
  }

  countryCodeRequestInFlight ??= (async () => {
    try {
      const response = await GM_fetch(
        "https://cloudflare-dns.com/cdn-cgi/trace",
        {
          timeout: 7000,
        },
      );
      const trace = await response.text();
      const loc = trace.split("\n").find((line) => line.startsWith("loc="));
      setCountryCode(loc?.slice(4, 6).toUpperCase());
    } catch (err) {
      console.error("[Dubbed] Error getting country:", err);
    }
  })().finally(() => {
    countryCodeRequestInFlight = null;
  });

  await countryCodeRequestInFlight;
}

export async function init(this: VideoHandler) {
  if (this.initialized) return;

  const audioContextSupported = this.isAudioContextSupported;

  // Retrieve settings from storage.
  this.data = await dubbedStorage.getValues({
    autoTranslate: false,
    autoSubtitles: false,
    // Default pair is "Авто -> Русский": the source stays on auto-detection and
    // the target is the UI language. The "don't translate" list must NOT be
    // pre-filled with the target language — that silently blocked every video
    // whose detected language matched it (e.g. Russian-audio YouTube Shorts
    // failed with "Вы отключили перевод видео на вашем языке" while English
    // regular videos worked).
    dontTranslateLanguages: [],
    enabledDontTranslateLanguages: false,
    enabledAutoVolume: true,
    enabledSmartDucking: true,
    autoVolume: defaultAutoVolume,
    buttonPos: "default",
    showVideoSlider: true,
    syncVolume: false,
    downloadWithName: isSupportGMXhr,
    sendNotifyOnComplete: false,
    subtitlesMaxLength: 300,
    subtitlesSmartLayout: true,
    highlightWords: false,
    subtitlesFontSize: 20,
    subtitlesFontFamily: "default-sans",
    subtitlesOpacity: 20,
    subtitlesDownloadFormat: "srt",
    responseLanguage: calculatedResLang,
    responseLanguageSubtitles: "auto",
    defaultVolume: 30,
    onlyBypassMediaCSP: audioContextSupported,
    newAudioPlayer: audioContextSupported,
    showPiPButton: false,
    translateAPIErrors: true,
    translationService: defaultTranslationService,
    detectService: defaultDetectService,
    translationHotkey: null,
    subtitlesHotkey: null,
    m3u8ProxyHost,
    proxyWorkerHost,
    translateProxyEnabled: 0,
    translateProxyEnabledDefault: true,
    audioBooster: false,
    useLivelyVoice: false,
    autoHideButtonDelay: defaultAutoHideDelay,
    // Audio download now uses direct network requests (GM_fetch/GM_xmlhttpRequest).
    useAudioDownload: isSupportGMXhr,
    compatVersion: "",
    account: {},
    localeHash: "",
    localeUpdatedAt: 0,
  });
  if (this.data.compatVersion !== actualCompatVersion) {
    // Migration "2026-09-11": translation volume default becomes 30%.
    // We can't distinguish a user-set 100% from the old default 100%, so the
    // migration applies 30% once; the user can raise it back in the menu.
    // Only run it for installs coming from an older compat version, so bumping
    // the version for later migrations does not clobber a customized volume.
    if (String(this.data.compatVersion || "") < "2026-09-11") {
      this.data.defaultVolume = 30;
      await dubbedStorage.set("defaultVolume", 30);
    }

    // Migration "2026-09-12": drop the legacy "don't translate <response lang>"
    // default. Older builds pre-filled the list with the response language
    // (or, for an English UI, with "en" and later rewrote it to the response
    // language) and enabled the feature. That silently blocked translation for
    // videos whose detected language matched the entry (Russian Shorts) instead
    // of merely skipping them. Only an untouched single-entry default is reset;
    // a user-customized list is preserved.
    if (
      this.data.enabledDontTranslateLanguages &&
      Array.isArray(this.data.dontTranslateLanguages) &&
      this.data.dontTranslateLanguages.length === 1 &&
      (this.data.dontTranslateLanguages[0] === calculatedResLang ||
        this.data.dontTranslateLanguages[0] === "en" ||
        // "kk" — исторический дефолт из navigator.language (kk-локаль),
        // см. src/utils/localization.ts.
        this.data.dontTranslateLanguages[0] === "kk")
    ) {
      this.data.enabledDontTranslateLanguages = false;
      this.data.dontTranslateLanguages = [];
      await dubbedStorage.set("enabledDontTranslateLanguages", false);
      await dubbedStorage.set("dontTranslateLanguages", []);
    }

    this.data = await updateConfig(this.data);
    await dubbedStorage.set("compatVersion", actualCompatVersion);
  }

  this.uiManager.data = this.data;
  // Translation volume starts from the user's saved default volume.
  console.log("[Dubbed] data from db:", this.data);

  // Enable translate proxy if extension isn't compatible with GM_xmlhttpRequest
  if (!this.data.translateProxyEnabled && isProxyOnlyExtension) {
    this.data.translateProxyEnabled = 1;
  }
  // Determine country for proxy purposes
  await ensureCountryCode();

  const countryCode = getCountryCode();
  if (
    countryCode !== null &&
    proxyOnlyCountries.includes(countryCode) &&
    this.data.translateProxyEnabledDefault
  ) {
    this.data.translateProxyEnabled = 2;
  }

  debug.log(
    "translateProxyEnabled",
    this.data.translateProxyEnabled,
    this.data.translateProxyEnabledDefault,
  );
  debug.log("Extension compatibility passed...");

  await this.initDubbedClient();

  // Initialize UI elements and events.
  this.uiManager.initUI();
  this.uiManager.initUIEvents();

  if (this.uiManager.dubbedOverlayView?.dubbedButton?.container) {
    this.uiManager.dubbedOverlayView.dubbedButton.container.hidden = true;
  }

  // Get video data and create player.
  this.createPlayer();

  this.translateToLang = this.data.responseLanguage ?? "ru";
  this.initExtraEvents();

  this.initialized = true;
}
