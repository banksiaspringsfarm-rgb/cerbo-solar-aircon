# Architecture — Daikin AC as a solar-aware load (AC v2, Faikout)

Last updated 2026-10-12. Status: **LIVE on the Cerbo since 22:16 2026-10-12** (the owner chose to skip the shadow phase). Faikout `daikin1` = <faikout-ip>.

## The problem in one picture (real farm data, 12 Oct 2026)

| Time | SOC | Solar | Inside | AC |
|---|---|---|---|---|
| 09:22 | 100 % | curtailed (being thrown away) | 27 °C | off |
| 13:18 | 100 % | curtailed | **35.3 °C** | off |
| 17:45 | 100 % | gone | 33 °C | off |

The battery was full and the panels were being throttled from 09:20 until sunset, while the house sat at 35 °C.
The current controller (AC v1.15 on the Cerbo) can't use that energy. It can only **power-cycle the AC with a
Tuya plug**, so it gets whatever mode the AC was last left in (Heat 25 °C). Its logic is also heating-only.
The Faikout gives real control over mode, setpoint, fan, econo and (maybe) demand limiting, plus real telemetry:
room temperature, outside temperature, compressor speed and online/offline.

## Components

```
                         farm Starlink WiFi / LAN 192.168.1.x
 ┌──────────────┐   S21   ┌───────────────┐   MQTT 1883   ┌─────────────────────────────────────┐
 │ Daikin       │◄───────►│ Faikout OG    │◄─────────────►│ Cerbo GX MK2  <cerbo-ip>          │
 │ FTXZ25NV1B   │ serial  │ ESP32, host   │               │  FlashMQ broker (1883, ws 9001)     │
 │ (indoor head)│         │ "daikin1"     │               │  Node-RED:                          │
 └──────▲───────┘         └───────────────┘               │   Hot Water v3+ tab ─► bsf/hotwater/status ─┐
        │ mains via Tuya plug <plug-ip>                │   AC v1.5 tab (v1.15, plug) — retired at P2 │
        │ (stays ON once Faikout is the controller)        │   AC v2 (Faikout) tab  ◄──────────────────┘
                                                           │      ▲ bsf/presence/state (farm iMac)
                                                           │      └─► command/daikin1, bsf/ac2/*
                                                           └─────────────────────────────────────┘
                                                                   ▲ ws 9001 (LAN dashboard, read/write)
                                                                   │ relay → public read-only dashboard
```

* **Faikout** — open-source ESP32 board on the AC's S21 port (RevK, firmware now on Codeberg:
  `codeberg.org/RevK/ESP32-Faikout`). Local only, no cloud. It speaks MQTT to the broker you give it and serves a
  web control page at `http://daikin1.local/`. The FTXZ25NV1B is on the confirmed-working list (S21, Type A
  lead). Ururu-only features (humidify) are not supported. Everything a normal split does works.
* **Cerbo GX** — already the farm's control plane. Its broker already carries every `bsf/*` topic. Its Node-RED
  already runs the hot-water and AC dispatchers. Anonymous MQTT on `<cerbo-ip>:1883` was verified from the
  farm iMac on 2026-10-12, and that is the port the Faikout will use.
* **AC v2 dispatcher** — a new Node-RED tab on the Cerbo, built from this repo (`dist/ac2-flow.json`).
* **Farm iMac** — unchanged. It runs the presence detector (`bsf/presence/state`), the relay and the dashboards.

## Decision: where the control logic lives → Node-RED on the Cerbo

the owner's call on 2026-10-12: *the Faikout is controlled by the Cerbo over WiFi, not by a Raspberry Pi.* That
settles it, and it is the right call on the merits too:

| Option | Verdict |
|---|---|
| **Node-RED function node on the Cerbo** (chosen) | Same box, same broker and same pattern as the live HW and AC dispatchers. No new host to fail. It survives reboots (flow context is persisted, as v1.x already relies on). The Cerbo is the device that already knows SOC/PV/load first-hand. |
| Python service on the Cerbo | Venus OS replaces its root filesystem on every firmware update, has no pip, and needs custom daemontools services. That is fragile on the box that runs the inverter. |
| Python on the farm iMac | Off the control plane. The Mac sleeps, moves IP (it already broke the dashboard once) and is a second point of failure for comfort *and* safety. |
| Faikout's own "auto" mode only | A good thermostat with no solar awareness. Kept as a *backstop* (daily off-time), not as the brain. |

**How it is authored:** the logic is plain JavaScript in this repo (`src/ac2-core.js`). It is a pure function
with no Node-RED dependency, unit-tested on the Mac with `node --test` and exercised against a day of real farm
data. `scripts/build.js` bakes config + core + a thin Node-RED wrapper into one paste body and a ready-to-import
flow, so what is tested is exactly what gets pasted. Each paste carries a sha256 stamp in its header, so
"disk vs deployed" can be checked by hashing the deployed node. That drift has bitten v1.x more than once.
See `docs/adr/0001-control-logic-on-cerbo-node-red.md`.

