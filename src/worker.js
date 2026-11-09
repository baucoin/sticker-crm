// Cloudflare Worker: serves the CRM web app (static files in /public) and an MCP server at /mcp/<MCP_SECRET>
// so Claude can read and log to the CRM. Secrets (set with `wrangler secret put`):
//   SUPABASE_URL, SUPABASE_ANON_KEY, CRM_KEY (matches private.settings crm_key), MCP_SECRET

const SERVER_INFO = { name: 'sticker-art-crm', version: '1.0.0' };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/mcp')) return handleMcp(req, env, url);
    if (url.pathname.startsWith('/api/')) return handleApi(req, env, url);
    if (url.pathname.startsWith('/_deploy/')) return new Response('Not found', { status: 404 });
    if (env.ASSETS) return env.ASSETS.fetch(req);
    return siteFile(env, url.pathname === '/' ? '/index.html' : url.pathname);
  },
};

// Fallback for deploys without the static-assets binding: site files are kept in the site_files table
// (scripts/publish_site.py uploads /public there).
async function siteFile(env, path) {
  const rows = await db(env, `site_files?path=eq.${encodeURIComponent(path)}&select=content_type,body`).catch(() => []);
  if (!rows?.length) return new Response('Not found', { status: 404 });
  return new Response(rows[0].body, { headers: { 'Content-Type': rows[0].content_type, 'Cache-Control': 'no-cache' } });
}

// ---------- Supabase REST helper ----------
async function db(env, path, { method = 'GET', body, prefer } = {}) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`, 'x-crm-key': env.CRM_KEY,
      'Content-Type': 'application/json', Prefer: prefer || 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Database error ${r.status}: ${txt}`);
  return txt ? JSON.parse(txt) : null;
}
const enc = encodeURIComponent;
const clean = (s) => String(s).replace(/[%,()*]/g, ' ').trim();
// escape text for a LIKE pattern, and build an "or" filter matching it in any of cols (quoted so commas/parentheses work)
const likeEsc = (q) => String(q).trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '\\%').replace(/_/g, '\\_').replace(/\*/g, ' ');
const orIlike = (cols, q) => 'or=(' + cols.map((c) => `${c}.ilike.${enc(`"%${likeEsc(q)}%"`)}`).join(',') + ')';
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Denver' });

async function findStore(env, ref) {
  if (!ref) throw new Error('store is required (id, slug or name)');
  if (/^[0-9a-f-]{36}$/.test(ref)) { const r = await db(env, `stores?id=eq.${ref}&select=*`); if (r[0]) return r[0]; }
  let r = await db(env, `stores?slug=eq.${enc(ref)}&select=*`); if (r[0]) return r[0];
  const pat = String(ref).trim().replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_').replace(/\*/g, ' ');  // plain filters take no quotes
  r = await db(env, `stores?name=ilike.${enc(pat)}&select=*`); if (r.length === 1) return r[0];
  r = await db(env, `stores?name=ilike.${enc('%' + pat + '%')}&select=id,name,city,state&limit=10`);
  if (r.length === 1) return (await db(env, `stores?id=eq.${r[0].id}&select=*`))[0];
  if (!r.length) throw new Error(`No store matches "${ref}". Use search_stores or create_store.`);
  throw new Error(`"${ref}" matches several stores: ${r.map((x) => `${x.name} (${x.city || ''} ${x.state || ''}, id ${x.id})`).join('; ')}. Pass the id.`);
}

// ---------- tools ----------
const STORE_FIELDS = {
  name: { type: 'string' }, city: { type: 'string' }, state: { type: 'string' }, address: { type: 'string' },
  email: { type: 'string' }, phone: { type: 'string' }, website: { type: 'string' },
  channel: { type: 'string', enum: ['faire', 'direct', 'both', 'prospect'] },
  account_status: { type: 'string', enum: ['Active', 'Overdue', 'Lapsed', 'Dormant', 'Closed'] },
  status: { type: 'string', enum: ['not-contacted', 'contacted', 'replied', 'ordered', 'seasonal-hold', 'sample-hold', 'skip'] },
  key_account: { type: 'boolean' }, holdout: { type: 'boolean' }, tags: { type: 'array', items: { type: 'string' } },
  background: { type: 'string' }, next_follow_up: { type: 'string', description: 'YYYY-MM-DD' }, pause_until: { type: 'string', description: 'YYYY-MM-DD' },
};
const pick = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k, v]) => keys.includes(k) && v !== undefined));

