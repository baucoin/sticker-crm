"""Turn the raw Highrise export + Outreach Tracker CSVs into JSON rows ready for Supabase.

usage: python3 build_import.py <highrise-export-dir> <tracker-backup-dir> <out-dir>
"""
import csv, glob, json, os, re, sys, uuid, html
import xml.etree.ElementTree as ET
from datetime import date

HR, TR, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(OUT, exist_ok=True)
NS = uuid.UUID('6f1c6b4e-5b51-4a51-9d0e-1c0ffee00001')
uid = lambda key: str(uuid.uuid5(NS, key))

def norm(name):
    s = (name or '').lower().replace('&', 'and')
    s = re.sub(r'\(.*?\)', ' ', s)
    s = re.sub(r"[^a-z0-9]+", ' ', s)
    s = re.sub(r'\b(the|llc|inc|co|company|store|shop|gifts?)\b', ' ', s)
    return ' '.join(s.split())

def txt(el, tag):
    x = el.find(tag)
    return (x.text or '').strip() if x is not None and x.text else ''

def contact_data(el):
    cd = el.find('contact-data')
    out = {'emails': [], 'phones': [], 'addresses': [], 'web': []}
    if cd is None: return out
    out['emails'] = [txt(e, 'address') for e in cd.iter('email-address') if txt(e, 'address')]
    out['phones'] = [txt(e, 'number') for e in cd.iter('phone-number') if txt(e, 'number')]
    out['web'] = [txt(e, 'url') for e in cd.iter('web-address') if txt(e, 'url')]
    for a in cd.iter('address'):
        parts = [txt(a, k) for k in ('street', 'city', 'state', 'zip', 'country')]
        out['addresses'].append({'street': parts[0], 'city': parts[1], 'state': parts[2], 'zip': parts[3], 'country': parts[4]})
    return out

def parse_all(pattern, tag):
    items = []
    for f in sorted(glob.glob(os.path.join(HR, pattern))):
        root = ET.fromstring(open(f, encoding='utf-8').read())
        items += list(root.iter(tag))
    return items

# ---------- Highrise ----------
companies = {txt(c, 'id'): c for c in parse_all('companies-*.xml', 'company')}
people = {txt(p, 'id'): p for p in parse_all('people-*.xml', 'person')}
tag_parties = json.load(open(os.path.join(HR, 'tag-parties.json')))
party_tags = {}
for tag, ids in tag_parties.items():
    for x in ids:
        pid = x.split(':')[0]
        party_tags.setdefault(pid, []).append(tag)
print('highrise companies', len(companies), 'people', len(people))

# ---------- Tracker ----------
rows = list(csv.DictReader(open(os.path.join(TR, 'stores.csv'), encoding='utf-8-sig')))
print('tracker stores', len(rows))

def d(v):
    return v[:10] if v and re.match(r'\d{4}-\d{2}-\d{2}', v) else None
def num(v):
    try: return round(float(v), 2)
    except: return 0
def jcell(v):
    if v and v[:1] in '[{':
        try: return json.loads(v)
        except: return v
    return v

stores, contacts, timeline, tasks = {}, [], [], []
by_hr = {}      # highrise company id -> store id
by_norm = {}    # normalized name -> store id
MAPPED = {'id', 'name', 'city', 'state', 'contact', 'email', 'phone', 'channel', 'accountStatus', 'status', 'keyAccount', 'holdout',
          'lastContact', 'nextFollowUp', 'faireSpend', 'shopifySpend', 'highriseId', 'pauseUntil', 'notes', 'lastFaireOrder', 'lastDirectOrder'}

