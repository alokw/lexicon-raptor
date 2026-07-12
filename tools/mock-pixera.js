/**
 * Mock Pixera server for development/testing without hardware.
 * Speaks the same pxr1-framed JSON-RPC protocol on port 1400 (or argv[2]).
 *
 *   node tools/mock-pixera.js [port]
 */
import net from 'node:net';

const PORT = Number(process.argv[2] || 1400);
const FRAME_TAG = Buffer.from('pxr1', 'ascii');

// ---- Fake project state -----------------------------------------------------
const timelines = [
  {
    handle: 1001,
    name: 'Main Show',
    fps: 60,
    transportMode: 3,
    timeFrames: 0,
    opacity: 1,
    cues: [
      { handle: 5001, name: 'Opening Look', number: 1, note: 'House to half', operation: 1, color: '#276235' },
      { handle: 5002, name: 'Walk-in Loop', number: 2, note: '', operation: 2, color: '#FFFF00' },
      { handle: 5003, name: 'Keynote Title', number: 3, note: 'Wait for MC', operation: 4, color: '#384C70' },
      { handle: 5005, name: 'Sponsor Reel — Diamond Tier Partners (Extended 4K Version)', number: 4, note: 'Long-name cue for UI testing', operation: 1, color: '#7A4B9B' },
      { handle: 5006, name: 'IMAG Look B / Wide + Lower Third Combo', number: 5, note: '', operation: 2 },
      { handle: 5004, name: 'Blackout', number: 99, note: 'EOS', operation: 3, color: '#8D1D2C' },
    ],
  },
  {
    handle: 1002,
    name: 'Breakout A',
    fps: 30,
    transportMode: 3,
    timeFrames: 0,
    opacity: 1,
    cues: [
      { handle: 5101, name: 'Intro Stinger', number: 1, note: '', operation: 1 },
      { handle: 5102, name: 'Speaker Support', number: 2, note: '', operation: 2 },
      // Real projects contain these — exercise the import UI warnings:
      { handle: 5103, name: 'Speaker Support', number: 3, note: 'dup name', operation: 2 },
      { handle: 5104, name: '', number: 4, note: 'unnamed cue', operation: 3 },
    ],
  },
  { handle: 1003, name: 'Rehearsal Scratch', fps: 25, transportMode: 3, timeFrames: 0, opacity: 1, cues: [] },
];
let selectedTimeline = timelines[0];

// Cues sit 45s apart on their timeline.
const cueTimeFrames = (tl, index) => index * 45 * tl.fps;

// Advance "playing" timelines and step opacity fades so feedback moves.
setInterval(() => {
  for (const tl of timelines) {
    if (tl.transportMode === 1) tl.timeFrames += tl.fps / 10;
    if (tl.fade) {
      const step = (tl.fps / 10) / Math.max(tl.fade.frames, 1);
      const dir = tl.fade.target > tl.opacity ? 1 : -1;
      tl.opacity = Math.max(0, Math.min(1, tl.opacity + dir * step));
      if (Math.abs(tl.opacity - tl.fade.target) < step) {
        tl.opacity = tl.fade.target;
        delete tl.fade;
      }
    }
  }
}, 100);

function framesToHmsf(frames, fps) {
  const totalSeconds = frames / fps;
  const h = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const s = String(Math.floor(totalSeconds % 60)).padStart(2, '0');
  const f = String(Math.floor(frames % fps)).padStart(2, '0');
  return `${h}:${m}:${s}:${f}`;
}

const hmsf = (tl) => framesToHmsf(tl.timeFrames, tl.fps);

const byName = (name) => timelines.find((t) => t.name === name);
const byHandle = (h) => timelines.find((t) => t.handle === h);

