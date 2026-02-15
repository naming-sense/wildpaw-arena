import { RealtimeEcsRuntime, type RuntimeInputState } from "../src/gameplay/ecs";

const url = process.argv[2] ?? "ws://127.0.0.1:7001";
const roomToken = process.argv[3] ?? "ecs-smoke";

let snapshotCount = 0;
let combatEventCount = 0;
let projectileEventCount = 0;
let latestHud: unknown = null;

const runtime = new RealtimeEcsRuntime({
  url,
  roomToken,
  renderAdapter: {
    onSnapshot: () => {
      snapshotCount += 1;
    },
    onCombatEvent: () => {
      combatEventCount += 1;
    },
    onProjectileEvent: () => {
      projectileEventCount += 1;
    },
    onLocalHud: (hud) => {
      latestHud = hud;
    },
  },
});

runtime.start();

let tick = 0;
const inputTimer = setInterval(() => {
  tick += 1;

  const input: RuntimeInputState = {
    moveX: tick % 2 === 0 ? 1 : 0,
    moveY: 0,
    fire: tick % 4 === 0,
    aimRadian: 0,
    skillQ: tick % 10 === 0,
    skillE: false,
    skillR: tick % 25 === 0,
  };

  runtime.sendInput(input);
  runtime.step(Date.now());
}, 50);

setTimeout(() => {
  clearInterval(inputTimer);
  runtime.stop();

  console.log(
    JSON.stringify(
      {
        url,
        roomToken,
        snapshotCount,
        combatEventCount,
        projectileEventCount,
        latestHud,
      },
      null,
      2,
    ),
  );
}, 3200);