## MQTT topics

### Faikout (firmware-defined; checked against source on 2026-10-12, Codeberg commit `e6ad55b`)

`<host>` is the hostname set during setup. **`daikin1` is the proposed name.**

| Direction | Topic | Payload | Use here |
|---|---|---|---|
| → Faikout | `command/<host>` | JSON controls, e.g. `{"power":true,"mode":"C","temp":22,"fan":"A","econo":false,"demand":100}` | **The one command topic the dispatcher uses** (QoS 1, not retained). |
| → Faikout | `command/<host>/on`, `/off`, `/heat`, `/cool`, `/temp` (payload 22) … | simple one-field commands | Manual testing. |
| → Faikout | `command/<host>/control` | `{"env":24.5,"target":[21,23]}` | Faikout's own auto-mode with an external room sensor. Not used in v2. |
| → Faikout | `command/<host>/status` | empty | Ask for a status report (sent every tick, harmless). |
| → Faikout | `setting/<host>` | JSON settings, e.g. `{"livestatus":true}`. Empty payload = read back all settings. | Setup only. |
| ← Faikout | `state/<host>` | retained JSON while up, `false` (last will) when it drops off the network | Offline detection. |
| ← Faikout | `state/<host>/status` | JSON: `online` (AC talking on S21), `power`, `mode` (H/C/A/D/F), `temp` (setpoint), `fan`, `econo`, `demand`, `home` (room °C), `outside`, `liquid`, `inlet`, `comp` (compressor), `fanrpm`, `heat`, `antifreeze`, `consumption`/`Wh*` (if the unit reports them) | **Main telemetry.** Sent on change when `livestatus` is on. |
| ← Faikout | `Faikout/<host>` | once a minute: min/avg/max of each value over the period | Future energy logging. |
| ← Faikout | `error/<host>/…`, `info/<host>/…`, `event/<host>/…` | diagnostics | Logged, not acted on. |

Control values: `mode` is `H` heat, `C` cool, `A` auto, `D` dry, `F` fan; `fan` is `A` auto, `Q` quiet/night,
`1`–`5`; `demand` is an integer 30–100 % (a power cap on the outdoor unit), **only if this model reports it**.
Ururu `humidify` is not supported on the FTXZ.

**HTTP (manual checks only):** web UI `http://daikin1.local/`, live status websocket `/status`, and the legacy
Daikin BRP-compatible API (`/aircon/get_control_info`, `/aircon/set_control_info?pow=1&mode=3&stemp=24`,
`/aircon/get_sensor_info`, `/aircon/set_demand_control`). The dispatcher uses MQTT, not HTTP. MQTT pushes state
instead of being polled, it has a last-will for offline detection, and the Cerbo already speaks it.

⚠️ The field names come from the firmware source and manuals. They are **unverified against this unit** until it is
online. The first job once it is online is to capture one real `state/daikin1/status` and fix `normalizeFaikout`
if anything differs.

### Solar + farm state (existing, read-only for v2)

| Topic | Publisher | Fields v2 reads |
|---|---|---|
| `bsf/hotwater/status` (10 s, retained) | HW v3+ dispatcher on the Cerbo | `ts`, `soc`, `surplus_smooth` (fallback `surplus_now`), `ac_load` (whole inverter output W), `curtailed`, `plug_power` (HW element draw), `sunset_iso` |
| `bsf/presence/state` | farm iMac `bsf_presence.py` | `anyone_home` |
| `bsf/weather/forecast` (retained, every 2 h) | farm iMac `scripts/ac2_weather.py` (launchd `farm.bsf.ac2-weather`), Open-Meteo, CC BY 4.0 | `today.{date,max_c,min_c,rad_mj,cloud,rain_prob,hum}`, `tomorrow` |
| `Faikout/daikin1` (every minute) | the Faikout | minute summary (value or [min,avg,max]): keeps an idle unit's temps fresh |
| `bsf/ac/plug_power` (retained) | Tuya bridges tab | metered AC draw (W), used to add the AC's own draw back onto surplus |
| `bsf/ac/status` | AC v1.15 | `inside_temp`. This is the Tuya room probe, used only as a fallback when the Faikout has no `home` reading. |

### AC v2's own topics (new namespace, so it can shadow v1.15 safely)

