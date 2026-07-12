/** Thin REST client. Every call throws an Error with a useful message on failure. */

async function call(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('cannot reach Lexicon Raptor server');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) {
    throw new Error(data?.error || `${method} ${url} failed (${res.status})`);
  }
  return data;
}

export const api = {
  getState: () => call('GET', '/api/state'),
  updateSettings: (settings) => call('PUT', '/api/settings', settings),
  addCue: (cue) => call('POST', '/api/cues', cue),
  updateCue: (id, cue) => call('PUT', `/api/cues/${id}`, cue),
  deleteCue: (id) => call('DELETE', `/api/cues/${id}`),
  reorderCues: (ids) => call('PUT', '/api/cues/order', { ids }),
  fireCue: (id) => call('POST', `/api/cues/${id}/fire`),
  transport: (action, timelineName) =>
    call('POST', '/api/transport', timelineName ? { action, timelineName } : { action }),
  listImportCues: () => call('GET', '/api/import/cues'),
  timelineCues: (timeline) =>
    call('GET', `/api/timelines/cues?timeline=${encodeURIComponent(timeline)}`),
  blendToCue: (body) => call('POST', '/api/timelines/blend', body),
  listShows: () => call('GET', '/api/shows'),
  createShow: (name) => call('POST', '/api/shows', { name }),
  activateShow: (file) => call('POST', '/api/shows/active', { file }),
  importShow: (name, show) => call('POST', '/api/shows/import', { name, show }),
  deleteShow: (file) => call('DELETE', `/api/shows/${encodeURIComponent(file)}`),
  showDownloadUrl: (file) => `/api/shows/${encodeURIComponent(file)}/download`,
};
