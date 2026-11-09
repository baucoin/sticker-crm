// Sticker Art CRM: plain JavaScript, no build step. Talks straight to Supabase.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

const cfg = window.CRM_CONFIG || {};
const sb = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
const $app = document.getElementById('app');

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
const fmtDate = (d) => d ? new Date(d.length === 10 ? d + 'T12:00:00' : d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
const fmtDateTime = (d) => d ? new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
const money = (n) => n == null ? '' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const dueClass = (d) => !d ? '' : d < today() ? 'overdue' : d === today() ? 'due-today' : '';
function toast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2200); }
function fail(error) { if (error) { console.error(error); toast('Error: ' + (error.message || error)); throw error; } }
const KINDS = { note: 'Note', email: 'Email', call: 'Call', faire: 'Faire message', mail: 'Mail', order: 'Order', task: 'Task done', system: 'Update' };
const STATUSES = ['not-contacted', 'contacted', 'replied', 'ordered', 'seasonal-hold', 'sample-hold', 'skip'];
const ACCOUNT = ['Active', 'Overdue', 'Lapsed', 'Dormant', 'Closed'];
const CHANNELS = ['faire', 'direct', 'both', 'prospect'];
const CATEGORIES = ['Follow-up', 'Email', 'Call', 'Ship', 'Sample', 'Meeting', 'Thank-you'];
let me = null;

function storeTags(s) {
  let h = '';
  if (s.key_account) h += '<span class="tag key">Key account</span>';
  if (s.holdout) h += '<span class="tag hold">Holdout</span>';
  for (const t of s.tags || []) h += `<span class="tag">${esc(t)}</span>`;
  return h;
}

