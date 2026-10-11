# Smart-Home Assistants & Integrations — Research (October 2026)

What the big smart-home platforms connect to, how to hook into each, which brands matter,
and what that means for Playlite. Usage numbers come from Home Assistant's public analytics;
platform details are from vendor docs and 2026 reporting (sources at the bottom; rumored items are marked).

---

## 1. The platforms at a glance

| Platform | Brain lives | Size / reach (2026) | How Playlite hooks in (best → fallback) |
|---|---|---|---|
| **Home Assistant** | Local (your server) | ~658k active installs; ~2,700–3,000 integrations | REST + WebSocket API (two-way), **webhook trigger** automations, `rest_command`, MQTT, its built-in **MCP server** (`/api/mcp`) for AI agents |
| **Amazon Alexa / Alexa+** | Cloud (+ local Matter) | Biggest installed base of speakers; Alexa+ adding brand integrations (Bosch, iRobot, Yale, Whirlpool, Tapo, Eufy… reported Jul 2026) | **Local emulated Hue bridge** (done in Playlite) → Matter bridge → cloud Smart Home Skill |
| **Google Home / Gemini for Home** | Cloud (+ local Matter) | Gemini replaced Google Assistant on Nest speakers/displays in 2026 | Matter bridge → cloud-to-cloud "Works with Google Home" → Google Home script-editor automations calling Playlite webhooks |
| **Apple Home / Siri** | Local hub (HomePod / Apple TV) | New Siri + Apple home hub expected this month (**rumored**, Oct 13) | **Siri Shortcuts → Playlite URLs** (done) → HomeKit bridge (HAP) → Matter bridge |
| **SmartThings** (Samsung) | Cloud + hub (Edge drivers run locally) | Fast Matter adopter; first-party hub hardware wound down (Aeotec hub) | SmartThings REST API + webhook SmartApp; Matter |
| **Hubitat** | Fully local hub | Niche, reliability-focused; C-8 Pro (Z-Wave LR, Zigbee, Matter) | **Maker API** (local HTTP + event POSTs to a URL) |
| **Homey** (Athom/LG) | Local hub / self-hosted | Matter 1.5 certified (EV chargers, heat pumps, solar, appliances) | Homey Web API, webhooks via Flows |

**Matter is the common language.** Every platform above speaks it, but at different versions
(reports: Google ≈1.2, Apple partial 1.4, SmartThings/Hubitat/Homey 1.5; HA's new matter.js
server is tracking 1.6). Practical consequence: the same Matter device can work on one platform and
not another, so a **Playlite Matter bridge** would expose routines to Alexa, Google and Apple at once.

---

## 2. What Home Assistant users actually connect (real usage data)

Share of HA installs using each integration — snapshot of 26 July 2026, 522,056 reporting installs.

