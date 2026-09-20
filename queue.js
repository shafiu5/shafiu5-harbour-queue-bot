// Queue parsing + change detection for https://local.port.mv/api/portal/vessel-queue
//
// Response shape (Sept 2026):
// { success, data: [ { queue: {identifier, name, description},
//                      listings: [ { vessel: {name, display_name, registration_no, length, breadth},
//                                    status_name, given_zone, given_position, held_at } ] } ] }

export const norm = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export function parseQueue(json) {
  const groups = Array.isArray(json?.data) ? json.data : [];
  const out = [];
  for (const g of groups) {
    const queue = g?.queue?.name || g?.queue?.identifier || '';
    const listings = Array.isArray(g?.listings) ? g.listings : [];
    listings.forEach((l, i) => {
      const v = l?.vessel || {};
      const name = String(v.name || v.display_name || '').trim();
      if (!name) return;
      const reg = String(v.registration_no || '').trim();
      out.push({
        key: reg ? norm(reg) : norm(name),
        nameKey: norm(name),
        name,
        reg,
        queue,
        position: String(i + 1),
        total: listings.length,
        status: String(l.status_name || '').trim(),
        zone: l.given_zone ? String(l.given_zone) : '',
        givenPosition: l.given_position ? String(l.given_position) : '',
      });
    });
  }
  return out;
}

export function describe(v) {
  const lines = [];
  if (v.queue) lines.push(`Queue: ${v.queue}`);
  if (v.position) lines.push(`Position: ${v.position}${v.total ? ` of ${v.total}` : ''}`);
  if (v.status) lines.push(`Status: ${v.status}`);
  if (v.zone || v.givenPosition) lines.push(`Assigned: ${[v.zone, v.givenPosition].filter(Boolean).join(' / ')}`);
  return lines.join('\n');
}

export function findVessel(watch, vessels) {
  return vessels.find((x) => x.key === watch.key || x.nameKey === watch.key);
}

function snapshot(v) {
  return {
    key: v.key, label: v.name, present: true,
    queue: v.queue, position: v.position, total: v.total,
    status: v.status, zone: v.zone, givenPosition: v.givenPosition,
  };
}

// Compare one watch against the latest vessel list.
// Returns { message, next } — message is null when nothing should be sent.
export function evaluate(watch, vessels) {
  const v = findVessel(watch, vessels);

  if (!v) {
    if (!watch.present) return { message: null, next: watch }; // still scanning, stay silent
    return {
      message: `⚪ ${watch.label} is no longer in the queue.\nStill watching — I'll message you when it's back.`,
      next: { key: watch.key, label: watch.label, present: false },
    };
  }

  const next = snapshot(v);
  if (!watch.present) {
    return { message: `🟢 ${v.name} is IN QUEUE\n${describe(v)}`, next };
  }

  const changes = [];
  const diff = (label, a, b) => { if ((a || '') !== (b || '')) changes.push(`${label}: ${a || '—'} → ${b || '—'}`); };
  diff('Queue', watch.queue, v.queue);
  diff('Position', watch.position, v.position);
  diff('Status', watch.status, v.status);
  diff('Zone', watch.zone, v.zone);
  diff('Given position', watch.givenPosition, v.givenPosition);
  if (!changes.length) return { message: null, next };
  return { message: `🔄 ${v.name}\n${changes.join('\n')}\n\n${describe(v)}`, next };
}
