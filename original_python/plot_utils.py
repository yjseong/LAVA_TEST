import plotly.graph_objects as go
import pandas as pd
import numpy as np
import copy
from seismic_stations import seismic_station, infra_station

# ── Common layout settings ─────────────────────────────────
MINI_LAYOUT = dict(
    margin=dict(l=45, r=10, t=15, b=5),
    height=80,
    paper_bgcolor="rgba(0,0,0,0)",
    plot_bgcolor="rgba(240,250,244,1)",
    xaxis=dict(showticklabels=False, showgrid=False, zeroline=False),
    yaxis=dict(showticklabels=True, showgrid=True, gridcolor="#e0e0e0",
               zeroline=True, zerolinecolor="#aaa", zerolinewidth=1,
               tickfont=dict(size=8), nticks=3, rangemode="tozero"),
    showlegend=False,
)

FULL_LAYOUT = dict(
    margin=dict(l=60, r=20, t=40, b=60),
    height=300,
    paper_bgcolor="rgba(0,0,0,0)",
    plot_bgcolor="rgba(240,250,244,1)",
    xaxis=dict(showgrid=True, gridcolor="#e0e0e0", zeroline=False,
               title="Time (UTC)"),
    yaxis=dict(showgrid=True, gridcolor="#e0e0e0",
               zeroline=True, zerolinecolor="#aaa", zerolinewidth=1,
               rangemode="tozero"),
    showlegend=False,
)

EMPTY_MESSAGE = "No data available"

def empty_figure(mini=False):
    """Return an empty figure with a 'No data available' message."""
    layout = MINI_LAYOUT.copy() if mini else FULL_LAYOUT.copy()
    fig = go.Figure(layout=layout)
    fig.add_annotation(
        text=EMPTY_MESSAGE,
        xref="paper", yref="paper",
        x=0.5, y=0.5, showarrow=False,
        font=dict(size=10 if mini else 13, color="#aaa")
    )
    return fig

# ── RSAM plot ──────────────────────────────────────────────
RSAM_YMAX = {
    # Asosan: the RSAM station changed V.ASO2 -> V.ASOA from 2026-10-14 23:00 UTC; ASOA reads ~25x higher
    # (median ~9000 against ~370 before, 99th percentile ~21000), so the old limit of 6000 cut it off.
    # The ASO2 period before that now looks flat at the bottom.
    "Asosan": 30000,
    "Kirishimayama": 4000,
    # Sakurajima: since the station change to V.SKA2 (2026-10-16) the typical level is ~350 (99th percentile ~1300,
    # 99.9th ~1600), so 1000 cut off many points; 2000 shows the usual peaks and clips only a handful.
    "Sakurajima": 2000,
    "Kuchinoerabujima": 1000,
    "Ontakesan": 1500,
}
def plot_rsam(df, mini=False, volcano=""):
    """
    Plot RSAM as a line plot.
    df: DataFrame with columns [time_utc, RSAM]
    """
    if df.empty:
        return empty_figure(mini)

    layout = copy.deepcopy(MINI_LAYOUT) if mini else copy.deepcopy(FULL_LAYOUT)
    layout["yaxis"]["range"] = [0, RSAM_YMAX[volcano]]
    layout["yaxis"]["rangemode"] = "normal"  # Override tozero since range is fixed

    if mini:
        layout["yaxis"]["title"] = dict(text="RSAM (μm/s)", font=dict(size=8), standoff=2)
    else:
        layout["yaxis"]["title"] = "RMS Amplitude (μm/s)"
        layout["title"] = dict(text=f"RSAM — {seismic_station(volcano)}", font=dict(size=13))

    fig = go.Figure(layout=layout)

    # Insert NaN where time gap > 30 minutes to break the line
    df = df.copy()
    diff = df["time_utc"].diff()
    df.loc[diff > pd.Timedelta(minutes=30), "RSAM"] = None

    fig.add_trace(go.Scatter(
        x=df["time_utc"],
        y=df["RSAM"],
        mode="lines",
        line=dict(color="#27ae60", width=1 if mini else 1.5),
    ))
    return fig

