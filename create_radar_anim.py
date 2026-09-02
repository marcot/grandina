#!/usr/bin/env python3
"""
Generate animated GIF of Italian Civil Protection radar data.
Downloads POH, VIL, ETM, VMI GeoTIFFs, converts to images,
creates side-by-side comparison with hail risk assessment.
"""

import io
import json
import urllib.request
import numpy as np
from pathlib import Path
from datetime import datetime

from PIL import Image

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.colors as mcolors

import imageio
import rasterio
from pyproj import Transformer

# ============================================================
# Configuration
# ============================================================
OUTPUT_DIR = Path("radar_animations")
OUTPUT_DIR.mkdir(exist_ok=True)

RADAR_API = "https://radar-api.protezionecivile.it"
ORIGIN = "https://radar.protezionecivile.it"

PRODUCTS = ["POH", "VIL", "ETM", "VMI"]
PRODUCT_LABELS = {
    "POH": "Probability of Hail (POH)",
    "VIL": "Vertically Integrated Liquid (VIL)",
    "ETM": "Echo Top Map (ETM)",
    "VMI": "Vertical Max Intensity (VMI)",
}

PRODUCT_CONFIG = {
    "POH":  {"cmap": "Purples",    "vmin": 0,  "vmax": 1.0,  "unit": "",
             "high": 0.6, "extreme": 0.8},
    "VIL":  {"cmap": "YlOrRd",    "vmin": 0,  "vmax": 100,  "unit": "kg/m²",
             "high": 40,  "extreme": 50},
    "ETM":  {"cmap": "RdYlBu_r",  "vmin": 0,  "vmax": 15,   "unit": "km",
             "high": 10,  "extreme": 12,
             "convert": lambda x: x / 1000.0},  # Raw data is in meters
    "VMI":  {"cmap": "YlOrBr",    "vmin": 0,  "vmax": 70,   "unit": "dBZ",
             "high": 50,  "extreme": 55,
             "min_detect": 10},  # Radar detection threshold ~10 dBZ
}

# Italian cities to mark on the map
CITIES = [
    ("Milano", 9.19, 45.46),
    ("Roma", 12.49, 41.89),
    ("Torino", 7.68, 45.07),
    ("Napoli", 14.25, 40.85),
    ("Firenze", 11.25, 43.77),
    ("Bologna", 11.34, 44.49),
    ("Venezia", 12.32, 45.44),
    ("Genova", 8.94, 44.41),
    ("Bari", 16.87, 41.12),
    ("Palermo", 13.36, 38.11),
]

# ============================================================
# Download functions
# ============================================================

def download_product(product_type):
    url = f"{RADAR_API}/findLastProductByType?type={product_type}"
    req = urllib.request.Request(url, headers={"Origin": ORIGIN})
    with urllib.request.urlopen(req) as resp:
        info = json.loads(resp.read())["lastProducts"][0]
    
    dl_url = f"{RADAR_API}/downloadProduct"
    payload = json.dumps({
        "productType": info["productType"],
        "productDate": info["time"]
    }).encode()
    req = urllib.request.Request(dl_url, data=payload, headers={
        "Content-Type": "application/json",
        "origin": ORIGIN
    })
    with urllib.request.urlopen(req) as resp:
        dl_info = json.loads(resp.read())
    
    req = urllib.request.Request(dl_info["url"])
    with urllib.request.urlopen(req) as resp:
        return resp.read(), info["time"]

def get_risk_label(product_type, value, config):
    if value >= config["extreme"]:
        return "EXTREME"
    elif value >= config["high"]:
        return "HIGH"
    elif value > config["high"] * 0.5:
        return "MEDIUM"
    elif value > 0:
        return "LOW"
    return "NONE"

def risk_color(risk):
    return {
        "NONE": "#4CAF50", "LOW": "#FFC107", "MEDIUM": "#FF9800",
        "HIGH": "#F44336", "EXTREME": "#9C27B0"
    }.get(risk, "#888888")

# ============================================================
# Visualization
# ============================================================

