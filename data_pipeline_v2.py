import requests
import pandas as pd
import numpy as np
import time
import json
import joblib
from scipy.spatial import KDTree
from sklearn.ensemble import IsolationForest
import os

# Configuration
BANGKOK_CENTER = {"lat": 13.7563, "lon": 100.5018}
BBOX = {"lat_min": 13.50, "lat_max": 14.00, "lon_min": 100.30, "lon_max": 100.90}
# EXTENDED to include 2025 "Rain Bomb" and "High Tide" dates
DATE_RANGE = {"start": "2020-01-01", "end": "2025-12-31"}

def collect_weather():
    print("Collecting weather data (Extended 2020-2025)...")
    url = "https://archive-api.open-meteo.com/v1/archive"
    params = {
        "latitude": BANGKOK_CENTER["lat"],
        "longitude": BANGKOK_CENTER["lon"],
        "start_date": DATE_RANGE["start"],
        "end_date": DATE_RANGE["end"],
        "hourly": "precipitation,wind_speed_10m,soil_moisture_0_to_7cm,temperature_2m,relative_humidity_2m",
        "timezone": "Asia/Bangkok"
    }
    response = requests.get(url, params=params)
    response.raise_for_status()
    data = response.json()
    
    hourly_data = data["hourly"]
    df = pd.DataFrame(hourly_data)
    
    # Rename soil moisture
    if "soil_moisture_0_to_7cm" in df.columns:
        df = df.rename(columns={"soil_moisture_0_to_7cm": "soil_moisture_0_to_1cm"})
    
    # --- ADD LAGGED PRECIPITATION ---
    print("Engineering lagged precipitation features...")
    df['precip_6h'] = df['precipitation'].rolling(window=6, min_periods=1).sum()
    df['precip_24h'] = df['precipitation'].rolling(window=24, min_periods=1).sum()
    
    # --- ADD RIVER LEVEL ---
    print("Engineering river level feature with event overrides...")
    # Baseline river level (seasonal)
    df['time_dt'] = pd.to_datetime(df['time'])
    # Simple seasonal model: peaks in Oct/Nov (monsoon)
    df['month'] = df['time_dt'].dt.month
    df['river_level_m'] = 0.5 + (np.sin((df['month'] - 6) * np.pi / 6) + 1) * 0.4
    
    # OVERRIDES for known flood events provided by user
    # Sep 8, 2025 (Rain Bomb)
    sep_8_mask = df['time'].str.startswith("2025-09-08")
    df.loc[sep_8_mask, 'river_level_m'] = 1.8 # High due to intensity
    
    # Nov 10, 2025 (High Tide & River Peak)
    nov_10_mask = df['time'].str.startswith("2025-11-10")
    df.loc[nov_10_mask, 'river_level_m'] = 2.1
    
    # Dec 4–12, 2025 (High Tide Warning)
    dec_warn_mask = (df['time_dt'] >= "2025-12-04") & (df['time_dt'] <= "2025-12-12")
    df.loc[dec_warn_mask, 'river_level_m'] = 2.0
    
    # Add lat/lon
    df["lat"] = BANGKOK_CENTER["lat"]
    df["lon"] = BANGKOK_CENTER["lon"]
    
    df.to_csv("weather.csv", index=False)
    print("Weather data saved to weather.csv")
    return df

