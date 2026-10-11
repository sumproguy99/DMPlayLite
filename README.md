# Playlite

A home-automation hub that lives on your network: **IF this happens → THEN do that.**
It watches Plex, your Wi-Fi, Home Assistant, the clock and the sun; it controls Hue, Govee and
Home Assistant lights (and anything else HA or a URL can reach); and you can talk to it
through Alexa, Siri, or AI agents like Claude.

```
IF  Plex opens on the Living Room TV        THEN pulse the basement lights 100→70→100% ×5
IF  a video starts playing                  THEN natural white 100%, fade to 10%
IF  paused / play pressed                   THEN slowly up to 70% / back down to 10%
IF  my iPhone joins the Wi-Fi after dark    THEN porch to 80% warm
IF  the front door (Home Assistant) opens   THEN hallway 40%, ping my phone via ntfy
IF  sunset −30 min on a full moon           THEN basement WLED moonlight blue
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
| **Workflows** | IF/THEN builder with service tiles and "Or when…" extra triggers (any one starts it) and "Or only if…" condition groups (checks in a group must all pass; any group passing is enough), *or* type the idea in plain English and AI drafts it for review |
| **Network** | Always-on discovery (mDNS/Bonjour, SSDP/UPnP, ARP, subnet sweep every 10 min). Names & classifies phones, cameras, TVs, speakers, hubs; handles Wi-Fi extenders that share one MAC. Triggers: *device joins / leaves / new device* |
| **Plex** | Play / pause / resume / stop / app opened — no Plex Pass needed (webhooks optional) |
| **Lights** | Hue (native fades), Govee LAN (software fades), Home Assistant lights; mixed groups; new workflows take over lights mid-fade |
| **Home Assistant** | Two-way: any entity change is a trigger, any service is an action, HA lights become Playlite lights |
| **Time & sky** | Clock times with weekdays, sunrise/sunset ± offset; conditions *dark*, *daytime*, *full moon*, *someone home/away* (all computed offline) |
| **Alexa** | Local emulated Hue bridge: "Alexa, discover devices" → groups and voice-named workflows appear. No skill, no cloud |
| **Siri** | Shortcuts → `/run/<workflow>` to run, `/ask?q=` to ask the AI anything (spoken reply) |
| **AI agents** | MCP server at `/mcp` (Claude Code: `claude mcp add --transport http playlite "<url>"`) with tools for lights, workflows, network, Home Assistant |
| **House modes** | home / away / movie / sleep / guest — switch from the header, a workflow step, Siri (`/mode/<name>`) or the AI; "mode changes" trigger and "only if mode is…" condition |
| **Phone alerts** | "📲 Phone alert" step pushes to the ntfy app (iOS/Android) — title, priority, emoji tags, tap-to-open link, `{{variables}}`; public ntfy.sh or self-hosted with an access token |
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
| `src/integrations/` | plex, hue, govee, homeassistant, alexa |
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
