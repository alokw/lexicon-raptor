/**
 * OscListener — minimal OSC-over-UDP receiver.
 *
 * We only need the address pattern of incoming messages (commands carry no
 * arguments), so this deliberately implements just enough of the OSC 1.0 spec:
 * an OSC string is ASCII, null-terminated, padded to a 4-byte boundary.
 * #bundle payloads are ignored (logged once per packet). No external deps —
 * show machines are often offline.
 */
import dgram from 'node:dgram';

function readOscAddress(buf) {
  const end = buf.indexOf(0);
  if (end <= 0) return null;
  const addr = buf.toString('ascii', 0, end);
  return addr.startsWith('/') ? addr : null;
}

export class OscListener {
  constructor(log, onCommand) {
    this.log = log; // CommsLog
    this.onCommand = onCommand; // async (address) => void
    this.socket = null;
    this.port = null;
  }

  /** Idempotent: only rebinds when enabled/port actually changed. */
  configure({ oscEnabled, oscPort }) {
    const wantPort = oscEnabled ? oscPort : null;
    if (wantPort === this.port) return;
    this.close();
    if (wantPort == null) return;

    const socket = dgram.createSocket('udp4');
    socket.on('error', (err) => {
      this.log.add({ server: 'system', dir: 'error', data: `OSC socket error: ${err.message}` });
      this.close();
    });
    socket.on('message', (msg, rinfo) => {
      const addr = readOscAddress(msg);
      if (!addr) {
        this.log.add({
          server: 'system',
          dir: 'error',
          data: `OSC: unparseable packet from ${rinfo.address} (bundles are not supported)`,
        });
        return;
      }
      this.log.add({ server: 'system', dir: 'rx', data: `OSC ${addr} from ${rinfo.address}` });
      Promise.resolve(this.onCommand(addr)).catch((err) =>
        this.log.add({ server: 'system', dir: 'error', data: `OSC ${addr} failed: ${err.message}` })
      );
    });
    this.socket = socket;
    this.port = wantPort;
    socket.bind(wantPort, () =>
      this.log.add({ server: 'system', dir: 'info', data: `OSC listening on udp/${wantPort}` })
    );
  }

  close() {
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* already closed */
      }
      this.socket = null;
    }
    this.port = null;
  }
}
