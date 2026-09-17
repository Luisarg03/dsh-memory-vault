#!/usr/bin/env python3
"""Generate docs/diagrams/memory-loop.html — a Loop diagram (diagram-design).

Loop type: work advances clockwise around a ring while each pass writes durable
state back to one shared hub. Here the hub is the vault and the ring is one
session. Geometry follows references/type-loop.md §2 exactly; tokens come from
the project profile (~/.diagram-design/profiles/dsh-memory-vault.md), which
extracts the palette of the four archify diagrams already in docs/diagrams/.

Run: python3 docs/diagrams/make-loop.py
"""
from __future__ import annotations

import math
from pathlib import Path

OUT = Path(__file__).resolve().parent / "memory-loop.html"

# ── tokens (profile: dsh-memory-vault, light column) ────────────────────────
PAPER, PAPER2 = "#f8fafc", "#ffffff"
INK, MUTED, SOFT = "#0f172a", "#64748b", "#94a3b8"
RULE, RULE_SOLID = "rgba(15,23,42,0.12)", "#cbd5e1"
ACCENT, ACCENT_TINT = "#ea580c", "rgba(234,88,12,0.08)"

SANS = "'Geist', ui-sans-serif, system-ui, sans-serif"
MONO = "'Geist Mono', ui-monospace, SFMono-Regular, monospace"
SERIF = "'Instrument Serif', Georgia, serif"

# ── geometry (type-loop §1/§2) ──────────────────────────────────────────────
CX, CY, R = 520.0, 340.0, 240.0
SW, SH = 160.0, 64.0
HW, HH = 200.0, 104.0
MARKER_OVERHANG, MARKER_GAP = 1.2, 6.0
VIEW_W, VIEW_H = 1040, 740
LEGEND_Y = 620

STATIONS = [
    dict(name="Recall", sub="the agent asks what is already known"),
    dict(name="Work", sub="decisions, facts and lessons happen"),
    dict(name="Capture", sub="checkpoints fire on commit, compaction, idle", focal=True),
    dict(name="Digest", sub="entries extracted in-process via ctx.llm", spoke="ENTRIES"),
    dict(name="Commit", sub="the vault is a git repo: every pass leaves one", spoke=True),
]
HUB = dict(name="Vault", sub="Markdown source · FTS5 index")
TITLE = "The memory loop"
SUBTITLE = "One session per lap: recall what is known, work, and write the durable state back."
EYEBROW = "DSH · MEMORY STACK"


def r4(value: float) -> float:
    return float(round(value / 4) * 4)


def box_distance(dx: float, dy: float, half_w: float, half_h: float) -> float:
    terms = [t for t in (half_w / abs(dx) if dx else None, half_h / abs(dy) if dy else None) if t]
    return min(terms)


def inside(x: float, y: float, rect: tuple[float, float]) -> bool:
    rx, ry = rect
    return rx <= x <= rx + SW and ry <= y <= ry + SH


def circle_point(phi: float) -> tuple[float, float]:
    return CX + R * math.cos(phi), CY + R * math.sin(phi)


def crossing(rect: tuple[float, float], phi0: float, step: float) -> float:
    """Bisect the angle at which the ring leaves/enters `rect`, walking `step`."""
    lo, hi = phi0, phi0 + step
    for _ in range(60):
        mid = (lo + hi) / 2
        x, y = circle_point(mid)
        if inside(x, y, rect) == inside(*circle_point(lo), rect):
            lo = mid
        else:
            hi = mid
    return hi


def wrap(text: str, width: int = 28, lines: int = 2) -> list[str]:
    words, out, current = text.split(), [], ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if len(candidate) <= width:
            current = candidate
        else:
            out.append(current)
            current = word
    out.append(current)
    if len(out) > lines:
        raise SystemExit(f"wrap: {text!r} needs {len(out)} lines")
    return out


