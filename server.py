"""
FloodWatch Bangkok — Flask Backend
Serves the dashboard and provides ML prediction endpoints.
Modified to trigger auto-reload
"""
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import joblib
import json
import pandas as pd
import numpy as np
import os
import math
from datetime import datetime

app = Flask(__name__)
CORS(app)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# ─── Load model & static data on startup ───────────────────────────────────
print("Loading model and data...")
model = joblib.load(os.path.join(BASE_DIR, 'model.pkl'))

with open(os.path.join(BASE_DIR, 'thresholds.json')) as f:
    thresholds = json.load(f)

with open(os.path.join(BASE_DIR, 'feature_meta.json')) as f:
    feature_meta = json.load(f)

elevation_df = pd.read_csv(os.path.join(BASE_DIR, 'elevation.csv'))
canal_df = pd.read_csv(os.path.join(BASE_DIR, 'canal_distances.csv'))

# Build lookup dicts keyed by "lat,lon" string
elevation_lookup = {}
for _, row in elevation_df.iterrows():
    key = f"{row['lat']:.6f},{row['lon']:.6f}"
    elevation_lookup[key] = float(row['elevation_m'])

canal_lookup = {}
for _, row in canal_df.iterrows():
    key = f"{row['lat']:.6f},{row['lon']:.6f}"
    canal_lookup[key] = float(row['dist_to_canal_m'])

FEATURE_COLS = feature_meta['all_features']
GRID_POINTS = feature_meta['grid_points']
print(f"Loaded {len(GRID_POINTS)} grid points, {len(FEATURE_COLS)} features")
print(f"Training features: {FEATURE_COLS}")

# Fix 1: Startup check for elevation fallbacks
fallback_count = 0
for gp in GRID_POINTS:
    key = f"{gp['lat']:.6f},{gp['lon']:.6f}"
    if key not in elevation_lookup or elevation_lookup[key] == 5.0:
        fallback_count += 1

print(f"Grid points using elevation fallback: {fallback_count}/{len(GRID_POINTS)}")
if fallback_count > len(GRID_POINTS) * 0.2:
    print("!"*50)
    print(f"LOUD WARNING: {fallback_count} grid points are missing elevation data and using 5.0m fallback!")
    print("!"*50)


def engineer_features(df):
    """Replicate the feature engineering from data_pipeline.py exactly."""
    out = df.copy()
    out["inv_elevation"] = 1.0 / (out["elevation_m"].clip(lower=0.1) + 1.0)
    out["inv_canal_dist"] = 1.0 / (out["dist_to_canal_m"].clip(lower=1.0))
    out["rain_x_inv_elev"] = out["precipitation"] * out["inv_elevation"]
    out["rain_x_soil"] = out["precipitation"] * out["soil_moisture_0_to_1cm"]
    out["rain_x_inv_canal"] = out["precipitation"] * out["inv_canal_dist"]
    
    # Sync with data_pipeline_v2.py
    out["river_x_inv_elev"] = out["river_level_m"] * out["inv_elevation"]
    
    out["flood_risk_index"] = (
        out["precipitation"] * 0.3 +
        out["precip_24h"] * 0.1 +
        out["river_level_m"] * 0.3 +
        out["soil_moisture_0_to_1cm"] * 100 * 0.1 +
        out["inv_elevation"] * 10 * 0.1 +
        out["inv_canal_dist"] * 1000 * 0.1
    )
    return out


# Issue 3: Verify feature list consistency on startup
# 1. Reconstruct a dummy row to verify engineer_features output matches FEATURE_COLS
dummy_df = pd.DataFrame([{
    'elevation_m': 0.0, 'dist_to_canal_m': 0.0, 'precipitation': 0.0,
    'precip_6h': 0.0, 'precip_24h': 0.0, 'river_level_m': 0.0,
    'wind_speed_10m': 0.0, 'soil_moisture_0_to_1cm': 0.0,
    'temperature_2m': 0.0, 'relative_humidity_2m': 0.0
}])
dummy_processed = engineer_features(dummy_df)
actual_features = dummy_processed[FEATURE_COLS].columns.tolist()
if actual_features != FEATURE_COLS:
    raise RuntimeError(f"Startup Feature mismatch (Transformation)!\nExpected: {FEATURE_COLS}\nActual: {actual_features}")

# 2. Verify against model's internal feature list if available
if hasattr(model, 'feature_names_in_'):
    model_features = list(model.feature_names_in_)
    if model_features != FEATURE_COLS:
         raise RuntimeError(f"Startup Feature mismatch (Model)!\nExpected: {FEATURE_COLS}\nActual: {model_features}")

print("Startup verification passed: Features match training columns exactly.")


# ─── Routes ────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return send_from_directory(BASE_DIR, 'index.html')


@app.route('/canals.geojson')
def canals():
    return send_from_directory(BASE_DIR, 'canals.geojson')


@app.route('/style.css')
def style():
    return send_from_directory(BASE_DIR, 'style.css')


