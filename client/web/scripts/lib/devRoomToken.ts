function fnv1a32(raw: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function toHex8(value: number): string {
  return (value >>> 0).toString(16).padStart(8, "0");
}

export function resolveRoomToken(rawToken: string | null | undefined): string {
  const input = String(rawToken ?? "dev-room").trim() || "dev-room";
  if (input.startsWith("rt1:")) {
    return input;
  }

  const matchId = input.replace(/:/g, "_");
  const mapId = process.env.ROOM_MAP_ID ?? "NJD_CR_01";
  const ttlMs = Number(process.env.ROOM_TOKEN_TTL_MS ?? 60 * 60 * 1000);
  const expiresAtMs = Date.now() + (Number.isFinite(ttlMs) ? ttlMs : 60 * 60 * 1000);
  const secret = process.env.WILDPAW_ROOM_TOKEN_SECRET ?? "dev-room-secret";
  const signature = toHex8(fnv1a32(`${matchId}:${mapId}:${expiresAtMs}:${secret}`));

  return `rt1:${matchId}:${mapId}:${expiresAtMs}:${signature}`;
}
