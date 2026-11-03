# Control logic — AC v2 (solar-aware Daikin via Faikout)

Last updated 2026-10-15. Code: `src/ac2-core.js`. Thresholds: `config/ac2.config.json`. Every number below is a
config key, and **every one is a proposal awaiting the owner's OK** (see §10).

## 1. Idea

The arrays face ~60° east and west of north, so the solar curve is **flat**: a long plateau from about 08:00 to 16:00
instead of a noon spike. On a good day the gel bank is full by mid-morning. On 12 Oct 2026 it hit 100 % at 09:22,
and from then on the chargers throttle the panels (**curtailment**), so that energy is thrown away for 6+ hours.

The house is the cheapest battery on the farm. v2 spends curtailed and surplus PV on **cooling (or heating) the house past
comfort** while the sun is up. The thermal mass then coasts through the late afternoon and evening, when the
battery matters most. It never borrows from the battery for this except in deliberate, guarded cases (morning
warm-up in winter, manual boost).

## 2. Inputs (each tick, every 30 s)

| Signal | Source | Notes |
|---|---|---|
| SOC % | `bsf/hotwater/status.soc` | Victron BMV via the HW dispatcher |
| Surplus W | `surplus_smooth` (fallback `surplus_now`) | **The AC's own draw is added back** (metered `bsf/ac/plug_power`, else 700 W estimate), so running the AC doesn't make it think the surplus has gone |
| Curtailed | `curtailed` | The strongest "free energy" signal. When the battery is full, `surplus` understates what the panels could make. |
| House load W | `ac_load` | Whole inverter output, used for the 4200 W trailer-lead cap |
| HW element draw | `plug_power` | Whether hot water is drawing |
| Sunset | `sunset_iso` | **Only trusted if it is today's.** Otherwise the window falls back to 16:00 (the v1.15 midnight lesson). |
| Room °C | Inkbird 4 on the kitchen fridge (`bsf/ac2/room_ref`) while fresh; else the Faikout `home`, corrected for heating (−2.0) and idle drift (−3.9 over 12 min) | Bedroom Tuya probe not used (reads 4–7 °C high) |
| AC state | Faikout `state/daikin1/status` | power, mode, setpoint, compressor; `state/daikin1` = online |
| Presence | `bsf/presence/state.anyone_home`, **or** a change at the unit in the last 4 h (`presence.hand_change_home_h`) | A dead feed fails **open** (same as v1.11). A hand change counts as home because a phone in airplane mode reads as away (owner 20 Oct); an AC found already running does not. Status shows `home_by_hand_until`. |

## 3. Order of decisions

```
boost expired? ─► AUTO
detect a manual change (remote / web page) ─► MANUAL HOLD 60 min (each change restarts it; ends a boost)
mode OFF ─────────────────────────────► power off (re-asserted)
manual hold ──────────────────────────► leave it alone, except SOC floor / load cap still cut it
hard guards ──────────────────────────► power off immediately (beats min-run and boost)
mode BOOST ───────────────────────────► run at comfort setpoint until the timer ends
AUTO:
  outside 05:00–18:00 ────────────────► off (TIME_LOCKOUT)
  after sunset − 90 min ──────────────► off (WINDOW_CLOSED)
  tiers (highest latched wins): SOAK > COMFORT > MORNING > ECO, else idle/off
short-cycle protection (min-run, min-off, setpoint pacing)
send a command only if the AC doesn't already look like that
```

## 4. Hard guards (fail to OFF)