@app.route('/app.js')
def appjs():
    return send_from_directory(BASE_DIR, 'app.js')


@app.route('/api/meta')
def meta():
    """Return grid points, elevation, canal distances, and thresholds."""
    return jsonify({
        'grid_points': GRID_POINTS,
        'features': FEATURE_COLS,
        'elevation': elevation_lookup,
        'canal_distances': canal_lookup,
        'thresholds': thresholds
    })


@app.route('/api/predict', methods=['POST'])
def predict():
    """
    Expects JSON: { "weather": { precipitation, wind_speed_10m,
                     soil_moisture_0_to_1cm, temperature_2m, relative_humidity_2m } }
    Returns predictions for all 100 grid points.
    """
    data = request.json
    weather = data.get('weather', {})

    # Calculate seasonal river level
    now = datetime.now()
    month = now.month
    river_level = 0.5 + (math.sin((month - 6) * math.pi / 6) + 1) * 0.4

    precip = float(weather.get('precipitation', 0.0))
    wind = float(weather.get('wind_speed_10m', 0.0))
    soil = float(weather.get('soil_moisture_0_to_1cm', 0.0))
    temp = float(weather.get('temperature_2m', 25.0))
    humidity = float(weather.get('relative_humidity_2m', 70.0))

    rows = []
    for gp in GRID_POINTS:
        lat, lon = gp['lat'], gp['lon']
        key = f"{lat:.6f},{lon:.6f}"
        rows.append({
            'elevation_m': elevation_lookup.get(key, 5.0),
            'dist_to_canal_m': canal_lookup.get(key, 800.0),
            'precipitation': precip,
            'precip_6h': precip * 3.0,   # Conservative estimate
            'precip_24h': precip * 8.0,  # Conservative estimate
            'river_level_m': river_level,
            'wind_speed_10m': wind,
            'soil_moisture_0_to_1cm': soil,
            'temperature_2m': temp,
            'relative_humidity_2m': humidity,
        })

    df = pd.DataFrame(rows)
    df = engineer_features(df)

    X = df[FEATURE_COLS]
    
    # Issue 3: Verify feature list consistency
    expected_features = FEATURE_COLS
    actual_features = X.columns.tolist()
    if actual_features != expected_features:
        raise RuntimeError(f"Feature mismatch!\nExpected: {expected_features}\nActual: {actual_features}")
        
    scores = model.decision_function(X)
    min_score = scores.min()
    max_score = scores.max()
    score_range = max_score - min_score if (max_score - min_score) > 0 else 1.0

    results = []
    for i, gp in enumerate(GRID_POINTS):
        lat, lon = gp['lat'], gp['lon']
        key = f"{lat:.6f},{lon:.6f}"
        score = float(scores[i])
        thresh = thresholds.get(key, 0.0)
        label = "FLOOD" if score < thresh else "NO FLOOD"

        confidence = (score - min_score) / score_range
        flood_confidence_pct = round((1 - confidence) * 100.0, 1)

        results.append({
            'lat': lat, 'lon': lon,
            'label': label,
            'anomaly_score': round(score, 6),
            'threshold': round(thresh, 6),
            'elevation_m': float(df.iloc[i]['elevation_m']),
            'dist_to_canal_m': round(float(df.iloc[i]['dist_to_canal_m']), 1),
            'flood_confidence_pct': flood_confidence_pct
        })

    return jsonify({'results': results})


@app.route('/api/health')
def health():
    """Verify system health and model metadata."""
    model_path = os.path.join(BASE_DIR, 'model.pkl')
    mtime = os.path.getmtime(model_path)
    timestamp = datetime.fromtimestamp(mtime).strftime('%Y-%m-%d %H:%M:%S')
    
    global_thresh = next(iter(thresholds.values())) if thresholds else 0.0
    
    # Fix 4: Live dry-day sanity check
    test_row = {
        'precipitation': 0.0, 'precip_6h': 0.0, 'precip_24h': 0.0, 
        'river_level_m': 0.7, 'wind_speed_10m': 5.0, 'soil_moisture_0_to_1cm': 0.05, 
        'temperature_2m': 30.0, 'relative_humidity_2m': 60.0, 
        'elevation_m': 5.0, 'dist_to_canal_m': 800.0
    }
    test_df = pd.DataFrame([test_row])
    test_df = engineer_features(test_df)
    dry_day_score = float(model.decision_function(test_df[FEATURE_COLS])[0])
    dry_day_prediction = "FLOOD" if dry_day_score < global_thresh else "NO FLOOD"
    
    return jsonify({
        'status': 'healthy',
        'model_timestamp': timestamp,
        'feature_count': len(FEATURE_COLS),
        'features': FEATURE_COLS,
        'grid_points': len(GRID_POINTS),
        'global_threshold': global_thresh,
        'dry_day_score': dry_day_score,
        'dry_day_prediction': dry_day_prediction
    })


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(debug=False, host='0.0.0.0', port=port)