| # | Integration | % | Category | Playlite relevance |
|---|---|---|---|---|
| 1 | Google Cast | 50.8 | Media | Cast "now playing" trigger, TTS announcements |
| 2 | Bluetooth | 49.0 | Protocol | BLE sensors (Govee/SwitchBot/Xiaomi thermometers) |
| 3 | **MQTT** | 48.6 | Protocol | **One integration → Zigbee2MQTT, Frigate, Tasmota, OwnTracks, rtl_433** |
| 4 | **Matter** | 39.2 | Protocol | Future Playlite bridge |
| 5 | UPnP/IGD | 32.9 | Network | Router stats — Playlite discovery already speaks SSDP |
| 6 | Tuya | 29.6 | Cheap Wi-Fi devices | Huge brand family (many store brands) |
| 7 | IPP | 29.3 | Printers | Discovered already (your Canon) |
| 8–12 | DLNA, ESPHome, Zigbee (ZHA/Z2M), Shelly | 20–28 | DIY / local IoT | ESPHome + Shelly have simple local APIs |
| 13 | Android TV Remote | 20.8 | TV | "TV turned on" trigger |
| 14 / 19 | HomeKit bridge / controller | 17 / 15 | Apple | Shows demand for Siri control |
| 15–17 | Samsung TV, Sonos, **Philips Hue** | ~16–17 | Media / lights | Hue ✅ done |
| 18 | AirPlay | 15.8 | Media | |
| 20 | TP-Link (Kasa/Tapo) | 13.9 | Plugs / bulbs | Local API — strong next driver |
| 21 | LG webOS TV | 12.4 | TV | |
| 22–23 | Electricity Maps, Forecast.Solar | ~12 | Energy | "Cheap/clean power now" triggers |
| 24 | Reolink | 10.9 | Cameras | Motion/person events |
| 25 | SmartThings | 10.0 | Platform | |
| 26 | Music Assistant | 9.9 | Media | |
| 27 | Synology DSM | 9.5 | NAS | |
| 28 | Roborock | 9.3 | Vacuums | "Vacuum when everyone leaves" |
| 29–33 | FRITZ!Box, Brother, Z-Wave JS, Tasmota, **UniFi Network** | 7–9 | Network / IoT | Router presence |
| 34–36 | Spotify, Ring, **WLED** | ~6 | Media / security / lights | WLED next on the list |
| 37–50 | Speedtest, Broadlink (IR), BTHome, Xiaomi BLE, **ONVIF**, Home Connect (Bosch/Siemens), **Telegram**, SMLIGHT, **Alexa Devices**, OpenWeatherMap, Denon AVR, LG ThinQ, **UniFi Protect**, OpenAI Conversation | 4.5–6 | Mixed | Cameras, notifications, weather, AI |
| 51–60 | SwitchBot, NUT (UPS), AdGuard, Netatmo, Fully Kiosk, WiZ, Google Nest, **Plex**, Google Assistant, Xbox | 3.5–4.3 | Mixed | |

**Takeaway:** a Playlite ↔ Home Assistant bridge plus MQTT instantly covers the long tail.
Native drivers are worth it only where Playlite needs speed/smoothness (lights) or media awareness.

---

## 3. Brands that work across the assistants, by category

✅ = widely documented support · M = via Matter · (check model) = support varies by product line.
Verify specific models before buying; ecosystems change support frequently.

| Category | Brands (examples) | Alexa | Google | Apple | HA |
|---|---|---|---|---|---|
| **Lighting** | Philips Hue, Nanoleaf, LIFX, Govee, WiZ, TP-Link Kasa/Tapo, Lutron Caséta, Cync (GE), Sengled, IKEA, Aqara, Yeelight, **WLED** (DIY) | ✅ | ✅ | ✅ / M (check model) | ✅ |
| **Plugs & switches** | TP-Link Kasa/Tapo, Shelly, Meross, Wemo, Leviton, Lutron, Inovelli, Zooz, Eve, SwitchBot, Aqara | ✅ | ✅ | M / HomeKit (check model) | ✅ |
| **Thermostats & climate** | ecobee, Google Nest, Honeywell/Resideo, Sensibo, Mysa, tado°, Daikin, Mitsubishi (Kumo/MELCloud) | ✅ | ✅ | ecobee/Honeywell/Mysa/tado (check model) | ✅ |
| **Locks** | Yale/August, Schlage, Kwikset, Level, Ultraloq, Eufy, Aqara, Nuki | ✅ | ✅ | ✅ (check model) | ✅ |
| **Cameras & doorbells** | Ring, Arlo, **Wyze** (you have these), Eufy, Reolink, Google Nest, UniFi Protect, Blink, Amcrest, Aqara | ✅ | ✅ (most) | HomeKit Secure Video: Eufy, Aqara, Logitech, Eve, some Arlo | ✅ (Wyze via add-ons/RTSP) |
| **Sensors** (motion, door, leak, air) | Aqara, Eve, Shelly, SwitchBot, Govee, Ecowitt, Netatmo, Airthings, Sensereo (Matter smoke/CO) | ✅ | ✅ | ✅ (check model) | ✅ |
| **Robot vacuums** | Roborock, iRobot, Ecovacs, Dreame, Eufy, Shark | ✅ | ✅ | M (newer models) | ✅ |
| **Appliances** | Samsung (SmartThings), LG ThinQ, Bosch/Siemens (Home Connect), Whirlpool, GE (SmartHQ) | ✅ | ✅ | M (newer) | ✅ |
| **Media / TV** | Sonos, Roku, Samsung, LG, Android/Google TV, Apple TV, Denon/Marantz HEOS, Yamaha MusicCast, **Plex**, Spotify | ✅ | ✅ | AirPlay | ✅ |
| **Network** | UniFi, eero, TP-Link Deco/Omada, **TP-Link Archer** (yours), FRITZ!Box, OpenWrt, Synology | some | some | — | ✅ |
| **Energy** | Enphase, SolarEdge, Tesla Powerwall, Emporia, Sense, EV chargers (Wallbox, ChargePoint) | some | some | M (Matter 1.4+ energy) | ✅ |
| **Garage** | Chamberlain myQ (via ratgdo / Matter retrofit), Meross, Tailwind | ✅ | ✅ | ✅ (check model) | ✅ |