for r in rows:
    sid = uid('tracker:' + r['id'])
    lo = max([x for x in (d(r['lastFaireOrder']), d(r['lastDirectOrder'])) if x] or [None]) if (d(r['lastFaireOrder']) or d(r['lastDirectOrder'])) else None
    tags = []
    extra = {k: jcell(v) for k, v in r.items() if k not in MAPPED and v not in ('', None)}
    s = {
        'id': sid, 'slug': r['id'], 'name': r['name'].strip() or r['id'], 'city': r['city'] or None, 'state': r['state'] or None,
        'phone': r['phone'] or None, 'email': r['email'] or None, 'channel': r['channel'] or None,
        'account_status': r['accountStatus'] or None, 'status': r['status'] or None,
        'key_account': r['keyAccount'] == 'True', 'holdout': r['holdout'] == 'True', 'tags': tags,
        'next_follow_up': d(r['nextFollowUp']), 'pause_until': d(r['pauseUntil']), 'last_contact': d(r['lastContact']),
        'last_order': lo, 'faire_spend': num(r['faireSpend']), 'shopify_spend': num(r['shopifySpend']),
        'highrise_id': int(r['highriseId']) if r['highriseId'].isdigit() else None, 'background': None, 'address': None, 'website': None,
        'extra': extra,
    }
    if r['floodHold']: tags.append('flood hold')
    if r['batch']: tags.append(r['batch'])
    stores[sid] = s
    if s['highrise_id']: by_hr[str(s['highrise_id'])] = sid
    by_norm.setdefault(norm(s['name']), sid)
    if r['contact'] and r['contact'].strip():
        contacts.append({'id': uid('trackercontact:' + r['id']), 'store_id': sid, 'name': r['contact'].strip(), 'email': r['email'] or None, 'phone': r['phone'] or None})
    if r['notes'].strip():
        when = d(r['updated']) or d(r['lastContact']) or '2026-11-08'
        timeline.append({'id': uid('trackernote:' + r['id']), 'store_id': sid, 'kind': 'note', 'occurred_at': when + 'T12:00:00-07:00',
                         'author': 'Outreach Tracker', 'subject': 'Outreach Tracker notes (as of Nov 8, 2026)', 'body': r['notes'].strip(),
                         'source': 'tracker', 'source_id': 'tracker:notes:' + r['id']})

# Highrise companies -> link to tracker store, or create a new store
matched_by_name = 0
# Hand-checked pairs whose names differ too much for automatic matching (Highrise name -> tracker slug)
MANUAL = {'Sparkle (Lake Placid, NY)': 'sparkle-lake-placid', 'Tattered Covered Bookstore': 'tattered-cover-book-store',
          'Wild Country Keep Sakes': 'wild-country-keepsakes-ltd', 'Tinkertown Museum NM': 'tinkertown-museum'}
slug_to_sid = {s['slug']: k for k, s in stores.items()}
for hid, c in companies.items():
    name = html.unescape(txt(c, 'name'))
    sid = by_hr.get(hid)
    if not sid:
        cand = by_norm.get(norm(name)) or slug_to_sid.get(MANUAL.get(name, ''))
        if cand and not stores[cand]['highrise_id']:
            sid = cand; stores[sid]['highrise_id'] = int(hid); matched_by_name += 1
    cd = contact_data(c)
    if not sid:
        sid = uid('highrise:' + hid)
        a = cd['addresses'][0] if cd['addresses'] else {}
        stores[sid] = {'id': sid, 'slug': 'hr-' + hid, 'name': name, 'city': a.get('city') or None, 'state': a.get('state') or None,
                       'phone': None, 'email': None, 'channel': None, 'account_status': None, 'status': None, 'key_account': False, 'holdout': False,
                       'tags': ['highrise only'], 'next_follow_up': None, 'pause_until': None, 'last_contact': None, 'last_order': None,
                       'faire_spend': 0, 'shopify_spend': 0, 'highrise_id': int(hid), 'background': None, 'address': None, 'website': None, 'extra': {}}
    by_hr[hid] = sid
    s = stores[sid]
    s['background'] = txt(c, 'background') or s['background']
    s['email'] = s['email'] or (cd['emails'][0] if cd['emails'] else None)
    s['phone'] = s['phone'] or (cd['phones'][0] if cd['phones'] else None)
    s['website'] = s['website'] or (cd['web'][0] if cd['web'] else None)
    if cd['addresses']:
        a = cd['addresses'][0]
        s['address'] = ', '.join(x for x in (a['street'], a['city'], a['state'], a['zip']) if x) or None
        s['city'] = s['city'] or a['city'] or None; s['state'] = s['state'] or a['state'] or None
    extra_emails = cd['emails'][1:] + cd['phones'][1:]
    if extra_emails: s['extra']['other_contact_info'] = extra_emails
    for t in party_tags.get(hid, []):
        if t not in s['tags']: s['tags'].append(t)
    s['extra']['highrise_created'] = txt(c, 'created-at')[:10]
