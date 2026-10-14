/**
 * Применяет Rezka-патчи к node_modules/@vot.js/ext (идемпотентно).
 * Запуск: node ./scripts/apply-rezka-patch.mjs
 * Вызывай после npm install, если файлы были перезаписаны.
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
  console.error("[rezka-patch] node_modules/@vot.js/ext не найден. Сначала npm install.");
  process.exit(1);
}

const read = (p) => fs.readFileSync(p, "utf8");
const write = (p, s) => fs.writeFileSync(p, s);
const ensureOnce = (text, marker, addition) =>
  text.includes(marker) ? text : text.replace(marker, marker + "\n" + "");

const files = {
  helperJs: path.join(extDist, "helpers", "rezka.js"),
  helperDts: path.join(extDist, "helpers", "rezka.d.ts"),
  helperIndex: path.join(extDist, "helpers", "index.js"),
  helperIndexDts: path.join(extDist, "helpers", "index.d.ts"),
  serviceJs: path.join(extDist, "types", "service.js"),
  serviceDts: path.join(extDist, "types", "service.d.ts"),
  sites: path.join(extDist, "data", "sites.js"),
};

// 1. Копируем helper-файлы (генерируются вместе с патчем, живут тут же)
const patchDir = path.join(root, "scripts", "rezka-patch-files");
fs.mkdirSync(patchDir, { recursive: true });
if (!fs.existsSync(path.join(patchDir, "rezka.js"))) {
  console.error("[rezka-patch] нет scripts/rezka-patch-files/rezka.js");
  process.exit(1);
}
fs.copyFileSync(path.join(patchDir, "rezka.js"), files.helperJs);
fs.copyFileSync(path.join(patchDir, "rezka.d.ts"), files.helperDts);

// 2. types/service.js — enum
{
  let t = read(files.serviceJs);
  if (!t.includes('ExtVideoService["rezka"]')) {
    t = t.replace(
      'ExtVideoService["skilljar"] = "skilljar";',
      'ExtVideoService["skilljar"] = "skilljar";\n    ExtVideoService["rezka"] = "rezka";',
    );
    write(files.serviceJs, t);
  }
}
// 3. types/service.d.ts — enum
{
  let t = read(files.serviceDts);
  if (!t.includes("rezka = ")) {
    t = t.replace(
      "skilljar = \"skilljar\"",
      "skilljar = \"skilljar\",\n    rezka = \"rezka\"",
    );
    write(files.serviceDts, t);
  }
}
// 4. helpers/index.js — import + availableHelpers
{
  let t = read(files.helperIndex);
  if (!t.includes("rezka.js")) {
    t = t.replace(
      'import PicartoHelper from "./picarto.js";',
      'import PicartoHelper from "./picarto.js";\nimport RezkaHelper from "./rezka.js";',
    );
    t = t.replace(
      "[ExtVideoService.skilljar]: SkilljarHelper,",
      "[ExtVideoService.skilljar]: SkilljarHelper,\n    [ExtVideoService.rezka]: RezkaHelper,",
    );
    write(files.helperIndex, t);
  }
}
// 5. helpers/index.d.ts — import + availableHelpers
{
  let t = read(files.helperIndexDts);
  if (!t.includes("rezka.js")) {
    t = t.replace(
      'import PicartoHelper from "./picarto.js";',
      'import PicartoHelper from "./picarto.js";\nimport RezkaHelper from "./rezka.js";',
    );
    t = t.replace(
      "skilljar: typeof SkilljarHelper;",
      "skilljar: typeof SkilljarHelper;\n    rezka: typeof RezkaHelper;",
    );
    write(files.helperIndexDts, t);
  }
}
// 6. data/sites.js — сервис rezka
//
// Список зеркал Rezka. ВАЖНО: держать его ОДНИМ источником правды — правки
// «руками» в node_modules теряются при `npm install`, а idempotent-проверка
// `t.includes("ExtVideoService.rezka")` (как было раньше) не давала добавить
// НОВОЕ зеркало в уже пропатченный файл: блок считался установленным, и
// `rezka-tv.org` молча не попадал ни в sites.js, ни в манифест.
const REZKA_DOMAINS = [
  "rezka\\.ag",
  "hdrezka\\.ag",
  "hdrezka-home\\.tv",
  "hdrezka\\.me",
  "hdrezka\\.fi",
  "rezka\\.tv",
  "standby-rezka\\.tv",
  "rezka-tv\\.org",
];
const rezkaMatchLines = REZKA_DOMAINS.map(
  (d) => `            /^(www\\.)?${d}$/,`,
).join("\n");
{
  let t = read(files.sites);
  if (!t.includes("ExtVideoService.rezka")) {
    const anchor = `    {
        host: ExtVideoService.mediafile,
        url: "https://mediafile.cc/",
        match: /^(www\\.)?mediafile\\.cc$/,
        selector: "div#playerContainer",
        needExtraData: true,
    },`;
    const withRezka = anchor + `
    {
        host: ExtVideoService.rezka,
        url: "stub",
        match: [
${rezkaMatchLines}
        ],
        selector: "#videoplayer, .b-player",
        needExtraData: true,
    },`;
    t = t.replace(anchor, withRezka);
    write(files.sites, t);
  } else {
    // Блок уже есть — доводим список зеркал до актуального, вставляя
    // недостающие строки ПЕРЕД закрывающей `],` блока rezka.
    const blockStart = t.indexOf("ExtVideoService.rezka");
    const closeIdx = t.indexOf("        ],", blockStart);
    if (closeIdx !== -1) {
      const block = t.slice(blockStart, closeIdx);
      const missing = REZKA_DOMAINS.filter(
        (d) => !block.includes(`?${d}$`),
      ).map((d) => `            /^(www\\.)?${d}$/,`);
      if (missing.length) {
        t = t.slice(0, closeIdx) + missing.join("\n") + "\n" + t.slice(closeIdx);
        write(files.sites, t);
        console.log(`[rezka-patch] добавлены зеркала: ${missing.length}`);
      }
    }
  }
}

console.log("[rezka-patch] готово: helper rezka установлен в @vot.js/ext");
