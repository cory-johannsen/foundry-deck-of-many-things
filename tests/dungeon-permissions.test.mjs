// tests/dungeon-permissions.test.mjs
import { describe, it, expect } from "vitest";
import {
  canActOnDungeon,
  decideOpenDungeon,
  decideGmLessBroadcast,
  withSettingsModifyGrantedTo,
} from "../scripts/dungeon-permissions.mjs";

const gm = { id: "gm-1", isGM: true };
const player = { id: "player-1", isGM: false };
const otherPlayer = { id: "player-2", isGM: false };
const noActiveUsers = [gm, player, otherPlayer].map((u) => ({ ...u, active: false }));
const gmActive = [{ ...gm, active: true }, { ...player, active: true }];
const gmInactive = [{ ...gm, active: false }, { ...player, active: true }];

describe("canActOnDungeon", () => {
  it("always allows a GM, regardless of run state", () => {
    expect(
      canActOnDungeon(null, { userRef: gm, usersRef: noActiveUsers }),
    ).toBe(true);
    expect(
      canActOnDungeon({ hostUserId: "someone-else" }, { userRef: gm, usersRef: noActiveUsers }),
    ).toBe(true);
  });

  it("allows the run's own host when no GM is active", () => {
    const run = { hostUserId: player.id };
    expect(
      canActOnDungeon(run, { userRef: player, usersRef: gmInactive }),
    ).toBe(true);
  });

  it("denies the host once any GM is active", () => {
    const run = { hostUserId: player.id };
    expect(
      canActOnDungeon(run, { userRef: player, usersRef: gmActive }),
    ).toBe(false);
  });

  it("denies a non-host, non-GM player even with no active GM", () => {
    const run = { hostUserId: player.id };
    expect(
      canActOnDungeon(run, { userRef: otherPlayer, usersRef: gmInactive }),
    ).toBe(false);
  });

  it("denies a non-GM when there is no run at all", () => {
    expect(
      canActOnDungeon(null, { userRef: player, usersRef: gmInactive }),
    ).toBe(false);
  });
});

describe("decideOpenDungeon", () => {
  it("always renders for a GM", () => {
    expect(decideOpenDungeon(null, { userRef: gm, usersRef: noActiveUsers })).toEqual({
      action: "render",
    });
  });

  it("warns GM-only when a GM is active and caller isn't", () => {
    expect(
      decideOpenDungeon(null, { userRef: player, usersRef: gmActive }),
    ).toEqual({ action: "warnGmOnly" });
  });

  it("renders for a non-GM starting fresh with no GM active and no hosted run", () => {
    expect(
      decideOpenDungeon(null, { userRef: player, usersRef: gmInactive }),
    ).toEqual({ action: "render" });
  });

  it("renders for a non-GM reopening their own hosted run", () => {
    const hosted = { sceneId: "scene-1", hostUserId: player.id };
    expect(
      decideOpenDungeon(hosted, { userRef: player, usersRef: gmInactive }),
    ).toEqual({ action: "render" });
  });

  it("warns already-hosted for a different non-GM while someone else's run is active", () => {
    const hosted = { sceneId: "scene-1", hostUserId: player.id };
    expect(
      decideOpenDungeon(hosted, { userRef: otherPlayer, usersRef: gmInactive }),
    ).toEqual({ action: "warnAlreadyHosted", hostUserId: player.id });
  });
});

describe("decideGmLessBroadcast", () => {
  it("never acts for a GM client", () => {
    const hosted = { sceneId: "scene-1", hostUserId: player.id };
    expect(decideGmLessBroadcast(hosted, false, { userRef: gm })).toEqual({
      action: "none",
    });
  });

  it("never acts on the host's own client", () => {
    const hosted = { sceneId: "scene-1", hostUserId: player.id };
    expect(decideGmLessBroadcast(hosted, false, { userRef: player })).toEqual({
      action: "none",
    });
  });

  it("opens a fresh read-only instance for another player with none open yet", () => {
    const hosted = { sceneId: "scene-1", hostUserId: player.id };
    expect(
      decideGmLessBroadcast(hosted, false, { userRef: otherPlayer }),
    ).toEqual({ action: "open" });
  });

  it("re-renders an already-open read-only instance", () => {
    const hosted = { sceneId: "scene-1", hostUserId: player.id };
    expect(
      decideGmLessBroadcast(hosted, true, { userRef: otherPlayer }),
    ).toEqual({ action: "render" });
  });

  it("closes an open read-only instance once no run is hosted any more", () => {
    expect(decideGmLessBroadcast(null, true, { userRef: otherPlayer })).toEqual({
      action: "close",
    });
  });

  it("does nothing when there's no hosted run and nothing open", () => {
    expect(decideGmLessBroadcast(null, false, { userRef: otherPlayer })).toEqual({
      action: "none",
    });
  });
});

describe("withSettingsModifyGrantedTo", () => {
  it("adds missing roles, preserving existing ones and other permission keys", () => {
    const current = { SETTINGS_MODIFY: [3, 4], OTHER_PERM: [4] };
    expect(withSettingsModifyGrantedTo(current, [1, 2])).toEqual({
      SETTINGS_MODIFY: [1, 2, 3, 4],
      OTHER_PERM: [4],
    });
  });

  it("returns null when every requested role is already granted", () => {
    const current = { SETTINGS_MODIFY: [1, 2, 3, 4] };
    expect(withSettingsModifyGrantedTo(current, [1, 2])).toBeNull();
  });

  it("treats a missing SETTINGS_MODIFY entry as granting nobody", () => {
    expect(withSettingsModifyGrantedTo({}, [1, 2])).toEqual({
      SETTINGS_MODIFY: [1, 2],
    });
  });

  it("treats null current permissions the same as empty", () => {
    expect(withSettingsModifyGrantedTo(null, [1])).toEqual({
      SETTINGS_MODIFY: [1],
    });
  });
});