def build() -> str:
    n = len(STATIONS)
    ideal = [(CX + R * math.cos(math.radians(-90 + k * 360 / n)),
              CY + R * math.sin(math.radians(-90 + k * 360 / n))) for k in range(n)]
    rects = [(r4(x - SW / 2), r4(y - SH / 2)) for x, y in ideal]
    # Mirror paired stations about the vertical axis so rounding stays symmetric.
    rects[4] = (r4(2 * CX - rects[1][0] - SW), rects[1][1])
    rects[3] = (r4(2 * CX - rects[2][0] - SW), rects[2][1])

    ring, spokes_hub, spokes_station, labels = [], [], [], []
    for k in range(n):
        phi = math.radians(-90 + k * 360 / n)
        # Ring arc: exit this box clockwise, land just short of the next box.
        exit_phi = crossing(rects[k], phi, math.radians(360 / n) / 2)
        entry_phi = crossing(rects[(k + 1) % n], phi + math.radians(360 / n), -math.radians(360 / n) / 2)
        end_phi = entry_phi - MARKER_OVERHANG / R
        x0, y0 = circle_point(exit_phi)
        x1, y1 = circle_point(end_phi)
        ring.append(f'<path d="M {x0:.1f} {y0:.1f} A {R:g} {R:g} 0 0 1 {x1:.1f} {y1:.1f}" '
                    f'fill="none" stroke="{MUTED}" stroke-width="1.2" marker-end="url(#arr-muted)"/>')
        # Write-back spoke: station inner edge to just outside the hub stroke.
        # type-loop §2.3: spoke_start = P_k − d_station·u_k (inward from the box).
        if STATIONS[k].get("spoke"):
            ux, uy = math.cos(phi), math.sin(phi)
            cx_k, cy_k = rects[k][0] + SW / 2, rects[k][1] + SH / 2
            d_station = box_distance(ux, uy, SW / 2, SH / 2)
            d_hub = box_distance(ux, uy, HW / 2, HH / 2)
            sx, sy = cx_k - ux * d_station, cy_k - uy * d_station
            ex, ey = CX + ux * (d_hub + MARKER_GAP), CY + uy * (d_hub + MARKER_GAP)
            spokes_hub.append(f'<path d="M {sx:.1f} {sy:.1f} L {ex:.1f} {ey:.1f}" fill="none" '
                              f'stroke="{SOFT}" stroke-width="1" stroke-dasharray="5,4" '
                              f'marker-end="url(#arr-soft)"/>')
            # Label beside the *visible* segment (box edge → hub), never on the
            # stroke and never under a station painted later (SKILL.md §6 rule 6).
            # Anchor along the visible run (65% toward the hub), then offset
            # sideways: keeps the mask off the stroke and off the station box.
            # Only the Digest spoke carries a label: the Commit corridor is
            # 48px wide between its box and the hub, too tight for a mask that
            # keeps its 6-10px gap, and type-loop §2.3 says to label a curated
            # subset rather than crowd the hub halo.
            if not isinstance(STATIONS[k]["spoke"], str):
                continue
            mx, my = sx + 0.65 * (ex - sx), sy + 0.65 * (ey - sy)
            nx, ny = -uy, ux
            lx, ly = mx + 14 * nx, my + 14 * ny + 3
            labels.append(f'<rect x="{lx - 32:.1f}" y="{ly - 10:.1f}" width="64" height="12" rx="2" fill="{PAPER}"/>'
                          f'<text x="{lx:.1f}" y="{ly:.1f}" fill="{SOFT}" font-size="8" font-family="{MONO}" '
                          f'text-anchor="middle" letter-spacing="0.10em">{STATIONS[k]["spoke"]}</text>')

    stations_svg, station_text = [], []
    for k, (rx, ry) in enumerate(rects):
        focal = STATIONS[k].get("focal", False)
        fill, stroke = (ACCENT_TINT, ACCENT) if focal else (PAPER, INK)
        width = 1.2 if focal else 1
        stations_svg.append(f'<rect x="{rx:g}" y="{ry:g}" width="{SW:g}" height="{SH:g}" rx="6" '
                            f'fill="{PAPER}"/>')
        stations_svg.append(f'<rect x="{rx:g}" y="{ry:g}" width="{SW:g}" height="{SH:g}" rx="6" '
                            f'fill="{fill}" stroke="{stroke}" stroke-width="{width}"/>')
        cx_k, cy_k = rx + SW / 2, ry + SH / 2
        name_fill = ACCENT if focal else INK
        station_text.append(f'<text x="{cx_k:g}" y="{cy_k - 8:g}" fill="{name_fill}" font-size="12" '
                            f'font-weight="600" font-family="{SANS}" text-anchor="middle">{STATIONS[k]["name"]}</text>')
        for i, line in enumerate(wrap(STATIONS[k]["sub"])):
            station_text.append(f'<text x="{cx_k:g}" y="{cy_k + 8 + i * 12:g}" fill="{MUTED}" font-size="8" '
                                f'font-family="{MONO}" text-anchor="middle">{line}</text>')

    hub = [
        f'<rect x="{CX - HW / 2:g}" y="{CY - HH / 2:g}" width="{HW:g}" height="{HH:g}" rx="8" fill="{INK}"/>',
        f'<text x="{CX:g}" y="{CY - 4:g}" fill="{PAPER}" font-size="16" font-weight="600" '
        f'font-family="{SANS}" text-anchor="middle">{HUB["name"]}</text>',
        f'<text x="{CX:g}" y="{CY + 16:g}" fill="{RULE_SOLID}" font-size="8" font-family="{MONO}" '
        f'text-anchor="middle">{HUB["sub"]}</text>',
    ]

    legend = [
        f'<line x1="40" y1="{LEGEND_Y - 20}" x2="{VIEW_W - 40}" y2="{LEGEND_Y - 20}" stroke="{RULE}" stroke-width="0.8"/>',
        f'<text x="40" y="{LEGEND_Y}" fill="{MUTED}" font-size="8" font-family="{MONO}" letter-spacing="0.14em">LEGEND</text>',
        f'<line x1="140" y1="{LEGEND_Y - 4}" x2="184" y2="{LEGEND_Y - 4}" stroke="{MUTED}" stroke-width="1.2" marker-end="url(#arr-muted)"/>',
        f'<text x="196" y="{LEGEND_Y}" fill="{MUTED}" font-size="8" font-family="{MONO}">session advances, one lap per session</text>',
        f'<line x1="470" y1="{LEGEND_Y - 4}" x2="514" y2="{LEGEND_Y - 4}" stroke="{SOFT}" stroke-width="1" stroke-dasharray="5,4" marker-end="url(#arr-soft)"/>',
        f'<text x="526" y="{LEGEND_Y}" fill="{MUTED}" font-size="8" font-family="{MONO}">durable state written back</text>',
        f'<rect x="760" y="{LEGEND_Y - 12}" width="16" height="12" rx="3" fill="{ACCENT_TINT}" stroke="{ACCENT}" stroke-width="1.2"/>',
        f'<text x="786" y="{LEGEND_Y}" fill="{MUTED}" font-size="8" font-family="{MONO}">focal step of the loop</text>',
    ]

    return f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{TITLE} — dsh-memory-vault</title>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root {{ color-scheme: light; }}
  body {{ margin: 0; padding: 48px 24px; background: {PAPER}; color: {INK};
         font-family: {SANS}; -webkit-font-smoothing: antialiased; }}
  .page {{ max-width: {VIEW_W}px; margin: 0 auto; }}
  .eyebrow {{ font-family: {MONO}; font-size: 12px; letter-spacing: 0.16em;
              text-transform: uppercase; color: {MUTED}; margin: 0 0 12px; }}
  h1 {{ font-family: {SERIF}; font-weight: 400; font-size: 28px; line-height: 1.2; margin: 0 0 8px; }}
  .subtitle {{ color: {MUTED}; font-size: 16px; margin: 0 0 32px; max-width: 62ch; }}
  .diagram {{ border: 1px solid {RULE}; border-radius: 8px; background: {PAPER2};
              padding: 8px; overflow-x: auto; }}
  svg {{ display: block; width: 100%; height: auto; }}
  footer {{ font-family: {MONO}; font-size: 12px; color: {SOFT}; margin-top: 24px;
            padding-top: 12px; border-top: 1px solid {RULE}; }}
