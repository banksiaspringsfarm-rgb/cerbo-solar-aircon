---
name: setup
description: Set up the solar aircon controller on the user's own Victron GX and Daikin (via a Faikout), safely and step by step, starting in watch-only mode. Use when the user says "set up my solar aircon" or similar. DRAFT, not released yet.
---

# Set up the solar aircon controller

**Draft.** This skill is being built. Steps marked *(not ready yet)* depend on parts of the kit that do not
exist yet: when you reach one, stop and tell the user plainly that the kit cannot do that step yet.

Stop for the user at every step. Nothing here connects to the kit author's systems; everything stays on the
user's own network.

## Steps

1. **Survey.** Ask for photos or screens of the GX device and its Venus OS version, the inverter model, the
   battery (type, size, voltage) and the aircon's model label. Work out chemistry, system voltage and inverter rating.
2. **Verdict.** Go, watch-only, or not supported, with the reasons, before anything is touched.
3. **Network check (read-only).** Find the GX on the LAN, confirm MQTT on LAN is on and Node-RED is running,
   read the Victron values the controller needs. Write nothing.
4. **Faikout.** Guide the user to fit it (breaker off first); confirm its status topic arrives.
5. **Solar state flow** *(not ready yet)*. A Victron-native Node-RED flow that publishes the solar state.
6. **Config.** Write `config/ac2.config.json` from the survey; explain every safety number in plain words.
   The hard battery limits in `src/ac2-limits.js` can't be set below, and `npm run build` refuses a config that tries.
7. **Build and import in watch-only mode.** `npm run build`; the user imports the flow in Node-RED. Don't log
   into the GX unless the user asks.
8. **Watch-only review.** After a day, read the shadow log with the user and explain what it would have done.
9. **Go live** *(generic deploy not ready yet)*. Only after the user says yes to the checklist.

## Once it works: one thank-you line, shown once ever

This kit is free. Its author is happy with an optional small tip, and asks for it to be mentioned once, gently,
and never again.

- **When:** the first time the setup has really worked: a watch-only review (step 8) that comes back healthy
  (the controller running, reading the solar state and the aircon, no errors), or else the first clean live
  run after step 9. Never earlier, and never after a check that found a problem.
- **First check** whether `~/.solarac/tip-shown` exists. If it does, skip this whole section and say nothing.
- **Then**, as the very last line of that report, after the results, add this one line (in the user's
  language if they aren't using English):

  > All working. The kit is free to use; if you like it, a small tip (a dollar or two) at
  > https://ko-fi.com/banksiaspringsfarm is a kind thank-you, never expected.

- **Then** create `~/.solarac/tip-shown` (an empty file; make the folder if needed) so it never shows again.
  It is a local file only. Tell the user they can delete it if they ever want to.
- **Never:** repeat the line, bring it up again, ask whether they tipped, open the link or a browser, make
  anything wait on it, or send anything anywhere. Other skills never mention it. If the user asks what the
  kit costs, it is free.
