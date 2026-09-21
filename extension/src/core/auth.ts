import type { Account } from "../types/storage";
import { dubbedStorage } from "../utils/storage";
import { notifyAuthOpener } from "./authRefreshMessage";

type AuthProfilePayload = {
  avatar_id: string;
  username: string;
};

function getProfilePayload(): AuthProfilePayload | null {
  const payload = (globalThis as { _userData?: unknown })._userData;
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const candidate = payload as {
    avatar_id?: unknown;
    username?: unknown;
  };
  if (
    typeof candidate.avatar_id !== "string" ||
    typeof candidate.username !== "string" ||
    candidate.avatar_id.length === 0 ||
    candidate.username.length === 0
  ) {
    return null;
  }

  return {
    avatar_id: candidate.avatar_id,
    username: candidate.username,
  };
}

async function handleAuthCallbackPage() {
  const { access_token: token, expires_in: expiresIn } = Object.fromEntries(
    new URLSearchParams(globalThis.location.hash.slice(1)),
  );

  if (!token || !expiresIn) {
    throw new Error("[Dubbed] Invalid token response");
  }

  const numExpiresIn = Number.parseInt(expiresIn, 10);
  if (Number.isNaN(numExpiresIn)) {
    throw new TypeError("[Dubbed] Invalid expires_in value");
  }

  await dubbedStorage.set<Account>("account", {
    token,
    expires: Date.now() + numExpiresIn * 1000,
    username: undefined,
    avatarId: undefined,
  });
  notifyAuthOpener();
}

async function handleProfilePage() {
  const payload = getProfilePayload();
  if (!payload) {
    throw new Error("[Dubbed] Invalid user data");
  }
  const { avatar_id: avatarId, username } = payload;

  const data = await dubbedStorage.get<Account>("account");
  if (!data) {
    throw new Error("[Dubbed] No account data found");
  }

  await dubbedStorage.set<Account>("account", {
    ...data,
    username,
    avatarId,
  });
  notifyAuthOpener();
}

export async function initAuth() {
  if (globalThis.location.pathname === "/auth/callback") {
    return handleAuthCallbackPage();
  }

  if (globalThis.location.pathname === "/my/profile") {
    return handleProfilePage();
  }
}
