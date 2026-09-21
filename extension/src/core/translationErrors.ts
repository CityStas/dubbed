import { safeNestedGet } from "../utils/errors";

/**
 * Яндекс в ответе на перевод умеет отдавать `status: FAILED` вместе с
 * `shouldRetry` — то есть «сейчас не получилось, повтори». Наблюдали значения
 * 1 и 7 (секунды). Раньше поле нигде не читалось: любая FAILED сразу
 * показывалась пользователю как «Возникла ошибка при переводе, попробуйте
 * позже», хотя сервер сам просил повторить запрос.
 *
 * Возвращает число секунд до повтора (0 — повтор не запрошен).
 */
export function getTranslationShouldRetry(value: unknown): number {
  const raw = safeNestedGet(value, ["data", "shouldRetry"]);
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return 0;
  }
  return raw;
}

export function notifyTranslationFailureIfNeeded(options: {
  aborted: boolean;
  translateApiErrorsEnabled: boolean;
  hadAsyncWait: boolean;
  videoId?: string;
  error: unknown;
  notify(params: { videoId?: string; message?: unknown }): void;
}): boolean {
  if (options.aborted) {
    return false;
  }

  if (!options.translateApiErrorsEnabled || !options.hadAsyncWait) {
    return options.hadAsyncWait;
  }

  options.notify({
    videoId: options.videoId,
    message: options.error,
  });
  return false;
}
