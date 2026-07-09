/**
 * CommsLog — bounded ring buffer of all Pixera traffic (tx/rx/info/error),
 * streamed to the debug panel over WebSocket.
 */
import { EventEmitter } from 'node:events';

const MAX_ENTRIES = 2000;

export class CommsLog extends EventEmitter {
  constructor() {
    super();
    this.entries = [];
    this.nextSeq = 1;
  }

  add({ server, dir, data }) {
    const entry = {
      seq: this.nextSeq++,
      ts: new Date().toISOString(),
      server, // 'primary' | 'backup' | 'system'
      dir, // 'tx' | 'rx' | 'info' | 'error'
      data: typeof data === 'string' ? data : JSON.stringify(data),
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
    this.emit('entry', entry);
    return entry;
  }

  recent(limit = 500) {
    return this.entries.slice(-limit);
  }

  clear() {
    this.entries = [];
  }
}
