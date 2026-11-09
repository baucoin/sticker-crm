"""Load the tracker's playbook, handoff notes and wins (from the Nov 8 backup CSVs). Safe to re-run.
usage: source env; python3 import_playbook.py <tracker-backup-dir>"""
import csv, json, os, sys, urllib.request, urllib.error
URL, KEY, CK, D = os.environ['SUPABASE_URL'], os.environ['SUPABASE_ANON_KEY'], os.environ['CRM_KEY'], sys.argv[1]
H = {'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'x-crm-key': CK, 'Content-Type': 'application/json'}
def post(table, rows, conflict):
    h = dict(H, Prefer='resolution=merge-duplicates,return=minimal')
    r = urllib.request.Request(f'{URL}/rest/v1/{table}?on_conflict={conflict}', data=json.dumps(rows).encode(), method='POST', headers=h)
    try: urllib.request.urlopen(r).read()
    except urllib.error.HTTPError as e: raise SystemExit(f'{table}: {e.read().decode()[:400]}')
    print(table, len(rows))
rd = lambda f: list(csv.DictReader(open(os.path.join(D, f), encoding='utf-8-sig')))
post('playbook', [{'heading': r['heading'], 'body': r['body'], 'sort': i * 10} for i, r in enumerate(rd('playbook.csv'))], 'heading')
def stores_list(v):
    try: return json.loads(v) if v else []
    except Exception: return []
post('handoffs', [{'slug': r['id'], 'created_on': r['date'] or None, 'from_who': r['from'] or None, 'to_who': r['to'] or 'all', 'topic': r['topic'] or '(no topic)',
                   'note': r['note'] or None, 'status': r['status'] or 'open', 'done_by': r['doneBy'] or None, 'done_on': r['doneDate'] or None,
                   'done_note': r['doneNote'] or None, 'progress_note': r['progressNote'] or None, 'store_slugs': stores_list(r['stores'])} for r in rd('handoffs.csv')], 'slug')
req = urllib.request.Request(f'{URL}/rest/v1/stores?select=id,slug&limit=5000', headers=H)
sid = {s['slug']: s['id'] for s in json.loads(urllib.request.urlopen(req).read())}
post('wins', [{'slug': r['id'], 'store_id': sid.get(r['store']), 'store_name': r['storeName'], 'amount': float(r['amount'] or 0), 'channel': r['channel'] or None,
               'confidence': r['confidence'] or 'counted', 'contact_by': r['contactBy'] or None, 'contact_on': r['contactDate'] or None,
               'contact_via': r['contactVia'] or None, 'won_on': r['date'], 'order_no': r['orderNo'] or None, 'note': r['note'] or None} for r in rd('wins.csv')], 'slug')
