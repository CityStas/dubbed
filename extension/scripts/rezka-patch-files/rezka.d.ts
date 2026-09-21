import type { MinimalVideoData } from "../types/client.js";
import { BaseHelper } from "./base.js";
export default class RezkaHelper extends BaseHelper {
    API_ORIGIN: string;
    getVideoId(url: URL): Promise<string | undefined>;
    getVideoData(videoId: string): Promise<MinimalVideoData | undefined>;
}
//# sourceMappingURL=rezka.d.ts.map