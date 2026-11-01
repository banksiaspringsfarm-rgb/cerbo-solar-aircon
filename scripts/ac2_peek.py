#!/usr/bin/env python3
"""
One-shot read of what the aircon is doing, straight from the Cerbo broker: the controller's status
(bsf/ac2/status) and the Faikout's own report (state/daikin1/status). Used to prove a button press landed.

  ac2_peek.py              print both, once
  ac2_peek.py --wait H 90  wait up to 90 s for the Faikout to report mode H (C/F/A/D) or power off ("off")
"""
import json, sys, time

import paho.mqtt.client as mqtt

BROKER = os.environ.get("CERBO_HOST", "venus.local")
seen = {}


def on(c, u, msg):
    try:
        seen[msg.topic] = json.loads(msg.payload.decode())
    except ValueError:
        pass


def main():
    want = sys.argv[sys.argv.index("--wait") + 1] if "--wait" in sys.argv else None
    limit = float(sys.argv[sys.argv.index("--wait") + 2]) if "--wait" in sys.argv and len(sys.argv) > sys.argv.index("--wait") + 2 else 90
    try:
        c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="bsf-ac2-peek")
    except AttributeError:
        c = mqtt.Client(client_id="bsf-ac2-peek")
    c.on_message = on
    c.connect(BROKER, 1883, 60)
    c.subscribe("state/daikin1/status")
    c.subscribe("bsf/ac2/status")
    c.loop_start()
    t0 = time.time()
    while time.time() - t0 < (limit if want else 6):
        time.sleep(1)
        f = seen.get("state/daikin1/status")
        if want and f and ((want == "off" and not f.get("power")) or (want != "off" and f.get("power") and f.get("mode") == want)):
            break
    c.loop_stop()
    f = seen.get("state/daikin1/status") or {}
    s = seen.get("bsf/ac2/status") or {}
    print("faikout : power=%s mode=%s temp=%s fan=%s home=%s outside=%s comp=%s" % (
        f.get("power"), f.get("mode"), f.get("temp"), f.get("fan"), f.get("home"), f.get("outside"), f.get("comp")))
    print("ac2     : mode=%s tier=%s preset=%s until=%s room=%s soc=%s ts=%s" % (
        s.get("mode"), s.get("tier"), s.get("preset"), s.get("preset_until"), s.get("room_c"), s.get("soc"), s.get("ts")))
    if want:
        ok = (want == "off" and f and not f.get("power")) or (want != "off" and f.get("power") and f.get("mode") == want)
        print("waited %.0f s for %s: %s" % (time.time() - t0, want, "OK" if ok else "NOT SEEN"))
        sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
