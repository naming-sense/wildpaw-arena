import { RealtimeClient, type PlayerSnapshot } from "../src/netcode";

const url = process.argv[2] ?? "ws://127.0.0.1:7001";
const profileId = process.argv[3] ?? "skirmisher";

let localPlayerId: number | null = null;
let profileApplied = false;
let profileInvalid = false;
let latestLocal: PlayerSnapshot | null = null;

const client = new RealtimeClient({
  url,
  onSnapshot: (snapshot) => {
    if (localPlayerId == null) {
      return;
    }

    const local = snapshot.players.find((player) => player.playerId === localPlayerId);
    if (local) {
      latestLocal = local;
    }
  },
  onEvent: (name, payload) => {
    if (name === "S2C_WELCOME") {
      const body = payload as { playerId?: number };
      if (typeof body.playerId === "number") {
        localPlayerId = body.playerId;
        client.selectProfile(profileId);
      }
      return;
    }

    if (name === "profile.applied") {
      profileApplied = true;
      return;
    }

    if (name === "profile.invalid") {
      profileInvalid = true;
    }
  },
});

client.connect("profile-select-smoke");

setTimeout(() => {
  client.disconnect();

  console.log(
    JSON.stringify(
      {
        url,
        requestedProfile: profileId,
        localPlayerId,
        profileApplied,
        profileInvalid,
        localMaxAmmo: latestLocal?.maxAmmo ?? null,
        localAmmo: latestLocal?.ammo ?? null,
      },
      null,
      2,
    ),
  );
}, 2600);
