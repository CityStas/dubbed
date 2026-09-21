import { availableLangs, availableTTS } from "@vot.js/shared/consts";
import type { RequestLang, ResponseLang } from "@vot.js/shared/types/data";
import { maxAudioVolume } from "../../config/config";
import { EventImpl } from "../../core/eventImpl";
import { FullscreenHelper } from "../../core/fullscreenHelper";
import { localizationProvider } from "../../localization/localizationProvider";
import type { Direction, Position } from "../../types/components/dubbedButton";
import type { StorageData } from "../../types/storage";
import type { ButtonLayout, OverlayMount } from "../../types/uiManager";
import type {
  OverlayViewEventMap,
  OverlayViewProps,
} from "../../types/views/overlay";
import ui from "../../ui";
import { containsCrossShadow, getDeepActiveElement } from "../../utils/dom";
import { hasTouchScreen, isTouchFirstInput } from "../../utils/inputDevice";
import type { IntervalIdleChecker } from "../../utils/intervalIdleChecker";
import { dubbedStorage } from "../../utils/storage";
import { isPiPAvailable } from "../../utils/utils";
import type { VideoHandler } from "../../VideoHandler";
import {
  normalizeButtonPosition,
  resolveButtonLayout,
  resolveButtonPositionFromPointer,
} from "../buttonPlacement";
import {
  addKeyboardActivationListener,
  isEventInside,
  isPrimaryPointerAction,
} from "../components/componentShared";
import DownloadButton from "../components/downloadButton";
import Dialog from "../components/dialog";
import Label from "../components/label";
import LanguagePairSelect from "../components/languagePairSelect";
import Select from "../components/select";
import Slider from "../components/slider";
import SliderLabel from "../components/sliderLabel";
import Tooltip from "../components/tooltip";
import VoicePopover, { type VoiceType } from "../components/voicePopover";
import DubbedButton from "../components/dubbedButton";
import DubbedMenu from "../components/dubbedMenu";
import { SETTINGS_ICON, SUBTITLES_ICON } from "./../icons";
import {
  createShadowMount,
  destroyShadowMount,
  reparentShadowMount,
  type ShadowMount,
} from "../shadowMount";

type ButtonDragState = {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  clientX: number;
  clientY: number;
  rootRect: DOMRect;
  active: boolean;
  initialPosition: Position;
  targetPosition: Position;
  frameId: number | null;
};

export class OverlayView {
  private static readonly BIG_CONTAINER_WIDTH_PX = 550;
  private resizeObserver?: ResizeObserver;
  private lastIsBigContainer = false;
  private readonly fullscreenHelper: FullscreenHelper;

  mount: OverlayMount;
  globalPortal: HTMLElement;
  private abortController: AbortController | null = null;
  private defaultVolumePersistTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly defaultVolumePersistDelayMs = 250;

  private readonly dragThresholdPx = 6;
  private readonly dragActionSuppressMs = 350;
  private dragState: ButtonDragState | null = null;
  private dockPreview: HTMLElement | null = null;
  private lastButtonDragEndAt = 0;

  private initialized = false;
  private readonly data: Partial<StorageData>;
  private readonly videoHandler?: VideoHandler;
  private readonly intervalIdleChecker: IntervalIdleChecker;
  private overlayMount?: ShadowMount;

  private readonly events: {
    [K in keyof OverlayViewEventMap]: EventImpl<OverlayViewEventMap[K]>;
  } = {
    "click:settings": new EventImpl<OverlayViewEventMap["click:settings"]>(),
    "click:pip": new EventImpl<OverlayViewEventMap["click:pip"]>(),
    "click:subtitles": new EventImpl<OverlayViewEventMap["click:subtitles"]>(),
    "click:downloadTranslation": new EventImpl<
      OverlayViewEventMap["click:downloadTranslation"]
    >(),
    "click:downloadSubtitles": new EventImpl<
      OverlayViewEventMap["click:downloadSubtitles"]
    >(),
    "click:translate": new EventImpl<OverlayViewEventMap["click:translate"]>(),
    "input:videoVolume": new EventImpl<
      OverlayViewEventMap["input:videoVolume"]
    >(),
    "input:translationVolume": new EventImpl<
      OverlayViewEventMap["input:translationVolume"]
    >(),
    "select:fromLanguage": new EventImpl<
      OverlayViewEventMap["select:fromLanguage"]
    >(),
    "select:toLanguage": new EventImpl<
      OverlayViewEventMap["select:toLanguage"]
    >(),
    "select:subtitles": new EventImpl<
      OverlayViewEventMap["select:subtitles"]
    >(),
    "select:voiceType": new EventImpl<
      OverlayViewEventMap["select:voiceType"]
    >(),
  };

  // button
  dubbedButton?: DubbedButton;
  dubbedButtonTooltip?: Tooltip;
  subtitlesButtonTooltip?: Tooltip;
  voiceMenuButtonTooltip?: Tooltip;
  openSettingsButtonTooltip?: Tooltip;
  voicePopover?: VoicePopover;
  // menu
  dubbedMenu?: DubbedMenu;
  downloadTranslationButton?: DownloadButton;
  downloadSubtitlesButton?: HTMLElement;
  openSettingsButton?: HTMLElement;
  languagePairSelect?: LanguagePairSelect<RequestLang, ResponseLang>;
  subtitlesSelectLabel?: Label;
  subtitlesSelect?: Select;
  videoVolumeSliderLabel?: SliderLabel;
  videoVolumeSlider?: Slider;
  translationVolumeSliderLabel?: SliderLabel;
  translationVolumeSlider?: Slider;

  constructor({
    mount,
    globalPortal,
    data = {},
    videoHandler,
    intervalIdleChecker,
  }: OverlayViewProps) {
    this.mount = mount;
    this.globalPortal = globalPortal;
    this.data = data;
    this.videoHandler = videoHandler;
    this.intervalIdleChecker = intervalIdleChecker;

    this.fullscreenHelper = new FullscreenHelper({
      container: videoHandler?.container || (mount.root as HTMLElement),
      video: videoHandler?.video,
    });
  }

  get root(): HTMLElement | ShadowRoot {
    return this.overlayMount?.root ?? this.mount.root;
  }

  get portalContainer(): HTMLElement {
    return this.mount.portalContainer;
  }

  private get tooltipParentElement(): HTMLElement | ShadowRoot {
    return this.root instanceof ShadowRoot
      ? (this.root.host as HTMLElement)
      : this.root;
  }

