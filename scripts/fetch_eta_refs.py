#!/usr/bin/env python3
"""Fetch publicly downloadable official ETA eInvoicing examples; no auth, no secrets."""
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.parse import quote
import hashlib, json

BASE = 'https://sdk.invoicing.eta.gov.eg/files/'
FILES = {
    'Egyptian eInvoicing SDK.postman_collection.json': 'eta-postman-collection.json',
    'one-doc.json': 'eta-unsigned-legacy-v0.9.json',
    'one-doc-I.json': 'eta-signed-legacy-v0.9.json',
    'one-doc-serialized.json.txt': 'eta-canonical-legacy-v0.9.txt',
}
OUT = Path(__file__).resolve().parent.parent / 'docs' / 'e-invoicing' / 'official-public'
OUT.mkdir(parents=True, exist_ok=True)
manifest = []
for src, dest in FILES.items():
    url = BASE + quote(src)
    print('Downloading', url)
    with urlopen(Request(url, headers={'User-Agent':'ETA-Integration-Reference-Fetch/1.0'}), timeout=40) as f:
        body = f.read()
    if src.endswith('.json'):
        json.loads(body.decode('utf-8-sig'))
    (OUT / dest).write_bytes(body)
    manifest.append({'filename': dest, 'source_url': url, 'sha256': hashlib.sha256(body).hexdigest()})
(OUT / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
print('Saved', len(manifest), 'official files to', OUT)
