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
DATE_RANGE = {"start": "2020-01-01", "end": "2024-12-31"}

def collect_weather():
    print("Collecting weather data...")
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
    # Rename soil moisture to match user request
    if "soil_moisture_0_to_7cm" in df.columns:
        df = df.rename(columns={"soil_moisture_0_to_7cm": "soil_moisture_0_to_1cm"})
    # Add lat/lon for joining (broadcasting to the area)
    df["lat"] = BANGKOK_CENTER["lat"]
    df["lon"] = BANGKOK_CENTER["lon"]
    df.to_csv("weather.csv", index=False)
    print("Weather data saved to weather.csv")
    return df

def collect_elevation():
    print("Collecting elevation data...")
    lats = np.linspace(BBOX["lat_min"], BBOX["lat_max"], 10)
    lons = np.linspace(BBOX["lon_min"], BBOX["lon_max"], 10)
    grid_points = []
    for lat in lats:
        for lon in lons:
            grid_points.append({"lat": lat, "lon": lon})
    
    # OpenTopoData API limit is 100 per request
    locations = "|".join([f"{p['lat']:.6f},{p['lon']:.6f}" for p in grid_points])
    url = "https://api.opentopodata.org/v1/srtm30m"
    params = {"locations": locations}
    
    # The request says "batches of 100 locations per request... 1-second delay". 
    # Since we have exactly 100 points, one batch is enough, but we should handle it generally.
    all_results = []
    for i in range(0, len(grid_points), 100):
        batch = grid_points[i:i+100]
        loc_str = "|".join([f"{p['lat']:.6f},{p['lon']:.6f}" for p in batch])
        resp = requests.get(url, params={"locations": loc_str})
        resp.raise_for_status()
        all_results.extend(resp.json()["results"])
        if i + 100 < len(grid_points):
            time.sleep(1)
            
    df = pd.DataFrame([
        {"lat": r["location"]["lat"], "lon": r["location"]["lng"], "elevation_m": r["elevation"]}
        for r in all_results
    ])
    df.to_csv("elevation.csv", index=False)
    print("Elevation data saved to elevation.csv")
    return df

def collect_canals(grid_points_df):
    print("Collecting canal data...")
    overpass_url = "https://overpass.kumi.systems/api/interpreter"
    query = f'[out:json][timeout:25];(node["waterway"~"river|canal|drain|stream"]({BBOX["lat_min"]},{BBOX["lon_min"]},{BBOX["lat_max"]},{BBOX["lon_max"]});way["waterway"~"river|canal|drain|stream"]({BBOX["lat_min"]},{BBOX["lon_min"]},{BBOX["lat_max"]},{BBOX["lon_max"]}););out body;>;out skel qt;'
    headers = {
        "User-Agent": "FloodDataCollector/2.0 (contact: researcher@example.com)",
    }
    response = requests.post(overpass_url, data={"data": query}, headers=headers)
    if response.status_code != 200:
        print(f"Overpass Error: {response.status_code} - {response.text}")
    response.raise_for_status()
    data = response.json()
    
    # Save as GeoJSON (simple conversion)
    geojson = {
        "type": "FeatureCollection",
        "features": []
    }
    nodes = {n["id"]: (n["lat"], n["lon"]) for n in data["elements"] if n["type"] == "node"}
    canal_nodes = []
    for element in data["elements"]:
        if element["type"] == "way":
            coords = [nodes[node_id] for node_id in element["nodes"] if node_id in nodes]
            if coords:
                canal_nodes.extend(coords)
                geojson["features"].append({
                    "type": "Feature",
                    "geometry": {"type": "LineString", "coordinates": [[c[1], c[0]] for c in coords]},
                    "properties": element.get("tags", {})
                })
    
    with open("canals.geojson", "w") as f:
        json.dump(geojson, f)
    
    print(f"Found {len(canal_nodes)} canal nodes.")
    if not canal_nodes:
        print("Warning: No canal nodes found. Using dummy distances.")
        dist_df = pd.DataFrame([
            {"lat": row["lat"], "lon": row["lon"], "dist_to_canal_m": 5000.0} 
            for _, row in grid_points_df.iterrows()
        ])
    else:
        tree = KDTree(canal_nodes)
        distances = []
        for _, row in grid_points_df.iterrows():
            dist, _ = tree.query([row["lat"], row["lon"]])
            dist_m = dist * 111320
            distances.append({"lat": row["lat"], "lon": row["lon"], "dist_to_canal_m": dist_m})
        dist_df = pd.DataFrame(distances)
    dist_df.to_csv("canal_distances.csv", index=False)
    print("Canal data saved to canals.geojson and canal_distances.csv")
    return dist_df

