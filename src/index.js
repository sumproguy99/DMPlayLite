import * as config from './config.js';
import { log } from './log.js';
import { Engine } from './engine.js';
import { LightController } from './lights.js';
import { Scheduler } from './scheduler.js';
import { Discovery } from './discovery.js';
import { Auth } from './auth.js';
import { Assistant } from './agent.js';
import { createTools } from './tools.js';
import { createServices, lightDrivers, emitters, startAll, stopAll } from './plugins/index.js';
import { createServer } from './server.js';
import { lanAddresses } from './net.js';

config.loadConfig();
const { getConfig, updateConfig, saveConfig } = config;
const port = Number(process.env.PORT ?? 8787);

// Core pieces, then every integration (src/plugins/) — they share one context.
const discovery = new Discovery({ dataDir: config.DATA_DIR, log });
const ctx = { getConfig, updateConfig, saveConfig, log, discovery, services: {} };
const services = createServices(ctx);
const lights = new LightController({ drivers: lightDrivers(services), getConfig, log });
const engine = new Engine({ getConfig, updateConfig, lights, log, discovery, services });
Object.assign(ctx, { lights, engine });
createServices(ctx, { late: true }); // plugins that need the engine (Alexa)
const scheduler = new Scheduler({ getConfig, engine, log });
const tools = createTools({ ...ctx, services });
const assistant = new Assistant({ getConfig, tools, log });
const auth = new Auth(config.DATA_DIR);

// Every event source feeds the same engine.
for (const source of [discovery, ...emitters(services)]) source.on('event', (event) => engine.handle(event));

startAll(services);
discovery.start();
scheduler.start();

const server = createServer({ config, lights, engine, log, port, discovery, services, assistant, tools, scheduler, auth });
server.listen(port, '0.0.0.0', () => {
  log.info(`Playlite running — open http://${lanAddresses()[0] ?? 'localhost'}:${port}`);
  if (!auth.hasUsers) log.info('First visit: you will be asked to create your login.');
});

const shutdown = () => {
  stopAll(services);
  discovery.stop();
  scheduler.stop();
  server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
