/**
 * Pure manifest-building helpers shared between:
 * - vite/lib/extension/firefox-pipeline.ts (Firefox build pipeline)
 * - vite/lib/extension/manifest.config.ts (CRXJS Chrome manifest)
 *
 * No fs/build dependencies — only string/array transforms.
 */

export const EXTENSION_ICON_SIZES = [16, 32, 48, 64, 96, 128, 256] as const;

const DEFAULT_EXTENSION_NAME = "Dubbed: Экспресс AI Видео Переводчик";
const DEFAULT_EXTENSION_DESCRIPTION =
  "Голосовое закадровое AI озвучивание иностранных фильмов, сериалов и видео";
const DEFAULT_EXTENSION_VERSION = "0.0.0";
/**
 * `*.js` покрывает все бандлы, `*.html` — страницу-ридер локальных файлов.
 *
 * Имена намеренно заданы ГЛОБАМИ, а не точными путями: CRXJS пытается
 * резолвить точный путь как ассет сборки и падает, если такого entry нет
 * (`Could not load manifest asset`). Файл ридера не бандлится — он копируется
 * в собранное расширение как есть (см. `copyStaticExtensionFiles`).
 */
const EXTENSION_WEB_ACCESSIBLE_JS_GLOBS = ["*.js", "*.html"] as const;

export interface ExtensionHeaders {
  name?: string;
  description?: string;
  version?: string;
  author?: string;
  match?: string[];
  exclude?: string[];
  connect?: string[];
}

// ----------------------------------------------------------------
// Host permissions
// ----------------------------------------------------------------

function normalizeHostPermission(
  entry: string | undefined | null,
): string | null {
  if (!entry) return null;
  const value = String(entry).trim();
  if (!value) return null;
  if (value === "<all_urls>") return value;

  if (/^[a-z*]+:\/\//i.test(value)) {
    if (/^[a-z*]+:\/\/[^/]+\/?$/i.test(value)) {
      return `${value.replace(/\/?$/, "")}/*`;
    }
    return value;
  }

  return `*://*.${value}/*`;
}

export function normalizeHostPermissions(list: string[] = []): string[] {
  const normalized = list
    .map((item) => normalizeHostPermission(item))
    .filter((value): value is string => Boolean(value));

  return [...new Set(normalized)];
}

// ----------------------------------------------------------------
// Web-accessible resources
// ----------------------------------------------------------------

function normalizeWebAccessibleResourceMatch(
  pattern: string | undefined | null,
): string | null {
  if (!pattern) return null;
  const value = String(pattern).trim();
  if (!value) return null;
  if (value === "<all_urls>") {
    return "*://*/*";
  }

  // `file://` не имеет хоста, поэтому общий хостовый нормализатор ниже его
  // отбрасывает. А он нужен: ридер локальных файлов встраивается в `file://`
  // документ, и без `file:///*` в web_accessible_resources браузер запретит
  // такое встраивание.
  if (/^file:\/\//i.test(value)) {
    return value;
  }

  const match = /^([^:]+:\/\/[^/]+)(\/.*)?$/.exec(value);
  if (!match) {
    return null;
  }

  return `${match[1]}/*`;
}

function normalizeWebAccessibleResourceMatches(
  matches: string[] = [],
): string[] {
  return [
    ...new Set(
      matches
        .map((pattern) => normalizeWebAccessibleResourceMatch(pattern))
        .filter((pattern): pattern is string => Boolean(pattern)),
    ),
  ];
}

export function createWebAccessibleResources(
  matches: string[],
): Array<Record<string, unknown>> {
  const normalizedMatches = normalizeWebAccessibleResourceMatches(matches);
  if (!normalizedMatches.length) {
    return [];
  }

  return [
    {
      resources: [...EXTENSION_WEB_ACCESSIBLE_JS_GLOBS],
      matches: normalizedMatches,
    },
  ];
}

// ----------------------------------------------------------------
// Match splitting (origin-fallback vs direct)
// ----------------------------------------------------------------