def create_radar_image(product_type, data, timestamp_ms, crs):
    """Create matplotlib visualization of radar data"""
    config = PRODUCT_CONFIG[product_type]
    
    # Create figure
    fig, ax = plt.subplots(figsize=(14, 10), dpi=120)
    fig.patch.set_facecolor('#0d0d1a')
    ax.set_facecolor('#0d0d1a')
    
    # Convert -9999 nodata to NaN
    display_data = np.where(data > -5000, data, np.nan)
    
    # Plot
    im = ax.imshow(
        display_data,
        extent=[0, data.shape[1], 0, data.shape[0]],
        origin="lower",
        cmap=config["cmap"],
        vmin=config["vmin"],
        vmax=config["vmax"],
        alpha=0.9,
        interpolation="gaussian",
    )
    
    # Stats
    clean_data = display_data[~np.isnan(display_data)]
    data_max = np.nanmax(display_data) if len(clean_data) > 0 else 0
    
    # Risk assessment
    risk = get_risk_label(product_type, data_max, config)
    color = risk_color(risk)
    
    # Title
    plt.title(
        PRODUCT_LABELS[product_type],
        fontsize=18, fontweight="bold",
        color="white", pad=20
    )
    
    # Risk box
    time_str = datetime.fromtimestamp(timestamp_ms / 1000).strftime("%Y-%m-%d %H:%M UTC")
    risk_text = f"GRANDINE: {risk}\n{product_type} = {data_max:.3f}{config['unit']}\n{time_str}"
    bbox = dict(
        boxstyle="round,pad=0.5",
        facecolor=color,
        edgecolor="white",
        alpha=0.8,
        linewidth=2
    )
    ax.text(
        0.02, 0.98,
        risk_text,
        transform=ax.transAxes,
        fontsize=13,
        va="top",
        color="white",
        fontweight="bold",
        bbox=bbox
    )
    
    # Add city markers
    tr = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
    for name, lon, lat in CITIES:
        x_p, y_p = tr.transform(lon, lat)
        pcol = int((x_p - (-600000)) / 1000)
        prow = int((650000 - y_p) / 1000)
        
        if 0 <= prow < data.shape[0] and 0 <= pcol < data.shape[1]:
            marker_color = "yellow" if name == "Milano" else "white"
            marker_size = 150 if name == "Milano" else 50
            ax.plot(pcol, prow, 'o', color=marker_color, markersize=marker_size,
                   markeredgecolor='black', markeredgewidth=1, alpha=0.7)
            ax.text(pcol + 3, prow + 3, name, fontsize=8,
                   color="yellow" if name == "Milano" else "white",
                   fontweight="bold" if name == "Milano" else None, alpha=0.8)
    
    # Colorbar
    cbar = plt.colorbar(im, ax=ax, pad=0.02, shrink=0.8)
    cbar.set_label(
        f"{product_type} ({config['unit']})",
        fontsize=13, color="white", weight="bold"
    )
    cbar.ax.yaxis.set_tick_params(color="white")
    plt.setp(plt.getp(cbar.ax.axes, 'yticklabels'), color="white")
    
    # Grid lines
    ax.set_xticks(range(0, data.shape[1], 200))
    ax.set_yticks(range(0, data.shape[0], 200))
    ax.grid(True, alpha=0.15, color="white")
    ax.tick_params(colors="white", length=0)
    
    # Footer
    plt.figtext(
        0.5, 0.01,
        "Sorgente: Radar-DPC Protezione Civile Italia | Copertura: 5E-20E, 35N-48N | Risoluzione: 1km",
        ha="center", fontsize=11, color="#888",
        bbox=dict(facecolor="black", alpha=0.5, boxstyle="round,pad=0.3")
    )
    
    plt.tight_layout(rect=[0, 0.03, 1, 0.97])
    
    # Save to buffer
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=120, bbox_inches="tight", facecolor='#0d0d1a')
    plt.close(fig)
    buf.seek(0)
    return buf

# ============================================================
# Main
# ============================================================

def main():
    print("Downloading Italian Civil Protection radar data...\n")
    
    product_data = {}
    for product in PRODUCTS:
        try:
            print(f"  -> {product}...")
            tiff_bytes, ts = download_product(product)
            print(f"    Size: {len(tiff_bytes) / 1024:.0f} KB")
            product_data[product] = (tiff_bytes, ts)
        except Exception as e:
            print(f"    Error: {e}")
    
    if not product_data:
        print("No data available.")
        return
    
    print(f"\nGenerating {len(product_data)} radar visualizations...\n")
    
    pil_images = []
    
    for product, (tiff_bytes, ts) in product_data.items():
        print(f"  -> Processing {product}...")
        
        buf = io.BytesIO(tiff_bytes)
        with rasterio.open(buf) as src:
            data = src.read(1).astype(np.float64)
            crs = src.crs
        
        # Convert data if needed (e.g., ETM from meters to km)
        config = PRODUCT_CONFIG[product]
        display_data = data.copy()
        if "convert" in config:
            display_data = config["convert"](display_data)
        
        # Create visualization with converted data
        img_buf = create_radar_image(product, display_data, ts, crs)
        img = Image.open(img_buf).convert("RGB")
        img = img.resize((900, 640), Image.LANCZOS)
        pil_images.append(img)
        
        # Save individual PNG
        png_path = OUTPUT_DIR / f"{product}_radar.png"
        img.save(str(png_path))
        print(f"    Saved: {png_path}")
        
        # Stats
        clean = display_data[display_data > -5000]
        max_val = np.nanmax(display_data) if len(clean) > 0 else 0
        risk = get_risk_label(product, max_val, config)
        print(f"    Data: {len(clean)} active pixels, max={max_val:.3f} {config['unit']}, risk={risk}")

    
    # Create animated GIF
    print(f"\nCreating animated GIF ({len(pil_images)} frames)...")
    output_gif = OUTPUT_DIR / "radar_hail_prediction.gif"
    
    imageio.mimsave(
        str(output_gif),
        pil_images,
        "GIF",
        duration=4.0,
        loop=0
    )
    
    print(f"\nGIF saved: {output_gif}")
    print(f"   Size: {output_gif.stat().st_size / 1024:.0f} KB")
    print(f"   Frames: {len(pil_images)}")

if __name__ == "__main__":
    main()