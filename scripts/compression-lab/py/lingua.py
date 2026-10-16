"""LLMLingua-2 outputs for the compression lab (token-level pruning, local model).

    python lingua.py <export-dir> <ext-dir> [ratios=0,0.3,0.5]

Compresses each conversation's full transcript (full-c{N}.md) to the lab's token budget for each
level and writes <ext-dir>/llmlingua2/c{N}_{ratio}.md. Each message is compressed separately so
the message headers stay intact.
"""
import json
import os
import re
import sys
import time

import torch
from llmlingua import PromptCompressor

export_dir, ext_dir = sys.argv[1], sys.argv[2]
ratios = [float(r) for r in (sys.argv[3] if len(sys.argv) > 3 else "0,0.3,0.5").split(",")]
out_dir = os.path.join(ext_dir, "llmlingua2")
os.makedirs(out_dir, exist_ok=True)
device = "mps" if torch.backends.mps.is_available() else "cpu"
comp = PromptCompressor(model_name="microsoft/llmlingua-2-xlm-roberta-large-meetingbank", use_llmlingua2=True, device_map=device)

HEADER = re.compile(r"^(### \[#m\d+\] (?:User|AI))$", re.M)
meta = json.load(open(os.path.join(export_dir, "meta.json")))
timing = []
for m in meta:
    ci = m["ci"]
    full = open(os.path.join(export_dir, f"full-c{ci}.md"), encoding="utf-8").read()
    parts = HEADER.split(full)
    # parts: ['', header1, body1, header2, body2, ...]
    msgs = [(parts[i], parts[i + 1].strip()) for i in range(1, len(parts) - 1, 2)]
    for ratio in ratios:
        key = "0" if ratio == 0 else ("%g" % ratio)
        target = m["budgets"][key]
        rate = max(0.02, min(1.0, target / max(1, m["fullTokens"])))
        t0 = time.time()
        out = []
        for header, body in msgs:
            if not body:
                continue
            if rate >= 0.999:
                out.append(f"{header}\n{body}")
                continue
            r = comp.compress_prompt(body, rate=rate, force_tokens=["\n", "?", "."], drop_consecutive=True)
            out.append(f"{header}\n{r['compressed_prompt']}")
        open(os.path.join(out_dir, f"c{ci}_{key}.md"), "w", encoding="utf-8").write("\n\n".join(out))
        timing.append({"ci": ci, "ratio": ratio, "seconds": round(time.time() - t0, 1), "sourceTokens": m["sourceTokens"]})
        print(f"c{ci} ratio {key}: rate {rate:.3f} in {time.time() - t0:.1f}s", flush=True)
json.dump({"device": device, "runs": timing}, open(os.path.join(out_dir, "timing.json"), "w"), indent=1)
