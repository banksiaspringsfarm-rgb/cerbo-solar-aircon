#!/usr/bin/env python3
"""
Records one sample a minute of everything needed to graph the aircon against the house and the battery.
Runs under launchd (farm.bsf.ac2-recorder, KeepAlive) on the farm iMac and appends to
data/ac2-history.jsonl. It publishes, each minute (retained):
  bsf/ac2/room_ref {ts, c, src}  Inkbird 4 on the kitchen fridge (read by a sensor Pi): the room temperature AC v2
                                 runs on (owner 15 Oct). ts is when the Inkbird was read; v2 drops it after 10 min.
  bsf/ac2/probe {ts, raw_c}      the bedroom Tuya probe's raw reading (logged; v2 only uses it as a fallback if
                                 sensors.probe_fallback is on).

Sample fields (null when a feed is missing or stale):
  ts            ISO time (UTC)
  room_c, outside_c, hum, liquid_c, comp_hz, fan_rpm      Faikout (state/daikin1/status)
  ac_power, ac_mode, ac_temp, ac_fan, faikout_up          Faikout
  tier, ac2_mode, reasons                                  AC v2 (bsf/ac2/status)
  soc, pv_w, load_w, surplus_w, batt_w, curtailed, hw_w    hot-water status (bsf/hotwater/status)
  ac_plug_on                                               Tuya plug switch (bsf/ac/plug_state)
  tuya_outside_c, tuya_inside_c, ac_plug_w                 farm relay state.json (it meters the Tuya plugs over
                                                           the LAN itself; bsf/ac/plug_power is not published)
  home                                                     presence (bsf/presence/state)
  inkbirds, ref_hum                                        Inkbird temps by name; Inkbird 4's humidity (a second Pi)
"""
import json, os, time, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RELAY_STATE = os.path.expanduser(os.environ.get("RELAY_STATE", "~/solar-relay/state.json"))  # optional: a relay's state.json for extra sensors
OUT = os.path.join(ROOT, "data", "ac2-history.jsonl")
BROKER = os.environ.get("CERBO_HOST", "venus.local")
MAX_AGE = 600  # s: older readings are recorded as null

latest = {}


def on_message(c, u, m):
    try:
        p = m.payload.decode()
        latest[m.topic] = (time.time(), json.loads(p) if p[:1] in "{[" else (json.loads(p) if p in ("true", "false") else p))
    except Exception:
        latest[m.topic] = (time.time(), m.payload.decode(errors="replace"))


def fresh(topic):
    v = latest.get(topic)
    return v[1] if v and time.time() - v[0] <= MAX_AGE else None


def num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def relay():
    """The relay's metered AC watts + Tuya inside probe, if its snapshot is fresh (< 2 min)."""
    try:
        d = json.load(open(RELAY_STATE))
        if time.time() - d.get("ts", 0) / 1000 > 120:
            return {}
        a = d.get("ac2") or {}
        return {"ac_w": a.get("ac_w"), "tin": a.get("tuya_inside_c"),
                "tout": a.get("tuya_outside_c") if a.get("tuya_outside_age_s") is not None and a.get("tuya_outside_age_s") <= 600 else None}
    except Exception:
        return {}


def faikout():
    """Last Faikout status, trusted while the device's live heartbeat (state/daikin1, ~30 s) is recent:
    it publishes status on every change, so an idle unit's last status is still current. Temperatures are
    refreshed from the minute summary (Faikout/daikin1)."""
    st, hb, mn = latest.get("state/daikin1/status"), latest.get("state/daikin1"), latest.get("Faikout/daikin1")
    if not st or not isinstance(st[1], dict):
        return {}
    alive = hb and isinstance(hb[1], dict) and hb[1].get("up") and time.time() - hb[0] <= 120
    if not alive and time.time() - st[0] > MAX_AGE:
        return {}
    f = dict(st[1])
    if mn and isinstance(mn[1], dict) and time.time() - mn[0] <= 180:
        for k in ("home", "outside", "hum", "liquid"):
            v = mn[1].get(k); v = v[1] if isinstance(v, list) and len(v) == 3 else v
            if isinstance(v, (int, float)): f[k] = v
    return f


ROOM_REF = "Inkbird 4"   # owner 15 Oct: on the kitchen fridge, ~1 m up, out of the aircon's airflow = the room
_ink = {}


