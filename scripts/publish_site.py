"""Upload /public into the site_files table (used when the Worker runs without the static-assets binding).
usage: source env; python3 publish_site.py"""
import json, os, urllib.request
URL, KEY, CK = os.environ['SUPABASE_URL'], os.environ['SUPABASE_ANON_KEY'], os.environ['CRM_KEY']
T = {'html': 'text/html; charset=utf-8', 'js': 'text/javascript; charset=utf-8', 'css': 'text/css; charset=utf-8'}
root = os.path.join(os.path.dirname(__file__), '..', 'public')
rows = [{'path': '/' + f, 'content_type': T.get(f.rsplit('.', 1)[-1], 'text/plain'), 'body': open(os.path.join(root, f)).read()} for f in os.listdir(root)]
r = urllib.request.Request(URL + '/rest/v1/site_files?on_conflict=path', data=json.dumps(rows).encode(), method='POST',
    headers={'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'x-crm-key': CK, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal'})
urllib.request.urlopen(r).read(); print('published', [x['path'] for x in rows])
