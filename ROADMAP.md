# Playlite Roadmap & Feature Catalog

Playlite today: **Plex → Hue/Govee** routines with a rule engine (trigger → conditions → steps),
light ownership/takeover, a web UI, and generic webhooks. This document is the brainstorm for
everything it could grow into, and the order that makes sense to build it in.

Legend — **Local** = works on the LAN without the internet · **Cloud** = needs the vendor's API ·
Effort: 🟢 a day · 🟡 a few days · 🔴 a week+

---

## 0. The foundation: turn everything into plugins

Every idea below is the same three building blocks, so the first job is making them pluggable:

```js
// plugins/wled/index.js
export default {
  id: 'wled',
  name: 'WLED',
  settings: { hosts: { type: 'list', label: 'WLED IPs' } },   // UI form generated from this
  devices: async (ctx) => [...],                               // things with capabilities
  triggers: { 'preset.changed': {...} },                       // "When ..."
  conditions: { 'is.on': {...} },                              // "Only if ..."
  actions: { 'effect': { fields: {...}, run: async (ctx, args) => {...} } }, // "Then ..."
  start(ctx) {}, stop() {},
};
```

- **Capability model** so routines target *what a thing can do*, not the brand: `light`, `switch`, `sensor.temperature`,
  `sensor.motion`, `sensor.contact`, `thermostat`, `media_player`, `camera`, `presence`, `notifier`, `speaker`.
- **Engine upgrades**: multiple triggers per routine (OR), AND/OR condition groups, "for N minutes"
  (*no motion for 10 min*), **house modes/variables** (`movie`, `away`, `sleep`, `guest`), **scenes** (snapshot &
  restore), routines that call routines, per-routine run history.
- **Recipe library**: export/import routines as JSON, like IFTTT applets, so you can share them.

---

## 1. Time, sun, moon & calendar  — *Local, no API keys*

| Feature | How | Effort |
|---|---|---|
| Schedules (cron-style, weekdays, "every 15 min") | built-in scheduler | 🟢 |
| **Sunrise / sunset / dusk / dawn ± offset** | solar math from your lat/long (NOAA algorithm, offline) | 🟢 |
| Golden hour / blue hour | same solar math | 🟢 |
| **Full moon / new moon / moon phase** | lunar phase math, offline | 🟢 |
| Seasons, DST changes, holidays | built-in tables + optional holiday API | 🟢 |
| Google Calendar: "meeting starts → office light red (On Air)" | Google Calendar API | 🟡 Cloud |

Example ideas: porch light on at sunset, off at 11pm · full-moon night → basement WLED in moonlight blue ·
holiday color themes automatically in December/October · lights slowly brighten 30 min before sunrise as a wake-up.

## 2. Weather & environment

| Feature | How | Effort |
|---|---|---|
| Current/forecast weather triggers (rain starts, temp below X, wind) | **Open-Meteo** (free, no key) | 🟢 Cloud |
| Severe weather alerts (tornado/thunderstorm warnings) | **NWS api.weather.gov** (US, free) | 🟢 Cloud |
| Air quality / pollen / UV | Open-Meteo air-quality API | 🟢 Cloud |
| Local weather station | Ambient Weather / Ecowitt local push, or rtl_433 (see Radio) | 🟡 Local |

Ideas: tornado warning → every light flashes red + phone alert · rain expected → hallway light turns blue
when you get up · freezing tonight → notify to drip the faucets · bad AQI → turn on air purifier plug.

## 3. Lighting

| Integration | Protocol | Effort |
|---|---|---|
| ✅ Philips Hue | local REST v1 | done |
| ✅ Govee | LAN UDP | done |
| **WLED** | local JSON API + UDP realtime (effects, presets, segments, live color streaming) | 🟢 Local |
| Hue v2 event stream | HTTPS SSE — **Hue motion sensors, dimmer switches, tap dials become triggers** | 🟡 Local |
| Govee cloud API | scenes, DreamView, devices without LAN control | 🟢 Cloud |
| LIFX | LAN UDP protocol | 🟡 Local |
| Nanoleaf | local REST (needs pairing like Hue) | 🟢 Local |
| Yeelight, TP-Link Kasa/Tapo, Shelly, Tuya-local | local protocols | 🟡 Local |
| Zigbee/Z-Wave anything | via **Zigbee2MQTT / Z-Wave JS** over MQTT | 🟡 Local |

Lighting features: **color from the movie poster / album art** (extract palette from Plex artwork) · Ambilight-style
sync with Hyperion/HyperHDR · "movie mode" scene that remembers how the room was and restores after credits ·
circadian white (warmer as evening goes on) · light "notifications" (one soft blue pulse = email, red = doorbell).

## 4. Climate & thermostats

| Integration | Protocol | Effort |
|---|---|---|
| Ecobee | Cloud API (OAuth) — temp, humidity, occupancy sensors, set holds | 🟡 Cloud |
| Google Nest | Smart Device Management API (one-time $5 Google fee) | 🟡 Cloud |
| Honeywell/Resideo | Cloud API | 🟡 Cloud |
| SwitchBot / Govee hygrometers | BLE broadcast (needs a Bluetooth adapter) or cloud | 🟡 |
| Any thermostat in Home Assistant | via HA bridge (§8) | 🟢 |

