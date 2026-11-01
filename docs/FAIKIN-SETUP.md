# Faikout setup — get the Daikin online and talking to the Cerbo

For the owner, on the phone, at the AC. About 15 minutes. The fiddly checks after step D are done from the farm iMac by Claude.

**Kit:** Faikout "OG" (pre-flashed and tested by the AU seller 2026-09-28), Type A S21 lead (5-pin JST EH), in the
Daikin FTXZ25NV1B (Ururu Sarara). This model is on the Faikout confirmed-working list.

> **Power note.** The Faikout is powered *by the AC*. The AC's mains comes through the Tuya plug (<plug-ip>),
> which the current automation (AC v1.15) switches off outside 05:00–18:00 and whenever it doesn't want heat.
> **Whenever that plug is off, the Faikout is dark.** For a setup session, keep the plug on by pressing
> **ON (boost)** on the LAN dashboard (`http://other-mac.local:8780/solar_dispatch_dashboard.html`). Boost holds the
> plug on for 2 h, extendable +30 min, and v1.15 lets boost run at night. The AC wakes in its last mode
> (Heat 25 °C), so switch the AC itself off with the remote. The Faikout stays powered.

## A. Fit it (done 2026-10-12)

1. Isolate power: plug off, or the breaker.
2. Open the front panel and find the S21 socket (5-pin, white) on the indoor control board. It is the socket the
   official Daikin WiFi adapter uses. Pin 1 is marked with a triangle.
3. Plug in the Type A lead, then plug the other end into the Faikout.
4. Mount the board clear of the coil and the drip path, and don't pinch the lead when the cover goes back on.
5. Power back on. The LED is solid green for a few seconds, then blinks.

## B. Put it on the Starlink WiFi

1. On the phone's WiFi, join **`Faikout`** (sometimes `Daikin…`). It is an open network with no password.
2. The setup page should open by itself. If not, browse to **http://192.168.4.1**.
3. Fill in:

   | Field | Value |
   |---|---|
   | Hostname | **`daikin1`** (one word, no spaces; the dispatcher's topics are built from it) |
   | SSID / passphrase | the farm Starlink WiFi. It is 2.4 GHz only, which the Starlink router provides. |
   | MQTT host | **`<cerbo-ip>`** (the Cerbo GX) |
   | MQTT username / password | **leave blank** (the Cerbo's LAN broker is anonymous) |
   | Timezone | **`AEST-10`** (Queensland, no daylight saving) |

4. Press **Set**. It reboots and joins the farm WiFi. If it can't connect it comes back with an error, usually a
   typo in the passphrase.

## C. Point it at the Cerbo broker

This is already done if you filled in MQTT host in step B. To change it later, open **`http://daikin1.local/`** →
*WiFi settings* → MQTT host.

## D. Check it works (phone)

1. Phone back on the farm WiFi → open **`http://daikin1.local/`**. If Android won't resolve `.local`, find
   `daikin1` (or an Espressif device) in the Starlink app's device list and use its IP.
2. The controls page should show the **room temperature**, and probably the outside temperature.
3. Press **On/Off** on the page. The AC should beep and respond within a few seconds. Switch it off again.
4. **Upgrade the firmware:** *WiFi settings* → **Upgrade**. It needs internet, which Starlink provides. The seller
   flashed it in September and features are added often.

LED colours: **yellow** = AC off and talking OK · **red** = heating · **blue** = cooling · **magenta** = it can't talk to the
Daikin (lead or socket problem) · **white/cyan** blinking = setup WiFi mode, not configured yet · **white/yellow** = WiFi
link down.

## E. What Claude does from the iMac once it's online

* Subscribe to the Cerbo broker and confirm the real topics. Expect `state/daikin1` (online) and
  `state/daikin1/status` (JSON). If the firmware uses different topic or field names, fix `normalizeFaikout` and rebuild.
* Read back its settings (`setting/daikin1` with an empty payload) and set:
  * `livestatus: true`, so it publishes status on every change rather than only on request.
  * Turn off Home Assistant discovery, so it doesn't fill the Cerbo broker with `homeassistant/...` topics.
  * Optional backstop, **your call**: a daily auto-off time (`auto0`). Then even if the Cerbo died mid-afternoon,
    the AC still turns itself off that evening.
* With you watching: one `command/daikin1` on/off test, then capture a cooling run's telemetry.

Want to look yourself? Any MQTT app (MQTT Explorer, IoT MQTT Panel) → broker `<cerbo-ip>` port `1883` → subscribe `state/daikin1/#`.

## F. Report back

* ✅/❌ it joined the WiFi, and what hostname you used
* LED colour now
* Does the controls page show **room temp**? **Outside temp**?
* Which controls appear: is there a **Demand** slider? Econo / Powerful / Streamer / Quiet? (Demand tells us whether
  power-capping works on this model.)
* The firmware version (settings page), before and after the upgrade
* Which room the unit is in. Is that the room you want comfortable, and is anywhere else meant to be cooled by it?

## Troubleshooting

| Symptom | Fix |
|---|---|
| No `Faikout` WiFi appears | Check it's powered (the plug may be off, see the power note). Factory reset: short the two round pads on the back of the board 3 times quickly (red on the third). |
| Won't join Starlink | 2.4 GHz only. Check the passphrase. Special characters in the SSID can trip it. |
| LED magenta | It can't talk to the Daikin: reseat the lead and check pin 1 orientation. |
| Goes offline every evening / mid-day | The plug is being cut by v1.15. That is expected until the Phase 2 cutover leaves the plug on permanently. |
| `daikin1.local` doesn't load | Use the IP from the Starlink app. Some Android phones don't do `.local`. |
