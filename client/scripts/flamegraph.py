"""Lab 7: draws a flame graph (PNG) from a Chrome .cpuprofile — the picture for the README.

Each box is a function; its width is the CPU time spent in it AND everything it called; boxes
stacked on top are its callees. (idle) and (program) are left out: only our JavaScript.

    python3 client/scripts/flamegraph.py docs/perf/before.cpuprofile docs/img/lab07-flame-before.png
"""
import json, sys
from collections import defaultdict
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

src, out = sys.argv[1], sys.argv[2]
title = sys.argv[3] if len(sys.argv) > 3 else src
p = json.load(open(src))
nodes = {n["id"]: n for n in p["nodes"]}
parent = {}
for n in p["nodes"]:
    for c in n.get("children", []):
        parent[c] = n["id"]
self_time = defaultdict(float)
for sid, dt in zip(p["samples"], p["timeDeltas"]):
    self_time[sid] += dt

def name(n):
    cf = n["callFrame"]
    return cf["functionName"] or "(anonymous)"

SKIP = {"(idle)", "(program)", "(garbage collector)", "(root)"}
# total time per node = self + children
total = {}
def tot(i):
    if i in total: return total[i]
    n = nodes[i]
    t = self_time[i] + sum(tot(c) for c in n.get("children", []))
    total[i] = t
    return t
root = p["nodes"][0]["id"]
tot(root)
top = [c for c in nodes[root].get("children", []) if name(nodes[c]) not in SKIP]
width_all = sum(total[c] for c in top) or 1

fig, ax = plt.subplots(figsize=(16, 7), dpi=110)
palette = ["#f4a259", "#f6bd60", "#e76f51", "#f28482", "#e9c46a", "#f5cac3", "#ffb4a2"]
maxdepth = [0]
def draw(i, x, depth):
    w = total[i] / width_all
    if w < 0.001: return
    n = nodes[i]
    label = name(n)
    color = "#9ecae1" if n["callFrame"]["url"] == "" else palette[hash(label) % len(palette)]
    ax.add_patch(plt.Rectangle((x, depth), w, 0.95, facecolor=color, edgecolor="white", linewidth=0.4))
    if w > 0.035:
        ax.text(x + 0.002, depth + 0.45, f"{label} {100 * w:.0f}%", fontsize=7, va="center", clip_on=True)
    maxdepth[0] = max(maxdepth[0], depth)
    cx = x
    for c in sorted(n.get("children", []), key=lambda c: -total[c]):
        draw(c, cx, depth + 1)
        cx += total[c] / width_all
x = 0
for c in sorted(top, key=lambda c: -total[c]):
    draw(c, x, 0)
    x += total[c] / width_all
ax.set_xlim(0, 1)
ax.set_ylim(0, min(maxdepth[0] + 1, 28))
ax.set_yticks([])
ax.set_xticks([])
busy = width_all / 1000
ax.set_title(f"{title} — main-thread JavaScript, {busy:.0f} ms over 30 s (blue = browser API)", fontsize=11)
for s in ax.spines.values(): s.set_visible(False)
plt.tight_layout()
plt.savefig(out)
print(out)
