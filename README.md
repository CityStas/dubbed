# DUBBED

Бесплатное расширение для Chrome и Firefox: мгновенная AI-озвучка фильмов, сериалов и видео прямо в браузере. Ключевая фишка - Быстрая озвучка на HDrezka; работает в VK, Telegram, YouTube и сотнях других сайтов.

## Структура

```
index.html          лендинг (статика, без сборки — годится под GitHub Pages)
assets/             логотипы браузеров, иконка расширения
downloads/          готовые сборки для скачивания
extension/          исходники расширения (TypeScript, Vite + CRXJS)
```

## Установка расширения

**Chrome / Edge / Яндекс.Браузер**
1. Скачать `downloads/dubbed-chrome.zip` и распаковать.
2. Открыть `chrome://extensions`, включить «Режим разработчика».
3. «Загрузить распакованное расширение» → выбрать папку.

**Firefox**
1. Скачать `downloads/dubbed-firefox.xpi`.
2. `about:addons` → шестерёнка → «Установить из файла».

## Сборка из исходников

```bash
cd extension
npm install
npm run build:ext   # соберёт сборки для Chrome и Firefox в dist-ext/
```

## Лендинг локально

```bash
python -m http.server 8000
# открыть http://127.0.0.1:8000
```

Скорость бегущей строки сайтов — переменная `--marquee-duration` в `index.html` (больше = медленнее).