---

## 4. Hooks & connection methods worth knowing

| Platform | Inbound to Playlite (it tells us) | Outbound from Playlite (we tell it) |
|---|---|---|
| Home Assistant | WebSocket `state_changed` events; automation action `rest_command` → Playlite webhook | REST `POST /api/services/<domain>/<service>`; HA **webhook trigger** (`/api/webhook/<id>`); HA MCP server |
| Alexa | Alexa routine → "turn on" a virtual Playlite device (emulated Hue) | Alexa routines can be **triggered by a virtual device** turning on — Playlite can fire Alexa routines (announcements, music) by toggling one |
| Google Home | Script editor automations can call webhooks via linked services; Matter | Matter devices exposed by a Playlite bridge |
| Apple / Siri | Shortcuts "Get Contents of URL"; Personal Automations (arrive/leave, alarm, Focus, NFC tag, CarPlay) | HomeKit bridge accessories; Shortcuts can be launched by URL scheme on-device |
| SmartThings | Webhook SmartApp subscriptions | REST API device commands |
| Hubitat | **Maker API** POSTs every device event to a URL you choose | Maker API local HTTP commands |
| Homey | Flow "HTTP request" card | Homey Web API |
| AI agents (Claude, ChatGPT, etc.) | **MCP** (Playlite exposes `/mcp`) | Claude API (Playlite's "type an idea" builder) |
| IFTTT / Zapier / n8n | Their webhook actions → Playlite `/hooks/<name>` | Playlite "Call a URL" step → IFTTT Maker / Zapier catch hooks |

---

## 5. Found on your network (Playlite discovery, live scan)

Hue Bridge · Wyze cameras (Cam v4, Pan v3, Duo Cam Pan) · a thermostat (`Tstat-…`) · an Amazon Echo ·
an iPhone and a tablet · TP-Link Archer AX1500 · router `DMNETWORKS` · Canon MF650C printer · Raspberry Pi (`DMF-PI`) ·
Spotify Connect speaker · `DMF-SERVER` running the **ESPHome builder** (usually part of a Home Assistant setup).

**Implication:** if Home Assistant is running on that server, connecting Playlite to it brings in the
Wyze cameras, the thermostat and anything else HA already manages, with no extra drivers.

---

## 6. Playlite priority list derived from this research

1. **Home Assistant bridge** (two-way) — the most leverage, and it looks like you already run HA. *(building now)*
2. **Voice:** Alexa via local emulated Hue *(building now)*, Siri via Shortcuts URLs *(building now)*, later a **Matter bridge** to cover Google + Apple + Alexa at once.
3. **AI agents:** Playlite MCP server + plain-English workflow builder *(building now)*.
4. **MQTT** → Zigbee2MQTT, Frigate, OwnTracks, Tasmota, rtl_433.
5. Native drivers where speed matters: **WLED**, TP-Link Kasa/Tapo, Shelly, LIFX, Nanoleaf.
6. Media triggers beyond Plex: Google Cast, Android TV, Roku, Sonos, Samsung/LG TVs.
7. Notifications: Telegram, ntfy, Pushover.

---

## Sources

- [Most popular Home Assistant integrations (analytics snapshot, Jul 2026) — Gladys community](https://community.gladysassistant.com/t/integrations-home-assistant-les-plus-populaires-candidates-pour-des-integrations-externes-gladys/10385)
- [Home Assistant analytics](https://analytics.home-assistant.io/) · [HA 2026.1 release](https://www.home-assistant.io/blog/2026/01/07/release-20261/) · [Works with Home Assistant](https://www.home-assistant.io/blog/categories/works-with-home-assistant) · [WWHA 2025 recap](https://www.home-assistant.io/blog/2025/12/09/wwha-2025-recap/) · [HELTUN removed from WWHA](https://www.home-assistant.io/blog/2026/01/13/partner-update-heltun/)
- [HA 2026.1 Matter & Thread — Matter Alpha](https://www.matteralpha.com/news/home-assistant-2026-1-offers-better-access-to-matter-and-thread) · [HA 2026.9 Matter troubleshooting — Matter Alpha](https://www.matteralpha.com/news/home-assistant-2026-9-update-makes-matter-troubleshooting-more-accessible) · [Matter news ticker](https://matter-smarthome.de/en/news-ticker/matter-news-from-the-web/)
- [Home Assistant MCP Server integration](https://www.home-assistant.io/integrations/mcp_server) · [hass-mcp](https://mcpservers.org/en/servers/voska/hass-mcp)
- [Alexa+ developer blog (Jul 2026)](https://developer.amazon.com/alexaplus/blogs/2026/07/alexa-plus-new-ways-to-build-experiences) · [What's new in Alexa smart home](https://developer.amazon.com/docs/alexaplus/smarthome/whats-new.html) · [Alexa compatibility guide 2026](https://www.online-tech-tips.com/alexa-smart-home-device-compatibility/) · [Alexa+ new brands (Spanish, single source)](https://ecosistemastartup.com/?p=93591)
- [Gemini for Home replaces Google Assistant — The Gadgeteer](https://the-gadgeteer.com/2026/06/23/gemini-for-home-replaces-google-assistant/) · [Gemini for Home for partners — Google Developers](https://developers.googleblog.com/empowering-service-providers-and-hardware-partners-with-gemini-for-home/) · [Google Home dev newsletter May 2026](https://developers.home.google.com/newsletters/2026/05)
- [Apple Home accessories](https://www.apple.com/au/home-app/accessories/) · [Apple 2026 smart home lineup — MacRumors](https://macrumors.com/2026/07/15/apple-smart-home-lineup-rumors) · [Apple home hub as soon as October — MacRumors](https://www.macrumors.com/2026/07/28/apple-home-hub-as-soon-as-october/) · [Hub launch Oct 13 (rumor)](https://www.freepressjournal.in/tech/apple-likely-to-unveil-smart-home-hub-new-homepod-mini-apple-tv-on-october-13) · [Matter compatibility list — TechRadar](https://www.techradar.com/features/matter-compatibility-list)
- [Homey Matter 1.5 certification](https://www.residentialsystems.com/news/homey-achieves-matter-1-5-certification) · [HA vs SmartThings vs Hubitat 2026](https://carthageelectronics.com/home-assistant-vs-smartthings-vs-hubitat-2026/) · [Best Matter hubs 2026](https://knowledgelib.io/home/smart-home/smart-home-hubs-matter/2026) · [Why Matter still sucks in 2026](https://terrywhite.com/why-matter-still-sucks-in-2026/)