  /**
   * Update mount points when the player container changes.
   * Moves already-mounted UI nodes and rebinds root-bound listeners (dragging).
   */
  updateMount(nextMount: OverlayMount): this {
    const prevRoot = this.mount.root;
    const nextRoot = nextMount.root;

    this.mount = nextMount;

    if (!this.isInitialized()) {
      return this;
    }

    if (prevRoot !== nextRoot && this.overlayMount) {
      reparentShadowMount(this.overlayMount, nextRoot);
    }

    if (prevRoot !== nextRoot) {
      for (const tooltip of [
        this.dubbedButtonTooltip,
        this.subtitlesButtonTooltip,
        this.voiceMenuButtonTooltip,
        this.openSettingsButtonTooltip,
      ]) {
        tooltip?.updateMount({ parentElement: this.tooltipParentElement });
      }
    }

    return this;
  }

  isInitialized(): this is {
    // #region Button type
    dubbedButton: DubbedButton;
    dubbedButtonTooltip: Tooltip;
    subtitlesButtonTooltip: Tooltip;
    voiceMenuButtonTooltip: Tooltip;
    openSettingsButtonTooltip: Tooltip;
    voicePopover: VoicePopover;
    // #endregion Button type
    // #region Menu type
    dubbedMenu: DubbedMenu;
    downloadTranslationButton: DownloadButton;
    downloadSubtitlesButton: HTMLElement;
    openSettingsButton: HTMLElement;
    languagePairSelect: LanguagePairSelect<RequestLang, ResponseLang>;
    subtitlesSelectLabel: Label;
    subtitlesSelect: Select;
    videoVolumeSliderLabel: SliderLabel;
    videoVolumeSlider: Slider;
    translationVolumeSliderLabel: SliderLabel;
    translationVolumeSlider: Slider;
    // #endregion Menu type
  } {
    return this.initialized;
  }

  calcButtonLayout(position: string): ButtonLayout {
    return resolveButtonLayout(this.isBigContainer, position);
  }

  /** Centered bar uses dropdown arrow; side layout uses translate segment hover. */
  private isCenteredButtonLayout(): boolean {
    return this.dubbedButton?.direction !== "column";
  }

  /** Side layout blocks voice popover on error (tooltip instead). Centered bar always allows dropdown. */
  private allowsVoicePopover(): boolean {
    // Voice selection block (Dubbed/Live) is hidden in this build.
    return false;
  }

  private shouldUseTouchVoiceInteraction(event?: PointerEvent): boolean {
    return event?.pointerType === "touch" || isTouchFirstInput();
  }

  private shouldUseHoverVoiceInteraction(event?: PointerEvent): boolean {
    return event?.pointerType !== "touch" && !isTouchFirstInput();
  }

