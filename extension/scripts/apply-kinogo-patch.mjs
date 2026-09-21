/**
 * Применяет Kinogo-патчи к node_modules/@vot.js/ext (идемпотентно).
 * Запуск: node ./scripts/apply-kinogo-patch.mjs
 * Вызывай ПОСЛЕ apply-rezka-patch.mjs (или вместе), если файлы перезаписаны.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const extDist = path.join(
  root,
  "node_modules",
  "@vot.js",
  "ext",
  "dist",
);

if (!fs.existsSync(extDist)) {
  console.error("[kinogo-patch] node_modules/@vot.js/ext не найден. Сначала npm install.");
  process.exit(1);
}

const read = (p) => fs.readFileSync(p, "utf8");
const write = (p, s) => fs.writeFileSync(p, s);

const files = {
  helperJs: path.join(extDist, "helpers", "kinogo.js"),
  helperDts: path.join(extDist, "helpers", "kinogo.d.ts"),
  helperIndex: path.join(extDist, "helpers", "index.js"),
  helperIndexDts: path.join(extDist, "helpers", "index.d.ts"),
  serviceJs: path.join(extDist, "types", "service.js"),
  serviceDts: path.join(extDist, "types", "service.d.ts"),
  sites: path.join(extDist, "data", "sites.js"),
};

// 1. Копируем helper-файлы
const patchDir = path.join(root, "scripts", "kinogo-patch-files");
fs.mkdirSync(patchDir, { recursive: true });
if (!fs.existsSync(path.join(patchDir, "kinogo.js"))) {
  console.error("[kinogo-patch] нет scripts/kinogo-patch-files/kinogo.js");
  process.exit(1);
}
fs.copyFileSync(path.join(patchDir, "kinogo.js"), files.helperJs);
fs.copyFileSync(path.join(patchDir, "kinogo.d.ts"), files.helperDts);

// 2. types/service.js — enum
{
  let t = read(files.serviceJs);
  if (!t.includes('ExtVideoService["kinogo"]')) {
    t = t.replace(
      'ExtVideoService["rezka"] = "rezka";',
      'ExtVideoService["rezka"] = "rezka";\n    ExtVideoService["kinogo"] = "kinogo";',
    );
    write(files.serviceJs, t);
  }
}
// 3. types/service.d.ts — enum
{
  let t = read(files.serviceDts);
  if (!t.includes("kinogo = ")) {
    t = t.replace(
      'rezka = "rezka"',
      'rezka = "rezka",\n    kinogo = "kinogo"',
    );
    write(files.serviceDts, t);
  }
}
// 4. helpers/index.js — import + availableHelpers
{
  let t = read(files.helperIndex);
  if (!t.includes("kinogo.js")) {
    t = t.replace(
      'import RezkaHelper from "./rezka.js";',
      'import RezkaHelper from "./rezka.js";\nimport KinogoHelper from "./kinogo.js";',
    );
    t = t.replace(
      "[ExtVideoService.rezka]: RezkaHelper,",
      "[ExtVideoService.rezka]: RezkaHelper,\n    [ExtVideoService.kinogo]: KinogoHelper,",
    );
    write(files.helperIndex, t);
  }
}
// 5. helpers/index.d.ts — import + availableHelpers
{
  let t = read(files.helperIndexDts);
  if (!t.includes("kinogo.js")) {
    t = t.replace(
      'import RezkaHelper from "./rezka.js";',
      'import RezkaHelper from "./rezka.js";\nimport KinogoHelper from "./kinogo.js";',
    );
    t = t.replace(
      "rezka: typeof RezkaHelper;",
      "rezka: typeof RezkaHelper;\n    kinogo: typeof KinogoHelper;",
    );
    write(files.helperIndexDts, t);
  }
}
// 6. data/sites.js — сервис kinogo (страница kinogo + iframe-плеер ortified)
{
  let t = read(files.sites);
  if (!t.includes("ExtVideoService.kinogo")) {
    const siteFragmentPath = path.join(patchDir, "kinogo-site.js");
    const siteFragment = fs.readFileSync(siteFragmentPath, "utf8").trimEnd();
    // Вставляем блок kinogo ПЕРЕД началом skilljar-блока (т.е. после rezka).
    const anchor = `    {
        host: ExtVideoService.skilljar,`;
    if (t.includes(anchor)) {
      t = t.replace(anchor, siteFragment + "\n" + anchor);
      write(files.sites, t);
    } else {
      console.error("[kinogo-patch] не найден якорь skilljar-блока в sites.js. Сначала apply-rezka-patch.mjs.");
      process.exit(1);
    }
  }
}

// 7. Синхронизация селектора kinogo. Источник истины — `kinogo-site.js`.
//
// ВАЖНО: шаг 6 вставляет блок kinogo в sites.js ТОЛЬКО если его там ещё нет.
// На повторных прогонах (sites.js уже пропатчен) правка `kinogo-site.js` в
// сборку НЕ попадала — та же ловушка, что и с helper-файлами. Поэтому здесь
// принудительно переписываем `selector:` внутри блока kinogo на актуальный.
//
// Никогда не монтируем оверлей внутрь <video>: дети видео — fallback-контент
// и не рендерятся во время воспроизведения (кнопка была 0×0 и невидимой).
{
  const siteFragment = fs.readFileSync(
    path.join(patchDir, "kinogo-site.js"),
    "utf8",
  );
  const wantSelector = /selector:\s*("(?:[^"\\]|\\.)*")/.exec(siteFragment)?.[1];
  if (!wantSelector) {
    console.error("[kinogo-patch] в kinogo-site.js не найден selector:");
    process.exit(1);
  }

  const t = read(files.sites);
  const anchor = "host: ExtVideoService.kinogo,";
  const anchorAt = t.indexOf(anchor);
  if (anchorAt < 0) {
    console.error("[kinogo-patch] в sites.js нет блока kinogo. Сначала apply-rezka-patch.mjs.");
    process.exit(1);
  }

  const tail = t.slice(anchorAt);
  const current = /selector:\s*"(?:[^"\\]|\\.)*"/.exec(tail)?.[0];
  if (!current) {
    console.error("[kinogo-patch] в блоке kinogo нет selector:");
    process.exit(1);
  }

  const next = `selector: ${wantSelector}`;
  if (current !== next) {
    write(files.sites, t.slice(0, anchorAt) + tail.replace(current, next));
    console.log(`[kinogo-patch] селектор kinogo обновлён:\n  было:  ${current}\n  стало: ${next}`);
  } else {
    console.log("[kinogo-patch] селектор kinogo уже актуален");
  }
}

console.log("[kinogo-patch] готово: helper kinogo установлен в @vot.js/ext");