const TOOLS = [
  {
    name: 'search_stores',
    description: 'Find stores by name, city, email or background text, with optional filters (channel, account status, outreach status, tag, state, key account, holdout, follow-up due). Returns a short list.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string' }, channel: STORE_FIELDS.channel, account_status: STORE_FIELDS.account_status, status: STORE_FIELDS.status,
      tag: { type: 'string' }, state: { type: 'string' }, key_account: { type: 'boolean' }, holdout: { type: 'boolean' },
      follow_up_due: { type: 'boolean', description: 'Only stores whose next follow-up is today or earlier' },
      has_ordered: { type: 'boolean', description: 'true = only stores with at least one paid order ($0 sample orders do not count); false = never paid' },
      include_archived: { type: 'boolean', description: 'Archived stores (never ordered, gone quiet) are hidden unless this is true' },
      archived_only: { type: 'boolean' }, limit: { type: 'number' } } },
    async run(env, a) {
      const f = ['select=id,slug,name,city,state,channel,account_status,status,key_account,holdout,tags,last_contact,next_follow_up,last_order,archived_at'];
      if (a.query) f.push(orIlike(['name', 'city', 'email', 'background'], a.query));
      if (a.channel) f.push(`channel=eq.${a.channel}`);
      if (a.account_status) f.push(`account_status=eq.${a.account_status}`);
      if (a.status) f.push(`status=eq.${a.status}`);
      if (a.tag) f.push(`tags=cs.{${enc('"' + a.tag + '"')}}`);
      if (a.state) f.push(`state=ilike.${enc(a.state)}`);
      if (a.key_account != null) f.push(`key_account=is.${a.key_account}`);
      if (a.holdout != null) f.push(`holdout=is.${a.holdout}`);
      if (a.follow_up_due) f.push(`next_follow_up=lte.${today()}`);
      if (a.has_ordered != null) f.push(`order_total=${a.has_ordered ? 'gt' : 'eq'}.0`); // paid orders only
      if (a.archived_only) f.push('archived_at=not.is.null'); else if (!a.include_archived) f.push('archived_at=is.null');
      f.push(`order=name`, `limit=${Math.min(a.limit || 25, 200)}`);
      return db(env, `${a.has_ordered != null ? 'store_list' : 'stores'}?${f.join('&')}`);
    },
  },
  {
    name: 'get_store',
    description: 'Get one store with its people, open tasks, orders and recent timeline (notes, emails, calls, Faire messages, orders). Read this before contacting a store.',
    inputSchema: { type: 'object', properties: { store: { type: 'string', description: 'Store id, slug or exact/partial name' }, timeline_limit: { type: 'number' } }, required: ['store'] },
    async run(env, a) {
      const s = await findStore(env, a.store);
      const root = s.parent_id || s.id;
      const [contacts, tasks, orders, timeline, related] = await Promise.all([
        db(env, `contacts?store_id=eq.${s.id}&select=id,name,title,email,phone,background`),
        db(env, `tasks?store_id=eq.${s.id}&done_at=is.null&select=id,title,category,due_date&order=due_date`),
        db(env, `orders?store_id=eq.${s.id}&select=channel,order_no,ordered_at,total&order=ordered_at.desc&limit=50`),
        db(env, `timeline?store_id=eq.${s.id}&select=id,kind,occurred_at,author,subject,body,source&order=occurred_at.desc&limit=${Math.min(a.timeline_limit || 40, 500)}`),
        db(env, `stores?or=(id.eq.${root},parent_id.eq.${root})&id=neq.${s.id}&select=id,name,city,state,parent_id`),
      ]);
      const related_stores = related.map((r) => ({ ...r, relation: r.id === s.parent_id ? 'parent account' : r.parent_id === s.id ? 'location of this store' : 'same parent account' }));
      return { store: s, related_stores, contacts, open_tasks: tasks, orders, timeline };
    },
  },
  {
    name: 'log_activity',
    description: 'Add an entry to a store\'s timeline (note, email, call, Faire message, mail). Optionally sets the next follow-up date and marks the store as contacted. Use after every outreach or reply.',
    inputSchema: { type: 'object', properties: {
      store: { type: 'string' }, kind: { type: 'string', enum: ['note', 'email', 'call', 'faire', 'mail', 'system'] },
      subject: { type: 'string' }, body: { type: 'string' }, occurred_at: { type: 'string', description: 'ISO date/time; defaults to now' },
      author: { type: 'string', description: 'Who did it, e.g. Bryant, Claude, faire-daily. Defaults to Claude' },
      counts_as_contact: { type: 'boolean', description: 'Update last contact date (default true for email/call/faire/mail)' },
      next_follow_up: { type: 'string', description: 'YYYY-MM-DD' }, status: STORE_FIELDS.status,
      contact_name: { type: 'string', description: 'Person at the store this was with (optional)' },
      source_id: { type: 'string', description: 'Optional unique id (e.g. gmail:<message id>) so the same item is never logged twice' } },
      required: ['store', 'kind', 'body'] },
    async run(env, a) {
      const s = await findStore(env, a.store);
      const when = a.occurred_at ? new Date(a.occurred_at).toISOString() : new Date().toISOString();
      let contact_id = null;
      if (a.contact_name) { const c = await db(env, `contacts?store_id=eq.${s.id}&name=ilike.*${enc(clean(a.contact_name))}*&select=id&limit=1`); contact_id = c[0]?.id || null; }
      const row = { store_id: s.id, contact_id, kind: a.kind, subject: a.subject || null, body: a.body, occurred_at: when, author: a.author || 'Claude', source: 'claude', source_id: a.source_id || null };
      const ins = await db(env, `timeline${a.source_id ? '?on_conflict=source_id' : ''}`, { method: 'POST', body: row, prefer: a.source_id ? 'return=representation,resolution=ignore-duplicates' : undefined });
      const upd = {};
      const contact = a.counts_as_contact ?? ['email', 'call', 'faire', 'mail'].includes(a.kind);
      const day = new Date(when).toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
      if (contact && (!s.last_contact || day > s.last_contact)) upd.last_contact = day;
      if (a.status) upd.status = a.status; else if (contact && (!s.status || s.status === 'not-contacted')) upd.status = 'contacted';
      if (a.next_follow_up) upd.next_follow_up = a.next_follow_up;
      if (contact && s.archived_at) upd.archived_at = null; // talking to them again brings them back
      if (Object.keys(upd).length) await db(env, `stores?id=eq.${s.id}`, { method: 'PATCH', body: upd });
      return { logged: ins?.[0] || 'already logged', store: s.name, store_updates: upd };
    },
  },
  {
    name: 'list_due',
    description: 'What needs doing: open tasks due by a date (default today, America/Denver) and stores whose follow-up date has arrived.',
    inputSchema: { type: 'object', properties: { through: { type: 'string', description: 'YYYY-MM-DD, default today' } } },
    async run(env, a) {
      const d = a.through || today();
      const [tasks, stores] = await Promise.all([
        db(env, `tasks?done_at=is.null&due_date=lte.${d}&select=id,title,category,due_date,store_id,stores(name)&order=due_date&limit=300`),
        db(env, `stores?next_follow_up=lte.${d}&archived_at=is.null&select=id,name,city,state,channel,status,key_account,next_follow_up,last_contact&order=next_follow_up&limit=300`),
      ]);
      return { through: d, tasks, follow_ups: stores };
    },
  },
  {
    name: 'create_task',
    description: 'Create a task (optionally on a store) with a due date.',
    inputSchema: { type: 'object', properties: { store: { type: 'string' }, title: { type: 'string' }, due_date: { type: 'string', description: 'YYYY-MM-DD' }, category: { type: 'string', description: 'Follow-up, Email, Call, Ship, Sample, Meeting, Thank-you' } }, required: ['title'] },
    async run(env, a) {
      const s = a.store ? await findStore(env, a.store) : null;
      return db(env, 'tasks', { method: 'POST', body: { store_id: s?.id || null, title: a.title, due_date: a.due_date || null, category: a.category || 'Follow-up', source: 'claude' } });
    },
  },
  {
    name: 'update_task',
    description: 'Complete, reopen, reschedule or rename a task by id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, done: { type: 'boolean' }, due_date: { type: 'string' }, title: { type: 'string' } }, required: ['id'] },
    async run(env, a) {
      const upd = {};
      if (a.done != null) upd.done_at = a.done ? new Date().toISOString() : null;
      if (a.due_date) upd.due_date = a.due_date;
      if (a.title) upd.title = a.title;
      const r = await db(env, `tasks?id=eq.${a.id}`, { method: 'PATCH', body: upd });
      if (a.done && r[0]?.store_id) await db(env, 'timeline?on_conflict=source_id', { method: 'POST', prefer: 'return=minimal,resolution=ignore-duplicates',
        body: { store_id: r[0].store_id, kind: 'task', subject: 'Task done: ' + r[0].title, author: 'Claude', source: 'claude', source_id: 'taskdone:' + a.id } });
      return r;
    },
  },
  {
    name: 'create_store',
    description: 'Add a new store (search first so you do not create a duplicate).',
    inputSchema: { type: 'object', properties: STORE_FIELDS, required: ['name'] },
    async run(env, a) {
      const slug = a.name.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const exists = await db(env, `stores?slug=eq.${enc(slug)}&select=id`);
      return db(env, 'stores', { method: 'POST', body: { ...pick(a, Object.keys(STORE_FIELDS)), slug: exists.length ? `${slug}-${Date.now().toString(36).slice(-4)}` : slug } });
    },
  },
  {
    name: 'update_store',
    description: 'Change a store\'s fields: status, account status, channel, follow-up date, tags, key account, holdout, archived, contact info, background.',
    inputSchema: { type: 'object', properties: { store: { type: 'string' }, ...STORE_FIELDS, archived: { type: 'boolean', description: 'Archive (hide from lists) or bring back' }, parent_store: { type: 'string', description: 'Link this store as a location of another store (id, slug or name); empty string unlinks' }, add_tags: { type: 'array', items: { type: 'string' } }, remove_tags: { type: 'array', items: { type: 'string' } } }, required: ['store'] },
    async run(env, a) {
      const s = await findStore(env, a.store);
      const upd = pick(a, Object.keys(STORE_FIELDS));
      if (a.parent_store != null) upd.parent_id = a.parent_store === '' ? null : (await findStore(env, a.parent_store)).id;
      if (a.archived != null) upd.archived_at = a.archived ? new Date().toISOString() : null;
      if (a.add_tags || a.remove_tags) {
        const t = new Set(upd.tags || s.tags || []);
        (a.add_tags || []).forEach((x) => t.add(x)); (a.remove_tags || []).forEach((x) => t.delete(x));
        upd.tags = [...t];
      }
      return db(env, `stores?id=eq.${s.id}`, { method: 'PATCH', body: upd });
    },
  },
  {
    name: 'add_contact',
    description: 'Add or update a person at a store (matched by email or name).',
    inputSchema: { type: 'object', properties: { store: { type: 'string' }, name: { type: 'string' }, title: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' }, background: { type: 'string' } }, required: ['store', 'name'] },
    async run(env, a) {
      const s = await findStore(env, a.store);
      const rec = pick(a, ['name', 'title', 'email', 'phone', 'background']);
      const q = a.email ? `email=ilike.${enc(a.email)}` : `name=ilike.${enc(clean(a.name))}`;
      const ex = await db(env, `contacts?store_id=eq.${s.id}&${q}&select=id`);
      return ex[0] ? db(env, `contacts?id=eq.${ex[0].id}`, { method: 'PATCH', body: rec }) : db(env, 'contacts', { method: 'POST', body: { ...rec, store_id: s.id } });
    },
  },
  {
    name: 'record_order',
    description: 'Record a Shopify or Faire order (idempotent on channel + order number). Matches the store by store ref, customer email or name; it shows on the store timeline automatically.',
    inputSchema: { type: 'object', properties: {
      channel: { type: 'string', enum: ['shopify', 'faire'] }, order_no: { type: 'string' }, ordered_at: { type: 'string' }, total: { type: 'number' },
      status: { type: 'string' }, customer_name: { type: 'string' }, customer_email: { type: 'string' }, store: { type: 'string', description: 'Store id/slug/name if known' },
      items: { type: 'array', items: { type: 'object' } } }, required: ['channel', 'order_no', 'ordered_at'] },
    async run(env, a) {
      let s = null;
      try { if (a.store) s = await findStore(env, a.store); } catch (e) { /* fall through */ }
      if (!s && a.customer_email) { const r = await db(env, `stores?email=ilike.${enc(a.customer_email)}&select=id,name&limit=2`); if (r.length === 1) s = r[0];
        if (!s) { const c = await db(env, `contacts?email=ilike.${enc(a.customer_email)}&select=store_id&limit=2`); if (c.length === 1 && c[0].store_id) s = { id: c[0].store_id }; } }
      if (!s && a.customer_name) { try { s = await findStore(env, a.customer_name); } catch (e) { /* unmatched */ } }
      const row = { channel: a.channel, order_no: a.order_no, ordered_at: new Date(a.ordered_at).toISOString(), total: a.total ?? null, status: a.status || null,
        customer_name: a.customer_name || null, customer_email: a.customer_email || null, items: a.items || [], store_id: s?.id || null, source_id: `${a.channel}:${a.order_no}` };
      const r = await db(env, 'orders?on_conflict=source_id', { method: 'POST', body: row, prefer: 'return=representation,resolution=merge-duplicates' });
      return { order: r[0], matched_store: s?.id ? true : false };
    },
  },
  {
    name: 'search_timeline',
    description: 'Full-text search across all notes, emails and messages in every store\'s timeline.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, since: { type: 'string', description: 'YYYY-MM-DD' }, limit: { type: 'number' } }, required: ['query'] },
    async run(env, a) {
      return db(env, `timeline?${orIlike(['body', 'subject'], a.query)}${a.since ? `&occurred_at=gte.${a.since}` : ''}&select=id,kind,occurred_at,author,subject,body,store_id,stores(name)&order=occurred_at.desc&limit=${Math.min(a.limit || 25, 100)}`);
    },
  },
  {
    name: 'recent_activity',
    description: 'Latest timeline entries across all stores (what happened lately), optionally since a date or by author.',
    inputSchema: { type: 'object', properties: { since: { type: 'string' }, author: { type: 'string' }, limit: { type: 'number' } } },
    async run(env, a) {
      return db(env, `timeline?select=kind,occurred_at,author,subject,body,store_id,stores(name)${a.since ? `&occurred_at=gte.${a.since}` : ''}${a.author ? `&author=ilike.${enc(a.author)}` : ''}&order=occurred_at.desc&limit=${Math.min(a.limit || 30, 200)}`);
    },
  },
  {
    name: 'get_playbook',
    description: 'Read the outreach playbook: standing rules, priorities, who-does-what. Read it at the start of every outreach run.',
    inputSchema: { type: 'object', properties: {} },
    async run(env) { return db(env, 'playbook?select=heading,body,updated_at&order=sort'); },
  },
  {
    name: 'update_playbook',
    description: 'Replace (or add) one playbook section by heading. Only change the playbook when Bryant asks.',
    inputSchema: { type: 'object', properties: { heading: { type: 'string' }, body: { type: 'string' }, sort: { type: 'number' } }, required: ['heading', 'body'] },
    async run(env, a) { return db(env, 'playbook?on_conflict=heading', { method: 'POST', prefer: 'return=representation,resolution=merge-duplicates', body: { heading: a.heading, body: a.body, ...(a.sort != null ? { sort: a.sort } : {}) } }); },
  },
  {
    name: 'list_handoffs',
    description: 'Handoff notes between Claude chats/threads. Default: open notes addressed to "to" or to all.',
    inputSchema: { type: 'object', properties: { to: { type: 'string', description: 'e.g. daily-tasks, faire-chat, win-backs' }, status: { type: 'string', enum: ['open', 'done', 'any'] }, limit: { type: 'number' } } },
    async run(env, a) {
      const f = ['select=id,slug,created_on,from_who,to_who,topic,note,status,progress_note,store_slugs,done_by,done_on,done_note', 'order=created_on.desc', `limit=${Math.min(a.limit || 50, 200)}`];
      if ((a.status || 'open') !== 'any') f.push(`status=eq.${a.status || 'open'}`);
      if (a.to) f.push(`to_who=in.(${enc(a.to)},all)`);
      return db(env, `handoffs?${f.join('&')}`);
    },
  },
  {
    name: 'add_handoff',
    description: 'Leave a handoff note for another chat/thread (or "all").',
    inputSchema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, topic: { type: 'string' }, note: { type: 'string' }, store_slugs: { type: 'array', items: { type: 'string' } } }, required: ['from', 'topic'] },
    async run(env, a) { return db(env, 'handoffs', { method: 'POST', body: { slug: `${today()}-${a.from}-${String(a.topic).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}`, from_who: a.from, to_who: a.to || 'all', topic: a.topic, note: a.note || null, store_slugs: a.store_slugs || [], created_on: today() } }); },
  },
  {
    name: 'close_handoff',
    description: 'Mark a handoff note done (or add a progress note while keeping it open).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, by: { type: 'string' }, note: { type: 'string' }, keep_open: { type: 'boolean' } }, required: ['id'] },
    async run(env, a) {
      const body = a.keep_open ? { progress_note: a.note || null } : { status: 'done', done_by: a.by || 'claude', done_on: today(), done_note: a.note || null };
      return db(env, `handoffs?id=eq.${a.id}`, { method: 'PATCH', body });
    },
  },
  {
    name: 'record_win',
    description: 'Credit an order to outreach (an order that followed a personal email or Faire message within 60 days; blasts excluded). Feeds the $1,000/month goal.',
    inputSchema: { type: 'object', properties: { store: { type: 'string' }, amount: { type: 'number' }, channel: { type: 'string' }, order_no: { type: 'string' }, won_on: { type: 'string' },
      contact_by: { type: 'string' }, contact_on: { type: 'string' }, contact_via: { type: 'string' }, confidence: { type: 'string', enum: ['counted', 'possible'] }, note: { type: 'string' } }, required: ['store', 'amount'] },
    async run(env, a) {
      const s = await findStore(env, a.store);
      return db(env, 'wins', { method: 'POST', body: { store_id: s.id, store_name: s.name, amount: a.amount, channel: a.channel || s.channel, order_no: a.order_no || null, won_on: a.won_on || today(),
        contact_by: a.contact_by || null, contact_on: a.contact_on || null, contact_via: a.contact_via || null, confidence: a.confidence || 'counted', note: a.note || null } });
    },
  },
  {
    name: 'list_wins',
    description: 'Orders credited to outreach, newest first, with the monthly total.',
    inputSchema: { type: 'object', properties: { since: { type: 'string', description: 'YYYY-MM-DD' } } },
    async run(env, a) {
      const rows = await db(env, `wins?select=won_on,store_name,amount,channel,confidence,contact_by,order_no,note${a.since ? `&won_on=gte.${a.since}` : ''}&order=won_on.desc&limit=500`);
      const byMonth = {}; rows.forEach((w) => { if (w.confidence === 'counted') byMonth[w.won_on.slice(0, 7)] = (byMonth[w.won_on.slice(0, 7)] || 0) + Number(w.amount || 0); });
      return { counted_by_month: byMonth, wins: rows };
    },
  },
];

