# Playlite

A home-automation hub that lives on your network: **IF this happens → THEN do that.**
It watches Plex, your Wi-Fi, Home Assistant, MQTT, Hue sensors, Frigate cameras, the weather, the clock and the sun; it controls Hue, Govee, WLED and
Home Assistant lights (and anything else HA or a URL can reach); and you can talk to it
through Alexa, Siri, or AI agents like Claude.

```
IF  Plex opens on the Living Room TV        THEN pulse the basement lights 100→70→100% ×5
IF  a video starts playing                  THEN natural white 100%, fade to 10%
IF  paused / play pressed                   THEN slowly up to 70% / back down to 10%
IF  someone comes home after dark          THEN porch to 80% warm
IF  everyone has left                      THEN away mode, lights off
IF  the front door (Home Assistant) opens   THEN hallway 40%, ping my phone via ntfy
IF  sunset −30 min on a full moon           THEN basement WLED moonlight blue
IF  a tornado warning is issued here        THEN every light red, urgent phone alert
IF  a person reaches the porch after dark    THEN porch light 100%, phone alert with the camera picture
```

## Run it

Node.js 22+. `npm install` once (only dependency: the Anthropic SDK, for the AI features), then:

```powershell
npm start            # → http://<this-pc>:8787   (first visit asks you to create your login)
```

Environment: `PORT` (8787), `PLAYLITE_DATA` (config folder, `./data`), `ANTHROPIC_API_KEY` (optional).

## What's inside

| Area | What it does |
|---|---|
| **Login** | Accounts with scrypt-hashed passwords, 30-day sessions, add family members under 👤 |
| **Workflows** | IF/THEN builder with service tiles and "Or when…" extra triggers (any one starts it) and "Or only if…" condition groups (checks in a group must all pass; any group passing is enough), and "…stays that way for N minutes" on Plex / network / Home Assistant / mode triggers (door open 10 min, phone gone 30 min), *or* type the idea in plain English and AI drafts it for review |
| **People** | Who's home, per person, from any mix of: their phone on the Wi-Fi (no setup), **OwnTracks** GPS (MQTT or HTTP; a "home" region or distance from your location), a **Home Assistant** person, or an **iPhone Shortcut** (arrive / leave automation calling a link). Once a person has GPS / HA / a Shortcut, a napping phone never counts as "left". Triggers: *someone comes home / leaves*, *first one home*, *everyone left* (with "for N minutes"); conditions *anyone / everyone / nobody / Sam is home*; "Mark home/away" by hand or via the AI |
| **Network** | Always-on discovery (mDNS/Bonjour, SSDP/UPnP, ARP, subnet sweep every 10 min). Names & classifies phones, cameras, TVs, speakers, hubs; handles Wi-Fi extenders that share one MAC. Triggers: *device joins / leaves / new device* |
| **Plex** | Play / pause / resume / stop / app opened — no Plex Pass needed (webhooks optional). "▶️ Plex playback" step pauses / resumes / stops / skips on a player (default: the one that triggered it or is playing) — e.g. doorbell → pause the movie |
| **Roku** | "📺 Roku remote" step: any remote button (play/pause, home, volume, power on Roku TVs) or open Plex / Netflix / YouTube… over the local ECP API; Rokus found by network discovery |
| **Lights** | Hue (native fades), Govee LAN (software fades), WLED strips (native fades; found automatically or added by IP), Home Assistant lights; mixed groups; new workflows take over lights mid-fade |
| **Hue sensors** | Hue motion sensors, dimmers / smart buttons / tap switches and contact sensors as triggers, live from the bridge's v2 event stream (pick button 1-4 and short / long press / hold). Motion clear and contact work with "for N minutes" |
| **Home Assistant** | Two-way: any entity change is a trigger, any service is an action, HA lights become Playlite lights |
| **Time & sky** | Clock times with weekdays, sunrise/sunset ± offset; conditions *dark*, *daytime*, *full moon*, *someone home/away* (all computed offline) |
| **Cameras** | Frigate NVR: "a person / car / dog / package… is seen" (by camera, zone and confidence; fires once per sighting and when it walks into a zone) and "it left" as triggers. "📷 Attach a camera picture" on any phone alert: the detection's snapshot, any Frigate camera's live frame, or any camera's snapshot URL (doorbell press → porch picture). AI tools can list cameras and *look* at one. Frigate on port 5000, or 8971 with its login |
| **Weather** | No account or key. Triggers: the sky changes (rain / snow / storm starts), temperature / feels-like / humidity / wind *crosses* a level (frost below 32°F), and US National Weather Service alerts for your spot (tornado / severe thunderstorm / flood warnings…, by name and severity) starting or ending — `{{headline}}` / `{{instruction}}` in phone alerts. Conditions: "only if it's raining", "only if it's below 40°F". Open-Meteo every 10 min, NWS every 2 min, rounded location; °F or °C |
| **Alexa** | Local emulated Hue bridge: "Alexa, discover devices" → groups and voice-named workflows appear. No skill, no cloud |
| **Siri** | Shortcuts → `/run/<workflow>` to run, `/ask?q=` to ask the AI anything (spoken reply) |
| **AI agents** | MCP server at `/mcp` (Claude Code: `claude mcp add --transport http playlite "<url>"`) with tools for lights, workflows, network, Home Assistant |
| **House modes** | home / away / movie / sleep / guest — switch from the header, a workflow step, Siri (`/mode/<name>`) or the AI; "mode changes" trigger and "only if mode is…" condition |
| **Scenes** | Save how lights look (brightness + white or color) under a name on the Lights tab, then restore with a tap, a "🎬 Scene" step, Siri (`/scene/<name>`) or the AI. A "📸 Save scene" step captures the room mid-workflow — e.g. remember it when a movie starts, put it back when it stops |
| **Phone alerts** | "📲 Phone alert" step pushes to the ntfy app (iOS/Android) — title, priority, emoji tags, tap-to-open link, `{{variables}}`; public ntfy.sh or self-hosted with an access token |
| **MQTT** | Built-in client (no extra installs): any broker message is a trigger — match the topic (`+`/`#` wildcards) and the whole message or one JSON field that *changes* (Zigbee2MQTT motion/doors/buttons, Tasmota, ESPHome, Frigate, rtl_433, OwnTracks); "📡 MQTT message" step publishes commands. Works with "for N minutes" (no motion for 10 min) |
| **Web** | Inbound `/hooks/<name>` (IFTTT, Zapier, Tasker, HA `rest_command`); outbound "Call a URL" step with `{{variables}}` |