| Guard | Rule | Why |
|---|---|---|
| `STALE_SOLAR` | No solar state for **120 s** (`stale.solar_max_age_s`) | Never run blind. The AC goes off and stays off until data returns. |
| `SOC_FLOOR` | SOC < **75 %** (`battery.soc_floor_pct`, same for boost) | Lead-gel bank. This is the v1.15 floor, unchanged. |
| `LOAD_CAP` | AC on, house load > **4200 W**, hot water *not* drawing | Trailer-lead cap. This is v1.9's cascade rule: if HW is drawing, its own dispatcher sheds first. |
| `LOAD_HEADROOM` | AC off and load + 700 W > 4200 W | Don't start into a full lead |
| `HARD_SOC_FLOOR` | SOC below the battery chemistry's hard floor: **50 %** lead/gel/AGM (`battery.chemistry: "lead"`, also the default) or **25 %** lithium | The floor no setting or override can go below (owner, 4 Nov 2026). Applies in a manual hold, a boost and a preset too, whatever `manual.guards_in_hold` says. |
| `BATT_VOLTAGE` | Only if `battery.voltage_floor_v` is set: battery voltage (`batt_v` in the solar state) below it, **or missing** | Second check that doesn't trust the SOC estimate. Never runs blind once a floor is configured. The original site has no voltage in its feed, so it is off there. |

### Hard limits (`src/ac2-limits.js`)