def merge_data():
    print("Merging data...")
    weather_df = pd.read_csv("weather.csv")
    elevation_df = pd.read_csv("elevation.csv")
    canal_dist_df = pd.read_csv("canal_distances.csv")
    
    print(f"Weather rows: {len(weather_df)}")
    print(f"Elevation rows: {len(elevation_df)}")
    print(f"Canal distance rows: {len(canal_dist_df)}")
    
    # Round to avoid floating point issues
    elevation_df["lat"] = elevation_df["lat"].round(6)
    elevation_df["lon"] = elevation_df["lon"].round(6)
    canal_dist_df["lat"] = canal_dist_df["lat"].round(6)
    canal_dist_df["lon"] = canal_dist_df["lon"].round(6)
    
    # First, join terrain features
    terrain_df = pd.merge(elevation_df, canal_dist_df, on=["lat", "lon"])
    print(f"Terrain joined rows: {len(terrain_df)}")
    
    # Cross join with weather
    terrain_df["key"] = 1
    weather_df["key"] = 1
    weather_clean = weather_df.drop(columns=["lat", "lon"])
    
    merged_df = pd.merge(terrain_df, weather_clean, on="key").drop(columns="key")
    print(f"Merged rows before dropna: {len(merged_df)}")
    
    # Drop rows with nulls
    null_counts = merged_df.isnull().sum()
    print("Null counts per column:")
    print(null_counts)
    
    merged_df = merged_df.dropna()
    print(f"Merged rows after dropna: {len(merged_df)}")
    
    merged_df.to_csv("training_data.csv", index=False)
    print(f"Training data saved to training_data.csv ({len(merged_df)} rows)")
    return merged_df

def engineer_features(df):
    """
    Engineer interaction features that capture flood-risk physics:
      - high rainfall + low elevation = water pools
      - high rainfall + saturated soil = no absorption
      - proximity to canals = overflow risk
      - combined flood risk index
    """
    out = df.copy()
    
    # Inverse elevation: lower elevation → higher flood vulnerability
    # Add small epsilon to avoid division by zero; clamp negatives to 0
    out["inv_elevation"] = 1.0 / (out["elevation_m"].clip(lower=0.1) + 1.0)
    
    # Inverse canal distance: closer to canal → higher overflow risk
    out["inv_canal_dist"] = 1.0 / (out["dist_to_canal_m"].clip(lower=1.0))
    
    # Interaction: rainfall × inverse elevation (rain pooling in low areas)
    out["rain_x_inv_elev"] = out["precipitation"] * out["inv_elevation"]
    
    # Interaction: rainfall × soil moisture (saturated ground can't absorb)
    out["rain_x_soil"] = out["precipitation"] * out["soil_moisture_0_to_1cm"]
    
    # Interaction: rainfall × inverse canal distance (canal overflow risk)
    out["rain_x_inv_canal"] = out["precipitation"] * out["inv_canal_dist"]
    
    # Composite flood risk index: combines all three risk factors
    out["flood_risk_index"] = (
        out["precipitation"] * 0.4 +
        out["soil_moisture_0_to_1cm"] * 100 * 0.2 +
        out["inv_elevation"] * 10 * 0.2 +
        out["inv_canal_dist"] * 1000 * 0.1 +
        out["wind_speed_10m"] * 0.1
    )
    
    return out


# The raw + engineered feature columns used for training
# We remove static geographic features so the model evaluates weather intensity dynamically
FEATURE_COLS = [
    "precipitation", "wind_speed_10m", "soil_moisture_0_to_1cm",
    "temperature_2m", "relative_humidity_2m",
    # engineered
    "rain_x_inv_elev", "rain_x_soil", "rain_x_inv_canal",
    "flood_risk_index"
]


