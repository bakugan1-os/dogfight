# Draws docs/img/lab04-rss.png from the CSV that measure-backpressure.js prints.
#   python3 scripts/plot-rss.py ../docs/data/lab04-rss.csv ../docs/img/lab04-rss.png
import csv, sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
rows = list(csv.DictReader(open(sys.argv[1])))
series = {"stream": [], "naive": []}
for r in rows:
    series[r["mode"]].append((float(r["seconds"]), float(r["rss_mb"])))
BLUE, ORANGE = "#2a78d6", "#eb6834"
INK, INK2, GRID, SURF = "#0b0b0b", "#52514e", "#e6e5e0", "#fcfcfb"
plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 11})
fig, ax = plt.subplots(figsize=(9, 4.6), dpi=150)
fig.patch.set_facecolor(SURF); ax.set_facecolor(SURF)
labels = {"stream": "pipeline(createReadStream, res) — стрім", "naive": "readFile + res.end(buffer) — усе в пам'ять"}
for key, color in (("naive", ORANGE), ("stream", BLUE)):
    xs, ys = zip(*series[key])
    ax.plot(xs, ys, color=color, lw=2, solid_capstyle="round", label=labels[key])
    ax.annotate(f"пік {max(ys):.0f} MB", xy=(xs[ys.index(max(ys))], max(ys)), xytext=(6, 6),
                textcoords="offset points", color=INK2, fontsize=10)
ax.set_xlabel("секунди від початку завантаження (200 MB, 4 MB/с)", color=INK2)
ax.set_ylabel("rss сервера, MB", color=INK2)
ax.set_ylim(0, 320); ax.set_xlim(0, None)
ax.grid(axis="y", color=GRID, lw=1); ax.set_axisbelow(True)
for s in ("top", "right"): ax.spines[s].set_visible(False)
for s in ("left", "bottom"): ax.spines[s].set_color(GRID)
ax.tick_params(colors=INK2)
ax.set_title("Пам'ять сервера під час повільного завантаження реплею", color=INK, loc="left", fontsize=13, pad=12)
ax.legend(frameon=False, loc="center right", bbox_to_anchor=(1, 0.62), labelcolor=INK)
fig.tight_layout()
fig.savefig(sys.argv[2], facecolor=SURF)
