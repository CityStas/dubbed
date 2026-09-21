import {
  actualCompatVersion,
  maxAudioVolume,
  repositoryUrl,
} from "../config/config";
import { localizationProvider } from "../localization/localizationProvider";
import type { Status } from "../types/components/dubbedButton";
import type { StorageData } from "../types/storage";
import type { OverlayMount, UIManagerProps } from "../types/uiManager";
import debug from "../utils/debug";
import { downloadTranslation } from "../utils/download";
import { GM_fetch } from "../utils/gm";
import type { IntervalIdleChecker } from "../utils/intervalIdleChecker";
import { serializeProcessedSubtitles } from "../utils/serializeSubtitles";
import { dubbedStorage } from "../utils/storage";
import {
  clamp,
  clearFileName,
  type DownloadBlobOptions,
  downloadBlob,
} from "../utils/utils";
import type { VideoHandler } from "../VideoHandler";
import type { VideoData } from "../videoHandler/shared";
import { safeSetPlayerVolume } from "../videoHandler/translationVolume";
import { normalizeButtonPosition } from "./buttonPlacement";
import { applyOverlayMountUpdate } from "./mount";
import {
  createShadowMount,
  destroyShadowMount,
  reparentShadowMount,
  type ShadowMount,
} from "./shadowMount";
import { handleTranslationButtonCommand } from "./translationCommands";
import { OverlayView } from "./views/overlay";
import { SettingsView } from "./views/settings";

/**
 * Маркер для плейсхолдера `{0}` в шаблонах локализации. Нужен, чтобы подменить
 * его на `\d+` ПОСЛЕ regex-экранирования: если экранировать первым, `{0}`
 * станет `\{0\}` и наивная замена даст мусорный `\\d+`. `\u0000` в текстах
 * локализации не встречается.
 */
