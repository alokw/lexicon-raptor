/** HMSF ("hh:mm:ss:ff") ↔ frames helpers. All Pixera times are fps-dependent. */

/** Returns frames, or null if the string/fps is unusable. */
export function hmsfToFrames(hmsf, fps) {
  if (!fps) return null;
  const m = /^(\d+):(\d+):(\d+):(\d+)$/.exec(String(hmsf ?? '').trim());
  if (!m) return null;
  const [h, min, s, f] = m.slice(1).map(Number);
  return Math.round((h * 3600 + min * 60 + s) * fps + f);
}

/** Frames → "hh:mm:ss:ff" (or "mm:ss:ff" when under an hour, for row gaps). */
export function framesToHMSF(frames, fps, { compact = false } = {}) {
  if (frames == null || !fps) return null;
  const total = Math.max(0, Math.round(frames));
  const f = total % Math.round(fps);
  const totalSeconds = Math.floor(total / fps);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (compact && h === 0) return `${pad(m)}:${pad(s)}:${pad(f)}`;
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(f)}`;
}
