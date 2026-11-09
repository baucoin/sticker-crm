"""Upload the JSON rows from build_import.py into Supabase (upsert, safe to re-run).
usage: SUPABASE_URL=... SUPABASE_SERVICE_KEY=... python3 load_supabase.py <dir-with-json>"""
import json, os, sys, urllib.request
URL, KEY, D = os.environ['SUPABASE_URL'], os.environ['SUPABASE_SERVICE_KEY'], sys.argv[1]
def post(table, rows, conflict):
    for i in range(0, len(rows), 500):
        req = urllib.request.Request(f"{URL}/rest/v1/{table}?on_conflict={conflict}", data=json.dumps(rows[i:i+500]).encode(), method='POST',
            headers={'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal'})
        urllib.request.urlopen(req, timeout=120).read()
    print(table, len(rows), flush=True)
for t, c in [('stores', 'id'), ('contacts', 'id'), ('timeline', 'id'), ('tasks', 'id')]:
    rows = json.load(open(os.path.join(D, t + '.json')))
    keys = set().union(*(r.keys() for r in rows))           # PostgREST bulk insert needs the same keys on every row
    rows = [{k: r.get(k) for k in keys} for r in rows]
    post(t, rows, c)