  /** Error tooltip only on side layout — centered bar uses dropdown + button label. */
  syncTranslateButtonTooltip(): this {
    if (!this.isInitialized()) return this;

    const tooltip = this.dubbedButtonTooltip;
    const showErrorTooltip =
      this.dubbedButton.status === "error" && !this.isCenteredButtonLayout();

    tooltip.hidden = !showErrorTooltip;
    tooltip.dismissImmediate();

    if (showErrorTooltip) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => tooltip.revealIfHovered());
      });
    }

    return this;
  }

  /**
   * When status leaves `error`, pointer may still sit on translate segment or
   * chevron — no new `pointerenter` fires, so re-arm the hover popover here.
   */
  rescheduleVoicePopoverIfHovered(): this {
    if (!this.isInitialized() || isTouchFirstInput()) return this;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!this.isInitialized() || !this.allowsVoicePopover()) return;
        const vp = this.voicePopover;
        if (!vp || vp.isOpen) return;

        const hovered = (el: HTMLElement | null): boolean => {
          if (!el?.isConnected) return false;
          try {
            return el.matches(":hover");
          } catch {
            return false;
          }
        };

        if (this.dubbedButton.direction === "column") {
          if (hovered(this.dubbedButton.translateButton)) {
            vp.scheduleShow(this.dubbedButton.translateButton);
          }
        } else if (hovered(this.dubbedButton.dropdownArrow)) {
          vp.scheduleShow(this.dubbedButton.dropdownArrow);
        }
      });
    });
    return this;
  }

  addEventListener<K extends keyof OverlayViewEventMap>(
    type: K,
    listener: (...data: OverlayViewEventMap[K]) => void,
  ): this {
    this.events[type].addListener(listener);
    return this;
  }

  removeEventListener<K extends keyof OverlayViewEventMap>(
    type: K,
    listener: (...data: OverlayViewEventMap[K]) => void,
  ): this {
    this.events[type].removeListener(listener);
    return this;
  }

  private scheduleDefaultVolumePersist(): void {
    if (this.defaultVolumePersistTimer !== undefined) {
      globalThis.clearTimeout(this.defaultVolumePersistTimer);
    }

    this.defaultVolumePersistTimer = globalThis.setTimeout(() => {
      this.defaultVolumePersistTimer = undefined;
      this.flushDefaultVolumePersist();
    }, this.defaultVolumePersistDelayMs);
  }

  private bindPrimaryAction(
    element: HTMLElement,
    handler: () => void,
    signal: AbortSignal,
    options: {
      preventPointerDefault?: boolean;
      shouldHandlePointer?: (event: PointerEvent) => boolean;
    } = {},
  ): void {
    element.addEventListener(
      "pointerup",
      (event) => {
        if (!isPrimaryPointerAction(event)) return;
        if (this.shouldSuppressPointerAction()) return;
        if (options.shouldHandlePointer?.(event) === false) return;
        if (options.preventPointerDefault) {
          event.preventDefault();
        }
        handler();
        queueMicrotask(() => this.queueButtonAutoHideAfterInteraction());
      },
      { signal },
    );
    addKeyboardActivationListener(
      element,
      () => {
        handler();
        queueMicrotask(() => this.queueButtonAutoHideAfterInteraction());
      },
      { signal },
    );
  }

  private flushDefaultVolumePersist(): void {
    if (this.defaultVolumePersistTimer !== undefined) {
      globalThis.clearTimeout(this.defaultVolumePersistTimer);
      this.defaultVolumePersistTimer = undefined;
    }

    if (typeof this.data.defaultVolume !== "number") {
      return;
    }

    void dubbedStorage.set("defaultVolume", this.data.defaultVolume);
  }

  initUI(buttonPosition: string = "default") {
    if (this.isInitialized()) {
      throw new Error("[Dubbed] OverlayView is already initialized");
    }

    this.initialized = true;
    this.lastIsBigContainer = this.isBigContainer;
    this.overlayMount = createShadowMount({
      parent: this.mount.root,
      rootClasses: ["dubbed-overlay-root"],
      hostStyles: {
        position: "absolute",
        inset: "0",
        display: "block",
        "pointer-events": "none",
      },
      rootStyles: {
        position: "relative",
        display: "block",
        width: "100%",
        height: "100%",
        "pointer-events": "none",
      },
    });

    // #region Shared logic
    const { position, direction } = this.calcButtonLayout(buttonPosition);

    // #endregion Shared logic
    // #region Dubbed Button
    this.dubbedButton = new DubbedButton({
      position,
      direction,
      status: "none",
      labelHtml: localizationProvider.get("translateVideo"),
    });
    this.dubbedButton.opacity = 0;
    if (!this.pipButtonVisible) {
      this.dubbedButton.showPiPButton(false);
    }
    // Subtitles mode icon is hidden from the button in this build.
    this.dubbedButton.showSubtitlesButton(false);
    this.root.appendChild(this.dubbedButton.container);
    this.dubbedButton.syncDropdownArrowPlacement();

    // Translate label tooltip: hidden during normal use (voice popover instead).
    this.dubbedButtonTooltip = new Tooltip({
      target: this.dubbedButton.translateButton,
      content: localizationProvider.get("translateVideo"),
      position: this.dubbedButton.tooltipPos,
      autoLayout: false,
      hidden: true,
      bordered: false,
      parentElement: this.tooltipParentElement,
    });

    // Voice type popover — shown on hover over the translate button.
    const activeVoice: VoiceType =
      this.data.useLivelyVoice === false ? "standard" : "live";
    this.voicePopover = new VoicePopover({
      activeVoice,
      layoutRoot: this.root as HTMLElement,
      onTranslate: () => {
        this.events["click:translate"].dispatch();
      },
    });
    this.voicePopover.addEventListener("openChange", (isOpen) => {
      this.dubbedButton?.setVoiceMenuOpen(isOpen);
    });
    this.dubbedButton.container.dataset.voiceType = activeVoice;
    this.root.appendChild(this.voicePopover.container);
    this.syncTranslateButtonTooltip();
    this.subtitlesButtonTooltip = new Tooltip({
      target: this.dubbedButton.subtitlesButton,
      content: localizationProvider.get("DubbedSubtitles"),
      position: this.dubbedButton.tooltipPos,
      autoLayout: false,
      bordered: false,
      parentElement: this.tooltipParentElement,
    });

    this.voiceMenuButtonTooltip = new Tooltip({
      target: this.dubbedButton.dropdownArrow,
      anchor: this.dubbedButton.dropdownArrow,
      edgeAnchor: this.dubbedButton.translateButton,
      content: localizationProvider.get("DubbedVoiceSelection"),
      position: this.dubbedButton.tooltipPos,
      autoLayout: false,
      bordered: false,
      parentElement: this.tooltipParentElement,
    });
    this.voiceMenuButtonTooltip.hidden =
      this.dubbedButton.dropdownArrow.hidden === true;

    // #endregion Dubbed Button
    // #region Dubbed Menu
    this.dubbedMenu = new DubbedMenu({
      // The quick menu is a *mode* picker (language, auto-translate, subtitles,
      // volume) — it is not the settings screen, so it must not borrow the
      // "Настройки" phrasing. `DubbedSettings` stays on the gear button's
      // aria-label and on the real settings dialog title.
      titleHtml: localizationProvider.get("DubbedTranslateMode"),
      position,
    });
    this.root.appendChild(this.dubbedMenu.container);

    this.setupResizeObserver();

    // A11y: link the menu toggle button to the popover.
    this.dubbedButton.menuButton.setAttribute(
      "aria-controls",
      this.dubbedMenu.container.id,
    );

    // #region Dubbed Menu Header
    this.downloadTranslationButton = new DownloadButton();
    this.downloadTranslationButton.hidden = true;

    this.downloadSubtitlesButton = ui.createIconButton(SUBTITLES_ICON, {
      ariaLabel: "Download subtitles",
    });
    this.downloadSubtitlesButton.hidden = true;

    this.openSettingsButton = ui.createIconButton(SETTINGS_ICON, {
      ariaLabel: localizationProvider.get("DubbedSettings"),
    });
    // Tooltip for the gear button.
    this.openSettingsButtonTooltip = new Tooltip({
      target: this.openSettingsButton,
      anchor: this.openSettingsButton,
      content: localizationProvider.get("DubbedAdvancedSettings"),
      position: "bottom",
      autoLayout: false,
      bordered: false,
      parentElement: this.tooltipParentElement,
    });

    this.dubbedMenu.headerContainer.append(
      this.downloadTranslationButton.container,
      this.downloadSubtitlesButton,
      this.openSettingsButton,
    );

    // #endregion Dubbed Menu Header
    // #region Dubbed Menu Body

    const detectedLanguage =
      this.videoHandler?.videoData?.detectedLanguage ?? "auto";
    const responseLanguage = this.data.responseLanguage ?? "ru";
    this.languagePairSelect = new LanguagePairSelect({
      from: {
        // `detectedLanguage` is dynamic and may include codes that aren't in
        // the compile-time Phrase union (e.g. "ms"). Use getLangLabel, which
        // falls back to the raw code instead of warning for missing keys.
        selectTitle: localizationProvider.getLangLabel(detectedLanguage),
        items: Select.genLanguageItems(availableLangs, detectedLanguage),
      },
      to: {
        selectTitle: localizationProvider.getLangLabel(responseLanguage),
        items: Select.genLanguageItems(availableTTS, responseLanguage),
      },
      dialogParent: this.globalPortal,
    });

    this.subtitlesSelectLabel = new Label({
      labelText: localizationProvider.get("DubbedSubtitles"),
    });
    this.subtitlesSelect = new Select({
      selectTitle: localizationProvider.get("DubbedSubtitlesDisabled"),
      dialogTitle: localizationProvider.get("DubbedSubtitles"),
      labelElement: this.subtitlesSelectLabel.container,
      dialogParent: this.globalPortal,
      items: [
        {
          label: localizationProvider.get("DubbedSubtitlesDisabled"),
          value: "disabled",
          selected: true,
        },
      ],
    });

    const videoVolume = this.videoHandler
      ? this.videoHandler.getVideoVolume() * 100
      : 100;
    this.videoVolumeSliderLabel = new SliderLabel({
      labelText: localizationProvider.get("DubbedVolume"),
      value: videoVolume,
    });

    this.videoVolumeSlider = new Slider({
      labelHtml: this.videoVolumeSliderLabel.container,
      value: videoVolume,
    });
    // Volume sliders are always visible in the quick menu (on every site);
    // the video one still respects the user's "show video slider" setting.
    this.videoVolumeSlider.hidden = !this.data.showVideoSlider;

    const defaultVolume = this.data.defaultVolume ?? 100;
    this.translationVolumeSliderLabel = new SliderLabel({
      labelText: localizationProvider.get("DubbedVolumeTranslation"),
      value: defaultVolume,
    });

    this.translationVolumeSlider = new Slider({
      labelHtml: this.translationVolumeSliderLabel.container,
      value: defaultVolume,
      max:
        this.data.audioBooster && !this.data.syncVolume ? maxAudioVolume : 100,
    });

    this.dubbedMenu.bodyContainer.append(
      this.languagePairSelect.container,
      this.subtitlesSelect.container,
      this.videoVolumeSlider.container,
      this.translationVolumeSlider.container,
    );
    // Subtitles settings are hidden in the quick settings ("...") menu.
    this.subtitlesSelect.hidden = true;

    // "How to use?" — pinned, always-visible bar at the bottom of the quick menu.
    const howTo = ui.createEl("dubbed-block", ["dubbed-howto"]);
    const summary = ui.createEl("dubbed-block", ["dubbed-howto-summary"]);
    summary.textContent = localizationProvider.get("dubbedHowTo");
    summary.setAttribute("role", "button");
    summary.tabIndex = 0;
    howTo.appendChild(summary);
    const howToSteps = [
      "dubbedHowToStep1",
      "dubbedHowToStep2",
      "dubbedHowToStep3",
      "dubbedHowToStep4",
      "dubbedHowToStep5",
      "dubbedHowToNote",
    ];
    const openHowToDialog = () => {
      const dialog = new Dialog({
        titleHtml: localizationProvider.get("dubbedHowTo"),
        isTemp: true,
      });
      this.globalPortal.appendChild(dialog.container);
      for (const key of howToSteps) {
        const lineEl = ui.createEl(
        "dubbed-block",
        key === "dubbedHowToNote"
          ? ["dubbed-howto-line", "dubbed-howto-note"]
          : ["dubbed-howto-line"],
      );
        lineEl.textContent = localizationProvider.get(key as any);
        dialog.bodyContainer.appendChild(lineEl);
      }
      dialog.open();
    };
    summary.addEventListener("click", () => {
      summary.focus?.();
      openHowToDialog();
    });
    summary.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openHowToDialog();
      }
    });
    this.dubbedMenu.container.append(howTo);

    // #endregion Dubbed Menu Body
    // #endregion Dubbed Menu
    return this;
  }

  initUIEvents() {
    if (!this.isInitialized()) {
      throw new Error("[Dubbed] OverlayView isn't initialized");
    }

    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    // #region [Events] Dubbed Button
    // Prevent button click events from propagating.
    this.dubbedButton.container.addEventListener(
      "click",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      },
      { signal },
    );

    // Quick settings popover state helpers.
    const setMenuOpen = (
      open: boolean,
      { returnFocusToToggle = false }: { returnFocusToToggle?: boolean } = {},
    ) => {
      if (!this.isInitialized()) return;

      this.dubbedMenu.hidden = !open;
      this.dubbedButton.menuButton.setAttribute("aria-expanded", open.toString());

      if (open) {
        queueMicrotask(() => this.openSettingsButton?.focus?.());
      } else if (returnFocusToToggle) {
        queueMicrotask(() => this.dubbedButton.menuButton.focus?.());
      } else {
        this.dubbedButton.menuButton.blur();
      }
    };

    const toggleMenu = () => setMenuOpen(this.dubbedMenu.hidden);
    const closeMenu = (returnFocusToToggle = false) =>
      setMenuOpen(false, { returnFocusToToggle });

    const toggleVoicePopover = () => {
      if (!this.allowsVoicePopover()) return;
      const arrow = this.dubbedButton.dropdownArrow;
      this.voiceMenuButtonTooltip?.dismissImmediate();

      if (this.voicePopover?.isOpen) {
        this.voicePopover.hideNow();
        this.dubbedButton.setVoiceMenuOpen(false);
        queueMicrotask(() => this.queueButtonAutoHideAfterInteraction());
        return;
      }

      this.voicePopover?.showNow(arrow);
    };

    // The chevron is inside the translate segment. Handle it explicitly and
    // stop propagation so a chevron tap neither starts drag nor triggers
    // translation through the parent segment. Toggling on pointerdown keeps
    // repeated clicks symmetric: open -> close -> open.
    this.dubbedButton.dropdownArrow.addEventListener(
      "pointerdown",
      (event) => {
        if (!isPrimaryPointerAction(event)) return;
        event.preventDefault();
        event.stopPropagation();
        if (this.shouldSuppressPointerAction()) return;
        toggleVoicePopover();
      },
      { signal, capture: true },
    );
    this.dubbedButton.dropdownArrow.addEventListener(
      "pointerup",
      (event) => {
        event.preventDefault();
        event.stopPropagation();
      },
      { signal, capture: true },
    );
    this.dubbedButton.dropdownArrow.addEventListener(
      "click",
      (event) => {
        event.preventDefault();
        event.stopPropagation();
      },
      { signal, capture: true },
    );
    this.dubbedButton.dropdownArrow.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        toggleVoicePopover();
      },
      { signal, capture: true },
    );

    this.bindPrimaryAction(
      this.dubbedButton.translateButton,
      () => {
        closeMenu();
        this.events["click:translate"].dispatch();
      },
      signal,
      {
        shouldHandlePointer: (event) =>
          !(
            this.dubbedButton.direction === "column" &&
            this.allowsVoicePopover() &&
            this.shouldUseTouchVoiceInteraction(event)
          ),
      },
    );

    // Voice popover: show on hover over the translate button (desktop),
    // toggle on tap (touch/mobile).
    this.dubbedButton.translateButton.addEventListener(
      "pointerenter",
      (e) => {
        if (!this.shouldUseHoverVoiceInteraction(e)) return;
        // In row/default layout the dropdown arrow handles the popover.
        if (this.dubbedButton.direction !== "column") return;
        if (!this.allowsVoicePopover()) return;
        this.voicePopover?.scheduleShow(this.dubbedButton.translateButton);
      },
      { signal },
    );
    this.dubbedButton.translateButton.addEventListener(
      "pointerleave",
      (e) => {
        if (!this.shouldUseHoverVoiceInteraction(e)) return;
        if (this.dubbedButton.direction !== "column") return;
        this.voicePopover?.scheduleHide();
      },
      { signal },
    );
    this.dubbedButton.translateButton.addEventListener(
      "pointerup",
      (e) => {
        if (!this.shouldUseTouchVoiceInteraction(e)) return;
        // On touch in side layout, toggle the popover instead of translating.
        if (this.dubbedButton.direction !== "column") return;
        if (this.shouldSuppressPointerAction()) return;
        if (!this.allowsVoicePopover()) return;
        e.preventDefault();
        e.stopPropagation();

        if (this.voicePopover?.isOpen) {
          this.voicePopover.hideNow();
          this.dubbedButton.setVoiceMenuOpen(false);
          queueMicrotask(() => this.queueButtonAutoHideAfterInteraction());
          return;
        }

        this.voicePopover?.showNow(this.dubbedButton.translateButton);
      },
      { signal },
    );

    // Voice popover selection handler.
    this.voicePopover.addEventListener("voiceChange", (voice) => {
      const useLive = voice === "live";

      if (this.data.useLivelyVoice === useLive) {
        queueMicrotask(() => this.queueButtonAutoHideAfterInteraction());
        return;
      }

      this.data.useLivelyVoice = useLive;
      void dubbedStorage.set("useLivelyVoice", useLive);
      this.syncVoicePopoverState();
      this.events["select:voiceType"].dispatch(useLive);
      queueMicrotask(() => this.queueButtonAutoHideAfterInteraction());
    });

    this.bindPrimaryAction(
      this.dubbedButton.pipButton,
      () => {
        closeMenu();
        this.events["click:pip"].dispatch();
      },
      signal,
    );

    this.bindPrimaryAction(
      this.dubbedButton.subtitlesButton,
      () => {
        closeMenu();
        this.events["click:subtitles"].dispatch();
      },
      signal,
    );

    this.bindPrimaryAction(this.dubbedButton.menuButton, toggleMenu, signal, {
      preventPointerDefault: true,
    });

    // #region [Events] Dubbed Button Dragging
    // `touch-action` is not inherited, so cover every segment that can become
    // a drag handle. This keeps Pointer Events flowing instead of being
    // cancelled by browser pan/zoom gestures.
    const touchAction = "none";
    this.dubbedButton.container.style.touchAction = touchAction;
    this.dubbedButton.translateButton.style.touchAction = touchAction;
    this.dubbedButton.dropdownArrow.style.touchAction = touchAction;
    this.dubbedButton.subtitlesButton.style.touchAction = touchAction;
    this.dubbedButton.pipButton.style.touchAction = touchAction;
    this.dubbedButton.menuButton.style.touchAction = touchAction;

    this.dubbedButton.container.addEventListener(
      "pointerdown",
      this.onButtonDragPointerDown,
      { signal },
    );
    document.addEventListener("pointermove", this.onButtonDragPointerMove, {
      signal,
      capture: true,
    });
    document.addEventListener("pointerup", this.onButtonDragPointerUp, {
      signal,
      capture: true,
    });
    document.addEventListener("pointercancel", this.onButtonDragPointerCancel, {
      signal,
      capture: true,
    });
    this.dubbedButton.container.addEventListener(
      "lostpointercapture",
      this.onButtonDragPointerCancel,
      { signal },
    );

    // #endregion [Events] Dubbed Button Dragging
    // #endregion [Events] Dubbed Button
    // #region [Events] Dubbed Menu
    this.dubbedMenu.container.addEventListener(
      "click",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      },
      { signal },
    );

    for (const event of ["pointerdown"]) {
      this.dubbedMenu.container.addEventListener(
        event,
        (e) => {
          e.stopImmediatePropagation();
        },
        { signal },
      );
    }

    // Close the quick-settings menu when clicking outside.
    // Capture phase ensures we run even if the host page stops bubbling.
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (this.dubbedMenu.hidden) return;

        const path =
          typeof e.composedPath === "function"
            ? (e.composedPath() as unknown as EventTarget[])
            : [];

        // Keep menu open while interacting with dialogs spawned from it
        // (language picker, etc.).
        const isInsideDialog = path.some(
          (node) =>
            node instanceof HTMLElement &&
            node.classList.contains("dubbed-dialog-container"),
        );

        if (
          isEventInside(e, this.dubbedMenu.container) ||
          isEventInside(e, this.dubbedButton.menuButton) ||
          isEventInside(e, this.dubbedButton.container) ||
          isInsideDialog
        ) {
          return;
        }

        closeMenu(false);
      },
      { signal, capture: true, passive: true },
    );

    // Escape closes the menu when focused inside it.
    // NOTE: We keep the WAI-ARIA pattern (return focus to the toggle) only
    // when the user is in *keyboard navigation* mode (Tab). Otherwise, ESC is
    // treated as a quick-dismiss and we blur the toggle so the auto-hide timer
    // can work as expected.
    //
    // This fixes: "ESC close doesn't auto-hide after delay; works only when
    // using the close button".
    this.dubbedMenu.container.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Escape") return;

        const keyboardNav =
          document.documentElement.classList.contains("dubbed-keyboard-nav");

        e.preventDefault();
        e.stopPropagation();

        closeMenu(keyboardNav);

        // Closing via keyboard doesn't trigger pointerleave/focusout reliably,
        // so we manually queue overlay auto-hide when the overlay isn't hovered.
        const hovered =
          this.dubbedButton.container.matches(":hover") ||
          this.dubbedMenu.container.matches(":hover");

        if (!hovered) {
          this.videoHandler?.overlayVisibility?.queueAutoHide?.();
        }
      },
      { signal },
    );

    // #region [Events] Dubbed Menu Header
    this.downloadTranslationButton.addEventListener("click", () => {
      this.events["click:downloadTranslation"].dispatch();
    });

    this.downloadSubtitlesButton.addEventListener(
      "click",
      () => {
        this.events["click:downloadSubtitles"].dispatch();
      },
      { signal },
    );

    this.openSettingsButton.addEventListener(
      "click",
      () => {
        closeMenu();
        this.events["click:settings"].dispatch();
      },
      { signal },
    );

    // #endregion [Events] Dubbed Menu Header
    // #region [Events] Dubbed Menu Body
    this.languagePairSelect.fromSelect.addEventListener(
      "selectItem",
      (language) => {
        if (this.videoHandler?.videoData) {
          this.videoHandler.videoData.detectedLanguage = language;
          this.videoHandler.videoManager.rememberUserLanguageSelection(
            this.videoHandler.videoData.videoId,
            language,
          );
        }
        this.events["select:fromLanguage"].dispatch(language);
      },
    );

    this.languagePairSelect.toSelect.addEventListener(
      "selectItem",
      async (language) => {
        if (this.videoHandler?.videoData) {
          this.videoHandler.translateToLang =
            this.videoHandler.videoData.responseLanguage = language;
        }
        const prevResponseLanguage = this.data.responseLanguage;
        if (prevResponseLanguage !== language) {
          this.data.responseLanguage = language;
          await dubbedStorage.set("responseLanguage", this.data.responseLanguage);
        }

        // UX: keep the "Don't translate from selected languages" list in sync
        // with the selected response language, but only while the list still
        // looks like the old default.
        if (
          this.data.enabledDontTranslateLanguages &&
          Array.isArray(this.data.dontTranslateLanguages) &&
          this.data.dontTranslateLanguages.length === 1 &&
          prevResponseLanguage !== language &&
          typeof prevResponseLanguage === "string" &&
          this.data.dontTranslateLanguages[0] === prevResponseLanguage
        ) {
          this.data.dontTranslateLanguages = [language];
          await dubbedStorage.set(
            "dontTranslateLanguages",
            this.data.dontTranslateLanguages,
          );
        }
        this.events["select:toLanguage"].dispatch(language);
      },
    );

    this.subtitlesSelect.addEventListener("beforeOpen", async (dialog) => {
      if (!this.videoHandler?.videoData) {
        return;
      }

      const subtitleLanguage = this.videoHandler.getPreferredSubtitlesLanguage(
        this.videoHandler.videoData.detectedLanguage,
        this.videoHandler.videoData.responseLanguage,
      );
      if (!subtitleLanguage) {
        return;
      }

      const cacheKey = this.videoHandler.getSubtitlesCacheKey(
        this.videoHandler.videoData.videoId,
        this.videoHandler.videoData.detectedLanguage,
        subtitleLanguage,
      );
      if (this.videoHandler.subtitlesCacheKey === cacheKey) {
        return;
      }

      if (this.videoHandler.cacheManager.getSubtitles(cacheKey) !== undefined) {
        await this.videoHandler.ensureSubtitlesForCurrentLangPair();
        return;
      }

      const prevLoading = this.dubbedButton?.loading ?? false;
      if (this.dubbedButton) {
        this.dubbedButton.loading = true;
      }
      const loadingEl = ui.createInlineLoader();
      loadingEl.style.margin = "0 auto";
      dialog.footerContainer.appendChild(loadingEl);
      try {
        await this.videoHandler.ensureSubtitlesForCurrentLangPair();
      } finally {
        loadingEl.remove();
        if (this.dubbedButton) {
          this.dubbedButton.loading = prevLoading;
        }
      }
    });

    this.subtitlesSelect.addEventListener("selectItem", (data) => {
      this.events["select:subtitles"].dispatch(data);
    });

    this.videoVolumeSlider.addEventListener("input", (value, fromSetter) => {
      if (this.videoVolumeSliderLabel) {
        this.videoVolumeSliderLabel.value = value;
      }
      if (fromSetter) {
        return;
      }

      this.events["input:videoVolume"].dispatch(value);
    });

    this.translationVolumeSlider.addEventListener(
      "input",
      (value, fromSetter) => {
        if (this.translationVolumeSliderLabel) {
          this.translationVolumeSliderLabel.value = value;
        }
        if (this.data.defaultVolume !== value) {
          this.data.defaultVolume = value;
          this.scheduleDefaultVolumePersist();
        }
        if (fromSetter) {
          return;
        }

        this.events["input:translationVolume"].dispatch(value);
      },
    );

    // #endregion [Events] Dubbed Menu Body
    // #endregion [Events] Dubbed Menu
    return this;
  }

  updateButtonLayout(
    position: Position,
    direction: Direction,
    options: { keepVoicePopover?: boolean } = {},
  ) {
    if (!this.isInitialized()) {
      return this;
    }

    this.dubbedMenu.position = position;

    this.dubbedButton.position = position;
    this.dubbedButton.direction = direction;
    this.dubbedButton.syncDropdownArrowPlacement();

    this.dubbedButtonTooltip.setPosition(this.dubbedButton.tooltipPos);
    this.subtitlesButtonTooltip.setPosition(this.dubbedButton.tooltipPos);
    this.voiceMenuButtonTooltip.setPosition(this.dubbedButton.tooltipPos);
    this.voiceMenuButtonTooltip.hidden =
      this.dubbedButton.dropdownArrow.hidden === true;

    if (!options.keepVoicePopover && this.voicePopover?.isOpen) {
      this.voicePopover.hideNow();
      this.voiceMenuButtonTooltip?.dismissImmediate();
      this.dubbedButton.setVoiceMenuOpen(false);
    }

    this.syncTranslateButtonTooltip();

    return this;
  }

  /** Sync the voice popover's active state with the current data. */
  syncVoicePopoverState(): this {
    if (!this.isInitialized()) return this;
    const activeVoice =
      this.data.useLivelyVoice === false ? "standard" : "live";
    this.voicePopover.activeVoice = activeVoice;
    this.dubbedButton.container.dataset.voiceType = activeVoice;
    return this;
  }

  syncSubtitlesButtonState(isActive?: boolean): this {
    if (!this.isInitialized()) return this;

    const active =
      isActive ??
      Array.from(this.subtitlesSelect?.selectedValues ?? []).some(
        (value) => value !== "disabled",
      );
    this.dubbedButton.subtitlesActive = active;
    return this;
  }

  private getOverlayRootElement(): HTMLElement {
    const root = this.tooltipParentElement;
    return root instanceof ShadowRoot ? (root.host as HTMLElement) : root;
  }

  private shouldSuppressPointerAction(): boolean {
    return (
      Boolean(this.dragState?.active) ||
      Date.now() - this.lastButtonDragEndAt < this.dragActionSuppressMs
    );
  }

  private closeFloatingButtonUI(): void {
    if (!this.isInitialized()) return;
    this.dubbedMenu.hidden = true;
    this.dubbedButton.menuButton.setAttribute("aria-expanded", "false");
    this.voicePopover?.hideNow();
    this.voiceMenuButtonTooltip?.dismissImmediate();
    this.dubbedButton.setVoiceMenuOpen(false);
  }

  private isElementHovered(element: HTMLElement | null | undefined): boolean {
    if (!element?.isConnected) return false;

    try {
      return element.matches(":hover");
    } catch {
      return false;
    }
  }

  private getFloatingInteractionTargets(): HTMLElement[] {
    if (!this.isInitialized()) return [];

    return [
      this.dubbedButton.container,
      this.dubbedMenu.container,
      this.voicePopover.container,
    ].filter((element) => element.isConnected);
  }

  private isKeyboardFocusWithinFloatingUI(): boolean {
    if (
      typeof document === "undefined" ||
      typeof document.hasFocus !== "function" ||
      !document.hasFocus() ||
      !document.documentElement.classList.contains("dubbed-keyboard-nav")
    ) {
      return false;
    }

    const active = getDeepActiveElement(document);
    if (!(active instanceof Node)) return false;

    return this.getFloatingInteractionTargets().some((target) =>
      containsCrossShadow(target, active),
    );
  }

  shouldKeepVisibleForInteraction(): boolean {
    if (!this.isInitialized()) return false;

    const hoverActive =
      !isTouchFirstInput() &&
      this.getFloatingInteractionTargets().some((target) =>
        this.isElementHovered(target),
      );

    return (
      this.hasOpenFloatingButtonUI() ||
      hoverActive ||
      this.isKeyboardFocusWithinFloatingUI()
    );
  }

  private blurPointerFocusInsideButton(): void {
    if (!this.isInitialized()) return;
    if (document.documentElement.classList.contains("dubbed-keyboard-nav")) return;

    const active = getDeepActiveElement(document);
    if (
      active instanceof HTMLElement &&
      containsCrossShadow(this.dubbedButton.container, active)
    ) {
      active.blur();
    }
  }

  private hasOpenFloatingButtonUI(): boolean {
    if (!this.isInitialized()) return false;
    return !this.dubbedMenu.hidden || Boolean(this.voicePopover?.isOpen);
  }

  private queueButtonAutoHideAfterInteraction(): void {
    if (!this.isInitialized()) return;

    if (this.shouldKeepVisibleForInteraction()) {
      this.videoHandler?.overlayVisibility?.cancel?.();
      return;
    }

    this.blurPointerFocusInsideButton();

    if (this.shouldKeepVisibleForInteraction()) {
      this.videoHandler?.overlayVisibility?.cancel?.();
      return;
    }

    this.videoHandler?.overlayVisibility?.queueAutoHide?.();
  }

  private ensureDockPreview(): HTMLElement | null {
    if (!this.isInitialized()) {
      return null;
    }

    if (this.dockPreview?.isConnected) {
      return this.dockPreview;
    }

    const preview = this.dubbedButton.container.cloneNode(true) as HTMLElement;
    preview.classList.add("dubbed-segmented-button--dock-preview");
    preview.classList.remove(
      "dubbed-segmented-button--dragging",
      "dubbed-segmented-button--hidden",
    );
    preview.removeAttribute("id");
    preview.removeAttribute("aria-grabbed");
    preview.setAttribute("aria-hidden", "true");
    preview.querySelectorAll<HTMLElement>("[tabindex]").forEach((element) => {
      element.tabIndex = -1;
    });

    this.root.appendChild(preview);
    this.dockPreview = preview;
    return preview;
  }

  private removeDockPreview(): void {
    this.dockPreview?.remove();
    this.dockPreview = null;
  }

  private syncDockPreview(position: Position, direction: Direction): void {
    const preview = this.ensureDockPreview();
    if (!preview) return;

    preview.dataset.position = position;
    preview.dataset.direction = direction;
    preview.dataset.status = this.dubbedButton.status;
    preview.dataset.loading = this.dubbedButton.loading.toString();
    preview.dataset.dragTarget = "true";
    preview.classList.toggle(
      "dubbed-segmented-button--dock-preview-side",
      direction === "column",
    );

    preview
      .querySelectorAll<HTMLElement>("[aria-expanded]")
      .forEach((element) => {
        element.setAttribute("aria-expanded", "false");
      });

    const arrow = preview.querySelector<HTMLElement>(".dubbed-dropdown-arrow");
    if (arrow) {
      arrow.hidden = direction === "column";
      arrow.setAttribute("aria-hidden", (direction === "column").toString());
    }
  }

  private updateDraggingButtonPosition(): void {
    const state = this.dragState;
    if (!this.isInitialized() || !state?.active) return;

    const rootRect = this.getOverlayRootElement().getBoundingClientRect();
    state.rootRect = rootRect;

    const buttonRect = this.dubbedButton.container.getBoundingClientRect();
    const maxLeft = Math.max(0, rootRect.width - buttonRect.width);
    const maxTop = Math.max(0, rootRect.height - buttonRect.height);
    const nextLeft = Math.max(
      0,
      Math.min(state.clientX - rootRect.left - buttonRect.width / 2, maxLeft),
    );
    const nextTop = Math.max(
      0,
      Math.min(state.clientY - rootRect.top - buttonRect.height / 2, maxTop),
    );

    this.dubbedButton.container.style.setProperty(
      "--dubbed-button-drag-left",
      `${nextLeft}px`,
    );
    this.dubbedButton.container.style.setProperty(
      "--dubbed-button-drag-top",
      `${nextTop}px`,
    );
  }

  private startActiveButtonDrag(): void {
    if (!this.isInitialized() || !this.dragState?.active) return;

    this.closeFloatingButtonUI();
    this.updateDraggingButtonPosition();
    this.dubbedButton.container.classList.add("dubbed-segmented-button--dragging");
    this.dubbedButton.container.dataset.dragging = "true";
    this.dubbedButton.container.setAttribute("aria-grabbed", "true");
    this.updateDragTarget(
      resolveButtonPositionFromPointer(
        this.dragState.clientX,
        this.dragState.clientY,
        this.dragState.rootRect,
        this.isBigContainer,
      ),
    );
  }

  private updateDragTarget(position: Position): void {
    if (!this.isInitialized() || !this.dragState) return;

    const { position: layoutPosition, direction } = resolveButtonLayout(
      this.isBigContainer,
      position,
    );

    if (this.dragState.targetPosition !== layoutPosition) {
      this.dragState.targetPosition = layoutPosition;
    }

    this.syncDockPreview(layoutPosition, direction);
  }

  private applyButtonDragFrame(): void {
    const state = this.dragState;
    if (!this.isInitialized() || !state?.active) {
      return;
    }

    state.frameId = null;
    this.updateDraggingButtonPosition();

    const nextPosition = resolveButtonPositionFromPointer(
      state.clientX,
      state.clientY,
      state.rootRect,
      this.isBigContainer,
    );
    this.updateDragTarget(nextPosition);
  }

  private requestButtonDragFrame(): void {
    const state = this.dragState;
    if (!state?.active || state.frameId !== null) {
      return;
    }

    state.frameId = requestAnimationFrame(() => this.applyButtonDragFrame());
  }

  private finishButtonDrag(commit: boolean): void {
    const state = this.dragState;
    if (!state) {
      return;
    }

    if (state.frameId !== null) {
      cancelAnimationFrame(state.frameId);
      state.frameId = null;
    }

    const pointerId = state.pointerId;
    const wasActive = state.active;
    const shouldCommit = commit && wasActive && this.isInitialized();
    const targetPosition = shouldCommit
      ? state.targetPosition
      : state.initialPosition;

    if (wasActive) {
      this.lastButtonDragEndAt = Date.now();
    }

    this.dragState = null;

    try {
      if (this.dubbedButton?.container.hasPointerCapture(pointerId)) {
        this.dubbedButton.container.releasePointerCapture(pointerId);
      }
    } catch {
      // Ignore pointer-capture races during teardown.
    }

    if (this.isInitialized()) {
      this.dubbedButton.container.classList.remove(
        "dubbed-segmented-button--dragging",
      );
      delete this.dubbedButton.container.dataset.dragging;
      this.dubbedButton.container.style.removeProperty("--dubbed-button-drag-left");
      this.dubbedButton.container.style.removeProperty("--dubbed-button-drag-top");
      this.dubbedButton.container.removeAttribute("aria-grabbed");
      this.removeDockPreview();

      if (wasActive) {
        const { position, direction } = this.calcButtonLayout(targetPosition);
        this.updateButtonLayout(position, direction);

        if (shouldCommit) {
          this.data.buttonPos = targetPosition;
          void dubbedStorage.set("buttonPos", targetPosition);
        }

        this.queueButtonAutoHideAfterInteraction();
      }
    } else {
      this.removeDockPreview();
    }
  }

  private beginButtonDragCandidate(event: PointerEvent): void {
    if (!this.isInitialized()) return;

    const rootRect = this.getOverlayRootElement().getBoundingClientRect();
    const initialPosition = normalizeButtonPosition(
      this.data.buttonPos ?? this.dubbedButton.position,
    );
    this.dragState = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      clientX: event.clientX,
      clientY: event.clientY,
      rootRect,
      active: false,
      initialPosition,
      targetPosition: initialPosition,
      frameId: null,
    };

    this.intervalIdleChecker.markActivity("overlay-button-drag-start");
  }

  onButtonDragPointerDown = (event: PointerEvent) => {
    if (!event.isPrimary || event.button !== 0 || this.dragState) return;

    this.beginButtonDragCandidate(event);
  };

  onButtonDragPointerMove = (event: PointerEvent) => {
    const state = this.dragState;
    if (state?.pointerId !== event.pointerId) {
      return;
    }

    state.clientX = event.clientX;
    state.clientY = event.clientY;

    if (!state.active) {
      const moved = Math.hypot(
        event.clientX - state.startClientX,
        event.clientY - state.startClientY,
      );
      if (moved < this.dragThresholdPx) {
        return;
      }

      state.active = true;
      try {
        this.dubbedButton?.container.setPointerCapture(event.pointerId);
      } catch {
        // Drag still works without capture while the pointer stays over the UI.
      }
      this.startActiveButtonDrag();
    }

    event.preventDefault();
    event.stopPropagation();
    this.intervalIdleChecker.markActivity("overlay-button-drag-move");
    this.requestButtonDragFrame();
  };

  onButtonDragPointerUp = (event: PointerEvent) => {
    const state = this.dragState;
    if (state?.pointerId !== event.pointerId) {
      return;
    }

    state.clientX = event.clientX;
    state.clientY = event.clientY;
    if (state.active) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.applyButtonDragFrame();
    }
    this.finishButtonDrag(true);
  };

  onButtonDragPointerCancel = (event: PointerEvent) => {
    const state = this.dragState;
    if (state?.pointerId !== event.pointerId) {
      return;
    }

    if (state.active) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    this.finishButtonDrag(false);
  };

  updateButtonOpacity(opacity: number) {
    if (!this.isInitialized() || !this.dubbedMenu.hidden) {
      return this;
    }

    const nextOpacity =
      opacity <= 0.01 && this.voicePopover?.isOpen && hasTouchScreen()
        ? 1
        : opacity;

    // Avoid redundant style writes on high-frequency interaction events.
    if (Math.abs(this.dubbedButton.opacity - nextOpacity) > 0.01) {
      this.dubbedButton.opacity = nextOpacity;
      // If the button is fading out, immediately close the voice popover so it
      // doesn't float in the void after the anchor disappears. Touch screens
      // keep the button visible while the popover is open because there is no
      // stable hover state to keep the overlay alive.
      if (nextOpacity <= 0.01) {
        this.voicePopover?.hideNow();
      }
    }
    return this;
  }

  private doReleaseUI(): void {
    this.dubbedButton?.remove();
    this.dubbedMenu?.remove();
    this.dubbedButtonTooltip?.release();
    this.subtitlesButtonTooltip?.release();
    this.voiceMenuButtonTooltip?.release();
    this.openSettingsButtonTooltip?.release();
    this.voicePopover?.release();

    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = undefined;
    }

    this.fullscreenHelper.destroy();

    destroyShadowMount(this.overlayMount);
    this.overlayMount = undefined;
  }

  private doReleaseUIEvents(): void {
    this.abortController?.abort();
    this.abortController = null;

    this.finishButtonDrag(false);
    this.flushDefaultVolumePersist();

    for (const event of Object.values(this.events)) {
      event.clear();
    }
  }

  release() {
    if (!this.isInitialized()) {
      return this;
    }

    // Release events first to prevent late handlers from touching removed DOM.
    this.doReleaseUIEvents();
    this.doReleaseUI();

    this.initialized = false;
    return this;
  }

  get isBigContainer() {
    return this.fullscreenHelper.isBigContainer(
      OverlayView.BIG_CONTAINER_WIDTH_PX,
    );
  }

  private setupResizeObserver(): void {
    if (this.resizeObserver) {
      return;
    }

    this.resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width } = entry.contentRect;
        const currentIsBigContainer =
          width > OverlayView.BIG_CONTAINER_WIDTH_PX;

        if (this.lastIsBigContainer !== currentIsBigContainer) {
          this.lastIsBigContainer = currentIsBigContainer;
          this.handleContainerSizeChange(currentIsBigContainer);
        }

        this.updateMenuHeight(entry.contentRect.height);
      }
    });

    const target = this.fullscreenHelper.getResizeObserverTarget();
    this.resizeObserver.observe(target);
  }

  private updateMenuHeight(containerHeight?: number): void {
    if (!this.isInitialized() || !this.dubbedMenu?.container) {
      return;
    }

    let height: number;

    if (containerHeight && containerHeight > 200) {
      height = containerHeight;
    } else {
      const target = this.fullscreenHelper.getResizeObserverTarget();
      const rect = target.getBoundingClientRect();
      height = rect.height || target.clientHeight || window.innerHeight * 0.75;
    }

    if (!height || height < 200) {
      height = window.innerHeight * 0.75;
    }

    this.dubbedMenu.container.style.setProperty(
      "--dubbed-container-height",
      `${height}px`,
    );
  }

  private handleContainerSizeChange(isBigContainer: boolean): void {
    if (!this.isInitialized()) {
      return;
    }

    const preferredPosition = normalizeButtonPosition(
      this.data.buttonPos ?? this.dubbedButton.position,
    );
    const { position, direction } = resolveButtonLayout(
      isBigContainer,
      preferredPosition,
    );

    if (
      position !== this.dubbedButton.position ||
      direction !== this.dubbedButton.direction
    ) {
      this.updateButtonLayout(position, direction);
    }
  }

  get pipButtonVisible() {
    return isPiPAvailable() && !!this.data.showPiPButton;
  }
}
