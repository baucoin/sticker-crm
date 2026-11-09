"""Load past orders from the Shopify and Faire CSV exports, matched to stores. Safe to re-run (upserts on source_id).

usage: source env; python3 import_orders.py <shopify-orders.csv> <faire-orders.csv>
Needs SUPABASE_URL, SUPABASE_ANON_KEY, CRM_KEY. Stores that bought but don't exist yet are created (tag "from orders").
"""
import csv, json, os, re, sys, uuid, urllib.request, urllib.error
from datetime import datetime

URL, KEY, CK = os.environ['SUPABASE_URL'], os.environ['SUPABASE_ANON_KEY'], os.environ['CRM_KEY']
H = {'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'x-crm-key': CK, 'Content-Type': 'application/json'}

def req(method, path, body=None, prefer=None):
    h = dict(H)
    if prefer: h['Prefer'] = prefer
    r = urllib.request.Request(URL + '/rest/v1/' + path, data=json.dumps(body).encode() if body is not None else None, method=method, headers=h)
    try:
        with urllib.request.urlopen(r, timeout=180) as resp:
            t = resp.read().decode(); return json.loads(t) if t else None
    except urllib.error.HTTPError as e:
        raise SystemExit(f'{method} {path}: {e.code} {e.read().decode()[:600]}')

def get_all(path):
    out, off = [], 0
    while True:
        h = dict(H); h['Range'] = f'{off}-{off+999}'
        r = urllib.request.Request(URL + '/rest/v1/' + path, headers=h)
        with urllib.request.urlopen(r, timeout=120) as resp: rows = json.loads(resp.read())
        out += rows
        if len(rows) < 1000: return out
        off += 1000

def norm(name):
    s = (name or '').lower().replace('&', 'and')
    s = re.sub(r'\(.*?\)', ' ', s)
    s = re.sub(r"[^a-z0-9]+", ' ', s)
    s = re.sub(r'\b(the|llc|inc|co|company|store|shop|gifts?)\b', ' ', s)
    return ' '.join(s.split())
slugify = lambda s: re.sub(r'^-|-$', '', re.sub(r'[^a-z0-9]+', '-', s.lower().replace('&', 'and')))
money = lambda v: float(re.sub(r'[^0-9.\-]', '', v or '') or 0)

stores = get_all('stores?select=id,name,slug,email,city,state,channel,extra')
contacts = get_all('contacts?select=store_id,email')
by_email, by_name, by_slug = {}, {}, {s['slug']: s['id'] for s in stores}
for s in stores:
    if s['email']: by_email.setdefault(s['email'].strip().lower(), s['id'])
    by_name.setdefault(norm(s['name']), s['id'])
for c in contacts:
    if c['email'] and c['store_id']: by_email.setdefault(c['email'].strip().lower(), c['store_id'])
new_stores = {}

def ensure_store(name, channel, city=None, state=None, email=None, phone=None):
    key = norm(name)
    if key in by_name: return by_name[key]
    slug = slugify(name) or 'store'
    while slug in by_slug: slug += '-2'
    sid = str(uuid.uuid4())
    new_stores[sid] = {'id': sid, 'slug': slug, 'name': name.strip(), 'channel': channel, 'city': city or None, 'state': state or None,
                       'email': email or None, 'phone': phone or None, 'tags': ['from orders'] + (['Faire'] if channel == 'faire' else []),
                       'status': 'ordered', 'extra': {}}
    by_name[key] = sid; by_slug[slug] = sid
    if email: by_email.setdefault(email.lower(), sid)
    return sid

# ---------- Shopify ----------
orders = []
shop_rows = list(csv.DictReader(open(sys.argv[1], encoding='utf-8-sig')))
items = {}
for r in shop_rows:
    items.setdefault(r['Name'], []).append({'name': r['Lineitem name'], 'qty': int(r['Lineitem quantity'] or 0), 'price': money(r['Lineitem price']), 'sku': r['Lineitem sku'] or None})
unmatched_shop = 0
for r in shop_rows:
    if not r['Total']: continue
    email = (r['Email'] or '').strip().lower()
    company = r['Billing Company'] or r['Shipping Company']
    person = r['Billing Name'] or r['Shipping Name']
    sid = by_email.get(email) or (by_name.get(norm(company)) if company else None) or (by_name.get(norm(person)) if person else None)
    if not sid:
        unmatched_shop += 1
        sid = ensure_store(company or person or email or r['Name'], 'direct', r['Billing City'] or r['Shipping City'], r['Billing Province'] or r['Shipping Province'], email, r['Billing Phone'] or r['Phone'])
    when = datetime.strptime(r['Created at'], '%Y-%m-%d %H:%M:%S %z').isoformat()
    status = 'cancelled' if r['Cancelled at'] else r['Financial Status']
    orders.append({'channel': 'shopify', 'order_no': r['Name'], 'ordered_at': when, 'total': money(r['Total']) - money(r['Refunded Amount']),
                   'status': status, 'customer_name': company or person or None, 'customer_email': email or None, 'items': items.get(r['Name'], []),
                   'store_id': sid, 'source_id': 'shopify:' + r['Name']})

# ---------- Faire ----------
fo = {}
for r in csv.DictReader(open(sys.argv[2], encoding='utf-8-sig')):
    o = fo.setdefault(r['Order Number'], {'rows': [], 'r': r})
    o['rows'].append(r)
unmatched_faire = 0
for no, o in fo.items():
    r = o['r']
    sid = by_name.get(norm(r['Retailer Name']))
    if not sid:
        unmatched_faire += 1
        sid = ensure_store(r['Retailer Name'], 'faire', r['City'], r['State'], None, (r['Phone Number'] or '').lstrip("'"))
    its = [{'name': x['Product Name'], 'qty': int(x['Quantity'] or 0), 'price': money(x['Wholesale Price']), 'gtin': x['GTIN'] or None} for x in o['rows']]
    canceled = all(x['Status'] == 'Canceled' for x in o['rows'])
    total = round(sum(i['qty'] * i['price'] for i, x in zip(its, o['rows']) if x['Status'] != 'Canceled'), 2)
    when = datetime.strptime(r['Order Date'], '%B %d, %Y').strftime('%Y-%m-%dT12:00:00-07:00')
    orders.append({'channel': 'faire', 'order_no': no, 'ordered_at': when, 'total': total, 'status': 'Canceled' if canceled else r['Status'],
                   'customer_name': r['Retailer Name'], 'customer_email': None, 'items': its, 'store_id': sid, 'source_id': 'faire:' + no})

print(f'shopify orders {sum(1 for o in orders if o["channel"]=="shopify")} (no store found for {unmatched_shop}); '
      f'faire orders {len(fo)} (no store found for {unmatched_faire}); new stores to create {len(new_stores)}', flush=True)
if '--dry' in sys.argv: sys.exit()
nl = list(new_stores.values())
for i in range(0, len(nl), 500):
    req('POST', 'stores?on_conflict=id', nl[i:i+500], 'resolution=merge-duplicates,return=minimal')
for i in range(0, len(orders), 500):
    req('POST', 'orders?on_conflict=source_id', orders[i:i+500], 'resolution=merge-duplicates,return=minimal')
    print('orders', i + 500, flush=True)
print('done')
