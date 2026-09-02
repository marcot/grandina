#!/usr/bin/env python3
"""Dev-time only: write src/web/colormaps.json (256-step RGB LUTs) from matplotlib.

Runtime never invokes python; the generated JSON is committed.
Usage: python3 scripts/gen-colormaps.py
"""
import json
from pathlib import Path

import matplotlib.cm as cm
import numpy as np

PRODUCTS = {
    "POH": "Purples",
    "VIL": "YlOrRd",
    "ETM": "RdYlBu_r",
    "VMI": "YlOrBr",
}

out = {}
for key, name in PRODUCTS.items():
    cmap = cm.get_cmap(name).resampled(256)
    lut = (np.array([cmap(i) for i in range(256)])[:, :3] * 255).astype(int)
    out[key] = [tuple(int(c) for c in row) for row in lut]

path = Path(__file__).resolve().parent.parent / "src" / "web" / "colormaps.json"
path.write_text(json.dumps(out))
print(f"wrote {path} ({sum(len(v) for v in out.values())} lut entries)")
