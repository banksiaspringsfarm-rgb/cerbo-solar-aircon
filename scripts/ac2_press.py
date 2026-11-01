#!/usr/bin/env python3
"""
Press an aircon button the way the dashboard and the phone widget do: POST to the Tailscale-only control
service on this Mac (ac2_remote.py). From the Mac itself it goes to 127.0.0.1, which the service allows.

  ac2_press.py warm|cool|fresh|off|auto [minutes]
"""
import json, sys, urllib.request

URL = "http://127.0.0.1:8793/ac"


def main():
    action = sys.argv[1]
    body = {"action": action, "minutes": int(sys.argv[2]) if len(sys.argv) > 2 else 60}
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "X-BSF-Control": "1"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            print(r.status, r.read().decode())
    except urllib.error.HTTPError as e:
        print(e.code, e.read().decode())
        sys.exit(1)


if __name__ == "__main__":
    main()
