"""
Diagnose why the model misses known flood events.
Check weather data, scores, and thresholds for specific dates.
"""
import requests
import joblib
import json
import pandas as pd
import numpy as np
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
model = joblib.load(os.path.join(BASE_DIR, 'model.pkl'))
with open(os.path.join(BASE_DIR, 'thresholds.json')) as f:
    thresholds = json.load(f)
with open(os.path.join(BASE_DIR, 'feature_meta.json')) as f:
    feature_meta = json.load(f)
elevation_df = pd.read_csv(os.path.join(BASE_DIR, 'elevation.csv'))
canal_df = pd.read_csv(os.path.join(BASE_DIR, 'canal_distances.csv'))

FEATURE_COLS = feature_meta['all_features']
GRID_POINTS = feature_meta['grid_points']

# Build lookups
elev_lookup = {}
for _, r in elevation_df.iterrows():
    elev_lookup[f"{r['lat']:.6f},{r['lon']:.6f}"] = float(r['elevation_m'])
canal_lookup = {}
for _, r in canal_df.iterrows():
    canal_lookup[f"{r['lat']:.6f},{r['lon']:.6f}"] = float(r['dist_to_canal_m'])

def engineer(df):
    out = df.copy()
    out["inv_elevation"] = 1.0 / (out["elevation_m"].clip(lower=0.1) + 1.0)
    out["inv_canal_dist"] = 1.0 / (out["dist_to_canal_m"].clip(lower=1.0))
    out["rain_x_inv_elev"] = out["precipitation"] * out["inv_elevation"]
    out["rain_x_soil"] = out["precipitation"] * out["soil_moisture_0_to_1cm"]
    out["rain_x_inv_canal"] = out["precipitation"] * out["inv_canal_dist"]
    out["flood_risk_index"] = (
        out["precipitation"] * 0.4
        + out["soil_moisture_0_to_1cm"] * 100 * 0.2
        + out["inv_elevation"] * 10 * 0.2
        + out["inv_canal_dist"] * 1000 * 0.1
        + out["wind_speed_10m"] * 0.1
    )
    return out

def get_archive_weather(date_str):
    """Fetch full 24h weather for a date."""
    url = "https://archive-api.open-meteo.com/v1/archive"
    params = {
        "latitude": 13.7563, "longitude": 100.5018,
        "start_date": date_str, "end_date": date_str,
        "hourly": "precipitation,wind_speed_10m,soil_moisture_0_to_7cm,temperature_2m,relative_humidity_2m",
        "timezone": "Asia/Bangkok"
    }
    resp = requests.get(url, params=params)
    resp.raise_for_status()
    data = resp.json()["hourly"]
    # Rename soil moisture
    data["soil_moisture_0_to_1cm"] = data.pop("soil_moisture_0_to_7cm")
    return data

def score_weather(weather_at_hour):
    """Score all 100 grid points for a single hour's weather."""
    rows = []
    for gp in GRID_POINTS:
        key = f"{gp['lat']:.6f},{gp['lon']:.6f}"
        rows.append({
            'elevation_m': elev_lookup.get(key, 0.0),
            'dist_to_canal_m': canal_lookup.get(key, 5000.0),
            **weather_at_hour
        })
    df = pd.DataFrame(rows)
    df = engineer(df)
    X = df[FEATURE_COLS]
    scores = model.decision_function(X)
    return scores

