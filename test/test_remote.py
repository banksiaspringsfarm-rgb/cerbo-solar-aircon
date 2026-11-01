#!/usr/bin/env python3
"""ac2_remote: the allow-list, the action whitelist, CSRF protection and the rate limit, on a real --dry server.
Run: python3 test/test_remote.py"""
import json, os, subprocess, sys, time, urllib.request, urllib.error
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import ac2_remote as R
fails = 0
def check(n, c, d=""):
    global fails; print(("  ok " if c else "  FAIL ") + n + ("" if c else "  " + str(d))); fails += 0 if c else 1

# pure parts
check("auto -> set_mode AUTO", R.command_for("auto", None) == {"cmd": "set_mode", "mode": "AUTO"})
check("warm default 60 min", R.command_for("warm", None) == {"cmd": "preset", "name": "warm", "minutes": 60})
check("minutes clamped to 15-240", R.command_for("cool", 5)["minutes"] == 15 and R.command_for("cool", 999)["minutes"] == 240)
check("anything else refused", R.command_for("set_fan", 60) is None and R.command_for("power_on", None) is None)
check("unknown device not allowed", not R.allowed(None) and not R.allowed("some-laptop"))
check("listed device allowed, and found by its Tailscale address", R.allowed("my-phone") and R.node_name("100.64.0.11") == "my-phone")
check("an unknown tailnet address is not a known device", R.node_name("100.99.1.2") in (None, "") or not R.allowed(R.node_name("100.99.1.2")))
check("tailnet_ips only returns 100.64/10 addresses", all(a.startswith("100.") for a in R.tailnet_ips()))
own = {"100.64.0.13", "home-mac", "192.168.1.50"}
check("dashboard origin allowed", R.origin_ok("http://home-mac:8780", own) and R.origin_ok("http://192.168.1.50:8780", own))
check("other sites / ports refused", not R.origin_ok("https://evil.example", own) and not R.origin_ok("http://home-mac:8790", own)
      and not R.origin_ok("http://home-mac.evil.com:8780", own) and not R.origin_ok(None, own))

# late Tailscale (28 Oct: after a reboot it bound 127.0.0.1 only and never looked again)
tries = []
def flaky(a):
    tries.append(a)
    if len(tries) == 1:
        raise OSError(49, "Can't assign requested address")
bound = {"127.0.0.1"}
check("address not up yet: skipped, not marked bound", R.bind_new(["100.64.0.13"], bound, flaky) == [] and "100.64.0.13" not in bound)
check("next round it binds", R.bind_new(["100.64.0.13"], bound, flaky) == ["100.64.0.13"] and "100.64.0.13" in bound)
check("already bound: left alone", R.bind_new(["100.64.0.13"], bound, flaky) == [] and len(tries) == 2)
def real(a):
    R.ThreadingHTTPServer((a, 8795), R.H).server_close()
check("a real address the Mac doesn't have is refused by the OS and skipped", R.bind_new(["100.64.250.250"], set(), real) == [])

# a real dry server
PORT = 8794
srv = subprocess.Popen([sys.executable, os.path.join(ROOT, "scripts", "ac2_remote.py"), "--dry", "--port", str(PORT)],
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
time.sleep(1.5)
def req(method, body=None, headers=None):
    h = dict(headers or {})
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request("http://127.0.0.1:%d/ac" % PORT, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(r, timeout=5) as resp:
            return resp.status, json.loads(resp.read() or b"{}"), dict(resp.headers)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}"), dict(e.headers)
GOOD = {"Content-Type": "application/json", "X-BSF-Control": "1"}
try:
    code, body, _ = req("GET")
    check("GET status answers", code == 200 and body.get("ok"))
    code, body, _ = req("POST", {"action": "warm"}, {"Content-Type": "application/json"})
    check("POST without X-BSF-Control refused", code == 400)
    code, body, _ = req("POST", {"action": "warm"}, {"X-BSF-Control": "1", "Content-Type": "text/plain"})
    check("POST that isn't JSON refused (a cross-site form can't send JSON without a preflight)", code == 400)
    code, body, _ = req("POST", {"action": "open_garage"}, GOOD)
    check("unknown action refused", code == 400)
    code, body, _ = req("POST", {"action": "warm"}, GOOD)
    check("warm accepted -> preset warm 60 min, source tagged", code == 200 and body["sent"] == {"cmd": "preset", "name": "warm", "minutes": 60, "source": "remote:localhost"}, body)
    code, _, h = req("OPTIONS", None, {"Origin": "http://home-mac:8780", "Access-Control-Request-Method": "POST"})
    check("preflight from the dashboard: yes", code == 204 and h.get("Access-Control-Allow-Origin") == "http://home-mac:8780", (code, h))
    code, _, h = req("OPTIONS", None, {"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
    check("preflight from another site: no", code == 403 and "Access-Control-Allow-Origin" not in h, (code, h))
    codes = [req("POST", {"action": "fresh"}, GOOD)[0] for _ in range(10)]
    check("more than 10 a minute -> 429", 429 in codes and codes[0] == 200, codes)
finally:
    srv.terminate()
print("\n%d failure(s)" % fails); sys.exit(1 if fails else 0)