</style>
</head>
<body>
<div class="page">
  <p class="eyebrow">{EYEBROW}</p>
  <h1>{TITLE}</h1>
  <p class="subtitle">{SUBTITLE}</p>
  <div class="diagram">
  <svg viewBox="0 0 {VIEW_W} {VIEW_H}" role="img" aria-labelledby="memory-loop-title memory-loop-desc">
    <title id="memory-loop-title">The memory loop: one session per lap around the vault</title>
    <desc id="memory-loop-desc">A five-station ring — Recall, Work, Capture, Digest and Commit — around a central Vault hub. Work advances clockwise; dashed spokes carry durable state from Digest and Commit back into the vault, so the next lap starts from a richer record.</desc>
    <defs>
      <marker id="arr-muted" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
        <polygon points="0 0, 8 3, 0 6" fill="{MUTED}"/>
      </marker>
      <marker id="arr-soft" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
        <polygon points="0 0, 8 3, 0 6" fill="{SOFT}"/>
      </marker>
    </defs>
    <rect width="{VIEW_W}" height="{VIEW_H}" fill="{PAPER}"/>
    {chr(10).join("    " + s for s in ring)}
    {chr(10).join("    " + s for s in spokes_hub)}
    {chr(10).join("    " + s for s in labels)}
    {chr(10).join("    " + s for s in stations_svg)}
    {chr(10).join("    " + s for s in station_text)}
    {chr(10).join("    " + s for s in hub)}
    {chr(10).join("    " + s for s in legend)}
  </svg>
  </div>
  <footer>dsh-memory-vault · generated by the diagram-design skill · skin: dsh-memory-vault profile</footer>
</div>
</body>
</html>
'''


if __name__ == "__main__":
    OUT.write_text(build(), encoding="utf-8")
    print(f"make-loop: wrote {OUT} ({OUT.stat().st_size} bytes)")
