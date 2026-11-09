"""Per-party export of notes and emails (the account-wide recordings feed skips some). Writes notes-<type>-<id>.xml files."""
import os, re, sys, time, glob, urllib.request, base64
H="https://coloradostickerart.highrisehq.com"; OUT=sys.argv[1]; D=os.path.join(OUT,'party'); os.makedirs(D,exist_ok=True)
auth="Basic "+base64.b64encode(b"x:x").decode()
def get(p):
    for a in range(8):
        try:
            with urllib.request.urlopen(urllib.request.Request(H+p,headers={"Authorization":auth}),timeout=60) as r: return r.read().decode()
        except urllib.error.HTTPError as e:
            if e.code in (429,503): time.sleep(int(e.headers.get("Retry-After",10))); continue
            if e.code==404: return ""
            raise
        except Exception: time.sleep(5)
    raise RuntimeError(p)
parties=[]
for f in glob.glob(OUT+'/companies-*.xml'): parties+=[('companies',i) for i in re.findall(r'<company>\s*<author-id[^>]*>\d*</author-id>.*?</group-id>\s*<id type="integer">(\d+)',open(f).read(),re.S)]
for f in glob.glob(OUT+'/people-*.xml'): parties+=[('people',i) for i in re.findall(r'<person>.*?</group-id>\s*<id type="integer">(\d+)',open(f).read(),re.S)]
print('parties',len(parties),flush=True)
for k,(typ,pid) in enumerate(parties):
    for kind,tag in (('notes','note'),('emails','email')):
        fn=f"{D}/{kind}-{typ}-{pid}.xml"
        if os.path.exists(fn): continue
        chunks=[]; off=0
        while True:
            x=get(f"/{typ}/{pid}/{kind}.xml?n={off}"); chunks.append(x)
            if x.count(f"<{tag}>")<25: break
            off+=25
        open(fn,'w').write("\n".join(chunks))
    if k%50==0: print(k,flush=True)
print('DONE',flush=True)