def analyze_date(label, date_str):
    print(f"\n{'='*60}")
    print(f"  {label}: {date_str}")
    print(f"{'='*60}")
    
    weather = get_archive_weather(date_str)
    
    # Show 24h precipitation summary
    precips = weather["precipitation"]
    total_rain = sum(p for p in precips if p is not None)
    max_rain = max(p for p in precips if p is not None)
    peak_hour = precips.index(max_rain)
    
    print(f"\n  24h total rainfall: {total_rain:.1f} mm")
    print(f"  Peak hour rainfall: {max_rain:.1f} mm at hour {peak_hour}")
    print(f"  Hourly precip: {[f'{p:.1f}' if p else '0' for p in precips]}")
    print(f"  Soil moisture range: {min(s for s in weather['soil_moisture_0_to_1cm'] if s):.3f} - {max(s for s in weather['soil_moisture_0_to_1cm'] if s):.3f}")
    print(f"  Wind range: {min(w for w in weather['wind_speed_10m'] if w):.1f} - {max(w for w in weather['wind_speed_10m'] if w):.1f} km/h")
    
    # Score at peak hour
    w_peak = {
        'precipitation': precips[peak_hour] or 0,
        'wind_speed_10m': weather['wind_speed_10m'][peak_hour] or 0,
        'soil_moisture_0_to_1cm': weather['soil_moisture_0_to_1cm'][peak_hour] or 0,
        'temperature_2m': weather['temperature_2m'][peak_hour] or 25,
        'relative_humidity_2m': weather['relative_humidity_2m'][peak_hour] or 70,
    }
    
    scores = score_weather(w_peak)
    
    # Count flood/no-flood
    n_flood = 0
    for i, gp in enumerate(GRID_POINTS):
        key = f"{gp['lat']:.6f},{gp['lon']:.6f}"
        thresh = thresholds.get(key, 0.0)
        if scores[i] < thresh:
            n_flood += 1
    
    print(f"\n  Peak hour weather: precip={w_peak['precipitation']}, wind={w_peak['wind_speed_10m']}, soil={w_peak['soil_moisture_0_to_1cm']}")
    print(f"  Model scores: min={scores.min():.4f}, max={scores.max():.4f}, mean={scores.mean():.4f}")
    print(f"  Thresholds: min={min(thresholds.values()):.4f}, max={max(thresholds.values()):.4f}, mean={np.mean(list(thresholds.values())):.4f}")
    print(f"  FLOOD predictions: {n_flood} / {len(GRID_POINTS)}")
    
    # Show gap between scores and thresholds
    gaps = []
    for i, gp in enumerate(GRID_POINTS):
        key = f"{gp['lat']:.6f},{gp['lon']:.6f}"
        thresh = thresholds.get(key, 0.0)
        gaps.append(scores[i] - thresh)
    gaps = np.array(gaps)
    print(f"  Score-Threshold gap: min={gaps.min():.4f}, mean={gaps.mean():.4f}, max={gaps.max():.4f}")
    print(f"  (Negative gap = FLOOD)")

# Also check training data statistics
print("\n" + "="*60)
print("  TRAINING DATA STATISTICS")
print("="*60)
weather_df = pd.read_csv(os.path.join(BASE_DIR, 'weather.csv'))
print(f"  Rows: {len(weather_df)}")
print(f"  Date range: {weather_df['time'].min()} to {weather_df['time'].max()}")
print(f"  Precipitation: min={weather_df['precipitation'].min()}, max={weather_df['precipitation'].max()}, "
      f"mean={weather_df['precipitation'].mean():.2f}, 95th={weather_df['precipitation'].quantile(0.95):.2f}, "
      f"99th={weather_df['precipitation'].quantile(0.99):.2f}")
print(f"  Soil moisture: min={weather_df['soil_moisture_0_to_1cm'].min()}, max={weather_df['soil_moisture_0_to_1cm'].max()}")
print(f"  Wind: min={weather_df['wind_speed_10m'].min()}, max={weather_df['wind_speed_10m'].max()}")

# Analyze known flood dates
analyze_date("Sep 8 2025 Rain Bombs", "2025-09-08")
analyze_date("Nov 10 2025 High Tide", "2025-11-10")
analyze_date("Dec 8 2025 High Tide Warning", "2025-12-08")

# Also check a known normal day for contrast
analyze_date("Jan 15 2025 (Dry Season - Control)", "2025-01-15")