export function splitMatchesForOriginFallback(matches: string[] = []): {
  originFallbackMatches: string[];
  directMatches: string[];
} {
  const originFallbackMatches: string[] = [];
  const directMatches: string[] = [];

  const getPath = (pattern: string): string | null => {
    if (pattern === "<all_urls>") return "/*";
    const result = /^[^:]+:\/\/[^/]+(\/.*)$/.exec(pattern);
    return result ? result[1] : null;
  };

  for (const match of matches) {
    const pathPart = getPath(String(match));
    if (pathPart === "/*") originFallbackMatches.push(String(match));
    else directMatches.push(String(match));
  }

  return { originFallbackMatches, directMatches };
}

// ----------------------------------------------------------------
// Icons
// ----------------------------------------------------------------

export function buildIconsMap(
  sizes: readonly number[] = EXTENSION_ICON_SIZES,
  pathPrefix: string = "icons",
): Record<number, string> {
  return Object.fromEntries(
    sizes.map((size) => [size, `${pathPrefix}/icon-${size}.png`]),
  ) as Record<number, string>;
}

// ----------------------------------------------------------------
// Content scripts
// ----------------------------------------------------------------

export interface ManifestPathStrategy {
  iconPathFn?: (size: number) => string;
  scriptPathFn?: (distJs: string) => string;
  background?: Record<string, unknown>;
}

/**
 * Мост для `file://` собирается отдельным standalone-IIFE
 * (`src/extension/localfile-bridge.iife.ts`), потому что CRXJS-лоадер делает
 * `import(chrome.runtime.getURL(...))`, а на `file://` ISOLATED-мир получает
 * opaque origin и такой импорт падает с `Failed to fetch dynamically imported
 * module` / `net::ERR_ABORTED` → мост не поднимается, GM-запросы прелюда уходят
 * в таймаут, кнопка перевода не появляется. Classic-скрипт из того же origin
 * на `file://` грузится нормально — это и есть обход.
 *
 * Путь указывается к ИСХОДНИКУ (`.ts`): CRXJS сам находит его по маске
 * `\.iife\.(ts|tsx|js|jsx|mjs|cjs)$`, собирает бандл и переписывает манифест на
 * `src/extension/localfile-bridge.iife.js`.
 */
const LOCAL_FILE_BRIDGE_SOURCE = "src/extension/localfile-bridge.iife.ts";

/** `file://` не имеет хоста: хостовый нормализатор и origin-fallback его теряют. */
export function isLocalFileMatch(pattern: string): boolean {
  return /^file:\/\//i.test(String(pattern).trim());
}

export function createContentScriptEntries({
  matches,
  excludeMatches,
  includeWorld,
  matchOriginAsFallback = false,
  scriptPathFn,
  bridgeScript,
}: {
  matches: string[];
  excludeMatches: string[];
  includeWorld: boolean;
  matchOriginAsFallback?: boolean;
  scriptPathFn?: (distJs: string) => string;
  /** Переопределяет источник моста (по умолчанию `resolveScript("bridge.js")`). */
  bridgeScript?: string;
}): Record<string, unknown>[] {
  if (!matches.length) return [];

  const resolveScript = scriptPathFn ?? ((s: string) => s);
  const bridgeEntry = bridgeScript ?? resolveScript("bridge.js");
  const fallbackConfig = matchOriginAsFallback
    ? { match_origin_as_fallback: true }
    : {};

  return [
    {
      matches,
      exclude_matches: excludeMatches,
      js: [bridgeEntry],
      all_frames: true,
      match_about_blank: true,
      run_at: "document_start",
      ...fallbackConfig,
    },
    {
      matches,
      exclude_matches: excludeMatches,
      js: [resolveScript("prelude.js")],
      all_frames: true,
      match_about_blank: true,
      run_at: "document_start",
      ...(includeWorld ? { world: "MAIN" } : {}),
      ...fallbackConfig,
    },
    {
      matches,
      exclude_matches: excludeMatches,
      js: [resolveScript("content.js")],
      all_frames: true,
      match_about_blank: true,
      run_at: "document_end",
      ...(includeWorld ? { world: "MAIN" } : {}),
      ...fallbackConfig,
    },
  ];
}

