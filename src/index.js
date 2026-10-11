import * as config from './config.js';
import { log } from './log.js';
import { Engine } from './engine.js';
import { LightController } from './lights.js';
import { Scheduler } from './scheduler.js';
import { Discovery } from './discovery.js';
import { Auth } from './auth.js';
import { Assistant } from './agent.js';
import { createTools } from './tools.js';
import { HueDriver } from './integrations/hue.js';
import { GoveeDriver } from './integrations/govee.js';
import { PlexIntegration } from './integrations/plex.js';
import { HomeAssistant } from './integrations/homeassistant.js';
import { AlexaBridge } from './integrations/alexa.js';
import { Mqtt } from './integrations/mqtt.js';
import { createServer } from './server.js';
import { lanAddresses } from './net.js';

config.loadConfig();
const { getConfig, updateConfig } = config;
const port = Number(process.env.PORT ?? 8787);

const hue = new HueDriver(getConfig, log);
const govee = new GoveeDriver(getConfig, config.saveConfig, log);
const ha = new HomeAssistant(getConfig, log);
const lights = new LightController({ drivers: { hue, govee, ha }, getConfig, log });
const discovery = new Discovery({ dataDir: config.DATA_DIR, log });
const mqtt = new Mqtt(getConfig, log);
const engine = new Engine({ getConfig, updateConfig, lights, log, discovery, ha, mqtt });
const plex = new PlexIntegration(getConfig, log);
const scheduler = new Scheduler({ getConfig, engine, log });
const alexa = new AlexaBridge({ getConfig, updateConfig, engine, lights, log });
const tools = createTools({ getConfig, updateConfig, engine, lights, discovery, ha, mqtt, log });
const assistant = new Assistant({ getConfig, tools, log });
const auth = new Auth(config.DATA_DIR);

// Every event source feeds the same engine.
for (const source of [plex, ha, discovery, mqtt]) source.on('event', (event) => engine.handle(event));

govee.defaultInterface = lanAddresses()[0]; // multicast on the home LAN, not a VPN adapter
govee.start();
plex.restart();
ha.restart();
mqtt.restart();
discovery.start();
scheduler.start();
alexa.start();

const server = createServer({ config, plex, hue, govee, lights, engine, log, port, discovery, ha, mqtt, alexa, assistant, tools, scheduler, auth });
server.listen(port, '0.0.0.0', () => {
  log.info(`Playlite running — open http://${lanAddresses()[0] ?? 'localhost'}:${port}`);
  if (!auth.hasUsers) log.info('First visit: you will be asked to create your login.');
});

const shutdown = () => {
  for (const s of [plex, govee, ha, mqtt, discovery, scheduler, alexa]) s.stop();
  server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