Ideas: movie starts → hold the HVAC fan on "quiet"/auto so it's not roaring · nobody home → eco setpoint ·
basement humidity > 60% → dehumidifier plug on · room too warm during movie → fan plug on.

## 5. Sensors & IoT devices

| Source | How | Effort |
|---|---|---|
| **MQTT broker** (Mosquitto) | one integration unlocks Zigbee2MQTT, ESPHome, Tasmota, Frigate, rtl_433, OwnTracks | 🟡 Local |
| Motion / door / window / leak / vibration sensors | Zigbee via Zigbee2MQTT, Shelly, Hue v2 | via MQTT |
| Smart plugs w/ power metering | Kasa, Shelly, Tasmota — **"washer finished" = power drops below 5W for 2 min** | 🟡 Local |
| ESPHome / DIY sensors | native API or MQTT | 🟡 Local |
| Bluetooth (BLE) beacons & sensors | noble/BLE adapter | 🔴 |

Ideas: open the fridge during a movie → nothing (ha) — but open the *front door* during a movie → pause Plex,
bring lights to 50% · leak sensor → every light flashes, phone alarm · motion in basement at night → path lights 15%.

## 6. Presence & geolocation

| Method | How | Effort |
|---|---|---|
| **Phone on Wi-Fi** | router client list (OpenWrt / UniFi / ASUS) or ARP/ping sweep | 🟢 Local |
| **iPhone Shortcuts** | Personal Automation "Arrive/Leave Home" → calls Playlite webhook | 🟢 (works today via /hooks) |
| Android | Tasker / Automate / Home Assistant app → webhook | 🟢 |
| **OwnTracks** | open-source GPS app → HTTP/MQTT with zones & distance | 🟡 |
| Per-person presence + "everyone left" / "first one home" | engine feature on top of the above | 🟢 |
| Geofence radius & "approaching home" (within 2 km) | OwnTracks distance | 🟡 |

Ideas: first person home after sunset → entry lights on · everyone gone → all off, thermostat eco, notify if a door is open ·
heading home → pre-warm the house.

## 7. Phones, notifications & messaging

| Channel | How | Effort |
|---|---|---|
| ✅ **ntfy** push (iOS/Android, self-hostable, no account) | HTTP POST | done |
| Pushover | HTTP API | 🟢 Cloud |
| Telegram bot — **two-way**: "/movie" runs a routine, alerts come back with camera snapshots | Bot API | 🟡 Cloud |
| SMS / voice call for emergencies | Twilio | 🟢 Cloud |
| iPhone **Focus modes** (Sleep/Work) → webhook | Shortcuts automation | 🟢 (works today) |
| iPhone alarm stopped → sunrise lights | Shortcuts "When alarm is stopped" | 🟢 (works today) |
| Android: phone charging at night = going to bed | Tasker | 🟢 |
| Installable **mobile app (PWA)** with big routine buttons + home-screen widget | add manifest + service worker | 🟡 |

## 8. Home assistants & ecosystems

| Integration | Value | Effort |
|---|---|---|
| **Home Assistant bridge** (REST + WebSocket) | instantly import *every* HA entity as triggers/actions (thousands of device types) | 🟡 Local |
| **Emulated Hue bridge** | Alexa & Google discover Playlite routines as "lights" locally → "Alexa, turn on movie mode" | 🟡 Local |
| **Apple HomeKit** (HAP-NodeJS) | routines appear as switches → Siri, Home app, Apple Watch | 🟡 Local |
| Matter controller/bridge (matter.js) | future-proof control of Matter devices; expose routines to all ecosystems | 🔴 Local |
| Google Home / Alexa routines → webhook | call Playlite from their routines | 🟢 |

> **Biggest bang for the buck:** a Home Assistant + MQTT bridge. Rather than rebuilding 2,000 integrations,
> Playlite stays the friendly, media-centric automation layer and borrows devices from HA/MQTT.

## 9. Media (beyond Plex)

| Integration | How | Effort |
|---|---|---|
| Plex **control actions** — pause/resume a player, play a playlist | Plex player API | 🟢 Local |
| Plex extras: music (Plexamp) lighting, trailer vs. feature detection, "credits started" (marker data) | session metadata + markers | 🟡 |
| Jellyfin / Emby | webhooks plugin / websocket | 🟢 Local |
| Kodi | JSON-RPC websocket | 🟢 Local |
| **Roku** — "Netflix opened", power on, active app | ECP local HTTP (very easy) | 🟢 Local |
| LG webOS / Samsung Tizen / Android TV / Google TV | local TV APIs (power, app, input) | 🟡 Local |
| Apple TV | companion protocol (hard in Node; via HA) | 🔴 |
| Chromecast | castv2 status | 🟡 Local |
| Sonos | local UPnP/SOAP — play, volume, announcements | 🟡 Local |
| Spotify now playing → album-art colors | Spotify Web API | 🟡 Cloud |
| Xbox / PlayStation / Steam "game launched" → gaming scene | PC agent (§10) or HA | 🟡 |
| Twitch/YouTube "streamer went live" | Twitch EventSub / YouTube RSS | 🟢 Cloud |

