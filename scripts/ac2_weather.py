#!/usr/bin/env python3
"""
Fetches the site's weather forecast from Open-Meteo and publishes it, retained, on the Cerbo broker as
bsf/weather/forecast for AC v2 (forecast-aware pre-cooling / pre-heating). Run by launchd
(farm.bsf.ac2-weather) every 2 hours = 12 calls a day.

Terms (Open-Meteo): the free tier is for non-commercial use, which
includes personal home automation; limit < 10,000 calls/day; data CC BY 4.0, so the attribution string
travels with the data and is shown wherever the forecast is displayed. Open-Meteo gives no warranty, so
AC v2 treats the forecast as advice only: missing or stale (> 12 h) means default behaviour.

  ac2_weather.py           fetch + publish
  ac2_weather.py --dry     fetch + print, publish nothing
"""
import json, os, sys, time, urllib.request

LAT = float(os.environ.get("WEATHER_LAT", "0"))   # set to your site (the forecast grid is ~11 km, so 2 decimals is plenty)
LON = float(os.environ.get("WEATHER_LON", "0"))
BROKER = os.environ.get("CERBO_HOST", "venus.local")
TOPIC = "bsf/weather/forecast"
URL = ("https://api.open-meteo.com/v1/forecast?latitude=%s&longitude=%s"
       "&daily=temperature_2m_max,temperature_2m_min,shortwave_radiation_sum,cloud_cover_mean,"
       "precipitation_probability_max,relative_humidity_2m_mean&timezone=auto&forecast_days=2") % (LAT, LON)


def fetch():
    with urllib.request.urlopen(URL, timeout=30) as r:
        d = json.load(r)["daily"]
    days = []
    for i, date in enumerate(d["time"]):
        days.append({"date": date, "max_c": d["temperature_2m_max"][i], "min_c": d["temperature_2m_min"][i],
                     "rad_mj": d["shortwave_radiation_sum"][i], "cloud": d["cloud_cover_mean"][i],
                     "rain_prob": d["precipitation_probability_max"][i], "hum": d["relative_humidity_2m_mean"][i]})
    return {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "today": days[0], "tomorrow": days[1] if len(days) > 1 else None,
            "source": "Weather data by Open-Meteo.com (CC BY 4.0)", "lat": LAT, "lon": LON}


def main():
    msg = fetch()
    if "--dry" in sys.argv:
        print(json.dumps(msg, indent=1)); return
    import paho.mqtt.client as mqtt
    try:
        c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="bsf-ac2-weather")
    except AttributeError:
        c = mqtt.Client(client_id="bsf-ac2-weather")
    c.connect(BROKER, 1883, 30)
    c.loop_start()
    c.publish(TOPIC, json.dumps(msg, separators=(",", ":")), qos=1, retain=True).wait_for_publish(10)
    c.loop_stop(); c.disconnect()
    print(time.strftime("%H:%M"), "published", msg["today"]["date"], "max", msg["today"]["max_c"], "rad", msg["today"]["rad_mj"], flush=True)


if __name__ == "__main__":
    main()
