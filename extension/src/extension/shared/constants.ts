/**
 * Shared constants for the MV3 extension build.
 *
 * These strings MUST be identical across:
 *  - prelude (MAIN world)
 *  - bridge  (ISOLATED world)
 *  - background (service worker port name)
 *
 * CRXJS creates a separate internal Rollup build for each content-script
 * entry and the service worker, so shared code is duplicated per entry.
 * If tree-shaking/minification diverges, string constants would diverge
 * and break the postMessage bridge — keep them literal and centralized.
 */

export type AnyObject = Record<string, any>;

// Message channel marker (kept very specific to avoid collisions).
export const MARK = "__Dubbed_EXT_BRIDGE__";

// Message types (page <-> bridge)
export const TYPE_REQ = "Dubbed_EXT_REQ";
export const TYPE_RES = "Dubbed_EXT_RES";

export const TYPE_XHR_START = "Dubbed_EXT_XHR_START";
export const TYPE_XHR_ABORT = "Dubbed_EXT_XHR_ABORT";
export const TYPE_XHR_ACK = "Dubbed_EXT_XHR_ACK";
export const TYPE_XHR_EVENT = "Dubbed_EXT_XHR_EVENT";

export const TYPE_NOTIFY = "Dubbed_EXT_NOTIFY";

// Background port name (bridge <-> service worker)
export const PORT_NAME = "dubbed_gm_xhr";

// Background runtime message types (bridge <-> service worker, one-off)
export const BG_MSG_STORAGE = "gm_storage";
export const BG_MSG_NOTIFICATION = "gm_notification";

type BridgeMarked = { [MARK]: true };

export type BridgeReqMessage = BridgeMarked & {
  type: typeof TYPE_REQ;
  id: string;
  action: string;
  payload?: AnyObject;
};

export type BridgeResMessage = BridgeMarked & {
  type: typeof TYPE_RES;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

export type BridgeNotifyMessage = BridgeMarked & {
  type: typeof TYPE_NOTIFY;
  details?: AnyObject;
};

export type BridgeXhrStartMessage = BridgeMarked & {
  type: typeof TYPE_XHR_START;
  requestId: string;
  details?: AnyObject;
};

export type BridgeXhrAbortMessage = BridgeMarked & {
  type: typeof TYPE_XHR_ABORT;
  requestId: string;
};

export type BridgeXhrAckMessage = BridgeMarked & {
  type: typeof TYPE_XHR_ACK;
  requestId: string;
  payload?: AnyObject;
};

export type BridgeXhrEventMessage = BridgeMarked & {
  type: typeof TYPE_XHR_EVENT;
  requestId: string;
  payload?: AnyObject;
};

export type BridgeWireMessage =
  | BridgeReqMessage
  | BridgeResMessage
  | BridgeNotifyMessage
  | BridgeXhrStartMessage
  | BridgeXhrAbortMessage
  | BridgeXhrAckMessage
  | BridgeXhrEventMessage;

const BRIDGE_MESSAGE_TYPES = new Set<string>([
  TYPE_REQ,
  TYPE_RES,
  TYPE_NOTIFY,
  TYPE_XHR_START,
  TYPE_XHR_ABORT,
  TYPE_XHR_ACK,
  TYPE_XHR_EVENT,
]);

export function isOurMessage(data: unknown): data is BridgeWireMessage {
  return Boolean(
    data &&
      typeof data === "object" &&
      (data as Record<string, unknown>)[MARK] === true &&
      typeof (data as { type?: unknown }).type === "string" &&
      BRIDGE_MESSAGE_TYPES.has((data as { type: string }).type),
  );
}
