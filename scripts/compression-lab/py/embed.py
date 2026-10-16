"""Unit embeddings for the compression lab (EmbeddingGemma 2, text only, local).

    python embed.py <export-dir> <ext-dir> [dim=256] [k=20]

Reads units-c{N}.jsonl written by `LAB_EXPORT=<export-dir> npm run lab:file …` and writes, per
conversation, L2-normalized vectors and the k nearest neighbors (cosine) to <ext-dir>/emb/.
"""
import json
import os
import sys
import time

import numpy as np
import torch
from sentence_transformers import SentenceTransformer

export_dir, ext_dir = sys.argv[1], sys.argv[2]
dim = int(sys.argv[3]) if len(sys.argv) > 3 else 256
k = int(sys.argv[4]) if len(sys.argv) > 4 else 20
os.makedirs(os.path.join(ext_dir, "emb"), exist_ok=True)

device = "mps" if torch.backends.mps.is_available() else "cpu"
model = SentenceTransformer(
    "google/embeddinggemma-2",
    device=device,
    config_kwargs={"vision_config": None, "audio_config": None},
)
model.max_seq_length = 512  # units are sentences, items, short code blocks or tables

meta = json.load(open(os.path.join(export_dir, "meta.json")))
stats = []
for m in meta:
    ci = m["ci"]
    units = [json.loads(line) for line in open(os.path.join(export_dir, f"units-c{ci}.jsonl"), encoding="utf-8")]
    texts = [u["text"][:2000] or " " for u in units]
    t0 = time.time()
    vec = model.encode(
        texts,
        prompt_name="SentenceSimilarity",
        batch_size=64,
        truncate_dim=dim,
        normalize_embeddings=True,
        convert_to_numpy=True,
        show_progress_bar=False,
    ).astype(np.float32)
    secs = time.time() - t0
    n = len(units)
    idx = np.full((n, k), -1, dtype=np.int32)
    sim = np.zeros((n, k), dtype=np.float32)
    for s in range(0, n, 2048):
        block = vec[s : s + 2048] @ vec.T
        for r in range(block.shape[0]):
            block[r, s + r] = -1.0  # not its own neighbor
        kk = min(k, n - 1)
        if kk <= 0:
            continue
        part = np.argpartition(-block, kk - 1, axis=1)[:, :kk]
        rows = np.arange(block.shape[0])[:, None]
        order = np.argsort(-block[rows, part], axis=1)
        top = part[rows, order]
        idx[s : s + block.shape[0], :kk] = top
        sim[s : s + block.shape[0], :kk] = block[rows, top]
    base = os.path.join(ext_dir, "emb", f"c{ci}")
    vec.tofile(base + ".vec.f32")
    idx.tofile(base + ".knn.i32")
    sim.tofile(base + ".knn.f32")
    json.dump({"dim": dim, "k": k, "units": n}, open(base + ".json", "w"))
    stats.append({"ci": ci, "units": n, "seconds": round(secs, 2), "unitsPerSecond": round(n / max(secs, 1e-6), 1)})
    print(f"c{ci}: {n} units in {secs:.1f}s", flush=True)

json.dump({"device": device, "dim": dim, "k": k, "conversations": stats}, open(os.path.join(ext_dir, "emb", "stats.json"), "w"), indent=1)
total_units = sum(s["units"] for s in stats)
total_secs = sum(s["seconds"] for s in stats)
print(f"total {total_units} units in {total_secs:.0f}s ({total_units / max(total_secs, 1e-6):.0f} units/s on {device})")