Signature cross-feature: **doorbell rings during a movie → pause Plex, lights to 50%, snapshot to your phone;
door closes → resume and dim back.**

## 10. Computers & network

| Feature | How | Effort |
|---|---|---|
| Wake-on-LAN | magic packet | 🟢 Local |
| **Playlite PC Agent** (tiny tray app) — PC locked/unlocked, idle, game/app launched, screen on/off, run a command, shutdown/sleep | small Node/Go agent → webhooks | 🟡 |
| Desk lights follow PC: lock → off, unlock → on | PC agent | 🟢 |
| **Router: OpenWrt** (ubus/rpcd) — new device joined, phone presence, WAN down, bandwidth | ubus JSON-RPC | 🟡 Local |
| UniFi / ASUS-Merlin / pfSense / OPNsense | their APIs | 🟡 Local |
| Internet outage → lights amber, back up → green blip | ping/DNS checks | 🟢 Local |
| Unknown device on network → alert | router client list diff | 🟢 |
| NAS / server health (disk full, Plex transcode load) | SNMP / API | 🟡 |

## 11. Cameras & security

| Integration | How | Effort |
|---|---|---|
| **Frigate** — person/car/package detection (local AI) | MQTT events + snapshots | 🟡 Local |
| ONVIF cameras — motion events | ONVIF pull-point | 🟡 Local |
| Reolink / Amcrest / Hikvision | local HTTP APIs | 🟡 Local |
| UniFi Protect | websocket API | 🟡 Local |
| Doorbells (Reolink, UniFi, Ring via HA) | as above | 🟡 |
| Snapshot attached to phone notifications | RTSP/HTTP snapshot → ntfy/Telegram | 🟢 |

Ideas: person in driveway after dark → porch lights 100% for 5 min · package detected → blue pulse on living-room lights.

## 12. Email & accounts

| Feature | How | Effort |
|---|---|---|
| **Gmail**: email from X / with label Y → light pulse or phone alert | Gmail API (push via Pub/Sub) or IMAP IDLE | 🟡 Cloud |
| Any email provider | IMAP IDLE | 🟡 |
| Send email (daily digest, alert) | SMTP / Gmail API | 🟢 |
| Delivery tracking emails → "package arriving today" light | parse emails | 🟡 |

## 13. Radio

| Feature | How | Effort |
|---|---|---|
| **433/915 MHz sensors with an RTL-SDR dongle (~$30)** — cheap weather stations, doorbells, tire sensors, freezer thermometers | `rtl_433` → MQTT | 🟡 Local |
| NOAA Weather Radio / SAME alerts | rtl_fm + SAME decoder (or just NWS API, §2) | 🔴 |
| Internet radio as an action — play a station on Sonos/Chromecast | stream URL → speaker | 🟢 |
| "Wake up to radio + sunrise lights" | combo routine | 🟢 |

## 14. AI features

| Feature | Effort |
|---|---|
| **Describe a routine in plain English → Playlite builds it** ("when the doorbell rings during a movie, pause it and raise the lights") via the Claude API | 🟡 |
| "Why did my lights do that?" — explain a run from the activity log | 🟢 |
| Suggest routines from patterns ("you dim the lights every night at 10:30 — automate it?") | 🔴 |
| Generate light scenes from a mood or a movie ("make it feel like Blade Runner") | 🟡 |
| Daily/weekly summary: what ran, energy used, what failed | 🟢 |

---

## Suggested build order

**Done so far:** login · IF/THEN builder + AI drafting · always-on network discovery · Home Assistant bridge · Alexa (local) · Siri Shortcuts · MCP for AI agents · sun/moon/schedule triggers · webhooks in & out · ntfy phone alerts.

**Phase 1 — Platform** (makes everything else cheap)
1. Plugin API + capability model; move Plex/Hue/Govee into plugins
2. ✅ Multiple triggers (OR) · AND/OR conditions, "for N minutes", house modes, scenes
3. **Sun / moon / schedule triggers** (offline, no setup)
4. ✅ **ntfy phone notifications** as an action

**Phase 2 — Reach** (most devices for the least work)
5. **MQTT** (unlocks Zigbee2MQTT, Frigate, rtl_433, OwnTracks, Tasmota, ESPHome)
6. **Home Assistant bridge**
7. **WLED** + Hue v2 sensors/buttons
8. Plex control actions (pause on doorbell) + Roku/Jellyfin

**Phase 3 — Awareness**
9. Presence: router (OpenWrt/UniFi) + iOS Shortcuts/OwnTracks helpers
10. Weather + NWS severe alerts
11. Cameras/doorbells (Frigate/ONVIF) with snapshots

**Phase 4 — Polish & voice**
12. PWA mobile app with widgets
13. Emulated Hue (Alexa/Google) + HomeKit (Siri)
14. AI routine builder, PC agent, Gmail/Calendar, thermostats
