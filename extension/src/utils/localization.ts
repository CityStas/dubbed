import type { ResponseLang } from "@vot.js/shared/types/data";

function getNavigatorLang() {
  if (typeof navigator === "undefined") {
    return "en";
  }

  return navigator.language?.substring(0, 2).toLowerCase() || "en";
}

export const lang = getNavigatorLang();

/**
 * Целевой язык перевода по умолчанию — русский.
 *
 * Пара языков по умолчанию обязана быть «Авто → Русский», как и язык
 * интерфейса расширения (в `localizationProvider` `localeLangOverride`
 * жёстко `"ru"`).
 *
 * Раньше дефолт вычислялся из `navigator.language`: для локали `kk` он молча
 * давал «Авто → Казахский», для `en` — «Авто → Английский». Пользователь не
 * выбирал это и не понимал, откуда взялся целевой язык. Теперь дефолт
 * детерминированный; другой целевой язык выбирается в меню и сохраняется в
 * storage (`responseLanguage`), поэтому кастомизация не теряется.
 *
 * `availableTTS` = ["ru", "en", "kk"] — полный список допустимых значений.
 */
export const calculatedResLang: ResponseLang = "ru";