// ---------- Plain HTTP API (for chats without the connector, e.g. a desktop scheduled task using Chrome) ----------
// GET or POST /api/<MCP_SECRET>/<tool>?arg=value...  (POST may send a JSON body instead). GET /api/<secret>/ lists tools.
async function handleApi(req, env, url) {
  const [, , secret, name] = url.pathname.split('/');
  if (!env.MCP_SECRET || secret !== env.MCP_SECRET) return new Response('Not found', { status: 404 });
  const pretty = (o, status = 200) => new Response(JSON.stringify(o, null, 1), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } });
  if (!name) return pretty({ usage: 'GET /api/<secret>/<tool>?param=value (arrays as JSON or comma-separated). POST with a JSON body also works.',
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description, params: Object.fromEntries(Object.entries(t.inputSchema.properties || {}).map(([k, v]) => [k, v.type + (t.inputSchema.required?.includes(k) ? ' (required)' : '')])) })) });
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return pretty({ error: `Unknown tool ${name}` }, 404);
  const props = tool.inputSchema.properties || {};
  let args = {};
  if (req.method === 'POST') { try { args = await req.json(); } catch { return pretty({ error: 'Body must be JSON' }, 400); } }
  for (const [k, raw] of url.searchParams) {
    const t = props[k]?.type; let v = raw;
    if (t === 'number') v = Number(raw);
    else if (t === 'boolean') v = /^(1|true|yes)$/i.test(raw);
    else if (t === 'array' || t === 'object') { try { v = JSON.parse(raw); } catch { v = t === 'array' ? raw.split(',').map((x) => x.trim()).filter(Boolean) : raw; } }
    args[k] = v;
  }
  try { return pretty({ ok: true, result: await tool.run(env, args) }); }
  catch (e) { return pretty({ ok: false, error: String(e.message || e) }, 400); }
}