def collect_elevation():
    # Reuse existing if possible, but keep function for completeness
    if os.path.exists("elevation.csv"):
        print("Checking existing elevation.csv...")
        df = pd.read_csv("elevation.csv")
        null_or_zero = (df['elevation_m'].isnull()) | (df['elevation_m'] == 0.0)
        invalid_pct = null_or_zero.mean() * 100
        if invalid_pct > 20:
            print(f"Warning: {invalid_pct:.1f}% of elevation data is invalid/zero. Re-fetching...")
            os.remove("elevation.csv")
        else:
            return df
    
    print("Collecting elevation data...")
    lats = np.linspace(BBOX["lat_min"], BBOX["lat_max"], 100)
    lons = np.linspace(BBOX["lon_min"], BBOX["lon_max"], 100)
    grid_points = []
    for lat in lats:
        for lon in lons:
            grid_points.append({"lat": lat, "lon": lon})
    
    all_results = []
    url = "https://api.opentopodata.org/v1/srtm30m"
    for i in range(0, len(grid_points), 100):
        batch = grid_points[i:i+100]
        loc_str = "|".join([f"{p['lat']:.6f},{p['lon']:.6f}" for p in batch])
        
        for attempt in range(2):
            try:
                resp = requests.get(url, params={"locations": loc_str}, timeout=10)
                resp.raise_for_status()
                all_results.extend(resp.json()["results"])
                break
            except Exception as e:
                if attempt == 0:
                    print(f"Batch failed, retrying in 2s... ({e})")
                    time.sleep(2)
                else:
                    print(f"Batch failed twice, giving up on this batch. ({e})")
                    for p in batch:
                        all_results.append({"location": {"lat": p["lat"], "lng": p["lon"]}, "elevation": None})
                        
        if (i // 100) % 10 == 0:
            print(f"Fetched batch {i//100}/100...")

        if i + 100 < len(grid_points):
            time.sleep(1)
            
    rows = []
    for r in all_results:
        elev = r.get("elevation")
        if elev is None or elev == 0.0:
            elev = 5.0
        rows.append({"lat": r["location"]["lat"], "lon": r["location"]["lng"], "elevation_m": elev})
        
    df = pd.DataFrame(rows)
    df.to_csv("elevation.csv", index=False)
    return df


def collect_canals(grid_points_df):
    if os.path.exists("canal_distances.csv"):
        print("Using existing canal_distances.csv")
        return pd.read_csv("canal_distances.csv")
    
    print("Collecting canal data...")
    overpass_url = "https://overpass-api.de/api/interpreter"
    query = f'[out:json][timeout:60];(node["waterway"~"river|canal|drain|stream"]({BBOX["lat_min"]},{BBOX["lon_min"]},{BBOX["lat_max"]},{BBOX["lon_max"]});way["waterway"~"river|canal|drain|stream"]({BBOX["lat_min"]},{BBOX["lon_min"]},{BBOX["lat_max"]},{BBOX["lon_max"]}););out body;>;out skel qt;'
    headers = {'User-Agent': 'FloodWatchBKK/1.0 (kyawz)'}
    response = requests.get(overpass_url, params={"data": query}, headers=headers)
    response.raise_for_status()
    data = response.json()
    
    nodes = {n["id"]: (n["lat"], n["lon"]) for n in data["elements"] if n["type"] == "node"}
    canal_nodes = []
    for element in data["elements"]:
        if element["type"] == "way":
            coords = [nodes[node_id] for node_id in element["nodes"] if node_id in nodes]
            if coords: canal_nodes.extend(coords)
    
    tree = KDTree(canal_nodes)
    distances = []
    for _, row in grid_points_df.iterrows():
        dist, _ = tree.query([row["lat"], row["lon"]])
        distances.append({"lat": row["lat"], "lon": row["lon"], "dist_to_canal_m": dist * 111320})
    dist_df = pd.DataFrame(distances)
    dist_df.to_csv("canal_distances.csv", index=False)
    return dist_df

def merge_data():
    print("Merging data...")
    weather_df = pd.read_csv("weather.csv")
    elevation_df = pd.read_csv("elevation.csv")
    canal_dist_df = pd.read_csv("canal_distances.csv")
    
    elevation_df["lat"] = elevation_df["lat"].round(6).astype('float32')
    elevation_df["lon"] = elevation_df["lon"].round(6).astype('float32')
    canal_dist_df["lat"] = canal_dist_df["lat"].round(6).astype('float32')
    canal_dist_df["lon"] = canal_dist_df["lon"].round(6).astype('float32')
    weather_df["precipitation"] = weather_df["precipitation"].astype('float32')
    weather_df["river_level_m"] = weather_df["river_level_m"].astype('float32')
    weather_df["precip_24h"] = weather_df["precip_24h"].astype('float32')
    
    terrain_df = pd.merge(elevation_df, canal_dist_df, on=["lat", "lon"])
    terrain_df["key"] = 1
    weather_df["key"] = 1
    weather_clean = weather_df.drop(columns=["lat", "lon"])
    
    merged_df = pd.merge(terrain_df, weather_clean, on="key").drop(columns="key")
    merged_df = merged_df.dropna()
    
    # Downcast all float columns to float32
    fcols = merged_df.select_dtypes('float').columns
    merged_df[fcols] = merged_df[fcols].astype('float32')
    
    print(f"Merged DF memory: {merged_df.memory_usage(deep=True).sum() / 1024**2:.2f} MB")
    merged_df.to_csv("training_data.csv", index=False)
    return merged_df

def engineer_features(df):
    # Avoid .copy() if possible or do it once
    out = df
    out["inv_elevation"] = (1.0 / (out["elevation_m"].clip(lower=0.1) + 1.0)).astype('float32')
    out["inv_canal_dist"] = (1.0 / (out["dist_to_canal_m"].clip(lower=1.0))).astype('float32')
    
    out["rain_x_inv_elev"] = (out["precipitation"] * out["inv_elevation"]).astype('float32')
    out["rain_x_soil"] = (out["precipitation"] * out["soil_moisture_0_to_1cm"]).astype('float32')
    out["rain_x_inv_canal"] = (out["precipitation"] * out["inv_canal_dist"]).astype('float32')
    out["river_x_inv_elev"] = (out["river_level_m"] * out["inv_elevation"]).astype('float32')
    
    out["flood_risk_index"] = (
        out["precipitation"] * 0.3 +
        out["precip_24h"] * 0.1 +
        out["river_level_m"] * 0.3 +
        out["soil_moisture_0_to_1cm"] * 100 * 0.1 +
        out["inv_elevation"] * 10 * 0.1 +
        out["inv_canal_dist"] * 1000 * 0.1
    ).astype('float32')
    return out

# UPDATED FEATURE LIST
# We remove static geographic features so the model evaluates weather intensity dynamically
FEATURE_COLS = [
    "precipitation", "precip_6h", "precip_24h", # Lagged rain
    "river_level_m", # River/Tide
    "wind_speed_10m", "soil_moisture_0_to_1cm",
    "temperature_2m", "relative_humidity_2m",
    "rain_x_inv_elev", "rain_x_soil", "rain_x_inv_canal", "river_x_inv_elev",
    "flood_risk_index"
]

def train_model(df):
    print("Training model with augmented features...")
    df = engineer_features(df)
    
    # Subsample to avoid MemoryError on large datasets
    if len(df) > 500000:
        print(f"Subsampling from {len(df)} to 500,000 rows for memory efficiency...")
        df = df.sample(n=500000, random_state=42).reset_index(drop=True)
        
    X = df[FEATURE_COLS]
    
    # contamination slightly higher to be more sensitive to "anomalies"
    model = IsolationForest(
        contamination=0.03, 
        n_estimators=300,
        random_state=42,
        n_jobs=1
    )
    model.fit(X)
    
    scores = model.decision_function(X)
    df["anomaly_score"] = scores
    
    # --- Score Statistics ---
    print("\n--- Score Distribution Statistics ---")
    print(f"Score stats: min={scores.min():.4f}, max={scores.max():.4f}, mean={scores.mean():.4f}, std={scores.std():.4f}")
    print(f"Percentiles: 3rd={np.percentile(scores,3):.4f}, 5th={np.percentile(scores,5):.4f}, 10th={np.percentile(scores,10):.4f}")
    
    # --- Fix 1: Print actual score distribution from a dry-weather subset ---
    dry_mask = (df['precipitation'] < 1.0) & (df['precip_24h'] < 5.0) & (df['soil_moisture_0_to_1cm'] < 0.15)
    dry_scores = scores[dry_mask.values]
    print(f"\nDry weather scores: min={dry_scores.min():.4f}, max={dry_scores.max():.4f}, mean={dry_scores.mean():.4f}")
    print(f"Dry weather 5th percentile: {np.percentile(dry_scores, 5):.4f}")
    
    # --- Fix 2: Change threshold strategy ---
    wet_mask = (df['precipitation'] >= 5.0) | (df['precip_24h'] >= 20.0)
    wet_scores = scores[wet_mask.values]
    print(f"\nWet weather scores: min={wet_scores.min():.4f}, mean={wet_scores.mean():.4f}")

    global_thresh = float(np.percentile(wet_scores, 20))
    print(f"New threshold (20th percentile of wet days): {global_thresh:.6f}")
    
    flood_count = (scores < global_thresh).sum()
    flood_pct = (flood_count / len(scores)) * 100
    print(f"Flood Percentage: {flood_pct:.2f}% ({flood_count} / {len(scores)})")

    # --- Sanity Check ---
    print("\n--- Running Sanity Checks ---")
    dry_row = {
        'elevation_m': 5.0, 'dist_to_canal_m': 800.0,
        'precipitation': 0.0, 'precip_6h': 0.0, 'precip_24h': 0.0,
        'river_level_m': 0.7, 'wind_speed_10m': 5.0,
        'soil_moisture_0_to_1cm': 0.05, 'temperature_2m': 30.0,
        'relative_humidity_2m': 60.0
    }
    dry_df = pd.DataFrame([dry_row])
    dry_df = engineer_features(dry_df)
    dry_score = float(model.decision_function(dry_df[FEATURE_COLS])[0])
    dry_res = "FLOOD" if dry_score < global_thresh else "NO FLOOD"
    
    severe_row = {
        'elevation_m': 5.0, 'dist_to_canal_m': 800.0,
        'precipitation': 80.0, 'precip_6h': 200.0, 'precip_24h': 400.0,
        'river_level_m': 2.1, 'wind_speed_10m': 5.0,
        'soil_moisture_0_to_1cm': 0.35, 'temperature_2m': 25.0,
        'relative_humidity_2m': 90.0
    }
    severe_df = pd.DataFrame([severe_row])
    severe_df = engineer_features(severe_df)
    severe_score = float(model.decision_function(severe_df[FEATURE_COLS])[0])
    severe_res = "FLOOD" if severe_score < global_thresh else "NO FLOOD"
    
    # --- Fix 3: Light rain sanity check ---
    light_row = {
        'elevation_m': 5.0, 'dist_to_canal_m': 800.0,
        'precipitation': 2.0, 'precip_6h': 6.0, 'precip_24h': 10.0,
        'river_level_m': 0.8, 'wind_speed_10m': 5.0,
        'soil_moisture_0_to_1cm': 0.10, 'temperature_2m': 30.0,
        'relative_humidity_2m': 60.0
    }
    light_df = pd.DataFrame([light_row])
    light_df = engineer_features(light_df)
    light_score = float(model.decision_function(light_df[FEATURE_COLS])[0])
    light_res = "FLOOD" if light_score < global_thresh else "NO FLOOD"
    
    print(f"Dry day result: {dry_res} (score: {dry_score:.4f})")
    print(f"Light rain day result: {light_res} (score: {light_score:.4f})")
    print(f"Severe day result: {severe_res} (score: {severe_score:.4f})")
    
    if dry_res == "FLOOD":
        raise ValueError("Sanity Check Failed: Dry day returned FLOOD. Threshold is wrong!")
    if light_res == "FLOOD":
        raise ValueError("Sanity Check Failed: Light rain day returned FLOOD. Threshold is still too aggressive!")
        
    print("\n--- Final Summary ---")
    print(f"Threshold: {global_thresh:.6f}")
    print(f"Training Data Labeled FLOOD: {flood_pct:.2f}%")
    print(f"Dry Day: {dry_res}")
    print(f"Severe Day: {severe_res}")
    
    print("\nSanity checks passed. Saving model and thresholds...")
    joblib.dump(model, "model.pkl")

    thresholds = {}
    grid_points = df[["lat", "lon"]].drop_duplicates()
    for _, gp in grid_points.iterrows():
        thresholds[f"{gp['lat']:.6f},{gp['lon']:.6f}"] = global_thresh
    
    with open("thresholds.json", "w") as f:
        json.dump(thresholds, f, indent=2)
    
    with open("feature_meta.json", "w") as f:
        json.dump({
            "raw_features": ["elevation_m", "dist_to_canal_m", "precipitation", "precip_6h", "precip_24h", "river_level_m", "wind_speed_10m", "soil_moisture_0_to_1cm", "temperature_2m", "relative_humidity_2m"],
            "all_features": FEATURE_COLS,
            "grid_points": [{"lat": float(r["lat"]), "lon": float(r["lon"])} for _, r in grid_points.iterrows()]
        }, f, indent=2)
    
    print("Training complete.")

if __name__ == "__main__":
    elevation_df = collect_elevation()
    canal_dist_df = collect_canals(elevation_df)

    with open("feature_meta.json", "r") as f:
        meta = json.load(f)

    meta["grid_points"] = [{"lat": float(r["lat"]), "lon": float(r["lon"])} for _, r in elevation_df.iterrows()]
    
    with open("feature_meta.json", "w") as f:
        json.dump(meta, f, indent=2)

    real_count = elevation_df[elevation_df["elevation_m"] != 5.0].shape[0]
    fallback_count = elevation_df[elevation_df["elevation_m"] == 5.0].shape[0]

    print("\n--- Final Summary ---")
    print(f"Total points generated: {len(elevation_df)}")
    print(f"Real elevation data points: {real_count}")
    print(f"Fallback (estimated) elevation points: {fallback_count}")
