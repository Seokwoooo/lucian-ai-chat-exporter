"""Meaning-level retention for the compression lab (BAAI/bge-m3, local).

    python semeval.py <export-dir> <outputs-dir> <result.json> [ratios=0] [max_probes=400]

Lexical metrics miss paraphrases (LLMLingua-2 output, abstractive summaries). Here every sampled
source sentence is embedded and compared with every line of an output; a sentence counts as
kept when some output line has cosine similarity ≥ 0.80 with it. Embeddings are cached by text.
"""
import hashlib
import json
import os
import re
import sys
from collections import defaultdict

import numpy as np
import torch
from sentence_transformers import SentenceTransformer

export_dir, outputs_dir, result_path = sys.argv[1], sys.argv[2], sys.argv[3]
ratios = set((sys.argv[4] if len(sys.argv) > 4 else "0").split(","))
max_probes = int(sys.argv[5]) if len(sys.argv) > 5 else 400
THRESH = (0.7, 0.8, 0.9)

device = "mps" if torch.backends.mps.is_available() else "cpu"
model = SentenceTransformer("BAAI/bge-m3", device=device)
model.max_seq_length = 256
cache: dict[str, np.ndarray] = {}


def embed(texts):
    need = [t for t in dict.fromkeys(texts) if hashlib.sha1(t.encode()).hexdigest() not in cache]
    if need:
        vec = model.encode(need, batch_size=64, normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=False).astype(np.float32)
        for t, v in zip(need, vec):
            cache[hashlib.sha1(t.encode()).hexdigest()] = v
    return np.stack([cache[hashlib.sha1(t.encode()).hexdigest()] for t in texts]) if texts else np.zeros((0, 1024), np.float32)


REF = re.compile(r"\s*\[#m\d+\]\s*")


def lines_of(md: str):
    out = []
    in_code = False
    for line in md.split("\n"):
        if line.strip().startswith("```"):
            in_code = not in_code
            continue
        if in_code:
            continue
        t = REF.sub(" ", line).strip().lstrip("-*>|# ").strip()
        if len(t) >= 15:
            out.append(t[:600])
    return list(dict.fromkeys(out))


index = json.load(open(os.path.join(outputs_dir, "index.json")))
meta = {m["ci"]: m for m in json.load(open(os.path.join(export_dir, "meta.json")))}
probes = {}
for ci in meta:
    units = [json.loads(l) for l in open(os.path.join(export_dir, f"units-c{ci}.jsonl"), encoding="utf-8")]
    cand = [u["text"][:600] for u in units if u["kind"] in ("sentence", "item", "quote") and len(u["text"]) >= 40]
    if len(cand) > max_probes:
        step = len(cand) / max_probes
        cand = [cand[int(i * step)] for i in range(max_probes)]
    probes[ci] = embed(cand)
    print(f"c{ci}: {len(cand)} probes", flush=True)

rows = []
for entry in index:
    if str(entry["ratio"]) not in ratios:
        continue
    md = open(os.path.join(outputs_dir, entry["file"]), encoding="utf-8").read()
    lines = lines_of(md)
    P = probes[entry["ci"]]
    if not len(P):
        continue
    O = embed(lines)
    best = (P @ O.T).max(axis=1) if len(O) else np.zeros(len(P))
    rows.append({**entry, **{f"sem@{t}": float((best >= t).mean()) for t in THRESH}, "semMean": float(best.mean())})

agg = defaultdict(lambda: defaultdict(list))
for r in rows:
    for key in [f"sem@{t}" for t in THRESH] + ["semMean"]:
        agg[(r["ratio"], r["algo"])][key].append(r[key])
summary = [{"ratio": ratio, "algo": algo, **{k: float(np.mean(v)) for k, v in d.items()}, "n": len(d["semMean"])} for (ratio, algo), d in agg.items()]
summary.sort(key=lambda x: (x["ratio"], -x["sem@0.8"]))
json.dump({"device": device, "summary": summary, "rows": rows}, open(result_path, "w"), indent=1)
for s in summary:
    print(f"{s['ratio']:>5} {s['algo']:<24} sem@0.7 {s['sem@0.7']*100:5.1f}  sem@0.8 {s['sem@0.8']*100:5.1f}  sem@0.9 {s['sem@0.9']*100:5.1f}  mean {s['semMean']:.3f}  n={s['n']}")