All machine endpoints (`/hooks`, `/run`, `/mode`, `/ask`, `/mcp`, `/webhooks/plex`) require the secret key shown in Connections
(`?key=` or `Authorization: Bearer`). The Alexa bridge is unauthenticated by design (Hue protocol) and only exposes
groups and workflows you've given a voice name.

## Files

| | |
|---|---|
| `src/engine.js` | IF/THEN engine: triggers, conditions, steps, templating |
| `src/discovery.js`, `src/net.js`, `src/dns.js` | network discovery |
| `src/lights.js` | light control, fades, pulses, takeover |
| `src/scheduler.js`, `src/solar.js` | time/sun triggers, sun & moon math |
| `src/auth.js` | accounts & sessions |
| `src/tools.js`, `src/mcp.js`, `src/agent.js` | AI tools, MCP server, Claude assistant |
| `src/integrations/` | plex, hue, huesensors, govee, wled, homeassistant, alexa, mqtt, roku, weather, frigate |
| `public/` | UI (plain HTML/JS) |
| `INTEGRATIONS.md` | research: smart-home platforms, top HA integrations, brands |
| `ROADMAP.md` | what's next |

## Run it all the time (Windows)

Task Scheduler → *Create Task* → *At startup* → `node.exe` with argument `D:\aiprod\00-Playlite\src\index.js`,
"Start in" `D:\aiprod\00-Playlite`, *Run whether user is logged on or not*.
Allow Node through Windows Firewall on **Private** networks: TCP 8787 (UI), TCP 80 + UDP 1900 (Alexa),
UDP 4002 (Govee), UDP 5353 (discovery).

## Tests

```powershell
npm test
```
