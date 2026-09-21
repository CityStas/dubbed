import { localizationProvider } from "./localization/localizationProvider";
import type { Phrase } from "./types/localization";

class DubbedLocalizedError extends Error {
  override name = "DubbedLocalizedError";

  /** Original (non-localized) message key. */
  unlocalizedMessage: Phrase;

  /** Resolved localized message. */
  localizedMessage: string;

  constructor(message: Phrase) {
    const rawMessage = String(message);
    // Сырые сообщения об ошибке (например «Yandex couldn't translate video»,
    // которое при падении сервиса описывает сам провайдер) НЕ являются ключами
    // локализации. Если передать их в get()/getDefault(), localizationProvider
    // спамит в консоль «locale {} doesn't contain key ...». Определяем, похож ли
    // аргумент на ключ (буквы/цифры/._-), и для «не-ключей» не дёргаем словари.
    const isLocaleKey = /^[a-zA-Z0-9_.-]+$/.test(rawMessage);
    if (!isLocaleKey) {
      super(rawMessage);
      this.unlocalizedMessage = message;
      this.localizedMessage = rawMessage;
      return;
    }

    super(localizationProvider.getDefault(message));
    this.unlocalizedMessage = message;
    this.localizedMessage = localizationProvider.get(message);
  }
}

export default DubbedLocalizedError;
