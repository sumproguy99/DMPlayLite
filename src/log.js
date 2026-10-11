import { EventEmitter } from 'node:events';

// In-memory activity log with live subscribers (used for the UI's SSE feed).
class ActivityLog extends EventEmitter {
  entries = [];
  max = 500;
  #seq = 0;

  write(level, message, data) {
    const entry = { id: ++this.#seq, at: new Date().toISOString(), level, message, ...(data ? { data } : {}) };
    this.entries.push(entry);
    if (this.entries.length > this.max) this.entries.shift();
    const line = `[${entry.at.slice(11, 19)}] ${level.toUpperCase().padEnd(5)} ${message}`;
    (level === 'error' ? console.error : console.log)(line);
    this.emit('entry', entry);
    return entry;
  }

  info(message, data) { return this.write('info', message, data); }
  warn(message, data) { return this.write('warn', message, data); }
  error(message, data) { return this.write('error', message, data); }
  event(message, data) { return this.write('event', message, data); }
}

export const log = new ActivityLog();
log.setMaxListeners(100);
