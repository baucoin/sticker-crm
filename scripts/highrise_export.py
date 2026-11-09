"""Export everything from Highrise to raw XML files (companies, people, tasks, recordings, deals, tags, users, case files)."""
import os, sys, time, urllib.request, base64, re
H = "https://coloradostickerart.highrisehq.com"
OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
auth = "Basic " + base64.b64encode(b"x:x").decode()
def get(path):
    for attempt in range(6):
        try:
            req = urllib.request.Request(H + path, headers={"Authorization": auth, "User-Agent": "sticker-crm-export"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read().decode()
        except urllib.error.HTTPError as e:
            if e.code in (429, 503):
                time.sleep(int(e.headers.get("Retry-After", 10))); continue
            if e.code == 404: return ""
            raise
        except Exception:
            time.sleep(5)
    raise RuntimeError(path)
def save(name, txt):
    open(os.path.join(OUT, name), "w").write(txt)
def paged(path, tag, step, name):
    off, n = 0, 0
    while True:
        sep = "&" if "?" in path else "?"
        txt = get(f"{path}{sep}n={off}")
        c = txt.count(f"<{tag}>") + txt.count(f"<{tag} ")
        save(f"{name}-{off:06d}.xml", txt)
        n += c
        print(name, off, c, flush=True)
        if c < step: break
        off += step
        time.sleep(0.25)
    return n
paged("/companies.xml", "company", 500, "companies")
paged("/people.xml", "person", 500, "people")
for p, nm in [("/tasks/all.xml", "tasks-all"), ("/tasks/completed.xml", "tasks-completed"), ("/deals.xml", "deals"),
              ("/tags.xml", "tags"), ("/users.xml", "users"), ("/kases/open.xml", "kases-open"), ("/kases/closed.xml", "kases-closed"),
              ("/task_categories.xml", "task-categories"), ("/deal_categories.xml", "deal-categories"), ("/subject_fields.xml","subject-fields")]:
    save(nm + ".xml", get(p)); print(nm, flush=True)
# all recordings (notes, emails, comments) since the account began; 25 per page via since= cursor on updated-at
since = "20141201000000"
page = 0
seen = set()
while True:
    txt = get(f"/recordings.xml?since={since}")
    ids = re.findall(r"<recording[^>]*>\s*<id type=\"integer\">(\d+)</id>", txt) or re.findall(r"<id type=\"integer\">(\d+)</id>\s*<author-id", txt)
    save(f"recordings-{page:05d}.xml", txt)
    ups = re.findall(r"<updated-at type=\"datetime\">([^<]+)</updated-at>", txt)
    print("recordings", page, since, len(ups), flush=True)
    if len(ups) == 0: break
    last = max(ups)
    nxt = re.sub(r"[-:TZ]", "", last)
    if nxt == since: nxt = str(int(nxt) + 1)
    if len(ups) < 25 and nxt <= since: break
    if len(ups) < 25:
        # one more call to be safe, then stop
        since = nxt; page += 1
        txt2 = get(f"/recordings.xml?since={since}")
        if txt2.count("<updated-at") == 0: break
        save(f"recordings-{page:05d}.xml", txt2); break
    since = nxt; page += 1
    time.sleep(0.25)
print("DONE", flush=True)
