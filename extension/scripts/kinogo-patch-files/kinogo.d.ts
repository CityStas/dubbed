import type { MinimalVideoData } from "../types/client.js";
import { BaseHelper } from "./base.js";
export default class KinogoHelper extends BaseHelper {
    getVideoId(url: URL): Promise<string | undefined>;
    getVideoData(videoId: string): Promise<MinimalVideoData | undefined>;
    /** HLS-ссылка ТЕКУЩЕЙ серии из плейлиста ortified (без сети). */
    ortifiedEpisodeMedia(): string | undefined;
    /** «Личность» текущей серии `s<сезон>:e<серия>` (для наблюдателя смены серии). */
    peekEpisodeKey(): string | undefined;
    /** Текущая медиа-ссылка плеера без сети. */
    peekMediaUrl(): string | undefined;
}
//# sourceMappingURL=kinogo.d.ts.map