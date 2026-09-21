import { localizationProvider } from "../localization/localizationProvider";
import DubbedLocalizedError from "../DubbedLocalizedError";

type TimeoutId = ReturnType<typeof setTimeout>;

type TranslationEtaCountdownMessage = string | DubbedLocalizedError;

type TranslationEtaCountdownUpdateOptions = {
  /**
   * Countdown ticks are local UI refreshes, not fresh server responses, so they
   * must not affect the repeated-long-wait detector.
   */
  countLongWait?: boolean;
};

type TranslationEtaCountdownUpdate = (
  message: TranslationEtaCountdownMessage,
  signal: AbortSignal,
  options?: TranslationEtaCountdownUpdateOptions,
) => void | Promise<void>;

type TranslationEtaCountdownSyncOptions = {
  /**
   * The first render after `sync()` corresponds to a fresh backend response.
   * Later renders are local ticks and always disable long-wait counting.
   */
  countLongWaitOnFirstRender?: boolean;
};

const COUNTDOWN_TICK_MS = 1_000;

function normalizeRemainingTime(remainingTimeSeconds: number): number {
  if (!Number.isFinite(remainingTimeSeconds)) {
    return 0;
  }

  return Math.max(0, Math.ceil(remainingTimeSeconds));
}

function createEtaMessage(
  remainingSeconds: number,
): TranslationEtaCountdownMessage {
  if (remainingSeconds <= 0) {
    return new DubbedLocalizedError("TranslationDelayed");
  }

  // ЕДИНЫЙ статус ожидания (запрос 2026-09-13): пока идёт очередь Яндекса и
  // догрузка, кнопка показывает одну строку «Дождитесь окончания загрузки...»
  // со спиннером — без «Ещё примерно N минут», которые каждую минуту меняли
  // текст и выглядели как метания. Финальный статус «Готово! Нажмите "Play"»
  // приходит из обычного пути завершения перевода и здесь не затрагивается.
  //
  // Счётчик при этом продолжает тикать: `tick()` по-прежнему нужен, чтобы
  // продлевать жизнь спиннера и удерживать `deadlineMs` между поллингами.
  return localizationProvider.get("translationWaitingForAudio");
}

function getMessageIdentity(message: TranslationEtaCountdownMessage): string {
  return message instanceof DubbedLocalizedError
    ? `${message.name}:${message.unlocalizedMessage}`
    : message;
}

/**
 * Keeps the visible translation ETA moving between polling requests.
 *
 * Server responses still remain the source of truth: every call to `sync()`
 * recalculates the deadline from the latest `remainingTime`. Timer ticks only
 * render the local wall-clock countdown to avoid stale UI while the next poll is
 * still waiting.
 */
export class TranslationEtaCountdown {
  private deadlineMs = 0;
  private generation = 0;
  private lastMessageIdentity: string | null = null;
  private signal?: AbortSignal;
  private timeoutId?: TimeoutId;

  constructor(private readonly updateMessage: TranslationEtaCountdownUpdate) {}

  async sync(
    remainingTimeSeconds: number,
    signal: AbortSignal,
    options: TranslationEtaCountdownSyncOptions = {},
  ): Promise<void> {
    // Capture the previous deadline before `stop()` resets it: it powers the
    // monotonic clamp below (ETA must never jump up between polls).
    const prevDeadlineMs = this.deadlineMs;
    this.stop();

    const remainingSeconds = normalizeRemainingTime(remainingTimeSeconds);
    if (remainingSeconds <= 0 || signal.aborted) {
      return;
    }

    let effectiveSeconds = remainingSeconds;
    if (prevDeadlineMs > Date.now()) {
      const prevRemainingSeconds = Math.ceil(
        (prevDeadlineMs - Date.now()) / 1000,
      );
      // Monotonic display: a later poll returning a *larger* ETA (long videos
      // do this) must not rewind the countdown. Floor at 1s so the countdown
      // settles on "about a minute / less than a minute" instead of bouncing
      // back up, and never silently hits the "delayed" state via clamping.
      effectiveSeconds = Math.min(remainingSeconds, prevRemainingSeconds);
      if (effectiveSeconds < 1) {
        effectiveSeconds = 1;
      }
    }

    const generation = ++this.generation;
    this.deadlineMs = Date.now() + effectiveSeconds * 1000;
    this.signal = signal;

    await this.tick(generation, Boolean(options.countLongWaitOnFirstRender));
  }

  stop(): void {
    this.generation += 1;
    this.deadlineMs = 0;
    this.lastMessageIdentity = null;
    this.signal = undefined;

    if (this.timeoutId !== undefined) {
      clearTimeout(this.timeoutId);
      this.timeoutId = undefined;
    }
  }

  private async tick(generation: number, countLongWait = false): Promise<void> {
    if (generation !== this.generation) {
      return;
    }

    const signal = this.signal;
    if (!signal || signal.aborted) {
      this.stop();
      return;
    }

    const remainingSeconds = Math.max(
      0,
      Math.ceil((this.deadlineMs - Date.now()) / 1000),
    );
    const message = createEtaMessage(remainingSeconds);
    const messageIdentity = getMessageIdentity(message);

    if (messageIdentity !== this.lastMessageIdentity) {
      this.lastMessageIdentity = messageIdentity;
      await this.updateMessage(message, signal, { countLongWait });
    }

    if (generation !== this.generation || signal.aborted) {
      return;
    }

    if (remainingSeconds <= 0) {
      this.timeoutId = undefined;
      return;
    }

    this.timeoutId = setTimeout(() => {
      void this.tick(generation);
    }, COUNTDOWN_TICK_MS);
  }
}
