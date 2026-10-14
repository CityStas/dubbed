import fs from "node:fs/promises";
import path from "node:path";
import { zipDir } from "../../../scripts/zip/utils";
import type { BuildConfig } from "../env";
import { distExtDir, srcDir } from "../paths";

/**
 * Статические файлы расширения, которые не проходят через бандлер.
 *
 * `localfile-reader.{html,js}` — страница-ридер локальных файлов. Она объявлена
 * в `web_accessible_resources` (см. `manifest-helpers.ts`), поэтому обязана
 * лежать в корне собранного расширения; собирать её бандлом незачем — там нет
 * импортов.
 */
const STATIC_EXTENSION_FILES = ["localfile-reader.html", "localfile-reader.js"] as const;

export async function copyStaticExtensionFiles(targetDir: string): Promise<void> {
  await fs.mkdir(targetDir, { recursive: true });
  await Promise.all(
    STATIC_EXTENSION_FILES.map((fileName) =>
      fs.copyFile(
        path.join(srcDir, "extension", fileName),
        path.join(targetDir, fileName),
      ),
    ),
  );
}


export async function writeChromeUpdatesManifest({
  version,
  extensionId,
}: {
  version: string;
  extensionId: string;
}): Promise<string> {
  const updatesManifestPath = path.join(distExtDir, "update.xml");
  const xml =
    `<?xml version='1.0' encoding='UTF-8'?>\n` +
    `<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>\n` +
    `  <app appid='${extensionId}'>\n` +
    `    <updatecheck codebase='./dubbed-extension-chrome.zip' version='${version}' />\n` +
    `  </app>\n` +
    `</gupdate>\n`;

  await fs.writeFile(updatesManifestPath, xml, "utf8");
  return updatesManifestPath;
}

export async function finalizeChromeBuild(
  config: BuildConfig,
  headers: {
    version?: string;
    author?: string;
  },
): Promise<void> {
  const chromeDir = path.join(distExtDir, "chrome");
  const version = String(headers.version || "");

  await copyStaticExtensionFiles(chromeDir);

  const zipPath = path.join(distExtDir, "dubbed-extension-chrome.zip");
  await zipDir(chromeDir, zipPath);

  const updatesPath = await writeChromeUpdatesManifest({
    version,
    extensionId: config.CHROME_EXTENSION_ID,
  });

  console.log(`Chrome package: ${zipPath}`);
  console.log(`Chrome updates: ${updatesPath}`);
}

export async function getChromeExtensionBuildEnv(config: BuildConfig): Promise<{
  headers: { version?: string; author?: string };
  locales: string[];
  branch: string;
}> {
  const { getExtensionHeaders, getLocaleCodes } = await import(
    "./firefox-pipeline"
  );
  const [headers, locales] = await Promise.all([
    getExtensionHeaders(),
    getLocaleCodes(),
  ]);
  return { headers, locales, branch: config.REPO_BRANCH };
}