// ---- RPC handlers -----------------------------------------------------------
const handlers = {
  'Pixera.Utility.getApiRevision': () => 481,
  'Pixera.Timelines.getTimelineNames': () => timelines.map((t) => t.name),
  'Pixera.Timelines.getTimelinesSelected': () => (selectedTimeline ? [selectedTimeline.handle] : []),
  'Pixera.Timelines.getTimelineFromName': ({ name }) => byName(name)?.handle ?? null,
  'Pixera.Timelines.Timeline.getName': ({ handle }) => byHandle(handle)?.name ?? null,
  // Reply shape matches real rev-481 hardware (operation as string,
  // formattedNumber, time as HMSF string, color, countdown, jump fields).
  'Pixera.Timelines.Timeline.getCueInfosAsJsonString': ({ handle }) => {
    const tl = byHandle(handle);
    if (!tl) throw { code: -32000, message: 'unknown handle' };
    const opName = { 1: 'Play', 2: 'Pause', 3: 'Stop', 4: 'Jump' };
    return JSON.stringify(
      tl.cues.map((c, i) => ({
        color: c.color || '#000000',
        countdown: framesToHmsf(Math.max(cueTimeFrames(tl, i) - tl.timeFrames, 0), tl.fps),
        formattedNumber: String(c.number),
        handle: c.handle,
        index: i,
        jumpgoal: 'none',
        jumpmode: 'none',
        name: c.name,
        note: c.note,
        number: c.number,
        operation: opName[c.operation] || 'Play',
        time: framesToHmsf(cueTimeFrames(tl, i), tl.fps),
        waitDuration: 0.0,
      }))
    );
  },
  'Pixera.Timelines.Timeline.getCues': ({ handle }) =>
    byHandle(handle)?.cues.map((c) => c.handle) ?? [],
  'Pixera.Timelines.Cue.getName': ({ handle }) =>
    timelines.flatMap((t) => t.cues).find((c) => c.handle === handle)?.name ?? null,
  'Pixera.Timelines.Cue.getNumber': ({ handle }) =>
    timelines.flatMap((t) => t.cues).find((c) => c.handle === handle)?.number ?? null,
  'Pixera.Timelines.Cue.getNote': ({ handle }) =>
    timelines.flatMap((t) => t.cues).find((c) => c.handle === handle)?.note ?? '',
  'Pixera.Timelines.Cue.getOperation': ({ handle }) =>
    timelines.flatMap((t) => t.cues).find((c) => c.handle === handle)?.operation ?? 1,
  // Reply shape matches real rev-481 hardware: capital-M string Mode,
  // HMSF time, full nextcue object, opacity, smptemode. No duration field.
  'Pixera.Timelines.Timeline.getTimelineInfosAsJsonString': ({ handle }) => {
    const tl = byHandle(handle);
    if (!tl) throw { code: -32000, message: 'unknown handle' };
    const opName = { 1: 'Play', 2: 'Pause', 3: 'Stop', 4: 'Jump' };
    // Actual next cue relative to the playhead (like real hardware).
    const nextIdx = tl.cues.findIndex((c, i) => cueTimeFrames(tl, i) > tl.timeFrames);
    const next = nextIdx === -1 ? null : tl.cues[nextIdx];
    return JSON.stringify({
      Mode: opName[tl.transportMode] || 'Stop',
      fps: tl.fps,
      index: timelines.indexOf(tl),
      name: tl.name,
      nextcue: next
        ? {
            color: next.color || '#000000',
            countdown: framesToHmsf(cueTimeFrames(tl, nextIdx) - tl.timeFrames, tl.fps),
            formattedNumber: String(next.number),
            handle: next.handle,
            index: nextIdx,
            jumpgoal: 'none',
            jumpmode: 'none',
            name: next.name,
            note: next.note,
            number: next.number,
            operation: opName[next.operation] || 'Play',
            time: framesToHmsf(cueTimeFrames(tl, nextIdx), tl.fps),
            waitDuration: 0.0,
          }
        : null,
      opacity: Math.round(tl.opacity * 100) / 100,
      smptemode: 'none',
      time: hmsf(tl),
    });
  },
  'Pixera.Compound.getTransportModeOnTimeline': ({ timelineName }) =>
    byName(timelineName)?.transportMode ?? 3,
  'Pixera.Compound.setTransportModeOnTimeline': ({ timelineName, mode }) => {
    const tl = byName(timelineName);
    if (tl) tl.transportMode = mode;
    console.log(`[mock] transport ${timelineName} -> ${mode}`);
    return null;
  },
  'Pixera.Compound.getCurrentHMSFOfTimeline': ({ name }) => {
    const tl = byName(name);
    return tl ? hmsf(tl) : '00:00:00:00';
  },
  'Pixera.Compound.getCurrentCountdownHMSFOfTimeline': ({ name }) => '00:00:12:10',
  'Pixera.Compound.applyCueOnTimeline': ({ timelineName, cueName, blendDuration }) => {
    const tl = byName(timelineName);
    if (!tl) throw { code: -32000, message: `unknown timeline: ${timelineName}` };
    const cueIdx = tl.cues.findIndex((c) => c.name === cueName);
    if (cueIdx === -1) {
      throw { code: -32000, message: `unknown cue: ${cueName}` };
    }
    selectedTimeline = tl;
    tl.timeFrames = cueTimeFrames(tl, cueIdx);
    tl.transportMode = 1;
    console.log(
      `[mock] GO "${cueName}" on "${timelineName}" blend=${blendDuration ?? 'default'}s`
    );
    return null;
  },
  'Pixera.Compound.getFpsOfTimeline': ({ name }) => byName(name)?.fps ?? 60,
  'Pixera.Compound.startOpacityAnimationOfTimeline': ({ name, fadeIn, fullFadeDuration }) => {
    const tl = byName(name);
    if (tl) tl.fade = { target: fadeIn ? 1 : 0, frames: fullFadeDuration };
    console.log(`[mock] fade ${fadeIn ? 'UP' : 'DOWN'} "${name}" over ${fullFadeDuration} frames`);
    return null;
  },
  'Pixera.Timelines.Timeline.blendToTimeWithTransportMode': ({
    handle,
    goalTime,
    blendDuration,
    transportMode,
  }) => {
    const tl = byHandle(handle);
    if (!tl) throw { code: -32000, message: 'unknown handle' };
    tl.timeFrames = goalTime;
    tl.transportMode = transportMode;
    console.log(
      `[mock] blend "${tl.name}" to frame ${goalTime} over ${blendDuration} frames -> mode ${transportMode}`
    );
    return null;
  },
};

