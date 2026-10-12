export class AppError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
export function requireValue(condition, code = 'INVALID_INPUT', status = 400) {
  if (!condition) throw new AppError(code, status);
}
export function timestamp(value) {
  requireValue(typeof value === 'string' && /(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)), 'INVALID_TIME');
  return new Date(value).toISOString();
}
export function parseGPS(csv) {
  const lines = csv.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  const header = lines.shift().split(',').map(x => x.trim());
  requireValue(['timestamp', 'lat', 'lon'].every(x => header.includes(x)), 'INVALID_GPS');
  requireValue(lines.length > 1 && lines.length <= 100000, 'INVALID_GPS');
  let previous = -Infinity;
  return lines.map(line => {
    const cells = line.split(',').map(x => x.trim());
    const row = Object.fromEntries(header.map((k, i) => [k, cells[i]]));
    const time = timestamp(row.timestamp);
    const lat = Number(row.lat), lon = Number(row.lon);
    requireValue(row.lat && row.lon && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180, 'INVALID_GPS');
    requireValue(Date.parse(time) > previous, 'INVALID_GPS'); previous = Date.parse(time);
    const accuracy_m = row.accuracy_m ? Number(row.accuracy_m) : null;
    requireValue(accuracy_m === null || (Number.isFinite(accuracy_m) && accuracy_m >= 0), 'INVALID_GPS');
    return { timestamp: time, lat, lon, accuracy_m };
  });
}
export function positionAt(points, time) {
  const ms = Date.parse(time), after = points.findIndex(p => Date.parse(p.timestamp) >= ms);
  if (after < 0 || (after === 0 && ms < Date.parse(points[0].timestamp))) return { position: null, quality: 'unavailable' };
  const b = points[after], a = points[Math.max(0, after - 1)];
  const ta = Date.parse(a.timestamp), tb = Date.parse(b.timestamp);
  if (tb - ta > 5000 || Math.min(Math.abs(ms - ta), Math.abs(ms - tb)) > 2000) return { position: null, quality: 'gap' };
  if (a.accuracy_m === null || b.accuracy_m === null) return { position: null, quality: 'unknown_accuracy' };
  if (Math.max(a.accuracy_m, b.accuracy_m) > 30) return { position: null, quality: 'low_accuracy' };
  const f = tb === ta ? 0 : (ms - ta) / (tb - ta);
  return { position: { lat: a.lat + f * (b.lat - a.lat), lon: a.lon + f * (b.lon - a.lon) }, quality: 'approximate' };
}
export function groupFrames(frames) {
  const groups = [];
  for (const frame of [...frames].sort((a,b) => a.time_ms - b.time_ms)) {
    const last = groups.at(-1), prev = last?.at(-1);
    const overlap = prev && Math.abs(prev.bbox.x - frame.bbox.x) < .15 && Math.abs(prev.bbox.y - frame.bbox.y) < .15;
    if (prev && frame.time_ms - prev.time_ms <= 1200 && overlap) last.push(frame); else groups.push([frame]);
  }
  return groups;
}
