"""Lab 7: the load-test chart for the README (docs/perf/load.json -> docs/img/lab07-load.png)."""
import json
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

rows = json.load(open("docs/perf/load.json"))
n = [r["n"] for r in rows]
fig, ax = plt.subplots(figsize=(9, 4.8), dpi=110)
ax.plot(n, [r["tickP99"] for r in rows], "o-", color="#d1495b", label="tick p99, ms")
ax.plot(n, [r["tickP50"] for r in rows], "o--", color="#edae49", label="tick p50, ms")
ax.plot(n, [r["tickMax"] for r in rows], ".:", color="#8d99ae", label="tick max, ms")
ax.axhline(33.3, color="#d1495b", linewidth=1, alpha=0.6)
ax.text(n[-1], 34.3, "бюджет тіку 33,3 мс (30 Гц)", color="#d1495b", fontsize=9, ha="right")
ax.set_xlabel("гравців в одному матчі (headless WebSocket-клієнти)")
ax.set_ylabel("час тіку, мс")
ax.set_ylim(0, 40)
ax2 = ax.twinx()
ax2.bar(n, [r["outMBs"] for r in rows], width=9, alpha=0.25, color="#00798c", label="сервер → клієнти, МБ/с")
ax2.set_ylabel("МБ/с від сервера (сумарно)")
for x, r in zip(n, rows):
    ax2.text(x, r["outMBs"] + 1, f'{r["outMBs"]:.0f}', ha="center", fontsize=8, color="#00798c")
lines = ax.get_legend_handles_labels()
bars = ax2.get_legend_handles_labels()
ax.legend(lines[0] + bars[0], lines[1] + bars[1], loc="upper left", bbox_to_anchor=(0, 0.88), fontsize=9)
ax.set_zorder(ax2.get_zorder() + 1)
ax.patch.set_visible(False)
ax.set_title("Навантаження одного матчу: CPU не впирається, трафік росте як n²")
plt.tight_layout()
plt.savefig("docs/img/lab07-load.png")
