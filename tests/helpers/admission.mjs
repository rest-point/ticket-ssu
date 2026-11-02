// Existing policy/concurrency suites obtain admission through the real public
// endpoint. Admission rejection/forgery suites intentionally do not use this helper.
export async function admissionHeaders(store, base, headers, method, path, body) {
  let pid;
  const hold = /^\/api\/performances\/([^/]+)\/hold$/.exec(path);
  if (method.toUpperCase() === 'PUT' && hold && Array.isArray(body?.seatIds) && body.seatIds.length) pid = hold[1];
  if (method.toUpperCase() === 'POST' && path === '/api/bookings' && typeof body?.holdId === 'string') pid = store.get('SELECT performance_id FROM holds WHERE id=?', body.holdId)?.performance_id;
  if (!pid) return headers;
  const response = await fetch(`${base}/api/v1/performances/${pid}/queue`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' });
  const status = await response.json();
  return response.ok && status.admission_token ? { ...headers, 'X-Admission-Token': status.admission_token } : headers;
}