The config and the live overrides (`ac2_cfg_overrides`) can tune everything, but every tick both the dispatcher and
the watchdog clamp the merged settings first. They guard against a mistyped number or a careless override, not against
someone editing the code (the owner: anyone can edit it; it's a guard, not a lock).

| Setting | Limit |
|---|---|
| `battery.soc_floor_pct`, `boost_soc_floor_pct` | raised to at least the chemistry's hard floor (50 % lead, 25 % lithium). An unknown chemistry gets the lead floor. |
| `battery.voltage_floor_v` (with `system_v`) | raised to at least 1.95 V per cell on lead (46.8 V at 48 V) or 3.0 V per cell on lithium, counting cells down (45 V at 48 V, so a 15-cell Pylontech isn't tripped) |
| `load.cap_w` | at most 70 % of `load.inverter_continuous_w`, when that is given |
| `cycle.min_off_s` | at least 180 s |
| `stale.solar_max_age_s` / `ac_max_age_s` | at most 600 s / 900 s |

`scripts/build.js` refuses to build from a config with `battery.system_v` other than 24 or 48 (an aircon is too big a
load for 12 V), a `capacity_kwh` under 5, or a chemistry it doesn't know, and prints anything it raised. The shipped
config passes untouched (75 % floor, no voltage floor). Set `battery.chemistry`, `system_v`, `capacity_kwh` and,
if your solar state carries the battery voltage, `voltage_floor_v` for your own bank.

There are also three layers of backstop beyond the dispatcher:
1. **Watchdog node** (every 5 min, separate function node). If the dispatcher hasn't evaluated for 3 min, or
   solar data is stale, and the AC is on under automation, it sends power off. It also sends power off on a hard limit
   (`HARD_SOC_FLOOR`, `BATT_VOLTAGE`), even during a boost, preset or manual hold.
2. **Faikout daily auto-off** (`auto0`, optional, the owner's call). The AC turns itself off at a set time even if the whole
   Cerbo is down.
3. **The Tuya plug**, left on permanently after cutover, as a hard emergency kill.

If the Faikout itself is offline, nothing can be commanded: v2 raises `AC_OFFLINE` once and keeps sending commands
unconfirmed. If the Faikout is offline because the plug cut its power, the AC is off anyway.

## 5. Tiers (AUTO)

Each tier is a latch with its own **enter** and **stay** thresholds (hysteresis). An enter condition must hold for
**90 s** (`sustain.on_s`) and a stay condition must fail for **180 s** (`sustain.off_s`) before the latch flips. The
highest latched tier wins.

| Tier | Enter | Stay while | Runs at | Notes |
|---|---|---|---|---|
| **SOAK** (thermal storage) | SOC ≥ 97 % **and** (curtailed **or** surplus ≥ 1500 W) **and** room not already at the soak setpoint | SOC ≥ 93 % and (curtailed or surplus ≥ 600 W) | cool **24 °C** / heat **27 °C room** (21 Oct, the owner's 26 °C target; were 21 / 24) | Free energy: takes the heat out of the whole house in the afternoon. Allowed when nobody is home (`presence.soak_when_away`), so the house is cool when you get back. |
| **COMFORT** | room needs it (heat: < 24 °C, or < 25 °C when cold outside; cool: > 28 °C) and SOC ≥ 90 % and (curtailed or surplus ≥ 900 W) and someone home | SOC ≥ 85 % and (curtailed or surplus ≥ 300 W) | cool **26 °C** / heat **26 °C room** (21 Oct; were 23 / 23) | Once running, the Daikin's own thermostat regulates. v2 only decides whether it is allowed. |
| **MORNING** (any season, owner 2026-10-12) | 05:00–08:00, room < 19 °C, SOC ≥ 80 %, someone home | SOC ≥ 75 % | heat **22 °C room** (sent as 24) | Pre-dawn warm-up on battery (v1.x W1 rules), now also on a cold spring/summer morning. |
| **EVENING** (end of solar day → 20:00 bedtime) | room needs it, SOC ≥ 87 %, someone home. A day run carries straight on at sunset. | SOC ≥ 85 % | battery (cool 24 / heat 22 °C room) | Owner: comfortable until everyone goes to bed; battery down to 85 %. |
| **NIGHT** (20:00 → 05:00, compressor) | only a really hot (> 28 °C) or cold (< 15 °C) room, SOC ≥ 87 % | SOC ≥ 85 % and room not yet back to comfort | comfort | The exception; overnight is normally fan only. Manual runs at night are also cut at 85 %. |
| **NIGHT FAN** (20:00 → 05:00, any season, owner 15 Oct) | room > 22 °C **or** humidity ≥ 65 %, room > 18 °C, someone home | room > 17 °C and (room > 21 °C or humidity > 60 %) | fan only, quiet | Fresh air for the damp (breath, shower, mould) as much as for heat: the owner wants it even if it cools the house; it stops at 17 °C. The unit's fresh-air setting stays on (set at the unit), so the fan brings outside air in. ~25 W. An evening run hands over at 20:00 without stopping. |
| **ECO** (**off by default**) | room needs it, SOC ≥ 85 %, someone home | SOC ≥ 80 % | cool 27 / heat 19, econo on, demand 50 % | Battery-funded relief on hot afternoons with no surplus. Off until the owner decides (see §10). |

**Season:** heating vs cooling is locked once per local day so it never flips mid-run. Nov–Mar = cool,
May–Sep = heat. In April and October today's forecast decides (max ≥ 27 °C → cool, ≤ 18 °C → heat), else the room
(> 27 °C → cool). Both were 24 °C until the 26 °C target (21 Oct): otherwise heating to 26 got undone by solar pre-cooling to 24. A room that is plainly too cold or too hot overrides it (below).
A dashboard command can force it (`set_season`).

**FRESH AIR (owner 18 Oct): the fan runs whenever nothing else does.** Day and night, home or away, with no
temperature stops: whenever AUTO would otherwise switch the unit off, it runs fan only, quiet (the unit's
fresh-air setting stays on at the unit), ~25-30 W. The logs and the Sunday report show how often the room leaves
the comfort band; stops can be added later if needed. Not in dashboard OFF or a manual hold, and the safety
cut-outs (battery below 75 %, stale solar data, trailer-lead overload) still turn everything off. Because the
unit is now nearly always "on", what min-run (20 min) and min-off (10 min) protect is the **compressor**: heat/cool/
dry ↔ fan changes are timed from compressor start/stop, and fan-only can come and go freely. The fan counts as
30 W (not the compressor's 700 W) when spare solar is worked out, and the outdoor reading is trusted whenever the
compressor is off. A heat ↔ cool change ends any run in progress (a heat run once carried on as cooling).

### Added 2026-10-13 (the owner's picks #4, #5, #9, #10)

**the owner's comfort bands.** **21 Oct: make the house sit around 26 °C** — the numbers below are from before that; the live ones are in `config/ac2.config.json` (heat comfort 26 / soak 27 / battery 25, heats below 24 or 25 on a cold day; cool comfort 26 / soak 24 / battery 26, cools above 28; overnight compressor cools above 28.5). Before: acceptable household range 19–26 °C; 22–23 °C when there's power for it.
Setpoints by who pays (room temperatures): free surplus (pre-cool/heat) cool 21 / heat 24; solar comfort cool **23** /
heat **23**; battery (evening, overnight compressor, morning warm-up) cool **24** / heat **22** (raised 15 Oct, owner 22–23).
Heat settings are sent to the unit +2 °C (its sensor reads high while heating). "Needs it" means outside the
acceptable range (above 26, below 19); the overnight compressor starts above 26.5 / below 18.5.

| Tier | Enter | Stay | Runs at | Why |
|---|---|---|---|---|
| **DRY** (damp guard) | humidity ≥ **65 %** (Inkbird 4 while fresh; the aircon's head sensor reads ~20 % lower), room comfortable (not needing heat or cooling), SOC ≥ 90 %, spare solar ≥ 700 W or curtailed | humidity > 55 %, room ≥ 19 °C, SOC ≥ 85 % | dry mode at the room temperature | Owner: mould is an ongoing problem; target 50–55 % (30 % is drier than comfortable). If the room needs heat or cooling those win (both dry the air). Runs whether or not anyone is home. |

**Forecast (Open-Meteo, today; its free tier is for non-commercial use, data CC BY 4.0).** Hot day (max ≥ 30 °C): pre-cool from 93 %
SOC with 1000 W spare, and "needs cooling" from 25 °C. Mild day (max < 24 °C): no pre-cooling. Cold winter day
(max < 14 °C): pre-heat from 93 %. Warm winter day (≥ 20 °C): no pre-heat. Dull day (< 12 MJ/m² sun): comfort
needs 3 % more battery. A missing, stale (> 12 h) or wrong-date forecast changes nothing. Reasons show on the
dashboard ("hot day forecast 34C: pre-cool early").

**Hot water first (shared solar budget).** Owner: hot water is a bigger priority. While the HW dispatcher is
in DISPATCH, its element is off, SOC ≥ 80 % and there's ≥ 1800 W spare or curtailment, 3200 W is reserved for it
and curtailment doesn't count for the aircon: the aircon may only *start* on what's left. Once the element is
on (its draw is then in the house load) or the cylinder is satisfied, the reservation ends. If the HW hasn't
taken it within 10 minutes, the aircon stops waiting. Running aircon is not stopped for the HW.

**Room temperature = the kitchen/lounge, from the aircon's own sensor** (owner 15 Oct: that is the room to
heat; the bedroom is warmer with people asleep). Measured 14–15 Oct against five Inkbirds in the room: the
aircon sensor reads +0.3 °C while its fan runs, but once the fan stops it drifts up over ~12 min to about
+3.9 °C (warm ceiling air) and stays there. So while idle it is corrected by `sensors.ac_idle_offset_c` (−3.9)
ramped in over `ac_idle_ramp_min` (12) since the fan stopped (`room_src: faikout_idle`). The bedroom Tuya probe
read 4–7 °C high and is out of the loop (`probe_fallback: false`). It had been the idle source: its false 25 °C
kept restarting the night fan (bringing in 10 °C air) and hid the cold morning. Inkbird 4 stays on the fridge
(kitchen, ~1 m up, out of the airflow) as a reference; the recorder logs it from a second Pi.

**Setpoints are room temperatures; the unit is sent a trimmed setting.** Since 15 Oct Inkbird 4 (kitchen fridge,
no probe) is the room source while a second Pi is here to hear it (`bsf/ac2/room_ref`, `room_src: ref`; stale after
10 min → the aircon sensor). The unit still runs its own thermostat off its head sensor, which reads +2.0 °C high
while heating (Heat 21 throttled to 20 Hz with the room at 18.9 °C). So heat settings get
`sensors.heat_setpoint_add_c` (2) added when sent: a 22 °C room target goes to the unit as Heat 24. Cooling trim is
0 until measured. Heat room targets per the owner (22–23 °C): battery/morning 22, comfort 23, soak 24. The Sunday
report's calibration section refines the trim.

**A cold room heats, whatever the season says.** Below heat `need_below_c` (19 °C) the controller heats until
the room is back to heat `comfort_c` (22 °C); above cool `need_above_c` (26 °C) it cools until cool
`comfort_c`. The day's season is not relocked. (15 Oct: a 24 °C+ forecast had made the day 'cool' and boost
ran Cool 23 in a 16.5 °C house.) Boost uses the same season.

**A change at the unit beats boost.** Changing the aircon by hand during a dashboard boost ends the boost and
starts the normal 1 h manual hold. A dashboard OFF still puts itself back.

**Bluetooth sensor option.** If a Bluetooth sensor is paired to the Faikout, its reading (`env`) is used as the
room temperature (status shows `room_src: ble`). Recommended: Xiaomi Mi Temperature and Humidity Monitor 2
(LYWSD03MMC) flashed with the pvvx ATC firmware, or an ELA BlueCoinT.

**Idle readings stay fresh.** The Faikout only republishes status on change; its 30 s heartbeat and minute
summary (`Faikout/daikin1`) now keep an idle unit's readings current in v2, the relay and the recorder.

## 6. Short-cycling protection

| Rule | Value | Exempt |
|---|---|---|
| Minimum run once started | **20 min** (`cycle.min_run_s`) | guards, OFF mode |
| Minimum off before restart | **10 min** (`cycle.min_off_s`) | boost |
| Minimum gap between setpoint changes while running | **10 min** (`cycle.setpoint_min_interval_s`) | turn-on, guards, boost |

On top of this, the Daikin inverter keeps its own compressor restart delay. Because v2 controls by power,
setpoint and mode instead of cutting mains, the compressor ramps down normally instead of being yanked.

Mode changes are sent in two steps: the mode first, then the setpoint once the unit confirms the mode. The
Daikin keeps a separate setpoint per mode, and a combined command landed on the remembered heat setpoint (18 °C)
in the 2026-10-12 live test.

**Not controllable on this unit** (live-tested 2026-10-12): Powerful, econo, demand (power cap), the Ururu
humidify/ventilation features, and a fixed louvre angle. v2 never sends swing, so the louvre position set on the
remote (Owner: up along the roof, to throw air the length of the house) is kept.

## 7. Manual control and modes

* **IR remote or Faikout web page used while in AUTO** → v2 sees the AC no longer matches what it last sent (after
  that command had been confirmed) and enters **MANUAL HOLD** for **60 min** (owner 2026-10-12). **Every further
  change restarts the hour.** It does not fight the person. Only the
  SOC floor and the load cap still apply. Stale solar data does *not* switch off something a person turned on.
  When the hold ends, AUTO resumes. `{"cmd":"clear_hold"}` ends it early.
* **Preference log (owner 2026-10-12):** every manual change is published on `bsf/ac2/manual`. Presses within
  60 s are grouped into one event: from what automation had set → to the final setting, with room, outside and
  humidity readings, SOC, spare solar, and what automation was doing. When the hour ends, a `hold_end` records the
  kept setting, the number of changes and the room temperature at start and end. The farm iMac service
  `farm.bsf.ac2-manual-watch` appends each event to `data/manual-changes.jsonl` and sends it to the owner on
  Telegram. Purpose: learn what the household actually wants and tune the setpoints to it.
* **OFF** (`set_mode OFF`): held off, re-asserted every 2 min.
* **BOOST** (`boost`, default 120 min, max 360): runs at the comfort setpoint regardless of surplus, window or
  presence (same idea as v1.12). The SOC floor and load cap still cut it. Being cut by the SOC floor ends the boost.
* **Commands are idempotent.** v2 sends only when the AC doesn't already match. If the Faikout doesn't apply a command
  within 2 min it retries, and after 3 tries raises `COMMAND_NOT_APPLIED`. That is how it will tell us if a
  field (e.g. `demand`) isn't supported by this unit.

## 8. What the sims and replay show (`node sim/run.js …`)

These were run on the Mac against the built Node-RED paste, with a fake Faikout and a crude house/battery model.
They show the logic's behaviour, not real comfort numbers.

| Scenario | Result |
|---|---|
| `summer` (24 kWh bank, 34 °C day) | SOAK 08:00 → window close 17:30. **1 start**, 9.4 h at ~0.4–0.8 kW, battery still finishes at 97 % |
| `winter` (1–15 °C day) | MORNING heat 05:00 until SOC hit the 75 % floor (06:30), then COMFORT → SOAK heat to 23 °C on midday surplus. 2 starts. End SOC 94 %. |
| `lowsoc` (starts 68 %) | Held off by the guard until SOC recovered, then SOAK once curtailed (11:00) |
| `stale` (feed dies 11:00) | AC off at ~11:02 and kept off |
| `replay` (real 11–12 Oct farm data) | Night 24 °C from 21:38 to 05:00 (SOC ≥ 85 %), cool 24 °C at 07:56, SOAK 22 °C at 08:33, handed over to NIGHT at 16:00 without stopping. **5 commands in 24 h.** (This replays the uncooled house's temps and doesn't subtract the AC's own draw from the battery, so it shows *when* v2 acts, not the outcome.) |

`node --test test/*.test.js` runs 85 tests (plus `python3 test/test_remote.py`). They cover every guard, hysteresis, min-run, min-off, manual hold, boost,
the load cap, the stale-sunset fallback, dry-run isolation, offline/anomaly de-duplication, the watchdog, flow wiring and the replay.
Mutation check: removing the stale guard, the SOC floor or min-off each makes tests fail; so does removing the hard-limit
guard from the dispatcher or from the watchdog.

## 9. Making it modular (more loads later)

The pattern is generic: **guards → tier latches with hysteresis + sustain → short-cycle protection → idempotent
command → status/shadow/anomaly topics.** To add a load (a second AC, the pool pump, the well pump), you write a
config block, an adapter that turns `want` into that device's command, and a topic namespace.

The known gap is coordination. HW v3+ and AC v2 each read the same surplus. v2 adds back only its *own* draw, so
once HW starts, v2 sees the reduced surplus. But two loads can still start in the same 90 s window off the same
watts. Today the load-cap guard and the SOC/curtailment-led tiers make that safe, not efficient. The next step is a
**surplus allocator**: one node that publishes `bsf/budget/<load>` watt grants in priority order (HW → AC soak → …),
which each dispatcher treats as its surplus.

## 10. Decisions for the owner (defaults in brackets; the owner accepted these for now on 2026-10-12 and will review)

1. **Setpoints:** cool comfort [24], pre-cool soak [22], "needs cooling" above [26]. Heat comfort [21], pre-heat
   soak [23], "needs heating" below [19].
2. ~~Battery size~~ **24 kWh gel, confirmed by owner 2026-10-12.**
3. **ECO tier** (battery-funded relief, econo + 50 % demand): [off].
4. ~~Pre-cool when nobody's home~~ allowed (Owner: "you can"). Later idea: use a trip-logging app to pre-cool when he's driving home from town.
5. **AUTO window end:** [sunset − 90 min]. v1.x used −2 h. The flat curve supports later.
6. **Faikout daily auto-off backstop:** [21:00?]. It also turns off an evening manual run at that time.
7. **Room sensor:** the Faikout's own `home` (at the head, return air) vs the Tuya probe vs a BLE sensor. [Faikout, Tuya fallback]
8. **Rooms/zones:** one 2.5 kW head means one zone. Which room is it in, and is that the room to optimise?
9. **Cutover timing:** retire v1.15's plug control and leave the plug permanently on. [Now, while it's summer, since v1.15
   is heating-only and does nothing useful until May.]