| Topic | Retained | Content |
|---|---|---|
| `bsf/ac2/status` | yes | every 30 s: mode, tier, reasons, guards, season, room °C, SOC, surplus ex-AC, what it wants, what it sent, dry_run, latches |
| `bsf/ac2/shadow` | no | every command it sends *or would send* (`dry_run` flag, target topic, payload) |
| `bsf/ac2/log` | no | tier changes, manual-hold start/end, boost start/end |
| `bsf/ac2/anomaly` | no (QoS 1) | rising-edge only: `STALE_SOLAR`, `AC_OFFLINE`, `AC_TELEMETRY_STALE`, `COMMAND_NOT_APPLIED`, `BOOST_CUT_SOC`, `WATCHDOG_FORCE_OFF` |
| `bsf/ac2/manual` | no (QoS 1) | manual-preference events: `manual_change` (from → to + context) and `hold_end` (outcome). Logged + sent to Telegram by `scripts/ac2_manual_watch.py` on the farm iMac (launchd `farm.bsf.ac2-manual-watch`, persistent session). |
| `bsf/ac2/cmd` | no | dashboard/manual: `{"cmd":"set_mode","mode":"AUTO"\|"OFF"}`, `{"cmd":"boost","minutes":120}`, `{"cmd":"extend_boost","minutes":30}`, `{"cmd":"clear_hold"}`, `{"cmd":"set_season","season":"heat"\|"cool"\|"auto"}` |

Thresholds can be tuned live without a redeploy by writing a partial config into flow context `ac2_cfg_overrides`
(deep-merged over `config/ac2.config.json`).

## The Node-RED tab (`dist/ac2-flow.json`)

* 8 `mqtt in` nodes (the topics above, plus the existing dashboard's `bsf/ac/cmd`) → **`AC v2 dispatcher`** (function, 6 outputs), plus a 30 s `tick` inject.
* Outputs: `[0]` **real Faikout command (UNWIRED in Phase 1)** · `[1]` shadow · `[2]` status · `[3]` log · `[4]` anomaly · `[5]` status poll.
* **`AC v2 watchdog`** (function, 5-min inject), independent of the dispatcher. It forces the AC off if the dispatcher
  has stopped evaluating, or the solar data is stale, while the AC is running under automation. Its real output
  `[0]` is also unwired in Phase 1.
* It reuses the existing broker config node `hwv3.broker` ("Cerbo local broker"). No second broker is imported.

## The Tuya plug and the Faikout's power

The Faikout is **powered by the AC** (S21 pin 4, ~12 V). The Tuya plug at .114 feeds the whole AC, so **every
time v1.15 switches the plug off, the Faikout goes dark** and drops off MQTT. Consequences:

* While v1.15 still owns the plug, the Faikout is only online when the plug is on. In warm weather v1.15 keeps
  the plug off all day (it is heating-only), so the Faikout would be offline when it matters most.
* At cutover the plug is switched **on and left on**. It becomes a hard emergency kill only, never a control
  path. Power-cycling an inverter AC as a control method is also harder on it than setpoint/standby control.

## Rollout

| Phase | What | Who | Risk |
|---|---|---|---|
| 0 | Fit the Faikout, put it on WiFi, point it at the Cerbo broker (`docs/FAIKIN-SETUP.md`) | the owner (physical), Claude verifies topics from the iMac | none to the solar system |
| ~~1~~ | **Shadow — skipped at the owner's request.** Import `dist/ac2-flow.json` with `dry_run: true` and real outputs unwired. v2 reads real data and publishes what it *would* do on `bsf/ac2/shadow`. Fix field names from real telemetry. Plug held on, and v1.15's plug wires disabled (the owner decides when). | Claude prepares, the owner approves the deploy | none: v2 cannot command the AC |
| 2 | **Live (done 2026-10-12, `scripts/deploy.js --go`).** Dispatcher `[0]` + watchdog `[0]` wired, `dry_run: false`, v1.15's plug link cut, plug left on. Existing dashboard buttons (`bsf/ac/cmd`: AUTO / ON = boost / OFF / +30 min) are translated by v2. Still to do: the Faikout daily off-time backstop (the owner's call). | done | v2 drives the AC; guards + watchdog |
| 3 | Dashboard Air-Con panel on v2 + 24 h graphs, relay `ac2` block, phone widget aircon line, Mac 3-site widget, Telegram preference log, minute recorder — **done 2026-10-12 night** (see docs/WORKLOG-2026-10-12-overnight.md). Still later: shared surplus budget across loads; a trip-logging app "heading home" pre-cool. | done / later | — |

## Adding more loads later

The core is a pattern, not an AC special case: **guards → per-tier latches with hysteresis + sustain → short-cycle
protection → idempotent command**. A new load gets its own config block, adapter (Faikout, Tuya, Shelly …) and
topic namespace (`bsf/<load>/…`). The known gap, shared with the existing HW/AC pair, is that **each dispatcher
reads the same surplus independently**. Two loads can see the same 2 kW and both start. Today the 4200 W
trailer-lead cap guard and the curtailment/SOC-led tiers keep that safe. The proper fix is a small surplus
*allocator* that grants watts to loads in priority order. That is Phase 3+; see `docs/CONTROL-LOGIC.md` §9.