// ---------- router ----------
const routes = [
  [/^#?\/?$/, viewToday],
  [/^#\/stores$/, viewStores],
  [/^#\/stores\/new$/, viewNewStore],
  [/^#\/store\/([\w-]+)$/, viewStore],
  [/^#\/tasks$/, viewTasks],
  [/^#\/orders$/, viewOrders],
  [/^#\/activity$/, viewActivity],
  [/^#\/search\/(.*)$/, viewSearch],
];
async function route() {
  if (!me) return viewLogin();
  const h = location.hash || '#/';
  document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('on', a.getAttribute('href') === h.split('?')[0]));
  for (const [re, fn] of routes) {
    const m = h.split('?')[0].match(re);
    if (m) { try { await fn(...m.slice(1).map(decodeURIComponent)); } catch (e) { console.error(e); } window.scrollTo(0, 0); return; }
  }
  $app.innerHTML = '<p>Not found.</p>';
}
window.addEventListener('hashchange', route);
const params = () => new URLSearchParams((location.hash.split('?')[1]) || '');

// ---------- auth ----------
function viewLogin() {
  ['nav', 'quicksearch', 'signout'].forEach((id) => (document.getElementById(id).hidden = true));
  $app.innerHTML = `
  <div class="panel login">
    <h1>Sign in</h1>
    <form class="stack" id="loginform">
      <label>Email<input type="email" name="email" required autocomplete="username"></label>
      <label>Password<input type="password" name="password" required autocomplete="current-password"></label>
      <button>Sign in</button>
      <button type="button" class="link" id="magic">Email me a sign-in link instead</button>
    </form>
  </div>`;
  const f = document.getElementById('loginform');
  f.onsubmit = async (e) => {
    e.preventDefault();
    const { error } = await sb.auth.signInWithPassword({ email: f.email.value, password: f.password.value });
    if (error) toast(error.message);
  };
  document.getElementById('magic').onclick = async () => {
    if (!f.email.value) return toast('Type your email first');
    const { error } = await sb.auth.signInWithOtp({ email: f.email.value, options: { emailRedirectTo: location.origin, shouldCreateUser: false } });
    toast(error ? error.message : 'Check your email for the link');
  };
}
document.getElementById('signout').onclick = () => sb.auth.signOut();
document.getElementById('quicksearch').onsubmit = (e) => {
  e.preventDefault();
  const q = e.target.querySelector('input').value.trim();
  if (q) location.hash = '#/search/' + encodeURIComponent(q);
};
sb.auth.onAuthStateChange((_ev, session) => {
  const was = me; me = session?.user || null;
  ['nav', 'quicksearch', 'signout'].forEach((id) => (document.getElementById(id).hidden = !me));
  if (!!was !== !!me) route();
});

// ---------- Today ----------
async function viewToday() {
  const t = today();
  const [tasks, follow, recent, ordersRecent] = await Promise.all([
    sb.from('tasks').select('*, stores(id,name,slug)').is('done_at', null).lte('due_date', t).order('due_date').limit(200),
    sb.from('stores').select('id,name,city,state,next_follow_up,status,channel,key_account,holdout,tags').lte('next_follow_up', t).order('next_follow_up').limit(200),
    sb.from('timeline').select('id,kind,occurred_at,author,subject,body,store_id,stores(name)').order('occurred_at', { ascending: false }).limit(15),
    sb.from('orders').select('*, stores(id,name)').order('ordered_at', { ascending: false }).limit(8),
  ]);
  [tasks, follow, recent, ordersRecent].forEach((r) => fail(r.error));
  const upcoming = await sb.from('tasks').select('*, stores(id,name)').is('done_at', null).gt('due_date', t).order('due_date').limit(10);
  $app.innerHTML = `
  <h1>Today <span class="muted small">${fmtDate(t)}</span></h1>
  <div class="grid2">
    <div>
      <div class="panel"><h2 style="margin-top:0">Tasks due (${tasks.data.length})</h2>
        ${tasks.data.length ? tasks.data.map(taskRow).join('') : '<p class="muted">Nothing due. Nice.</p>'}
      </div>
      <div class="panel"><h2 style="margin-top:0">Stores to follow up (${follow.data.length})</h2>
        ${follow.data.length ? `<div class="tablewrap"><table><tbody>${follow.data.map((s) => `
          <tr><td><a href="#/store/${s.id}">${esc(s.name)}</a> ${storeTags(s)}<div class="muted small">${esc([s.city, s.state].filter(Boolean).join(', '))} · ${esc(s.channel || '')} · ${esc(s.status || '')}</div></td>
          <td class="${dueClass(s.next_follow_up)}" style="white-space:nowrap">${fmtDate(s.next_follow_up)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No follow-ups due.</p>'}
      </div>
    </div>
    <div>
      <div class="panel"><h2 style="margin-top:0">Coming up</h2>${upcoming.data?.length ? upcoming.data.map(taskRow).join('') : '<p class="muted">No upcoming tasks.</p>'}</div>
      <div class="panel"><h2 style="margin-top:0">Latest orders</h2>${ordersRecent.data.map((o) => `
        <div class="task"><span>${o.stores ? `<a href="#/store/${o.stores.id}">${esc(o.stores.name)}</a>` : esc(o.customer_name || '')}<div class="muted small">${esc(o.channel)} ${esc(o.order_no || '')} · ${fmtDate(o.ordered_at)}</div></span><span class="spacer"></span><b>${money(o.total)}</b></div>`).join('') || '<p class="muted">None yet.</p>'}</div>
      <div class="panel"><h2 style="margin-top:0">Latest activity</h2>${recent.data.map((e) => `
        <div class="task"><span><a href="#/store/${e.store_id}">${esc(e.stores?.name || '')}</a> <span class="muted small">${KINDS[e.kind] || e.kind} · ${fmtDate(e.occurred_at)}</span>
        <div class="small">${esc((e.subject || e.body || '').slice(0, 120))}</div></span></div>`).join('')}</div>
    </div>
  </div>`;
  bindTaskRows();
}

function taskRow(t) {
  return `<div class="task" data-task="${t.id}">
    <input type="checkbox" title="Mark done" ${t.done_at ? 'checked' : ''}>
    <span><span>${esc(t.title)}</span>
      ${t.stores ? ` · <a href="#/store/${t.stores.id}">${esc(t.stores.name)}</a>` : ''}
      <div class="small muted">${t.category ? esc(t.category) + ' · ' : ''}<span class="${dueClass(t.due_date)}">${t.due_date ? 'due ' + fmtDate(t.due_date) : 'no date'}</span></div></span>
    <span class="spacer"></span>
    <button class="link small" data-act="snooze" title="Push to tomorrow">+1d</button>
    <button class="link small" data-act="week" title="Push one week">+1w</button>
  </div>`;
}
function bindTaskRows(onChange) {
  document.querySelectorAll('[data-task]').forEach((el) => {
    const id = el.dataset.task;
    el.querySelector('input[type=checkbox]').onchange = async (e) => {
      const done = e.target.checked;
      const { data, error } = await sb.from('tasks').update({ done_at: done ? new Date().toISOString() : null }).eq('id', id).select('*').single();
      fail(error);
      if (done && data.store_id) {
        await sb.from('timeline').insert({ store_id: data.store_id, kind: 'task', author: 'Bryant', subject: 'Task done: ' + data.title, source: 'manual', source_id: 'taskdone:' + id })
          .then(({ error }) => error && console.warn(error));
      }
      toast(done ? 'Done' : 'Reopened');
      onChange ? onChange() : el.style.opacity = done ? .45 : 1;
    };
    el.querySelectorAll('[data-act]').forEach((b) => b.onclick = async () => {
      const d = new Date(today() + 'T12:00:00'); d.setDate(d.getDate() + (b.dataset.act === 'week' ? 7 : 1));
      fail((await sb.from('tasks').update({ due_date: d.toLocaleDateString('en-CA') }).eq('id', id)).error);
      toast('Moved to ' + fmtDate(d.toLocaleDateString('en-CA'))); onChange ? onChange() : route();
    });
  });
}

// ---------- Stores list ----------
let tagCache = null;
async function allTags() {
  if (tagCache) return tagCache;
  const counts = {};
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('stores').select('tags').range(from, from + 999); fail(error);
    data.forEach((r) => (r.tags || []).forEach((t) => (counts[t] = (counts[t] || 0) + 1)));
    if (data.length < 1000) break;
  }
  return (tagCache = Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

async function viewStores() {
  const p = params();
  const tags = await allTags();
  const sel = (name, opts, label) => `<select data-f="${name}"><option value="">${label}</option>${opts.map((o) => `<option ${p.get(name) === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  const chip = (key, val, label) => `<button class="chip ${p.get(key) === val ? 'on' : ''}" data-chip="${key}" data-val="${val}">${label}</button>`;
  $app.innerHTML = `
  <div class="row"><h1>Stores</h1><span class="spacer"></span><a href="#/stores/new"><button>+ New store</button></a></div>
  <div class="panel">
    <div class="row">
      <input type="search" data-f="q" placeholder="Name, city, contact email…" value="${esc(p.get('q') || '')}" style="flex:1;min-width:200px">
      ${sel('channel', CHANNELS, 'Any channel')}
      ${sel('account', ACCOUNT, 'Any account status')}
      ${sel('status', STATUSES, 'Any outreach status')}
      ${sel('tag', tags.map((t) => t[0]), 'Any tag')}
      <input data-f="state" placeholder="State" value="${esc(p.get('state') || '')}" style="width:70px">
    </div>
    <div class="chips">
      ${chip('key', '1', '★ Key accounts')} ${chip('channel', 'faire', 'Faire')} ${chip('channel', 'direct', 'Direct')} ${chip('channel', 'both', 'Faire + direct')}
      ${chip('holdout', '1', 'Holdouts')} ${chip('due', '1', 'Follow-up due')} ${chip('account', 'Active', 'Active')} ${chip('account', 'Overdue', 'Overdue')}
      ${chip('account', 'Lapsed', 'Lapsed')} ${chip('account', 'Dormant', 'Dormant')} ${chip('status', 'replied', 'Replied')}
      ${p.toString() ? '<button class="chip" id="clearf">✕ Clear</button>' : ''}
    </div>
  </div>
  <div id="list"><p class="muted">Loading…</p></div>`;
  const setParam = (k, v) => { const q = params(); v ? q.set(k, v) : q.delete(k); q.delete('page'); location.hash = '#/stores' + (q.toString() ? '?' + q : ''); };
  $app.querySelectorAll('select[data-f]').forEach((s) => (s.onchange = () => setParam(s.dataset.f, s.value)));
  $app.querySelectorAll('input[data-f]').forEach((s) => (s.onkeydown = (e) => e.key === 'Enter' && setParam(s.dataset.f, s.value.trim())));
  $app.querySelectorAll('[data-chip]').forEach((c) => (c.onclick = () => setParam(c.dataset.chip, p.get(c.dataset.chip) === c.dataset.val ? '' : c.dataset.val)));
  const clr = document.getElementById('clearf'); if (clr) clr.onclick = () => (location.hash = '#/stores');

  const sort = p.get('sort') || 'name', dir = p.get('dir') === 'desc', page = +(p.get('page') || 0), per = 100;
  let q = sb.from('store_list').select('id,name,city,state,channel,account_status,status,key_account,holdout,tags,next_follow_up,last_contact,last_order,faire_spend,shopify_spend,next_task_due', { count: 'exact' });
  if (p.get('q')) { const s = p.get('q').replace(/[%,()]/g, ' '); q = q.or(`name.ilike.%${s}%,city.ilike.%${s}%,email.ilike.%${s}%,background.ilike.%${s}%`); }
  if (p.get('channel')) q = q.eq('channel', p.get('channel'));
  if (p.get('account')) q = q.eq('account_status', p.get('account'));
  if (p.get('status')) q = q.eq('status', p.get('status'));
  if (p.get('tag')) q = q.contains('tags', [p.get('tag')]);
  if (p.get('state')) q = q.ilike('state', p.get('state'));
  if (p.get('key')) q = q.eq('key_account', true);
  if (p.get('holdout')) q = q.eq('holdout', true);
  if (p.get('due')) q = q.lte('next_follow_up', today());
  q = q.order(sort, { ascending: !dir, nullsFirst: false }).range(page * per, page * per + per - 1);
  const { data, count, error } = await q; fail(error);
  const th = (col, label) => `<th data-sort="${col}">${label}${sort === col ? (dir ? ' ↓' : ' ↑') : ''}</th>`;
  document.getElementById('list').innerHTML = `
    <p class="muted small">${count} stores</p>
    <div class="tablewrap"><table>
      <thead><tr>${th('name', 'Store')}${th('state', 'Where')}${th('account_status', 'Account')}${th('status', 'Outreach')}${th('last_contact', 'Last contact')}${th('next_follow_up', 'Follow up')}${th('last_order', 'Last order')}</tr></thead>
      <tbody>${data.map((s) => `<tr>
        <td><a href="#/store/${s.id}">${esc(s.name)}</a><div>${storeTags(s)}</div></td>
        <td>${esc([s.city, s.state].filter(Boolean).join(', '))}<div class="muted small">${esc(s.channel || '')}</div></td>
        <td>${esc(s.account_status || '')}</td><td>${esc(s.status || '')}</td>
        <td>${fmtDate(s.last_contact)}</td><td class="${dueClass(s.next_follow_up)}">${fmtDate(s.next_follow_up)}</td><td>${fmtDate(s.last_order)}</td></tr>`).join('')}
      </tbody></table></div>
    <div class="pager">${page > 0 ? '<button class="ghost" id="prev">← Prev</button>' : ''}<span class="muted small">Page ${page + 1} of ${Math.max(1, Math.ceil(count / per))}</span>${(page + 1) * per < count ? '<button class="ghost" id="next">Next →</button>' : ''}</div>`;
  document.querySelectorAll('th[data-sort]').forEach((h) => (h.onclick = () => { const q2 = params(); const c = h.dataset.sort; q2.set('dir', q2.get('sort') === c && q2.get('dir') !== 'desc' ? 'desc' : 'asc'); q2.set('sort', c); location.hash = '#/stores?' + q2; }));
  const go = (n) => { const q2 = params(); q2.set('page', n); location.hash = '#/stores?' + q2; };
  document.getElementById('prev')?.addEventListener('click', () => go(page - 1));
  document.getElementById('next')?.addEventListener('click', () => go(page + 1));
}

// ---------- Store form (new + edit) ----------
function storeForm(s = {}) {
  const opt = (arr, v) => '<option value=""></option>' + arr.map((o) => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('');
  return `
  <div class="formgrid">
    <label>Name<input name="name" required value="${esc(s.name)}"></label>
    <label>City<input name="city" value="${esc(s.city)}"></label>
    <label>State<input name="state" value="${esc(s.state)}"></label>
    <label>Email<input name="email" value="${esc(s.email)}"></label>
    <label>Phone<input name="phone" value="${esc(s.phone)}"></label>
    <label>Website<input name="website" value="${esc(s.website)}"></label>
    <label>Address<input name="address" value="${esc(s.address)}"></label>
    <label>Channel<select name="channel">${opt(CHANNELS, s.channel)}</select></label>
    <label>Account status<select name="account_status">${opt(ACCOUNT, s.account_status)}</select></label>
    <label>Outreach status<select name="status">${opt(STATUSES, s.status)}</select></label>
    <label>Next follow-up<input type="date" name="next_follow_up" value="${esc(s.next_follow_up || '')}"></label>
    <label>Paused until<input type="date" name="pause_until" value="${esc(s.pause_until || '')}"></label>
    <label>Tags (comma separated)<input name="tags" value="${esc((s.tags || []).join(', '))}"></label>
    <label style="flex-direction:row;align-items:center;gap:6px"><input type="checkbox" name="key_account" ${s.key_account ? 'checked' : ''}> Key account</label>
    <label style="flex-direction:row;align-items:center;gap:6px"><input type="checkbox" name="holdout" ${s.holdout ? 'checked' : ''}> Holdout</label>
  </div>
  <label class="small muted" style="display:block;margin-top:8px">Background<textarea name="background">${esc(s.background)}</textarea></label>`;
}
function readStoreForm(f) {
  const v = (n) => f[n].value.trim() || null;
  return {
    name: f.name.value.trim(), city: v('city'), state: v('state'), email: v('email'), phone: v('phone'), website: v('website'), address: v('address'),
    channel: v('channel'), account_status: v('account_status'), status: v('status'), next_follow_up: v('next_follow_up'), pause_until: v('pause_until'),
    tags: f.tags.value.split(',').map((t) => t.trim()).filter(Boolean), key_account: f.key_account.checked, holdout: f.holdout.checked, background: v('background'),
  };
}
const slugify = (s) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
function viewNewStore() {
  $app.innerHTML = `<h1>New store</h1><form class="panel" id="sf">${storeForm({ channel: 'prospect', status: 'not-contacted' })}<div class="row" style="margin-top:10px"><button>Save store</button><a href="#/stores">Cancel</a></div></form>`;
  document.getElementById('sf').onsubmit = async (e) => {
    e.preventDefault();
    const rec = readStoreForm(e.target); rec.slug = slugify(rec.name) + '-' + Date.now().toString(36).slice(-4);
    const { data, error } = await sb.from('stores').insert(rec).select('id').single(); fail(error);
    tagCache = null; location.hash = '#/store/' + data.id;
  };
}

// ---------- Store page ----------
async function viewStore(id) {
  const [st, contacts, tl, tasks, orders] = await Promise.all([
    sb.from('stores').select('*').eq('id', id).single(),
    sb.from('contacts').select('*').eq('store_id', id).order('name'),
    sb.from('timeline').select('*').eq('store_id', id).order('occurred_at', { ascending: false }).limit(500),
    sb.from('tasks').select('*').eq('store_id', id).order('due_date', { nullsFirst: false }),
    sb.from('orders').select('*').eq('store_id', id).order('ordered_at', { ascending: false }),
  ]);
  if (st.error) { $app.innerHTML = '<p>Store not found.</p>'; return; }
  const s = st.data;
  const openTasks = tasks.data.filter((t) => !t.done_at);
  const spend = orders.data.reduce((a, o) => a + Number(o.total || 0), 0);
  const ex = s.extra || {};
  $app.innerHTML = `
  <div class="row"><h1 style="margin-bottom:2px">${esc(s.name)}</h1><span class="spacer"></span><button class="ghost" id="editbtn">Edit</button></div>
  <div style="margin-bottom:12px">${storeTags(s)} <span class="muted small">${esc([s.city, s.state].filter(Boolean).join(', '))}</span></div>
  <div class="grid2">
    <div>
      <form class="panel" id="addnote">
        <div class="row" style="margin-bottom:6px">
          <select name="kind">${['note', 'email', 'call', 'faire', 'mail'].map((k) => `<option value="${k}">${KINDS[k]}</option>`).join('')}</select>
          <select name="contact_id"><option value="">About the store</option>${contacts.data.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
          <input type="datetime-local" name="when" title="When it happened (leave blank for now)">
        </div>
        <input name="subject" placeholder="Subject (optional)" style="width:100%;margin-bottom:6px">
        <textarea name="body" placeholder="Add a note, paste an email, log a call…" required></textarea>
        <div class="row" style="margin-top:6px">
          <label class="small muted">Follow up on <input type="date" name="follow"></label>
          <label class="small muted"><input type="checkbox" name="contacted" checked> Counts as contact</label>
          <span class="spacer"></span><button>Add to timeline</button></div>
      </form>
      <div class="row"><h2>Timeline</h2><span class="spacer"></span>
        <select id="tlfilter"><option value="">Everything</option>${Object.entries(KINDS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
      <div class="timeline" id="tl"></div>
    </div>
    <div>
      <div class="panel" id="infopanel">
        <dl class="kv">
          ${s.email ? `<dt>Email</dt><dd><a href="mailto:${esc(s.email)}">${esc(s.email)}</a></dd>` : ''}
          ${s.phone ? `<dt>Phone</dt><dd><a href="tel:${esc(s.phone)}">${esc(s.phone)}</a></dd>` : ''}
          ${s.website ? `<dt>Website</dt><dd><a href="${esc(/^https?:/.test(s.website) ? s.website : 'https://' + s.website)}" target="_blank" rel="noopener">${esc(s.website)}</a></dd>` : ''}
          ${s.address ? `<dt>Address</dt><dd>${esc(s.address)}</dd>` : ''}
          <dt>Channel</dt><dd>${esc(s.channel || '')}</dd>
          <dt>Account</dt><dd>${esc(s.account_status || '')}</dd>
          <dt>Outreach</dt><dd>${esc(s.status || '')}</dd>
          <dt>Follow up</dt><dd class="${dueClass(s.next_follow_up)}">${fmtDate(s.next_follow_up) || '—'}</dd>
          ${s.pause_until ? `<dt>Paused until</dt><dd>${fmtDate(s.pause_until)}</dd>` : ''}
          <dt>Last contact</dt><dd>${fmtDate(s.last_contact) || '—'}</dd>
          <dt>Last order</dt><dd>${fmtDate(s.last_order) || '—'}</dd>
          <dt>Spend</dt><dd>Faire ${money(s.faire_spend)} · Direct ${money(s.shopify_spend)}${orders.data.length ? ` <span class="muted small">(${orders.data.length} orders here, ${money(spend)})</span>` : ''}</dd>
        </dl>
        ${s.background ? `<p class="small" style="white-space:pre-wrap;margin-bottom:0">${esc(s.background)}</p>` : ''}
        ${Object.keys(ex).length ? `<details class="small" style="margin-top:8px"><summary class="muted">More tracker fields</summary><dl class="kv" style="margin-top:6px">${Object.entries(ex).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</dd>`).join('')}</dl></details>` : ''}
      </div>
      <div class="panel"><div class="row"><h2 style="margin:0">Tasks</h2><span class="spacer"></span><button class="link" id="showdone">${tasks.data.length - openTasks.length} done</button></div>
        <div id="tasklist">${openTasks.map((t) => taskRow(t)).join('') || '<p class="muted small">No open tasks.</p>'}</div>
        <div id="donelist" hidden>${tasks.data.filter((t) => t.done_at).map((t) => taskRow(t)).join('')}</div>
        <form id="addtask" class="row" style="margin-top:8px">
          <input name="title" placeholder="New task…" required style="flex:1;min-width:140px">
          <input type="date" name="due" value="${today()}">
          <select name="category">${CATEGORIES.map((c) => `<option>${c}</option>`).join('')}</select>
          <button>Add</button>
        </form>
      </div>
      <div class="panel"><div class="row"><h2 style="margin:0">People</h2><span class="spacer"></span><button class="link" id="addperson">+ Add</button></div>
        <div id="people">${contacts.data.map((c) => `<div class="task" data-person="${c.id}"><span><b>${esc(c.name)}</b>${c.title ? ` <span class="muted small">${esc(c.title)}</span>` : ''}
          <div class="small">${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a> ` : ''}${c.phone ? esc(c.phone) : ''}</div>${c.background ? `<div class="small muted">${esc(c.background)}</div>` : ''}</span>
          <span class="spacer"></span><button class="link small" data-editperson="${c.id}">Edit</button></div>`).join('') || '<p class="muted small">No people yet.</p>'}</div>
      </div>
      <div class="panel"><button class="link" id="delstore" style="color:var(--danger)">Delete this store…</button></div>
    </div>
  </div>`;

  // timeline render
  const renderTl = () => {
    const f = document.getElementById('tlfilter').value;
    const rows = tl.data.filter((e) => !f || e.kind === f);
    document.getElementById('tl').innerHTML = rows.map((e) => `
      <div class="entry ${esc(e.kind)}" data-entry="${e.id}">
        <div class="meta"><b>${KINDS[e.kind] || esc(e.kind)}</b><span>${fmtDateTime(e.occurred_at)}</span>${e.author ? `<span>· ${esc(e.author)}</span>` : ''}
          ${e.contact_id ? `<span>· ${esc(contacts.data.find((c) => c.id === e.contact_id)?.name || '')}</span>` : ''}
          <span class="spacer"></span>${e.source !== 'manual' ? `<span>${esc(e.source)}</span>` : ''}
          <button class="link small" data-edit="${e.id}">Edit</button></div>
        ${e.subject ? `<div class="subject">${esc(e.subject)}</div>` : ''}
        ${e.body ? `<div class="body">${esc(e.body)}</div>` : ''}
      </div>`).join('') || '<p class="muted">Nothing here yet.</p>';
    document.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => editEntry(tl.data.find((x) => x.id === b.dataset.edit))));
  };
  document.getElementById('tlfilter').onchange = renderTl;
  renderTl();

  const editEntry = (e) => {
    const box = document.querySelector(`[data-entry="${e.id}"]`);
    const local = new Date(new Date(e.occurred_at).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    box.innerHTML = `<form class="stack">
      <div class="row"><select name="kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}" ${k === e.kind ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <input type="datetime-local" name="when" value="${local}"></div>
      <input name="subject" value="${esc(e.subject)}" placeholder="Subject">
      <textarea name="body" style="min-height:140px">${esc(e.body)}</textarea>
      <div class="row"><button>Save</button><button type="button" class="ghost" data-cancel>Cancel</button><span class="spacer"></span><button type="button" class="danger" data-del>Delete</button></div></form>`;
    const f = box.querySelector('form');
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      fail((await sb.from('timeline').update({ kind: f.kind.value, subject: f.subject.value || null, body: f.body.value, occurred_at: new Date(f.when.value).toISOString() }).eq('id', e.id)).error);
      toast('Saved'); viewStore(id);
    };
    box.querySelector('[data-cancel]').onclick = renderTl;
    box.querySelector('[data-del]').onclick = async () => { if (confirm('Delete this entry?')) { fail((await sb.from('timeline').delete().eq('id', e.id)).error); viewStore(id); } };
  };

  document.getElementById('addnote').onsubmit = async (ev) => {
    ev.preventDefault(); const f = ev.target;
    const when = f.when.value ? new Date(f.when.value).toISOString() : new Date().toISOString();
    fail((await sb.from('timeline').insert({ store_id: id, contact_id: f.contact_id.value || null, kind: f.kind.value, subject: f.subject.value || null, body: f.body.value, occurred_at: when, author: 'Bryant', source: 'manual' })).error);
    const upd = {};
    if (f.contacted.checked) upd.last_contact = when.slice(0, 10);
    if (f.contacted.checked && (!s.status || s.status === 'not-contacted')) upd.status = 'contacted';
    if (f.follow.value) upd.next_follow_up = f.follow.value;
    if (Object.keys(upd).length) fail((await sb.from('stores').update(upd).eq('id', id)).error);
    toast('Added'); viewStore(id);
  };
  document.getElementById('addtask').onsubmit = async (ev) => {
    ev.preventDefault(); const f = ev.target;
    fail((await sb.from('tasks').insert({ store_id: id, title: f.title.value, due_date: f.due.value || null, category: f.category.value, source: 'manual' })).error);
    toast('Task added'); viewStore(id);
  };
  document.getElementById('showdone').onclick = () => { const d = document.getElementById('donelist'); d.hidden = !d.hidden; };
  bindTaskRows(() => viewStore(id));

  document.getElementById('editbtn').onclick = () => {
    const p = document.getElementById('infopanel');
    p.innerHTML = `<form id="ef">${storeForm(s)}<div class="row" style="margin-top:10px"><button>Save</button><button type="button" class="ghost" id="canceledit">Cancel</button></div></form>`;
    p.scrollIntoView({ behavior: 'smooth' });
    document.getElementById('canceledit').onclick = () => viewStore(id);
    document.getElementById('ef').onsubmit = async (ev) => {
      ev.preventDefault(); fail((await sb.from('stores').update(readStoreForm(ev.target)).eq('id', id)).error); tagCache = null; toast('Saved'); viewStore(id);
    };
  };
  const personForm = (c = {}) => `<form class="stack" id="pf" style="margin-top:8px">
      <input name="name" placeholder="Name" required value="${esc(c.name)}"><input name="title" placeholder="Title / role" value="${esc(c.title)}">
      <input name="email" placeholder="Email" value="${esc(c.email)}"><input name="phone" placeholder="Phone" value="${esc(c.phone)}">
      <textarea name="background" placeholder="Notes" style="min-height:50px">${esc(c.background)}</textarea>
      <div class="row"><button>Save</button><button type="button" class="ghost" onclick="this.closest('form').remove()">Cancel</button>${c.id ? '<span class="spacer"></span><button type="button" class="danger" id="pdel">Delete</button>' : ''}</div></form>`;
  const bindPerson = (c) => {
    const f = document.getElementById('pf');
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const rec = { store_id: id, name: f.name.value, title: f.title.value || null, email: f.email.value || null, phone: f.phone.value || null, background: f.background.value || null };
      fail((c ? await sb.from('contacts').update(rec).eq('id', c.id) : await sb.from('contacts').insert(rec)).error); viewStore(id);
    };
    document.getElementById('pdel')?.addEventListener('click', async () => { if (confirm('Delete this person?')) { fail((await sb.from('contacts').delete().eq('id', c.id)).error); viewStore(id); } });
  };
  document.getElementById('addperson').onclick = () => { document.getElementById('pf')?.remove(); document.getElementById('people').insertAdjacentHTML('beforeend', personForm()); bindPerson(null); };
  document.querySelectorAll('[data-editperson]').forEach((b) => (b.onclick = () => {
    document.getElementById('pf')?.remove(); const c = contacts.data.find((x) => x.id === b.dataset.editperson);
    document.querySelector(`[data-person="${c.id}"]`).insertAdjacentHTML('afterend', personForm(c)); bindPerson(c);
  }));
  document.getElementById('delstore').onclick = async () => {
    if (prompt(`Type DELETE to remove ${s.name} and its whole timeline.`) === 'DELETE') { fail((await sb.from('stores').delete().eq('id', id)).error); toast('Deleted'); location.hash = '#/stores'; }
  };
}

// ---------- Tasks ----------
async function viewTasks() {
  const p = params(); const show = p.get('show') || 'open';
  let q = sb.from('tasks').select('*, stores(id,name)');
  q = show === 'done' ? q.not('done_at', 'is', null).order('done_at', { ascending: false }).limit(200) : q.is('done_at', null).order('due_date', { nullsFirst: false }).limit(1000);
  const { data, error } = await q; fail(error);
  const t = today();
  const groups = show === 'done' ? { 'Recently done': data } : {
    Overdue: data.filter((x) => x.due_date && x.due_date < t), Today: data.filter((x) => x.due_date === t),
    Upcoming: data.filter((x) => x.due_date > t), 'No date': data.filter((x) => !x.due_date) };
  $app.innerHTML = `<div class="row"><h1>Tasks</h1><span class="spacer"></span>
    <a href="#/tasks"><button class="${show === 'open' ? '' : 'ghost'}">Open</button></a><a href="#/tasks?show=done"><button class="${show === 'done' ? '' : 'ghost'}">Done</button></a></div>
    ${Object.entries(groups).filter(([, v]) => v.length).map(([k, v]) => `<div class="panel"><h2 style="margin-top:0">${k} (${v.length})</h2>${v.map(taskRow).join('')}</div>`).join('') || '<p class="muted">No tasks.</p>'}`;
  bindTaskRows(viewTasks);
}

// ---------- Orders ----------
async function viewOrders() {
  const p = params(); const ch = p.get('channel') || '';
  let q = sb.from('orders').select('*, stores(id,name)').order('ordered_at', { ascending: false }).limit(300);
  if (ch) q = q.eq('channel', ch);
  const { data, error } = await q; fail(error);
  const total = data.reduce((a, o) => a + Number(o.total || 0), 0);
  $app.innerHTML = `<div class="row"><h1>Orders</h1><span class="spacer"></span>
    <a href="#/orders"><button class="${!ch ? '' : 'ghost'}">All</button></a><a href="#/orders?channel=shopify"><button class="${ch === 'shopify' ? '' : 'ghost'}">Shopify</button></a><a href="#/orders?channel=faire"><button class="${ch === 'faire' ? '' : 'ghost'}">Faire</button></a></div>
    <p class="muted small">Latest ${data.length} orders · ${money(total)}</p>
    <div class="tablewrap"><table><thead><tr><th>Date</th><th>Store</th><th>Channel</th><th>Order</th><th>Total</th></tr></thead><tbody>
    ${data.map((o) => `<tr><td>${fmtDate(o.ordered_at)}</td><td>${o.stores ? `<a href="#/store/${o.stores.id}">${esc(o.stores.name)}</a>` : `<span class="muted">${esc(o.customer_name || '')} (no store matched)</span>`}</td>
      <td>${esc(o.channel)}</td><td>${esc(o.order_no || '')}</td><td>${money(o.total)}</td></tr>`).join('')}</tbody></table></div>`;
}

// ---------- Activity feed ----------
async function viewActivity() {
  const page = +(params().get('page') || 0);
  const { data, error } = await sb.from('timeline').select('*, stores(id,name)').order('occurred_at', { ascending: false }).range(page * 50, page * 50 + 49); fail(error);
  $app.innerHTML = `<h1>All activity</h1><div class="timeline">${data.map((e) => `
    <div class="entry ${esc(e.kind)}"><div class="meta"><b>${KINDS[e.kind] || esc(e.kind)}</b><a href="#/store/${e.store_id}">${esc(e.stores?.name || '')}</a><span>${fmtDateTime(e.occurred_at)}</span>${e.author ? `<span>· ${esc(e.author)}</span>` : ''}</div>
    ${e.subject ? `<div class="subject">${esc(e.subject)}</div>` : ''}${e.body ? `<div class="body">${esc(e.body.length > 600 ? e.body.slice(0, 600) + '…' : e.body)}</div>` : ''}</div>`).join('')}</div>
    <div class="pager">${page ? `<a href="#/activity?page=${page - 1}"><button class="ghost">← Newer</button></a>` : ''}${data.length === 50 ? `<a href="#/activity?page=${page + 1}"><button class="ghost">Older →</button></a>` : ''}</div>`;
}

// ---------- Search ----------
async function viewSearch(q) {
  const s = q.replace(/[%,()]/g, ' ');
  document.querySelector('#quicksearch input').value = q;
  const [stores, people, notes] = await Promise.all([
    sb.from('stores').select('id,name,city,state,channel,key_account,holdout,tags').or(`name.ilike.%${s}%,city.ilike.%${s}%,email.ilike.%${s}%,background.ilike.%${s}%`).order('name').limit(50),
    sb.from('contacts').select('id,name,email,store_id,stores(name)').or(`name.ilike.%${s}%,email.ilike.%${s}%`).limit(50),
    sb.from('timeline').select('id,kind,occurred_at,subject,body,store_id,stores(name)').or(`body.ilike.%${s}%,subject.ilike.%${s}%`).order('occurred_at', { ascending: false }).limit(50),
  ]);
  const hl = (txt) => { const t = String(txt || ''); const i = t.toLowerCase().indexOf(q.toLowerCase()); const a = Math.max(0, i - 80); return esc((a ? '…' : '') + t.slice(a, a + 220)); };
  $app.innerHTML = `<h1>Search: “${esc(q)}”</h1>
    <div class="panel"><h2 style="margin-top:0">Stores (${stores.data?.length || 0})</h2>${(stores.data || []).map((x) => `<div class="task"><a href="#/store/${x.id}">${esc(x.name)}</a> ${storeTags(x)}<span class="muted small">${esc([x.city, x.state].filter(Boolean).join(', '))}</span></div>`).join('') || '<p class="muted small">None</p>'}</div>
    <div class="panel"><h2 style="margin-top:0">People (${people.data?.length || 0})</h2>${(people.data || []).map((x) => `<div class="task"><span>${esc(x.name)} <span class="muted small">${esc(x.email || '')}</span></span>${x.store_id ? `· <a href="#/store/${x.store_id}">${esc(x.stores?.name || '')}</a>` : ''}</div>`).join('') || '<p class="muted small">None</p>'}</div>
    <div class="panel"><h2 style="margin-top:0">Notes and emails (${notes.data?.length || 0})</h2>${(notes.data || []).map((x) => `<div class="task"><span><a href="#/store/${x.store_id}">${esc(x.stores?.name || '')}</a> <span class="muted small">${KINDS[x.kind] || x.kind} · ${fmtDate(x.occurred_at)}</span><div class="small">${hl(x.body || x.subject)}</div></span></div>`).join('') || '<p class="muted small">None</p>'}</div>`;
}

// ---------- boot ----------
if (!cfg.supabaseUrl) { $app.innerHTML = '<p>Missing config.js (Supabase URL and public key).</p>'; }
else { const { data } = await sb.auth.getSession(); me = data.session?.user || null; ['nav', 'quicksearch', 'signout'].forEach((id) => (document.getElementById(id).hidden = !me)); route(); }
