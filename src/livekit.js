"use strict";

const { AccessToken } = require("livekit-server-sdk");

// Reads an env var as a trimmed string, returning empty when unset.
function trimEnv(name) {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

// Normalizes a LiveKit endpoint to ws/wss and removes any trailing slash.
function normalizeLiveKitUrl(rawUrl) {
  const value = typeof rawUrl === "string" ? rawUrl.trim() : "";
  if (!value) return "";
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "http:") parsed.protocol = "ws:";
    if (parsed.protocol === "https:") parsed.protocol = "wss:";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return value.replace(/\/$/, "");
  }
}

// Builds the active LiveKit config from environment variables.
function getLiveKitConfig() {
  const apiKey = trimEnv("LIVEKIT_API_KEY");
  const apiSecret = trimEnv("LIVEKIT_API_SECRET");
  const publicUrl = normalizeLiveKitUrl(trimEnv("LIVEKIT_WS_URL"));
  const roomPrefix = trimEnv("LIVEKIT_ROOM_PREFIX") || "haven";
  return {
    apiKey,
    apiSecret,
    publicUrl,
    roomPrefix,
    enabled: !!(apiKey && apiSecret && publicUrl),
  };
}

// Computes the deterministic LiveKit room name for a Haven voice channel.
function getLiveKitRoomName(channelCode) {
  const config = getLiveKitConfig();
  return `${config.roomPrefix}-${channelCode}`;
}

// Creates a signed LiveKit JWT granting publish/subscribe access to one room.
async function createLiveKitToken({ identity, name, roomName, metadata }) {
  const config = getLiveKitConfig();
  if (!config.enabled) {
    throw new Error("LiveKit is not configured");
  }

  const token = new AccessToken(config.apiKey, config.apiSecret, {
    identity: String(identity),
    name: typeof name === "string" && name.trim() ? name.trim() : String(identity),
    ttl: "2h",
    metadata: JSON.stringify(metadata || {}),
  });

  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  return await token.toJwt();
}

module.exports = {
  createLiveKitToken,
  getLiveKitConfig,
  getLiveKitRoomName,
};