// ---------- MCP (Streamable HTTP, JSON responses) ----------
async function handleMcp(req, env, url) {
  const secret = url.pathname.split('/')[2] || (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!env.MCP_SECRET || secret !== env.MCP_SECRET) return new Response('Not found', { status: 404 });
  if (req.method === 'GET') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
  if (req.method === 'DELETE') return new Response(null, { status: 204 });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  let msg;
  try { msg = await req.json(); } catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }
  const batch = Array.isArray(msg) ? msg : [msg];
  const out = [];
  for (const m of batch) { const r = await handleRpc(env, m); if (r) out.push(r); }
  if (!out.length) return new Response(null, { status: 202 });
  return json(Array.isArray(msg) ? out : out[0]);
}
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

async function handleRpc(env, m) {
  if (m.id === undefined || m.id === null) return null; // notification
  const ok = (result) => ({ jsonrpc: '2.0', id: m.id, result });
  switch (m.method) {
    case 'initialize':
      return ok({ protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: SERVER_INFO,
        instructions: 'Sticker Art wholesale CRM: stores (retailers), their people, a timeline of notes/emails/calls/Faire messages/orders, tasks and orders. Read a store with get_store before contacting it; log every outreach or reply with log_activity. Start each outreach run with get_playbook and list_handoffs.' });
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === m.params?.name);
      if (!tool) return { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'Unknown tool' } };
      try {
        const r = await tool.run(env, m.params.arguments || {});
        return ok({ content: [{ type: 'text', text: JSON.stringify(r, null, 1) }] });
      } catch (e) {
        return ok({ content: [{ type: 'text', text: String(e.message || e) }], isError: true });
      }
    }
    default: return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } };
  }
}