// ----------------------------------------------------------------
// Full manifest builders
// ----------------------------------------------------------------

export interface ChromeManifestOptions {
  versionName?: string;
}

export function buildManifestChrome({
  headers,
  includeWorld,
  pathStrategy,
  chromeOptions,
  localFileBridgeScript = LOCAL_FILE_BRIDGE_SOURCE,
}: {
  headers: ExtensionHeaders;
  includeWorld: boolean;
  pathStrategy?: ManifestPathStrategy;
  chromeOptions?: ChromeManifestOptions;
  /**
   * Источник моста для `file://`.
   *
   * Chrome: standalone-IIFE (`LOCAL_FILE_BRIDGE_SOURCE`) — в ISOLATED-мире на
   * `file://` не работает динамический импорт ресурса расширения.
   * Firefox: обычный `bridge.js` — там мост и так собирается одним файлом без
   * динамических импортов (`verifyBundleSources` это отдельно проверяет), а
   * IIFE-файла в его out-dir нет.
   */
  localFileBridgeScript?: string;
}): Record<string, unknown> {
  const iconPathFn =
    pathStrategy?.iconPathFn ?? ((size: number) => `icons/icon-${size}.png`);
  const scriptPathFn = pathStrategy?.scriptPathFn ?? ((s: string) => s);

  const name = headers.name || DEFAULT_EXTENSION_NAME;
  const description = headers.description || DEFAULT_EXTENSION_DESCRIPTION;
  const version = headers.version || DEFAULT_EXTENSION_VERSION;
  const matches = headers.match || [];
  const excludeMatches = headers.exclude || [];
  const { originFallbackMatches, directMatches } =
    splitMatchesForOriginFallback(matches);
  // `file://` обрабатывается отдельно: ему нужен standalone-IIFE мост вместо
  // CRXJS-лоадера (см. `LOCAL_FILE_BRIDGE_SOURCE`). Прочие direct-паттерны
  // остаются на прежнем пути — поведение остальных сайтов не меняется.
  const localFileMatches = directMatches.filter(isLocalFileMatch);
  const regularDirectMatches = directMatches.filter(
    (match) => !isLocalFileMatch(match),
  );
  const hostPermissions = normalizeHostPermissions(headers.connect || []);
  const contentScripts = [
    ...createContentScriptEntries({
      matches: originFallbackMatches,
      excludeMatches,
      includeWorld,
      matchOriginAsFallback: true,
      scriptPathFn,
    }),
    ...createContentScriptEntries({
      matches: regularDirectMatches,
      excludeMatches,
      includeWorld,
      scriptPathFn,
    }),
    ...createContentScriptEntries({
      matches: localFileMatches,
      excludeMatches,
      includeWorld,
      scriptPathFn,
      bridgeScript: localFileBridgeScript,
    }),
  ];

  const iconSizes16and32 = [16, 32];

  const war = createWebAccessibleResources(matches);

  return {
    manifest_version: 3,
    name,
    description,
    version,
    ...(chromeOptions?.versionName && {
      version_name: chromeOptions.versionName,
    }),
    action: {
      default_title: name,
      default_icon: Object.fromEntries(
        iconSizes16and32.map((size) => [size, iconPathFn(size)]),
      ),
    },
    permissions: [
      "storage",
      "notifications",
      "activeTab",
      "declarativeNetRequestWithHostAccess",
    ],
    host_permissions: hostPermissions,
    background: pathStrategy?.background ?? {
      service_worker: "background.js",
      type: "module",
    },
    icons: Object.fromEntries(
      EXTENSION_ICON_SIZES.map((size) => [size, iconPathFn(size)]),
    ),
    content_scripts: contentScripts,
    web_accessible_resources: war,
  };
}
