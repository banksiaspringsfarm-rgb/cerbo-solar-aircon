# cerbo-solar-aircon

Run a Daikin split system off spare solar, from Node-RED on a Victron Cerbo GX.

On an off-grid site the battery is often full by mid-morning. After that the chargers throttle the panels
and the energy is thrown away. This project spends that energy on the house instead: it pre-cools (or
pre-heats) the house while the sun is up, so the building's thermal mass carries it through the evening, and
it backs off before it touches the battery. It has been running live on my farm since October 2026.

It controls the aircon properly (mode, setpoint, fan, econo), not by switching its power on and off. The
link is a **Faikout**, an open-source ESP32 board by RevK that plugs into the Daikin's S21 service port and
speaks MQTT. The brain is one Node-RED function node on the Cerbo, written as plain JavaScript with tests.

> **Unsupported modification.** This drives real equipment on the same box that runs your inverter. Read the
> code, start in dry-run (shadow) mode, and keep your own safety limits. No warranty: see the licence.

## What it does

- **Soaks up curtailed solar.** When the battery is near full and the panels are being throttled, it runs
  the aircon past normal comfort (cooler in summer, warmer in winter) to store the energy in the house.
- **Comfort on surplus.** When someone is home and the room is outside the comfort band, it runs only while
  there is surplus and the battery is high.
- **Morning warm-up and evening comfort**, on battery, down to a floor you set (mine is 85 % on a gel bank).
- **Fan-only fresh air** overnight and whenever nothing else is running.
- **Hard guards that fail to OFF:** stale solar data (no update for 2 minutes), battery below the floor,
  house load above a cap (my trailer lead is 4.2 kW), or not enough headroom to start.
- **A separate watchdog node** turns the aircon off if the dispatcher stops running or the data goes stale.
- **Short-cycle protection**: minimum run and off times, setpoint pacing.
- **Respects the remote.** A change at the unit puts it in manual hold for an hour; it leaves you alone.
- **Optional extras:** weather forecast (Open-Meteo) to pre-cool ahead of a hot day, a phone "heading home"
  trigger, and one-tap presets from a phone over Tailscale.

## Hardware (what mine runs on)

| Part | Mine | Needed? |
|---|---|---|
| Inverter/charger | Victron Multi RS | any Victron system with a GX device |
| GX device | Cerbo GX MK2, Venus OS Large (for Node-RED) | yes |
| Battery | ~24 kWh lead gel | any; set the SOC thresholds to suit |
| PV | 13.5 kW, east/west arrays, plus a Fronius | any |
| Aircon | Daikin FTXZ25NV1B (Ururu Sarara) | a Daikin with an S21 port (check the Faikout compatibility list) |
| Aircon interface | Faikout OG (ESP32, plugs into S21, powered by the aircon) | yes |
| Smart plug on the aircon | Tuya plug | optional: left on, only as an emergency kill |
| Room thermometer | Inkbird BLE sensor read by a Raspberry Pi | optional: the Faikout's own sensor works |
| Always-on computer | a Mac (any small Linux box or Pi works) | only for the optional scripts |

Faikout firmware and docs: <https://codeberg.org/RevK/ESP32-Faikout>.

## How it fits together (in words)

1. The **Faikout** sits on the aircon's S21 port and joins your WiFi. You point its MQTT setting at the
   Cerbo's own broker (port 1883, anonymous on the LAN). It publishes the aircon's state on
   `state/daikin1/status` and takes commands on `command/daikin1`.