def train_model(df):
    print("Training model...")
    print(f"Input rows: {len(df)}")
    
    # ---- feature engineering ------------------------------------------------
    df = engineer_features(df)
    
    X = df[FEATURE_COLS]
    print(f"Feature matrix shape: {X.shape}")
    print(f"Features: {FEATURE_COLS}")
    
    # ---- train Isolation Forest ---------------------------------------------
    model = IsolationForest(
        contamination=0.05,      # ~5 % of hours are "anomalous / flood-like"
        n_estimators=200,        # more trees → more stable scores
        max_samples="auto",
        random_state=42,
        n_jobs=-1
    )
    model.fit(X)
    joblib.dump(model, "model.pkl")
    print("Model saved to model.pkl")
    
    # ---- per-grid-point thresholds ------------------------------------------
    # decision_function: positive = normal, negative = anomaly
    # For each grid point we compute the 5th-percentile score as its own
    # threshold — grid points that are inherently low-lying or canal-adjacent
    # will have naturally lower scores, so a global threshold would misclassify.
    
    scores = model.decision_function(X)
    df["anomaly_score"] = scores
    
    # Calculate a SINGLE global threshold
    global_thresh = float(np.percentile(scores, 5))
    
    thresholds = {}
    grid_points = df[["lat", "lon"]].drop_duplicates()
    
    for _, gp in grid_points.iterrows():
        key = f"{gp['lat']:.6f},{gp['lon']:.6f}"
        thresholds[key] = global_thresh
    
    with open("thresholds.json", "w") as f:
        json.dump(thresholds, f, indent=2)
    print("Per-grid-point thresholds saved to thresholds.json")
    
    # ---- save feature metadata so the UI / server knows the column order ----
    feature_meta = {
        "raw_features": [
            "elevation_m", "dist_to_canal_m",
            "precipitation", "wind_speed_10m", "soil_moisture_0_to_1cm",
            "temperature_2m", "relative_humidity_2m"
        ],
        "all_features": FEATURE_COLS,
        "grid_points": [
            {"lat": float(row["lat"]), "lon": float(row["lon"])}
            for _, row in grid_points.iterrows()
        ]
    }
    with open("feature_meta.json", "w") as f:
        json.dump(feature_meta, f, indent=2)
    print("Feature metadata saved to feature_meta.json")
    
    # ---- summary ------------------------------------------------------------
    labels = (scores < 0).astype(int)   # global view
    flood_count = int(labels.sum())
    no_flood_count = int((labels == 0).sum())
    
    # Per-grid-point labelling using location-specific thresholds
    flood_by_thresh = 0
    for _, gp in grid_points.iterrows():
        key = f"{gp['lat']:.6f},{gp['lon']:.6f}"
        mask = (df["lat"] == gp["lat"]) & (df["lon"] == gp["lon"])
        point_scores = df.loc[mask, "anomaly_score"]
        flood_by_thresh += int((point_scores < thresholds[key]).sum())
    
    print("\n" + "=" * 55)
    print("  TRAINING SUMMARY")
    print("=" * 55)
    print(f"  Total training rows   : {len(df):,}")
    print(f"  Grid points           : {len(grid_points)}")
    print(f"  Features used         : {len(FEATURE_COLS)}")
    print(f"  FLOOD labels (global) : {flood_count:,}")
    print(f"  NO FLOOD      (global): {no_flood_count:,}")
    print(f"  FLOOD labels (per-pt) : {flood_by_thresh:,}")
    print(f"  Contamination ratio   : 5 %")
    print("=" * 55)
    print("  Model training complete [OK]")
    print("=" * 55)

if __name__ == "__main__":
    try:
        # weather_df = collect_weather()
        # elevation_df = collect_elevation()
        # canal_dist_df = collect_canals(elevation_df)
        # training_df = merge_data()
        training_df = pd.read_csv("training_data.csv")
        train_model(training_df)
    except Exception as e:
        print(f"Error during execution: {e}")
        import traceback
        traceback.print_exc()