print('highrise companies matched to tracker by name', matched_by_name, '| total stores', len(stores))

# People -> contacts (or their own store when they have no company)
by_person = {}
for pid, p in people.items():
    name = ' '.join(x for x in (txt(p, 'first-name'), txt(p, 'last-name')) if x) or 'Unknown'
    cd = contact_data(p)
    cid = txt(p, 'company-id')
    sid = by_hr.get(cid)
    if not sid:
        cname = txt(p, 'company-name')
        sid = by_norm.get(norm(cname)) if cname else None
    if not sid:
        sid = uid('highriseperson:' + pid)
        a = cd['addresses'][0] if cd['addresses'] else {}
        stores[sid] = {'id': sid, 'slug': 'hr-person-' + pid, 'name': txt(p, 'company-name') or name, 'city': a.get('city') or None, 'state': a.get('state') or None,
                       'phone': cd['phones'][0] if cd['phones'] else None, 'email': cd['emails'][0] if cd['emails'] else None, 'channel': None,
                       'account_status': None, 'status': None, 'key_account': False, 'holdout': False, 'tags': ['highrise only', 'person'],
                       'next_follow_up': None, 'pause_until': None, 'last_contact': None, 'last_order': None, 'faire_spend': 0, 'shopify_spend': 0,
                       'highrise_id': None, 'background': txt(p, 'background') or None, 'address': None,
                       'website': cd['web'][0] if cd['web'] else None, 'extra': {'highrise_person_id': pid}}
    for t in party_tags.get(pid, []):
        if t not in stores[sid]['tags']: stores[sid]['tags'].append(t)
    by_person[pid] = sid
    contacts.append({'id': uid('highriseperson-contact:' + pid), 'store_id': sid, 'name': name, 'title': txt(p, 'title') or None,
                     'email': cd['emails'][0] if cd['emails'] else None, 'phone': cd['phones'][0] if cd['phones'] else None,
                     'background': txt(p, 'background') or None, 'highrise_id': int(pid)})
# drop tracker contacts that duplicate a Highrise person (same store + same first name or email)
hr_keys = {(c['store_id'], (c['email'] or '').lower()) for c in contacts if c.get('highrise_id')} | \
          {(c['store_id'], c['name'].split()[0].lower()) for c in contacts if c.get('highrise_id')}
contacts = [c for c in contacts if c.get('highrise_id') or not ((c['store_id'], (c['email'] or '').lower()) in hr_keys and c['email'])
            and (c['store_id'], c['name'].split()[0].lower()) not in hr_keys]

def party_store(pid):
    return by_hr.get(pid) or by_person.get(pid)

# Recordings -> timeline
user_names = {'1090076': 'Bryant'}
for u in parse_all('users.xml', 'user'):
    user_names[txt(u, 'id')] = (txt(u, 'name') or 'Bryant').split()[0]