2. A **solar state message** arrives on the Cerbo broker every 10 seconds on `bsf/hotwater/status`: battery
   SOC, smoothed surplus watts, whole-house load, whether PV is being curtailed, and today's sunset. On my
   site my hot-water dispatcher publishes it (the companion project
   [bsf-solar-dispatch-starter](https://github.com/banksiaspringsfarm-rgb/bsf-solar-dispatch-starter)). If you
   don't run that, a small Node-RED flow reading the Victron `N/<portal-id>/...` topics can publish the same
   fields. The field list is in `docs/ARCHITECTURE.md`.
3. The **AC v2 dispatcher** (a Node-RED function node on the Cerbo) wakes every 30 seconds, reads those two
   feeds plus optional presence, weather and room-sensor topics, decides what the aircon should be doing, and
   sends a command only when the aircon isn't already doing it.
4. It reports on `bsf/ac2/status` (retained), and logs every command it sends *or would send* on
   `bsf/ac2/shadow`. You can drive it from a dashboard with `bsf/ac2/cmd` (Auto, Off, Boost, season).
5. A **watchdog** node, separate from the dispatcher, checks every 5 minutes and forces the aircon off if
   anything looks wrong.

The decision order and every rule are in `docs/CONTROL-LOGIC.md`. All the numbers live in
`config/ac2.config.json` and can be overridden live from flow context without a redeploy.

The `bsf/` topic prefix is just my site's namespace; keep it or change it consistently in `scripts/build.js`.

## Setup

1. **Fit the Faikout** and get it on WiFi: `docs/FAIKIN-SETUP.md` walks through it. Set the hostname
   (`daikin1` here), MQTT host = your Cerbo's IP, and turn `livestatus` on. Check with any MQTT client that
   `state/daikin1/status` is arriving.
2. **Make sure the solar state topic exists** (step 2 above).
3. **Build the flow** (Node 18 or later, no dependencies):
   ```
   npm test          # 76 tests
   npm run build     # writes dist/ac2-flow.json + paste bodies, in dry-run (shadow) mode
   ```
4. **Import `dist/ac2-flow.json`** into Node-RED on the Cerbo (Menu → Import). It expects an MQTT broker
   config node; point the imported nodes at your local broker. In dry-run it only publishes what it *would*
   do on `bsf/ac2/shadow`. Watch that for a day or two.
5. **Go live** by setting `dry_run: false` (or build with `node scripts/build.js --live`) and re-importing.
   `scripts/deploy.js` is how I deploy to my own Cerbo over the Node-RED admin API; it also cuts a wire in my
   older aircon tab, so read it and adjust before you use it.

Try it without hardware:
```
node sim/run.js summer | winter | lowsoc | stale   # synthetic days
node sim/run.js replay                             # a real day of my farm's data
```

## Optional scripts (`scripts/`, Python 3, `paho-mqtt`)

| Script | What |
|---|---|
| `ac2_peek.py` | print what the Faikout is reporting |
| `ac2_weather.py` | Open-Meteo forecast → `bsf/weather/forecast` every 2 h. Set `WEATHER_LAT` / `WEATHER_LON`. Free tier is non-commercial; data CC BY 4.0. |
| `ac2_recorder.py` | a sample every minute to `data/ac2-history.jsonl` |
| `ac2_remote.py` | small HTTP service for one-tap presets (warm / cool / fresh / off / auto) from allowed Tailscale devices only (`config/remote.example.json`) |
| `ac2_press.py` | press a preset from the command line |
| `ac2_homecoming.py` | receives a "coming home" ping from the phone app below and publishes `bsf/presence/coming_home` |

All of them take `CERBO_HOST` (default `venus.local`). `NOTIFY_CMD` is an optional command that gets a
one-line message (I send mine to Telegram).

`android-homecoming/` is a small Android app that watches for the drive home and pings `ac2_homecoming.py`
with a shared token. It sends an ETA, never a location. Put `HOMECOMING_URL` and `HOMECOMING_TOKEN` in
`android-homecoming/local.properties`.

## Status and limits

- Live on one site since 12 October 2026. One indoor head. Tested on lead gel, not lithium.
- Each dispatcher on my Cerbo reads the same surplus on its own; a proper shared surplus allocator across
  loads is not built yet.
- The Daikin's own humidify feature (Ururu) is not supported by the Faikout.

## Licence

[PolyForm Noncommercial 1.0.0](LICENSE.md): free for personal, hobby, research and other non-commercial use.
Ask if you want to use it commercially. Contributions: see `CONTRIBUTING.md`.

Built with a lot of help from Claude (Anthropic) as the main coder; I designed it, run it and check it.