// ---- pxr1-framed JSON-RPC server ---------------------------------------------
const server = net.createServer((socket) => {
  console.log('[mock] client connected');
  let buffer = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 8) {
      if (!buffer.subarray(0, 4).equals(FRAME_TAG)) {
        socket.destroy();
        return;
      }
      const size = buffer.readUInt32LE(4);
      if (buffer.length < 8 + size) return;
      const payload = buffer.subarray(8, 8 + size).toString('utf8');
      buffer = buffer.subarray(8 + size);

      let reply;
      try {
        const msg = JSON.parse(payload);
        const handler = handlers[msg.method];
        if (!handler) {
          reply = {
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32601, message: `method not found: ${msg.method}` },
          };
        } else {
          try {
            const result = handler(msg.params || {});
            reply = { jsonrpc: '2.0', id: msg.id };
            if (result !== null) reply.result = result;
          } catch (err) {
            reply = { jsonrpc: '2.0', id: msg.id, error: err };
          }
        }
      } catch {
        reply = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } };
      }

      const out = Buffer.from(JSON.stringify(reply), 'utf8');
      const header = Buffer.alloc(8);
      FRAME_TAG.copy(header, 0);
      header.writeUInt32LE(out.length, 4);
      socket.write(Buffer.concat([header, out]));
    }
  });

  socket.on('close', () => console.log('[mock] client disconnected'));
  socket.on('error', () => {});
});

server.listen(PORT, () => console.log(`[mock] fake Pixera listening on :${PORT}`));
