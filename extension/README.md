# Dubbed: Экспресс AI Видео Переводчик

<p>Голосовое закадровое AI озвучивание иностранных фильмов, сериалов и видео</p>

Расширение/юзерскрипт, добавляющий мгновенный AI-перевод голосом и субтитрами
к видео на любом сайте с плеером.

- **Версия:** 1.0.0
- **Сборка расширения:** `npm run build:chrome` → `dist-ext/chrome/`
- **Сборка юзерскрипта:** `npm run build:gm` → `dist/dubbed.user.js`
- **Патч под Rezka:** `node scripts/apply-rezka-patch.mjs` (идемпотентный, до сборки)
- **Карта проекта:** `../../README-DUBBED.md`
- **Тест-стенд:** `../../Dubbed_extensions/dubbed-playwright-test/`
- **English:** [README-EN.md](./README-EN.md)

> Распространяется по лицензии MIT. Технологической основой является
> клиентский SDK Яндекс-перевода (внешние npm-пакеты `ext` / `core` / `shared`,
> см. `package.json`).


