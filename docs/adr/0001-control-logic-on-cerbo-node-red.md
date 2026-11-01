# ADR 0001 — AC v2 control logic lives in Node-RED on the Cerbo GX, authored as tested JS in this repo

Date: 2026-10-12 · Status: accepted (Owner: "controlled by the Victron Cerbo through the Wi-Fi", not the Pi)

## Decision
The solar-aware AC controller is a Node-RED tab on the farm's Cerbo GX (<cerbo-ip>), next to the live hot-water
and AC v1.15 dispatchers, using the Cerbo's own MQTT broker. The Faikout joins the farm Starlink WiFi and connects
to that broker. The logic is written as a pure JS module (`src/ac2-core.js`), tested with `node --test` and a
real-data replay, and turned into a paste body + import flow by `scripts/build.js`.

## Why
- One control plane: the Cerbo already owns SOC/PV/load, the broker, the HW dispatcher and the presence feed.
- Same pattern as v1.x (function-node dispatchers, flow-context state, LOCKOUT-style watchdog), so it can be
  maintained the same way. But it is now testable off-device, and the paste is hash-stamped to catch disk/deploy drift.
- No new host that can fail.

## Rejected
- **Python on the Cerbo** — Venus OS rewrites its rootfs on firmware updates, has no pip, and needs custom services. Too fragile on the inverter's controller.
- **Python on the farm iMac** — off the control plane. The Mac sleeps and changes IP (it broke the dashboard on 2026-07-10).
- **Faikout's built-in auto mode alone** — no solar awareness. It is kept only as a daily auto-off backstop.
- **HTTP polling of the Faikout** — MQTT gives push updates plus a last-will offline signal, and the Cerbo already speaks it.