seen, orphan = set(), 0
for f in sorted(glob.glob(os.path.join(HR, 'recordings-*.xml'))):
    root = ET.fromstring(open(f, encoding='utf-8').read())
    for r in root.iter('recording'):
        rid = txt(r, 'id')
        if rid in seen: continue
        seen.add(rid)
        typ = r.get('type')
        sid = party_store(txt(r, 'subject-id')) if txt(r, 'subject-type') == 'Party' else None
        if not sid: orphan += 1; continue
        kind = {'Note': 'note', 'Email': 'email', 'TaskRecording': 'task', 'Comment': 'note'}.get(typ, 'note')
        body = txt(r, 'body')
        timeline.append({'id': uid('highrise-rec:' + rid), 'store_id': sid, 'kind': kind, 'occurred_at': txt(r, 'created-at'),
                         'author': user_names.get(txt(r, 'author-id'), 'Bryant'), 'subject': (txt(r, 'title') or ('Task done' if kind == 'task' else None)) or None,
                         'body': body, 'source': 'highrise', 'source_id': 'highrise:' + rid})
# Per-party notes and emails (more complete than the recordings feed)
for f in sorted(glob.glob(os.path.join(HR, 'party', '*.xml'))):
    for doc in open(f, encoding='utf-8').read().split('<?xml')[1:]:
        root = ET.fromstring('<?xml' + doc)
        for r in list(root.iter('note')) + list(root.iter('email')):
            rid = txt(r, 'id')
            if rid in seen: continue
            seen.add(rid)
            sid = party_store(txt(r, 'subject-id'))
            if not sid: orphan += 1; continue
            kind = 'email' if r.tag == 'email' else 'note'
            timeline.append({'id': uid('highrise-rec:' + rid), 'store_id': sid, 'kind': kind, 'occurred_at': txt(r, 'created-at'),
                             'author': user_names.get(txt(r, 'author-id'), 'Bryant'), 'subject': txt(r, 'title') or None,
                             'body': txt(r, 'body'), 'source': 'highrise', 'source_id': 'highrise:' + rid})
print('recordings', len(seen), 'orphans skipped', orphan)

# Tasks (open + completed)
cats = {txt(c, 'id'): txt(c, 'name') for c in parse_all('task-categories.xml', 'task-category')}
for fn in ('tasks-all.xml', 'tasks-completed.xml'):
    for t in parse_all(fn, 'task'):
        tid = txt(t, 'id')
        due = txt(t, 'due-at')
        tasks.append({'id': uid('highrise-task:' + tid), 'store_id': party_store(txt(t, 'subject-id')) if txt(t, 'subject-type') == 'Party' else None,
                      'title': txt(t, 'body') or '(no text)', 'category': cats.get(txt(t, 'category-id')) or None,
                      'due_date': due[:10] if due else None, 'done_at': txt(t, 'done-at') or None, 'assignee': 'Bryant',
                      'source': 'highrise', 'source_id': 'highrise-task:' + tid})
tasks = list({t['source_id']: t for t in tasks}.values())
print('tasks', len(tasks), 'open', sum(1 for t in tasks if not t['done_at']))

# Wins -> timeline note so the $1,000/month credit history stays with the store
for w in csv.DictReader(open(os.path.join(TR, 'wins.csv'), encoding='utf-8-sig')):
    sid = uid('tracker:' + w['store']) if uid('tracker:' + w['store']) in stores else None
    if sid:
        timeline.append({'id': uid('win:' + w['id']), 'store_id': sid, 'kind': 'system', 'occurred_at': (w['date'] or '2026-11-08') + 'T12:00:00-07:00',
                         'author': w['contactBy'] or None, 'subject': f"Win: ${w['amount']} {w['channel']} order {w['orderNo']}".strip(),
                         'body': w['note'], 'source': 'tracker', 'source_id': 'tracker:win:' + w['id']})

# Highrise and tracker both use "Faire": make the channel a tag too, so either filter works
for s in stores.values():
    if s['channel'] in ('faire', 'both') and 'Faire' not in s['tags']: s['tags'].append('Faire')
    s['tags'] = sorted(set(s['tags']), key=str.lower)

def dump(name, data):
    json.dump(data, open(os.path.join(OUT, name + '.json'), 'w'), ensure_ascii=False)
    print(name, len(data))
dump('stores', list(stores.values())); dump('contacts', contacts); dump('timeline', timeline); dump('tasks', tasks)