# ── SSAM plot ──────────────────────────────────────────────
# Colour range of the heatmap, in the units of the plotted z (the CSV holds dB, plot_ssam applies
# 10*log10 once more, so e.g. 35 dB is drawn as 15.4).
SSAM_Z_DEFAULT = (8, 19)
SSAM_Z_RANGE = {
    # Asosan: after the station change to V.ASOA (2026-10-14 23:00 UTC) the CSV values are ~30 dB
    # higher (drawn 17.2 .. 18.9 for the 1st-99th percentile, 13 .. 16.9 before), so the default
    # range was all red. The ASO2 period before the change now shows as uniform blue.
    "Asosan": (17.0, 19.0),
}
def plot_ssam(df, mini=False, volcano=""):
    """
    Plot SSAM as a heatmap.
    df: DataFrame with columns [time_utc, 0.5Hz, 1.0Hz, ..., 10.0Hz]
    """
    if df.empty:
        return empty_figure(mini)

    try:
        freq_cols = [c for c in df.columns if c != "time_utc"]

        # Convert frequency column names to numeric values
        freq_vals = []
        for c in freq_cols:
            try:
                freq_vals.append(float(c.replace("Hz", "").strip()))
            except Exception:
                freq_vals.append(c)

        z = df[freq_cols].values.T  # Shape: (freq, time)

        # Convert to dB (avoid log of zero)
        with np.errstate(divide='ignore', invalid='ignore'):
            z = np.where(z > 0, 10 * np.log10(z), np.nan)

        zmin_fixed, zmax_fixed = SSAM_Z_RANGE.get(volcano, SSAM_Z_DEFAULT)

        if mini:
            layout = copy.deepcopy(MINI_LAYOUT)
            layout["yaxis"] = dict(
                showticklabels=True,
                tickvals=[0, 5, 10],
                ticktext=["0", "5", "10"],
                tickfont=dict(size=8),
                zeroline=False,
                range=[0, max(freq_vals)] if freq_vals else [0, 10],
                title=dict(text="SSAM (Hz)", font=dict(size=8), standoff=2),
            )
            layout["margin"] = dict(l=45, r=10, t=5, b=5)
        else:
            layout = copy.deepcopy(FULL_LAYOUT)
            layout["yaxis"] = dict(
                title="Frequency (Hz)",
                showgrid=True,
                gridcolor="#e0e0e0",
                zeroline=False,
                tickmode="linear",
                tick0=0,
                dtick=1,
                range=[0, max(freq_vals)] if freq_vals else [0, 10],
            )
            layout["title"] = dict(text=f"SSAM — {seismic_station(volcano)}", font=dict(size=13))

        fig = go.Figure(layout=layout)
        fig.add_trace(go.Heatmap(
            x=df["time_utc"],
            y=freq_vals,
            z=z,
            colorscale="Jet",
            showscale=False,
            zsmooth="best",
            zmin=zmin_fixed,
            zmax=zmax_fixed,
        ))
        return fig

    except Exception as e:
        print(f"[SSAM plot] {volcano}: {e}")
        return empty_figure(mini)

# ── Peak pressure plot ─────────────────────────────────────

# Peak pressure Y max per volcano (Pa) — set to None for auto
PEAK_YMAX = {
    "Asosan":          20,
    "Kirishimayama":    None,
    "Sakurajima":       None,
    "Kuchinoerabujima": None,
    "Ontakesan":        None,
}

def plot_peak_pressure(df, mini=False, volcano=""):
    if df.empty:
        return empty_figure(mini)

    layout = copy.deepcopy(MINI_LAYOUT) if mini else copy.deepcopy(FULL_LAYOUT)

    if mini:
        layout["xaxis"] = dict(
            showticklabels=True, showgrid=False,
            zeroline=False, tickfont=dict(size=7),
            tickformat="%m/%d"
        )
        layout["margin"] = dict(l=45, r=10, t=5, b=30)
    else:
        layout["yaxis"]["title"] = "Peak Pressure (Pa)"
        if PEAK_YMAX.get(volcano):
            layout["yaxis"]["range"] = [0, PEAK_YMAX[volcano]]
            layout["yaxis"]["rangemode"] = "normal"
        layout["title"] = dict(text=f"Peak Pressure — {infra_station(volcano)}", font=dict(size=13))

    # Insert NaN where time gap > 30 minutes to break the line
    df = df.copy()
    diff = df["time_utc"].diff()
    df.loc[diff > pd.Timedelta(minutes=30), "peak_pressure_Pa"] = None

    fig = go.Figure(layout=layout)
    fig.add_trace(go.Scatter(
        x=df["time_utc"],
        y=df["peak_pressure_Pa"],
        mode="lines",
        line=dict(color="#2980b9", width=1 if mini else 1.5),
    ))
    return fig