const ETA_PLACEHOLDER = "\u0000";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class UIManager {
  mount: OverlayMount;

  private initialized = false;
  private readonly videoHandler?: VideoHandler;
  private readonly intervalIdleChecker: IntervalIdleChecker;
  data: Partial<StorageData>;

  dubbedGlobalPortal?: HTMLElement;
  private globalPortalMount?: ShadowMount;
  /**
   * Contains all elements over video player e.g. button, menu and etc
   */
  dubbedOverlayView?: OverlayView;
  /**
   * Dialog settings menu
   */
  dubbedSettingsView?: SettingsView;

  constructor({
    mount,
    data = {},
    videoHandler,
    intervalIdleChecker,
  }: UIManagerProps) {
    this.mount = mount;
    this.videoHandler = videoHandler;
    this.data = data;
    this.intervalIdleChecker = intervalIdleChecker;
  }

  get root(): HTMLElement | ShadowRoot {
    return this.mount.root;
  }

  get portalContainer(): HTMLElement {
    return this.mount.portalContainer;
  }

  getSubtitlesMountContainer(): HTMLElement | ShadowRoot {
    return this.dubbedOverlayView?.root ?? this.mount.subtitlesMountContainer;
  }

  isInitialized(): this is {
    dubbedGlobalPortal: HTMLElement;
    dubbedOverlayView: OverlayView;
    dubbedSettingsView: SettingsView;
  } {
    return this.initialized;
  }

  initUI() {
    if (this.isInitialized()) {
      throw new Error("[Dubbed] UIManager is already initialized");
    }

    this.initialized = true;

    this.globalPortalMount = createShadowMount({
      parent: this.getGlobalPortalHost(this.mount),
      rootClasses: ["dubbed-portal"],
    });
    this.dubbedGlobalPortal = this.globalPortalMount.root;

    this.dubbedOverlayView = new OverlayView({
      mount: this.mount,
      globalPortal: this.dubbedGlobalPortal,
      data: this.data,
      videoHandler: this.videoHandler,
      intervalIdleChecker: this.intervalIdleChecker,
    });
    // Preserve the user's last chosen button position across UI reloads
    // (e.g. when changing the menu language).
    this.dubbedOverlayView.initUI(normalizeButtonPosition(this.data.buttonPos));

    this.dubbedSettingsView = new SettingsView({
      globalPortal: this.dubbedGlobalPortal,
      data: this.data,
      videoHandler: this.videoHandler,
    });
    this.dubbedSettingsView.initUI();

    this.videoHandler?.subtitlesWidget?.updateMount({
      container: this.getSubtitlesMountContainer(),
    });

    return this;
  }

  updateMount(mount: OverlayMount) {
    reparentShadowMount(
      this.globalPortalMount,
      this.getGlobalPortalHost(mount),
    );

    this.mount = applyOverlayMountUpdate(this.mount, mount, (nextMount) => {
      this.dubbedOverlayView?.updateMount(nextMount);
    });

    this.videoHandler?.subtitlesWidget?.updateMount({
      container: this.getSubtitlesMountContainer(),
    });

    return this;
  }

  private getGlobalPortalHost(_mount: OverlayMount): HTMLElement | ShadowRoot {
    const fullscreenInfo =
      this.videoHandler?.fullscreenHelper?.getFullscreenInfo();

    if (fullscreenInfo?.element && fullscreenInfo.belongsToCurrentVideo) {
      return fullscreenInfo.shadowRoot ?? fullscreenInfo.element;
    }

    return document.documentElement;
  }

  initUIEvents() {
    if (!this.isInitialized()) {
      throw new Error("[Dubbed] UIManager isn't initialized");
    }

    this.dubbedOverlayView.initUIEvents();
    this.bindOverlayViewEvents();

    this.dubbedSettingsView.initUIEvents();
    this.bindSettingsViewEvents();
  }

  private bindOverlayViewEvents() {
    const overlayView = this.dubbedOverlayView;
    if (!overlayView) {
      return;
    }

    overlayView
      .addEventListener("click:translate", async () => {
        await this.handleTranslationBtnClick();
      })
      .addEventListener("click:pip", async () => {
        if (!this.videoHandler) {
          return;
        }

        try {
          const inPiP = document.pictureInPictureElement != null;
          if (inPiP) {
            await document.exitPictureInPicture();
          } else {
            await this.videoHandler.video.requestPictureInPicture();
          }
        } catch (err) {
          debug.warn("[Dubbed] Failed to toggle Picture-in-Picture", err);
        }
      })
      .addEventListener("click:subtitles", async () => {
        if (!this.videoHandler) {
          return;
        }

        await this.videoHandler.toggleSubtitlesForCurrentLangPair();
      })
      .addEventListener("click:settings", async () => {
        this.videoHandler?.subtitlesWidget?.releaseTooltip();
        this.videoHandler?.overlayVisibility?.cancel();
        this.videoHandler?.overlayVisibility?.show();
        this.dubbedSettingsView.open();
      })
      .addEventListener("click:downloadTranslation", async () => {
        await this.handleDownloadTranslationClick();
      })
      .addEventListener("click:downloadSubtitles", async () => {
        await this.handleDownloadSubtitlesClick();
      })
      .addEventListener("input:videoVolume", (volume) => {
        if (!this.videoHandler) {
          return;
        }

        if (volume === 0) {
          this.videoHandler.setVideoMuted(true);
        } else {
          if (this.videoHandler.isMuted()) {
            this.videoHandler.setVideoMuted(false);
          }
          const nextVolume01 = volume / 100;
          this.videoHandler.setVideoVolume(nextVolume01);
          this.videoHandler.applyManualVideoVolumeOverride(nextVolume01);
        }

        if (!this.data.syncVolume) {
          this.videoHandler.onVideoVolumeSliderSynced(volume);
          return;
        }

        this.videoHandler.syncVolumeWrapper("video", volume);
      })
      .addEventListener("input:translationVolume", (volume) => {
        if (!this.videoHandler) {
          return;
        }

        // Prefer the actual event payload (the overlay also updates `data`, but
        // using the payload is simpler and avoids accidental desyncs).
        const nextVolume = volume ?? this.data.defaultVolume ?? 100;
        safeSetPlayerVolume(
          this.videoHandler.audioPlayer.player,
          nextVolume / 100,
        );
        if (!this.data.syncVolume) {
          this.videoHandler.onTranslationVolumeSliderSynced(nextVolume);
          return;
        }
        const syncResult = this.videoHandler.syncVolumeWrapper(
          "translation",
          nextVolume,
        );
        if (typeof syncResult?.nextVideo === "number") {
          this.videoHandler.applyManualVideoVolumeOverride(
            syncResult.nextVideo / 100,
          );
        }
      })
      .addEventListener("select:fromLanguage", async () => {
        if (!this.videoHandler) {
          return;
        }

        await this.videoHandler.refreshAutoSubtitlesForCurrentLangPair();
      })
      .addEventListener("select:subtitles", (data) => {
        if (!this.videoHandler) {
          return;
        }

        this.runDetached(
          this.videoHandler.changeSubtitlesLang(data),
          "Failed to change subtitles language",
        );
      })
      .addEventListener("select:voiceType", () => {
        if (!this.videoHandler) {
          return;
        }

        const wasActive = this.videoHandler.hasActiveSource();
        this.runDetached(
          (async () => {
            await this.videoHandler?.stopTranslate();
            // Restart translation with the new voice mode if it was playing.
            if (wasActive) {
              await this.handleTranslationBtnClick();
            }
          })(),
          "Failed to restart translation after voice mode change",
        );
      });
  }

  private bindSettingsViewEvents() {
    const settingsView = this.dubbedSettingsView;
    if (!settingsView) {
      return;
    }

    settingsView
      .addEventListener("update:account", async (account) => {
        if (!this.videoHandler) {
          return;
        }

        this.videoHandler.dubbedClient.provider.apiToken = account?.token;
      })
      .addEventListener("change:autoTranslate", async (checked) => {
        const videoHandler = this.videoHandler;
        if (checked && videoHandler && !videoHandler.hasActiveSource()) {
          await this.handleTranslationBtnClick();
        }
      })
      .addEventListener("change:autoSubtitles", async (checked) => {
        if (!checked || !this.videoHandler?.videoData?.videoId) {
          return;
        }

        await this.videoHandler.refreshAutoSubtitlesForCurrentLangPair();
      })
      .addEventListener("select:responseLanguageSubtitles", async () => {
        if (
          !this.videoHandler?.data.autoSubtitles ||
          !this.videoHandler.videoData
        ) {
          return;
        }

        await this.videoHandler.refreshAutoSubtitlesForCurrentLangPair();
      })
      .addEventListener("change:showVideoVolume", () => {
        this.withInitializedOverlayView((overlayView) => {
          if (!overlayView.videoVolumeSlider || !overlayView.dubbedButton) {
            return;
          }

          overlayView.videoVolumeSlider.container.hidden =
            !this.data.showVideoSlider;
        });
      })
      .addEventListener("change:audioBooster", async () => {
        this.withInitializedOverlayView((overlayView) => {
          if (!overlayView.translationVolumeSlider) {
            return;
          }

          const currentVolume = overlayView.translationVolumeSlider.value;
          const maxVolume =
            this.data.audioBooster && !this.data.syncVolume
              ? maxAudioVolume
              : 100;
          overlayView.translationVolumeSlider.max = maxVolume;
          const nextVolume = clamp(currentVolume, 0, maxVolume);
          overlayView.translationVolumeSlider.value = nextVolume;
          this.videoHandler?.onTranslationVolumeSliderSynced(nextVolume);
          this.videoHandler?.syncTranslationPlaybackVolume();
        });
      })
      .addEventListener("change:syncVolume", (checked) => {
        if (!this.videoHandler) {
          return;
        }
        this.videoHandler.setupAudioSettings();

        this.withInitializedOverlayView((overlayView) => {
          const videoSlider = overlayView.videoVolumeSlider;
          const translationSlider = overlayView.translationVolumeSlider;
          if (!videoSlider || !translationSlider) {
            return;
          }

          const maxVolume =
            this.data.audioBooster && !checked ? maxAudioVolume : 100;
          translationSlider.max = maxVolume;
          const nextTranslation = clamp(translationSlider.value, 0, maxVolume);
          translationSlider.value = nextTranslation;
          this.videoHandler.onTranslationVolumeSliderSynced(nextTranslation);
          this.videoHandler.syncTranslationPlaybackVolume();

          if (!checked) {
            return;
          }

          this.videoHandler.resetVolumeLinkState(
            Number(videoSlider.value),
            nextTranslation,
          );
        });
      })
      .addEventListener("change:subtitlesHighlightWords", (checked) => {
        this.updateSubtitlesWidgetSetting(
          checked,
          this.data.highlightWords,
          (widget, value) => {
            widget.setHighlightWords(value);
          },
        );
      })
      .addEventListener("change:subtitlesSmartLayout", (checked) => {
        this.updateSubtitlesWidgetSetting(
          checked,
          this.data.subtitlesSmartLayout,
          (widget, value) => {
            widget.setSmartLayout(value);
          },
        );
      })
      .addEventListener("input:subtitlesMaxLength", (value) => {
        this.updateSubtitlesWidgetSetting(
          value,
          this.data.subtitlesMaxLength,
          (widget, nextValue) => {
            widget.setMaxLength(nextValue);
          },
        );
      })
      .addEventListener("input:subtitlesFontSize", (value) => {
        this.updateSubtitlesWidgetSetting(
          value,
          this.data.subtitlesFontSize,
          (widget, nextValue) => {
            widget.setFontSize(nextValue);
          },
        );
      })
      .addEventListener("select:subtitlesFontFamily", (item) => {
        this.updateSubtitlesWidgetSetting(
          item,
          this.data.subtitlesFontFamily,
          (widget, nextValue) => {
            widget.setFontFamily(nextValue);
          },
        );
      })
      .addEventListener("input:subtitlesBackgroundOpacity", (value) => {
        this.updateSubtitlesWidgetSetting(
          value,
          this.data.subtitlesOpacity,
          (widget, nextValue) => {
            widget.setOpacity(nextValue);
          },
        );
      })
      .addEventListener("change:proxyWorkerHost", (_value) => {
        if (!this.videoHandler) {
          return;
        }

        // Proxy host changes invalidate cached requests/URLs and should stop
        // the current translation session.
        this.runDetached(
          this.videoHandler.handleProxySettingsChanged("proxyWorkerHost"),
          "Failed to apply proxyWorkerHost change",
        );
      })
      .addEventListener("select:proxyTranslationStatus", () => {
        // Switching proxy mode changes request routing. Drop stale cache and
        // stop translation so the next run starts with fresh settings.
        if (!this.videoHandler) {
          return;
        }

        this.runDetached(
          this.videoHandler.handleProxySettingsChanged(
            "proxyTranslationStatus",
          ),
          "Failed to apply proxyTranslationStatus change",
        );
      })
      .addEventListener("change:useNewAudioPlayer", () => {
        void this.restartAudioPlayer();
      })
      .addEventListener("change:onlyBypassMediaCSP", () => {
        void this.restartAudioPlayer();
      })
      .addEventListener("select:translationTextService", () => {
        this.withSubtitlesWidget((widget) => {
          widget.resetTranslationContext(true);
        });
      })
      .addEventListener("change:showPiPButton", () => {
        this.withInitializedOverlayView((overlayView) => {
          if (!overlayView.dubbedButton) {
            return;
          }

          overlayView.dubbedButton.pipButton.hidden =
            overlayView.dubbedButton.separator2.hidden =
              !overlayView.pipButtonVisible;
        });
      })
      .addEventListener("select:buttonPosition", (item) => {
        this.withInitializedOverlayView((overlayView) => {
          const preferredPosition = normalizeButtonPosition(
            this.data.buttonPos ?? item,
          );
          const { position, direction } =
            overlayView.calcButtonLayout(preferredPosition);
          overlayView.updateButtonLayout(position, direction);
        });
      })
      .addEventListener("select:menuLanguage", async () => {
        await this.reloadMenu();
      })
      .addEventListener("click:bugReport", () => {
        if (!this.videoHandler || !repositoryUrl) {
          return;
        }

        const params = new URLSearchParams(
          this.videoHandler.collectReportInfo(),
        ).toString();

        globalThis
          .open(`${repositoryUrl}/issues/new?${params}`, "_blank")
          ?.focus();
      })
      .addEventListener("click:resetSettings", async () => {
        const valuesForClear = await dubbedStorage.list();
        await Promise.all(valuesForClear.map((key) => dubbedStorage.delete(key)));
        await dubbedStorage.set("compatVersion", actualCompatVersion);

        globalThis.location.reload();
      });
  }

  private async handleDownloadTranslationClick() {
    const overlayView = this.dubbedOverlayView;
    const videoHandler = this.videoHandler;
    const download = videoHandler?.downloadTranslation;
    if (!overlayView?.isInitialized() || !download || !videoHandler.videoData) {
      return;
    }

    const downloadVideoData = await this.getDownloadVideoData(
      videoHandler,
      download.videoId,
    );
    if (!downloadVideoData) {
      return;
    }

    const downloadButton = overlayView.downloadTranslationButton;
    const downloadUrl = download.url;
    const filename = this.data.downloadWithName
      ? clearFileName(downloadVideoData.downloadTitle)
      : `translation_${downloadVideoData.videoId}`;
    const isMobile = this.isLikelyMobileDownloadContext();
    const saveOptions: DownloadBlobOptions = { preferShare: isMobile };

    const setProgress = (progress: number) => {
      if (downloadButton) {
        downloadButton.progress = progress;
      }
    };

    setProgress(0);
    try {
      await this.downloadTranslationAudio(
        downloadUrl,
        filename,
        setProgress,
        saveOptions,
      );
    } catch (err) {
      console.error("[Dubbed] Download translation failed:", err);
      if (!this.triggerUrlDownload(downloadUrl, `${filename}.mp3`)) {
        globalThis.open(downloadUrl, "_blank")?.focus();
      }
    } finally {
      setProgress(0);
    }
  }

  private async getDownloadVideoData(
    videoHandler: VideoHandler,
    downloadVideoId: string,
  ): Promise<VideoData | null> {
    if (videoHandler.videoData?.videoId !== downloadVideoId) {
      this.clearDownloadTranslation(videoHandler);
      return null;
    }

    let videoData: VideoData;
    try {
      videoData = await videoHandler.getVideoData();
    } catch (err) {
      debug.log("[Dubbed] Failed to refresh video data before download", err);
      return null;
    }

    if (videoData.videoId !== downloadVideoId) {
      this.clearDownloadTranslation(videoHandler);
      return null;
    }

    videoHandler.videoData = videoData;
    return videoData;
  }

  private clearDownloadTranslation(videoHandler: VideoHandler): void {
    videoHandler.downloadTranslation = null;
    if (this.dubbedOverlayView?.downloadTranslationButton) {
      this.dubbedOverlayView.downloadTranslationButton.hidden = true;
    }
  }

  private async downloadTranslationAudio(
    downloadUrl: string,
    filename: string,
    onProgress: (progress: number) => void,
    saveOptions: DownloadBlobOptions,
  ) {
    // Download the full audio. A range request (bytes=0-0) only returns a tiny
    // fragment (~1 byte + headers), which results in a silent ~5KB file.
    const response = await GM_fetch(downloadUrl, { timeout: 0 });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    await downloadTranslation(response, filename, onProgress, saveOptions);
  }

  private async handleDownloadSubtitlesClick() {
    const videoHandler = this.videoHandler;
    if (!videoHandler?.yandexSubtitles || !videoHandler.videoData) {
      return;
    }

    const subsFormat = this.data.subtitlesDownloadFormat ?? "json";
    const subsContent = serializeProcessedSubtitles(
      videoHandler.yandexSubtitles,
      subsFormat,
      {
        assTitle:
          videoHandler.videoData.localizedTitle ??
          videoHandler.videoData.title ??
          videoHandler.videoData.downloadTitle,
      },
    );
    const blob = new Blob(
      [
        subsFormat === "json"
          ? JSON.stringify(subsContent)
          : (subsContent as string),
      ],
      {
        type: "text/plain",
      },
    );
    const filename = this.data.downloadWithName
      ? clearFileName(videoHandler.videoData.downloadTitle)
      : `subtitles_${videoHandler.videoData.videoId}`;
    const targetFilename = `${filename}.${subsFormat}`;
    const isMobile = this.isLikelyMobileDownloadContext();
    const saveOptions: DownloadBlobOptions = { preferShare: isMobile };

    await downloadBlob(blob, targetFilename, saveOptions);
  }

  async reloadMenu() {
    if (!this.dubbedOverlayView?.isInitialized()) {
      throw new Error("[Dubbed] OverlayView isn't initialized");
    }

    // Preserve overlay state across UI rebuild.
    const prevButtonOpacity = this.dubbedOverlayView.dubbedButton.opacity;
    const prevButtonHidden = this.dubbedOverlayView.dubbedButton.container.hidden;
    const prevMenuHidden = this.dubbedOverlayView.dubbedMenu.hidden;
    const prevButtonPos = normalizeButtonPosition(this.data.buttonPos);
    const settingsWasOpen =
      this.dubbedSettingsView?.dialog?.container?.hidden === false;

    await this.videoHandler?.stopTranslation();
    this.release();
    this.initUI();
    this.initUIEvents();
    if (!this.videoHandler) {
      return this;
    }

    // Restore button/menu visibility + layout.
    try {
      const { position, direction } =
        this.dubbedOverlayView.calcButtonLayout(prevButtonPos);
      this.dubbedOverlayView.updateButtonLayout(position, direction);
      this.dubbedOverlayView.dubbedMenu.hidden = prevMenuHidden;
      this.dubbedOverlayView.dubbedButton.container.hidden = prevButtonHidden;
      this.dubbedOverlayView.dubbedButton.opacity = prevButtonOpacity;
    } catch (err) {
      debug.warn(
        "[Dubbed] Failed to restore overlay state after menu reload",
        err,
      );
    }

    // Re-bind overlay visibility interactions (overlay elements were recreated).
    try {
      this.videoHandler.rebindOverlayVisibilityTargets();
    } catch (err) {
      debug.warn("[Dubbed] Failed to rebind overlay visibility targets", err);
    }

    // Keep settings open when language changes (better UX).
    if (settingsWasOpen) {
      try {
        this.dubbedSettingsView?.open();
      } catch (err) {
        debug.warn("[Dubbed] Failed to reopen settings after menu reload", err);
      }
    }

    await this.videoHandler.updateSubtitlesLangSelect();
    const widget = this.videoHandler.subtitlesWidget;
    if (widget) {
      widget.resetTranslationContext(true);
    }

    return this;
  }

  async handleTranslationBtnClick() {
    if (!this.dubbedOverlayView?.isInitialized()) {
      throw new Error("[Dubbed] OverlayView isn't initialized");
    }

    await handleTranslationButtonCommand({
      videoHandler: this.videoHandler,
      currentStatus: this.dubbedOverlayView.dubbedButton.status,
      currentLoading: this.dubbedOverlayView.dubbedButton.loading,
      transformBtn: (status, text) => {
        this.transformBtn(status, text);
      },
    });
    return this;
  }

  /**
   * Похоже ли сообщение на «ждём перевод», чтобы оставить на кнопке спиннер.
   *
   * ⚠️ Была бага (жалоба 2026-09-13): шаблон ETA подставляется через `{0}`, а
   * проверка вырезала плейсхолдер и искала по `includes` — в шаблоне оставалась
   * «дырка» между словами («Ещё примерно  минут - уже близко!»), и строка с
   * реальным числом («Ещё примерно 9 минут - уже близко!») НИКОГДА не совпадала.
   * Спиннер пропадал, кнопка уходила в вид ошибки — выглядело как «упало».
   * Теперь шаблон компилируется в регулярку, где `{0}` = `\d+`.
   */
  private isLoadingText(text: string) {
    if (typeof text !== "string") return false;
    const delayed = localizationProvider.get("TranslationDelayed");
    if (delayed && text.includes(delayed)) return true;
    const etaKeys = [
      // ЕДИНЫЙ статус ожидания (см. `TranslationEtaCountdown.createEtaMessage`):
      // без `{0}`, поэтому матчится веткой `includes` ниже.
      "translationWaitingForAudio",
      "translationTake",
      "translationTakeMoreThanHour",
      "translationTakeAboutMinute",
      "translationTakeFewMinutes",
      "translationTakeApproximatelyMinutes",
      "translationTakeApproximatelyMinute",
      "translationTakeApproximatelyMinute2",
    ];
    // Неразрывный пробел и «узкий» пробел приводим к обычному: шаблон и
    // отформатированное сообщение могут расходиться именно ими.
    const normalize = (value: string) =>
      value.replace(/[\u00A0\u202F\u2009]/g, " ");
    const haystack = normalize(text);
    return etaKeys.some((key) => {
      const template = localizationProvider.get(key as any);
      if (typeof template !== "string" || !template) return false;
      const normalizedTemplate = normalize(template);
      if (!normalizedTemplate.includes("{0}")) {
        const base = normalizedTemplate.trim();
        return base.length > 0 && haystack.includes(base);
      }
      // ⚠️ Порядок важен: сначала подменяем плейсхолдер на маркер, ПОТОМ
      // экранируем regex-спецсимволы, и только затем маркер -> `\d+`.
      // Иначе `{0}` превращается в `\{0\}` и замена даёт мусорный `\\d+`.
      const pattern = escapeRegExp(normalizedTemplate.replace(/\{0\}/g, ETA_PLACEHOLDER))
        .split(ETA_PLACEHOLDER)
        .join("\\d+");
      try {
        return new RegExp(pattern).test(haystack);
      } catch {
        // Экзотический шаблон — деградируем к прежнему поведению.
        const base = normalizedTemplate.replace("{0}", "").trim();
        return base.length > 0 && haystack.includes(base);
      }
    });
  }

  transformBtn(status: Status, text: string) {
    if (!this.dubbedOverlayView?.isInitialized()) {
      throw new Error("[Dubbed] OverlayView isn't initialized");
    }

    this.dubbedOverlayView.dubbedButton.status = status;
    this.dubbedOverlayView.dubbedButton.loading =
      status === "error" && this.isLoadingText(text);
    this.dubbedOverlayView.dubbedButton.setText(text);
    this.dubbedOverlayView.dubbedButtonTooltip.setContent(text);

    const { voicePopover, dubbedButtonTooltip } = this.dubbedOverlayView;
    const centered = this.dubbedOverlayView.dubbedButton.direction !== "column";

    if (status === "error") {
      if (!centered) {
        voicePopover?.cancelShow();
        voicePopover?.hideNow();
        this.dubbedOverlayView.dubbedButton.setVoiceMenuOpen(false);
      }
      dubbedButtonTooltip.dismissImmediate();
      this.dubbedOverlayView.syncTranslateButtonTooltip();
    } else {
      dubbedButtonTooltip.dismissImmediate();
      this.dubbedOverlayView.syncTranslateButtonTooltip();
      this.dubbedOverlayView.rescheduleVoicePopoverIfHovered();
    }

    return this;
  }

  release() {
    if (!this.isInitialized()) {
      return this;
    }

    // Release child views before removing the shared portal.
    // Each view is now idempotent and releases events before DOM.
    this.dubbedOverlayView.release();
    this.dubbedSettingsView.release();
    destroyShadowMount(this.globalPortalMount);
    this.globalPortalMount = undefined;
    this.dubbedGlobalPortal = undefined;

    this.initialized = false;
    return this;
  }

  private withInitializedOverlayView(
    callback: (overlayView: OverlayView) => void,
  ) {
    if (!this.dubbedOverlayView?.isInitialized()) {
      return;
    }

    callback(this.dubbedOverlayView);
  }

  private withSubtitlesWidget(
    callback: (widget: NonNullable<VideoHandler["subtitlesWidget"]>) => void,
  ) {
    const widget = this.videoHandler?.subtitlesWidget;
    if (!widget) {
      return;
    }

    callback(widget);
  }

  private updateSubtitlesWidgetSetting<T>(
    nextValue: T,
    storedValue: T | undefined,
    apply: (
      widget: NonNullable<VideoHandler["subtitlesWidget"]>,
      value: T,
    ) => void,
  ) {
    this.withSubtitlesWidget((widget) => {
      apply(widget, storedValue ?? nextValue);
    });
  }

  private runDetached(task: Promise<unknown>, errorMessage: string) {
    void task.catch((err) => {
      debug.warn(`[Dubbed] ${errorMessage}`, err);
    });
  }

  private triggerUrlDownload(url: string, filename: string): boolean {
    try {
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      // Cross-origin downloads can ignore `download`; keep navigation off the
      // current tab in that case.
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      a.remove();
      return true;
    } catch {
      return false;
    }
  }

  private isLikelyMobileDownloadContext(): boolean {
    if (this.videoHandler?.site.additionalData === "mobile") {
      return true;
    }

    return (
      typeof matchMedia === "function" &&
      matchMedia("(pointer: coarse)").matches
    );
  }

  private async restartAudioPlayer() {
    const videoHandler = this.videoHandler;
    if (!videoHandler) {
      return;
    }

    try {
      await videoHandler.stopTranslate();
      videoHandler.createPlayer();
    } catch (err) {
      debug.warn("[Dubbed] Failed to restart audio player", err);
    }
  }
}