def inkbirds():
    """Inkbirds read by a sensor Pi (it hears the tiny house): {name: temp_c} if fresh. Keeps the full reading of
    ROOM_REF (with its own read time) for the bsf/ac2/room_ref publish."""
    _ink.clear()
    try:
        with urllib.request.urlopen(os.environ.get("INKBIRD_URL", "http://sensor-pi:8780/state.json"), timeout=5) as r:
            fr = (json.load(r).get("freezers") or {})
        fresh_ = {n: o for n, o in fr.items() if isinstance(o, dict) and time.time() - (o.get("ts") or 0) < 600}
        if isinstance((fresh_.get(ROOM_REF) or {}).get("temp_c"), (int, float)):
            _ink["ref"] = fresh_[ROOM_REF]
        return {n: o.get("temp_c") for n, o in fresh_.items()}
    except Exception:
        return None


def sample():
    f = faikout()
    up = latest.get("state/daikin1")
    up = (up[1].get("up") if isinstance(up[1], dict) else up[1] not in (False, "false")) if up else None
    a = fresh("bsf/ac2/status") or {}
    h = fresh("bsf/hotwater/status") or {}
    pr = fresh("bsf/presence/state") or {}
    rl = relay()
    return {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "room_c": f.get("home"), "outside_c": f.get("outside"), "hum": f.get("hum"), "liquid_c": f.get("liquid"),
        "comp_hz": f.get("comp"), "fan_rpm": f.get("fanrpm"),
        "ac_power": f.get("power") if f else None, "ac_mode": f.get("mode"), "ac_temp": f.get("temp"), "ac_fan": f.get("fan"),
        "faikout_up": up,
        "tier": a.get("tier"), "ac2_mode": a.get("mode"), "reasons": a.get("reasons"),
        "soc": h.get("soc"), "pv_w": h.get("pv_total"), "load_w": h.get("ac_load"), "surplus_w": h.get("surplus_smooth", h.get("surplus_now")),
        "batt_w": h.get("batt_power"), "curtailed": h.get("curtailed"), "hw_w": h.get("plug_power"),
        "tuya_outside_c": num(rl.get("tout")) if rl.get("tout") is not None else num(fresh("bsf/ac/outside_temp")), "tuya_inside_c": num(rl.get("tin")),
        "ac_plug_w": num(rl.get("ac_w")), "ac_plug_on": fresh("bsf/ac/plug_state"),
        "home": pr.get("anyone_home") if pr else None,
        "inkbirds": inkbirds(),
        "ref_hum": (_ink.get("ref") or {}).get("humidity"),
    }


def main():
    import paho.mqtt.client as mqtt
    try:
        c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="bsf-ac2-recorder")
    except AttributeError:
        c = mqtt.Client(client_id="bsf-ac2-recorder")
    c.on_message = on_message
    c.on_connect = lambda c, u, f, rc, *a: [c.subscribe(t) for t in (
        "state/daikin1", "state/daikin1/status", "Faikout/daikin1", "bsf/ac2/status", "bsf/hotwater/status", "bsf/presence/state",
        "bsf/ac/outside_temp", "bsf/ac/inside_temp", "bsf/ac/plug_power", "bsf/ac/plug_state")]
    c.reconnect_delay_set(5, 120)
    c.connect_async(BROKER, 1883, 60)
    c.loop_start()
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    time.sleep(15)  # let retained topics arrive
    while True:
        smp = sample()
        with open(OUT, "a") as fh:
            fh.write(json.dumps(smp, separators=(",", ":")) + "\n")
        if _ink.get("ref"):   # the room temperature AC v2 runs on; it falls back to the aircon sensor if this stops
            r = _ink["ref"]
            c.publish("bsf/ac2/room_ref", json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(r["ts"])),
                      "c": r["temp_c"], "hum": r.get("humidity"), "src": ROOM_REF}), qos=0, retain=True)
        if isinstance(smp.get("tuya_inside_c"), float):
            c.publish("bsf/ac2/probe", json.dumps({"ts": smp["ts"], "raw_c": smp["tuya_inside_c"]}), qos=0, retain=True)
        time.sleep(60 - time.time() % 60)


if __name__ == "__main__":
    main()
