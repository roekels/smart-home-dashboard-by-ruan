import test from "node:test";
import assert from "node:assert/strict";
import type { Env } from "../../../apps/shell/src/env.ts";
import { parseHousehold } from "../../../packages/core/src/household.ts";
import { compact } from "../../home-assistant/ha.ts";
import { kvPut } from "../../home-assistant/store.ts";
import { HA_ENV, STATES, fakeHa, homeDb } from "../../home-assistant/test/fakes/d1.ts";
import { addToDay, buckets, cleanConfig, emptyConfig, emptyDay, localDate, picture, suggest, watts } from "../engine.ts";
import { energyNow, tick } from "../worker.ts";
import demo from "../../../demo/household.config.json" with { type: "json" };

const h = parseHousehold(demo);
const ha = compact(STATES).states;
const cfg = { ...emptyConfig(), solar: ["sensor.solar_power"], grid: "sensor.grid_power", battery: "sensor.battery_power", batteryLevel: "sensor.battery_charge", devices: [{ sensor: "sensor.fridge_power" }] };

test("watts reads W, kW and nothing from a sensor without a reading", () => {
  assert.equal(watts(ha, "sensor.solar_power"), 1200);
  assert.equal(watts(ha, "sensor.grid_power"), -300);
  assert.equal(watts({ "sensor.x": { s: "unavailable", u: "W" } }, "sensor.x"), null);
  assert.equal(watts(ha, null), null);
});

test("the picture: the house's draw is worked out when no sensor measures it", () => {
  const p = picture(ha, cfg);
  assert.deepEqual([p.solar, p.grid, p.battery, p.level], [1200, -300, 400, 81]);
  assert.equal(p.home, 500); // 1200 solar - 300 fed in - 400 into the battery
  assert.deepEqual(p.devices.map((d) => [d.name, d.w]), [["Fridge", 45]]);
  assert.equal(p.other, 455);
  assert.equal(picture(ha, { ...cfg, gridInverted: true }).grid, 300);
});

test("totals add up minute by minute, a long gap counts as one minute", () => {
  let d = emptyDay("2026-01-01");
  for (let i = 0; i < 60; i++) d = addToDay(d, { solar: 1200, home: 600, grid: -600, battery: 0, level: null }, 1);
  assert.deepEqual([Math.round(d.solar), Math.round(d.home), Math.round(d.exported), d.imported], [1200, 600, 600, 0]);
  assert.equal(addToDay(emptyDay("x"), { solar: 6000, home: 0, grid: 0, battery: 0, level: null }, 500).solar, 100);
  assert.equal(localDate("Europe/London", new Date("2026-06-30T23:30:00Z")), "2026-07-01");
});

test("the chart averages samples into buckets and leaves gaps out", () => {
  const s = (ts: number, solar: number | null) => ({ ts, s: { solar, home: 100, grid: null, battery: null, level: null } });
  const b = buckets([s(0, 100), s(60_000, 300), s(600_000, null)], 600_000);
  assert.deepEqual(b.map((x) => [x.t, x.solar, x.home]), [[0, 200, 100], [600_000, null, 100]]);
});

test("a first guess from the sensors' names", () => {
  const g = suggest(ha);
  assert.deepEqual(g.solar, ["sensor.solar_power"]);
  assert.equal(g.grid, "sensor.grid_power");
  assert.equal(g.battery, "sensor.battery_power");
  assert.equal(g.batteryLevel, "sensor.battery_charge");
  assert.deepEqual(g.devices, [{ sensor: "sensor.fridge_power" }]);
});

test("the setup is cleaned and names what is wrong", () => {
  assert.deepEqual(cleanConfig({ solar: ["sensor.a", "sensor.a"], grid: "", devices: [{ sensor: "sensor.b", plug: "switch.p" }, { sensor: "sensor.b" }] }),
    { ...emptyConfig(), solar: ["sensor.a"], devices: [{ sensor: "sensor.b", plug: "switch.p" }] });
  assert.throws(() => cleanConfig({ grid: "light.x" }), /grid must be a sensor/);
  assert.throws(() => cleanConfig({ devices: [{ sensor: "sensor.b", plug: "light.p" }] }), /plug must be a switch/);
});

test("the minute tick stores a sample and today's totals; nothing before sensors are chosen", async () => {
  const env = { ...HA_ENV, HOME_DB: homeDb() } as unknown as Env, f = fakeHa({ "/api/states": STATES });
  const t0 = new Date("2026-03-01T12:00:20Z");
  assert.equal(await tick(env, h, t0, f.fetcher), "no sensors chosen yet");
  await kvPut(env, "energy.config", cfg);
  assert.equal(await tick(env, h, t0, f.fetcher), "sampled");
  assert.equal(await tick(env, h, new Date(t0.getTime() + 60_000), f.fetcher), "sampled");
  const now = await energyNow(env, t0.getTime() + 61_000);
  assert.equal(now.configured, true);
  assert.equal(now.series.length, 1);
  assert.equal(now.series[0].solar, 1200);
  assert.deepEqual(now.today, { date: "2026-03-01", solar: 0.04, home: 0.02, imported: 0, exported: 0.01 });
});
