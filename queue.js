// Queue parsing + change detection. No dependencies, so it can be tested on its own.
//
// The exact JSON shape of /api/portal/vessel-queue isn't hard-coded. parseQueue()
// walks whatever comes back and picks fields by key name. If a field comes out
// wrong, run /raw in the bot to see the real keys and adjust the FIELD patterns below.

export const norm = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const FIELD = {
  name: [/^vessel_?name$/i, /^boat_?name$/i, /^name$/i, /^vessel$/i, /^boat$/i],
  reg: [/reg/i],
  queue: [/^queue(_?(name|type))?$/i, /^berth/i, /^(location|area|category|zone)$/i],
  position: [/^(queue_?)?(position|pos)$/i, /^queue_?(no|number)$/i, /^(serial|sn|rank|order|no|number)$/i],
  status: [/status/i, /^state$/i],
};
const GROUP_LABEL = [/^(queue_?)?name$/i, /^title$/i, /^label$/i, /^queue$/i];

function pick(obj, patterns) {
  for (const re of patterns) {
    for (const [k, v] of Object.entries(obj)) {
      if (!re.test(k)) continue;
      if (v === null || v === undefined || v === '' || typeof v === 'object') continue;
      return String(v).trim();
    }
  }
  return null;
}

function walk(node, ctx, out) {
  if (Array.isArray(node)) {
    node.forEach((n, i) => walk(n, { ...ctx, index: i }, out));
    return;
  }
  if (!node || typeof node !== 'object') return;

  const childLists = Object.values(node).filter(
    (v) => Array.isArray(v) && v.some((x) => x && typeof x === 'object'),
  );
  if (childLists.length) {
    // A wrapper or a queue group: remember its label, then descend.
    const label = pick(node, GROUP_LABEL) ?? ctx.queue;
    for (const list of childLists) walk(list, { queue: label }, out);
    return;
  }

  const name = pick(node, FIELD.name);
  if (!name) return;
  out.push({
    key: norm(name),
    name,
    reg: pick(node, FIELD.reg) ?? '',
    queue: pick(node, FIELD.queue) ?? ctx.queue ?? '',
    position: pick(node, FIELD.position) ?? String((ctx.index ?? 0) + 1),
    status: pick(node, FIELD.status) ?? '',
  });
}

export function parseQueue(json) {
  const out = [];
  walk(json, {}, out);
  return out;
}

export function describe(v) {
  const lines = [];
  if (v.queue) lines.push(`Queue: ${v.queue}`);
  if (v.position) lines.push(`Position: ${v.position}`);
  if (v.status) lines.push(`Status: ${v.status}`);
  return lines.join('\n');
}

// Compare one watch against the latest vessel list.
// Returns { message, next } — message is null when nothing should be sent.
export function evaluate(watch, vessels) {
  const v = vessels.find((x) => x.key === watch.key);

  if (!v) {
    if (!watch.present) return { message: null, next: watch }; // still scanning, stay silent
    return {
      message: `⚪ ${watch.label} is no longer in the queue.\nStill watching — I'll message when it's back.`,
      next: { key: watch.key, label: watch.label, present: false },
    };
  }

  const next = {
    key: watch.key, label: v.name, present: true,
    queue: v.queue, position: v.position, status: v.status,
  };

  if (!watch.present) {
    return { message: `🟢 ${v.name} is IN QUEUE\n${describe(v)}`, next };
  }

  const changes = [];
  if (watch.queue !== v.queue) changes.push(`Queue: ${watch.queue || '—'} → ${v.queue || '—'}`);
  if (watch.position !== v.position) changes.push(`Position: ${watch.position || '—'} → ${v.position || '—'}`);
  if (watch.status !== v.status) changes.push(`Status: ${watch.status || '—'} → ${v.status || '—'}`);
  if (!changes.length) return { message: null, next };
  return { message: `🔄 ${v.name}\n${changes.join('\n')}`, next };
}
