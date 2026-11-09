import re, sys, time, json, urllib.request, base64
H="https://coloradostickerart.highrisehq.com"; OUT=sys.argv[1]
auth="Basic "+base64.b64encode(b"x:x").decode()
def get(p):
    for a in range(6):
        try:
            with urllib.request.urlopen(urllib.request.Request(H+p,headers={"Authorization":auth}),timeout=60) as r: return r.read().decode()
        except urllib.error.HTTPError as e:
            if e.code in (429,503): time.sleep(10); continue
            raise
        except Exception: time.sleep(5)
t=open(OUT+"/tags.xml").read()
tags=re.findall(r'<id type="integer">(\d+)</id>\s*<name>([^<]*)</name>',t)
res={}
for tid,name in tags:
    x=get(f"/tags/{tid}.xml")
    ids=[re.search(r'</group-id>\s*<id type="integer">(\d+)</id>',chunk).group(1)+":"+chunk.split('"')[1] for chunk in x.split('<party type=')[1:]]
    res[name]=ids; print(name,len(ids),flush=True); time.sleep(0.2)
json.dump(res,open(OUT+"/tag-parties.json","w"),indent=1)
