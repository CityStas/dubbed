import { getLocalFileChunks, getLocalFilePartCount } from "../../core/localFile";
import type { GetAudioFromAPIOptions } from "../../types/audioDownloader";

/**
 * Стратегия загрузки аудио для локальных файлов (`file:///…/video.mp4`).
 *
 * Отличие от `webMseProxy` только в источнике байтов: там их вылавливает
 * MAIN-world хук MSE (YouTube), здесь — ридер расширения, который единственный
 * имеет доступ к `file://` (см. `src/core/localFile.ts`).
 *
 * Формат отдачи намеренно совпадает с YouTube-стратегией, поэтому протобуф,
 * чанкованная загрузка, ожидание готовности и ретраи переиспользуются как есть.
 */
export const LOCAL_FILE_STRATEGY = "localfile" as const;

function randomId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) {
    return uuid;
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function getAudioFromLocalFile({ signal }: GetAudioFromAPIOptions) {
  const { parts, size } = await getLocalFilePartCount();

  return {
    fileId: `random-${LOCAL_FILE_STRATEGY}-${randomId()}`,
    mediaPartsLength: parts,
    size,
    getMediaBuffers: () => getLocalFileChunks(undefined, signal),
  };
}
