// ─── State ──────────────────────────────────────────────────────────────────
let map, weatherCache = null, predictions = null;
let districtGeoJSON = null;
let currentTab = 'map';
let spatialIndex = null;
let districtsVisible = true, roadsVisible = true, reportsVisible = true;
let currentHour = 0, isArchiveMode = false, selectedPoint = null;
const BKK = { lat: 13.7563, lon: 100.5018 };
const LAT_STEP = 0.055556, LON_STEP = 0.066667;

// ─── Init ───────────────────────────────────────────────────────────────────
async function initMap() {
  map = new maplibregl.Map({
    container: 'map',
    style: 'https://tiles.openfreemap.org/styles/liberty',
    center: [100.5018, 13.7563],
    zoom: 12,
    pitch: 45,
    bearing: -10,
    antialias: true
  });

  map.addControl(new maplibregl.NavigationControl(), 'top-left');

  map.on('style.load', () => {
    map.easeTo({ pitch: 45, bearing: -10, duration: 1000 });
  });

  map.on('load', async () => {
    console.log('[Init] Map loaded');
    
    // 1. Add all sources first
    map.addSource('roads-risk', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addSource('districts', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addSource('report-points', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

    // 2. Add 3D buildings - detect correct source name from style
    const styleLayers = map.getStyle().layers;
    const buildingLayer = styleLayers.find(l => l['source-layer'] === 'building');
    const buildingSource = buildingLayer ? buildingLayer.source : 'openmaptiles';
    map.addLayer({
      id: '3d-buildings',
      source: buildingSource,
      'source-layer': 'building',
      type: 'fill-extrusion',
      minzoom: 14,
      paint: {
        'fill-extrusion-color': '#e8e0d8',
        'fill-extrusion-height': ['coalesce', ['get', 'render_height'], ['get', 'height'], 10],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], ['get', 'min_height'], 0],
        'fill-extrusion-opacity': 0.7
      }
    });

    // 3. Add road risk layer
    map.addLayer({
      id: 'roads-risk-layer',
      type: 'line',
      source: 'roads-risk',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': ['coalesce', ['get', 'color'], '#22c55e'],
        'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 10, 3, 15, 12, 18, 24],
        'line-opacity': 0.8,
        'line-blur': 0.5
      }
    });

    // 4. Add district layers
    map.addLayer({
      id: 'districts-fill',
      type: 'fill',
      source: 'districts',
      paint: {
        'fill-color': ['coalesce', ['get', 'color'], '#22c55e'],
        'fill-opacity': 0.3
      }
    });
    map.addLayer({
      id: 'districts-border',
      type: 'line',
      source: 'districts',
      paint: {
        'line-color': ['coalesce', ['get', 'border_color'], '#15803d'],
        'line-width': 1.5
      }
    });

    // 5. Add report points layer
    map.addLayer({
      id: 'report-points-layer',
      type: 'circle',
      source: 'report-points',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 6, 15, 14],
        'circle-color': ['coalesce', ['get', 'color'], '#ef4444'],
        'circle-opacity': 0.85,
        'circle-stroke-width': 2,
        'circle-stroke-color': 'white'
      }
    });

    // 5b. Add risk points layer (grid points)
    map.addSource('risk-points', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'risk-points-layer',
      type: 'circle',
      source: 'risk-points',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 3, 15, 8],
        'circle-color': ['coalesce', ['get', 'color'], '#22c55e'],
        'circle-opacity': 0.5,
        'circle-stroke-width': 1,
        'circle-stroke-color': 'rgba(255,255,255,0.3)'
      }
    });

    // Hover tooltips for roads
    map.on('mouseenter', 'roads-risk-layer', e => {
      map.getCanvas().style.cursor = 'pointer';
      const props = e.features[0].properties;
      new maplibregl.Popup({ closeButton: false, closeOnClick: false })
        .setLngLat(e.lngLat)
        .setHTML(`<b>${props.road_name || 'Road'}</b><br>Risk: <b style="color:${props.color}">${props.risk_tier}</b><br>Score: ${props.anomaly_score}`)
        .addTo(map);
    });
    map.on('mouseleave', 'roads-risk-layer', () => {
      map.getCanvas().style.cursor = '';
      document.querySelectorAll('.maplibregl-popup').forEach(p => p.remove());
    });

    // Hover for districts
    map.on('mouseenter', 'districts-fill', e => {
      const p = e.features[0].properties;
      new maplibregl.Popup({ closeButton: false })
        .setLngLat(e.lngLat)
        .setHTML(`<b>${p.name}</b><br>Risk: <b>${p.risk_tier}</b><br>Score: ${p.anomaly_score}`)
        .addTo(map);
    });
    map.on('mouseleave', 'districts-fill', () => {
      document.querySelectorAll('.maplibregl-popup').forEach(p => p.remove());
    });

    // Hover for report points
    map.on('mouseenter', 'report-points-layer', e => {
      map.getCanvas().style.cursor = 'pointer';
      const p = e.features[0].properties;
      new maplibregl.Popup({ closeButton: false })
        .setLngLat(e.lngLat)
        .setHTML(`<b>🚨 ${p.severity}</b><br>${p.description}<br><small>${p.reliability}</small>`)
        .addTo(map);
    });
    map.on('mouseleave', 'report-points-layer', () => {
      map.getCanvas().style.cursor = '';
      document.querySelectorAll('.maplibregl-popup').forEach(p => p.remove());
    });

    // 6. Load roads then fetch predictions
    await loadRoadGeometry();
    await fetchDistricts();
    await fetchAndPredict();
    await refreshReportMarkers();

    // 7. Start auto-refresh
    setInterval(refreshReportMarkers, 30000);

    addMapControls();
  });
}

async function fetchDistricts() {
  try {
    const resp = await fetch('https://raw.githubusercontent.com/apisit/thailand.json/master/thailandWithName.json');
    console.log(`Primary fetch status: ${resp.status}`);
    const data = await resp.json();
    console.log(`Primary elements returned: ${data.features ? data.features.length : 0}`);
    
    let bkkFeatures = (data.features || []).filter(f => {
      const name = (f.properties.name || f.properties.NAME_1 || '').toLowerCase();
      if (name.includes('bangkok') || name.includes('krung thep')) return true;
      const c = getFeatureCentroid(f);
      return c.lat >= 13.50 && c.lat <= 14.00 && c.lon >= 100.30 && c.lon <= 100.90;
    });
    
    if (bkkFeatures.length === 0) throw new Error('No Bangkok features in primary source');
    districtGeoJSON = { type: 'FeatureCollection', features: bkkFeatures };
  } catch (e) {
    console.error('Primary fetch error:', e);
    try {
      const resp = await fetch('https://raw.githubusercontent.com/cvibhagool/thailand-map/master/thailand-provinces.geojson');
      console.log(`Fallback fetch status: ${resp.status}`);
      const data = await resp.json();
      console.log(`Fallback elements returned: ${data.features ? data.features.length : 0}`);
      
      let bkkFeatures = (data.features || []).filter(f => {
        const name = (f.properties.name || f.properties.NAME_1 || '').toLowerCase();
        if (name.includes('bangkok') || name.includes('krung thep')) return true;
        const c = getFeatureCentroid(f);
        return c.lat >= 13.50 && c.lat <= 14.00 && c.lon >= 100.30 && c.lon <= 100.90;
      });
      
      if (bkkFeatures.length === 0) throw new Error('No Bangkok features in fallback source');
      districtGeoJSON = { type: 'FeatureCollection', features: bkkFeatures };
    } catch (e2) {
      console.error('Fallback fetch error:', e2);
      districtGeoJSON = buildSyntheticGrid();
    }
  }
}

async function loadRoadGeometry() {
  if (window._cachedRoadFeatures) return; // already loaded
  console.log('[Roads] Fetching from Overpass...');
  try {
    const overpassQuery = `
      [out:json][timeout:60];
      way["highway"~"primary|secondary|trunk|motorway|tertiary"]
        (13.55,100.35,13.95,100.85);
      out geom;
    `;
    const resp = await fetch('https://overpass.kumi.systems/api/interpreter', {
      method: 'POST',
      body: new URLSearchParams({ data: overpassQuery })
    });
    const data = await resp.json();
    window._cachedRoadFeatures = data.elements
      .filter(e => e.type === 'way' && e.geometry && e.geometry.length >= 2)
      .map(e => ({
        type: 'Feature',
        properties: { road_name: e.tags?.name || e.tags?.['name:en'] || 'Road' },
        geometry: {
          type: 'LineString',
          coordinates: e.geometry.map(n => [n.lon, n.lat])
        }
      }));
    console.log(`[Roads] Loaded ${window._cachedRoadFeatures.length} road segments`);
    // Initialize with default (safe) colors
    updateRoadColors([]);
  } catch(e) {
    console.warn('[Roads] Overpass fetch failed:', e);
    window._cachedRoadFeatures = [];
  }
}

function updateRoadColors(results) {
  if (!window._cachedRoadFeatures || window._cachedRoadFeatures.length === 0) {
    console.warn('[Roads] No cached road geometry yet');
    return;
  }
  const index = buildSpatialIndex(results);
  const features = window._cachedRoadFeatures.map(f => {
    const coords = f.geometry.coordinates;
    const mid = coords[Math.floor(coords.length / 2)];
    const nearest = nearestGridPoint(mid[1], mid[0], index);
    const style = nearest ? getRiskStyle(nearest.anomaly_score) : { color: '#16a34a', tier: 'Safe', opacity: 0.35 };
    return {
      ...f,
      properties: {
        ...f.properties,
        color: style.color,
        risk_tier: style.tier,
        opacity: style.opacity,
        anomaly_score: nearest?.anomaly_score?.toFixed(4) || 'N/A'
      }
    };
  });
  map.getSource('roads-risk').setData({ type: 'FeatureCollection', features });
  console.log(`[Roads] Colored ${features.length} road segments`);
}

function updateRiskPoints(results) {
  const features = results.map(r => {
    const style = getRiskStyle(r.anomaly_score);
    return {
      type: 'Feature',
      properties: {
        color: style.color,
        anomaly_score: r.anomaly_score.toFixed(4),
        label: r.label
      },
      geometry: { type: 'Point', coordinates: [r.lon, r.lat] }
    };
  });
  map.getSource('risk-points').setData({ type: 'FeatureCollection', features });
  console.log(`[Predict] Updated ${features.length} risk points`);
}

function getRiskStyle(score) {
  if (score <= -0.18) return { color: '#dc2626', tier: 'Critical', weight_low: 3.5, weight_high: 6, opacity: 0.95 }; // Deeper Red
  if (score <= -0.13) return { color: '#ea580c', tier: 'High',     weight_low: 3,   weight_high: 5, opacity: 0.9 };  // Deeper Orange
  if (score <= -0.05) return { color: '#fbbf24', tier: 'Moderate', weight_low: 2.5, weight_high: 4, opacity: 0.85 }; // Vivid Amber
  if (score <= 0.05)  return { color: '#4ade80', tier: 'Low',      weight_low: 2,   weight_high: 3, opacity: 0.7 };
  if (score <= 0.12)  return { color: '#22c55e', tier: 'Minimal',  weight_low: 1.5, weight_high: 2.5, opacity: 0.6 };
  return                       { color: '#16a34a', tier: 'Safe',    weight_low: 1,   weight_high: 2, opacity: 0.4 };
}

function getFeatureCentroid(feature) {
  let latSum = 0, lonSum = 0, count = 0;
  const geom = feature.geometry;
  if (!geom) return BKK;
  
  const extract = (arr) => {
    if (typeof arr[0] === 'number') {
      lonSum += arr[0]; latSum += arr[1]; count++;
    } else {
      arr.forEach(extract);
    }
  };
  extract(geom.coordinates);
  return count > 0 ? { lat: latSum / count, lon: lonSum / count } : BKK;
}

// District layer handled in initMap sources/layers


function updateDistrictLayer(districtGeoJSON, results) {
  const index = buildSpatialIndex(results);
  const features = districtGeoJSON.features.map(f => {
    const centroid = getPolygonCentroid(f.geometry.coordinates[0]);
    const nearest = nearestGridPoint(centroid[1], centroid[0], index);
    const style = nearest ? getRiskStyle(nearest.anomaly_score) : { color: '#22c55e', tier: 'Safe' };
    return {
      ...f,
      properties: {
        ...f.properties,
        color: style.color,
        border_color: style.color,
        risk_tier: style.tier,
        anomaly_score: nearest?.anomaly_score?.toFixed(4) || 'N/A'
      }
    };
  });
  map.getSource('districts').setData({ type: 'FeatureCollection', features });
  console.log(`[Districts] Updated ${features.length} features`);
}

function getPolygonCentroid(coords) {
  const lons = coords.map(c => c[0]);
  const lats = coords.map(c => c[1]);
  return [
    lons.reduce((a,b) => a+b,0) / lons.length,
    lats.reduce((a,b) => a+b,0) / lats.length
  ];
}

function addMapControls() {
  const ctrlContainer = document.createElement('div');
  ctrlContainer.className = 'maplibregl-ctrl map-toggle-ctrl';
  ctrlContainer.style.background = 'white';
  ctrlContainer.style.padding = '5px';
  ctrlContainer.style.borderRadius = '4px';
  ctrlContainer.style.display = 'flex';
  ctrlContainer.style.flexDirection = 'column';
  ctrlContainer.style.gap = '4px';
  ctrlContainer.style.boxShadow = '0 0 0 2px rgba(0,0,0,.1)';

  const btnDist = createToggleBtn('Districts', true, () => {
    toggleLayerVisibility('districts-fill', btnDist);
    toggleLayerVisibility('districts-border', null);
  });
  const btnRoads = createToggleBtn('Roads', true, () => {
    toggleLayerVisibility('roads-risk-layer', btnRoads);
  });
  const btnPoints = createToggleBtn('Grid', true, () => {
    toggleLayerVisibility('risk-points-layer', btnPoints);
  });
  const btnReports = createToggleBtn('Reports', true, () => {
    toggleLayerVisibility('report-points-layer', btnReports);
  });

  ctrlContainer.appendChild(btnDist);
  ctrlContainer.appendChild(btnRoads);
  ctrlContainer.appendChild(btnPoints);
  ctrlContainer.appendChild(btnReports);

  map.addControl({
    onAdd: () => ctrlContainer,
    onRemove: () => ctrlContainer.remove()
  }, 'top-right');
}

function createToggleBtn(label, active, onClick) {
  const btn = document.createElement('button');
  btn.textContent = label;
  btn.className = 'map-toggle-btn';
  btn.style.background = active ? '#1D4ED8' : 'white';
  btn.style.color = active ? 'white' : '#374151';
  btn.style.border = '1px solid #ddd';
  btn.style.padding = '4px 8px';
  btn.style.borderRadius = '3px';
  btn.style.fontSize = '10px';
  btn.style.fontWeight = '600';
  btn.style.cursor = 'pointer';
  btn.onclick = onClick;
  return btn;
}

function toggleLayerVisibility(layerId, btn) {
  const vis = map.getLayoutProperty(layerId, 'visibility') || 'visible';
  const newVis = vis === 'none' ? 'visible' : 'none';
  map.setLayoutProperty(layerId, 'visibility', newVis);
  if (btn) {
    btn.style.background = newVis === 'visible' ? '#1D4ED8' : 'white';
    btn.style.color = newVis === 'visible' ? 'white' : '#374151';
  }
}

async function refreshReportMarkers() {
  try {
    const resp = await fetch('/api/reports');
    if (!resp.ok) {
      console.warn(`[Reports] API returned ${resp.status}, skipping.`);
      return;
    }
    const reports = await resp.json();
    const sevColors = { ankle_deep:'#facc15', knee_deep:'#f97316', vehicle_submerged:'#ef4444', road_blocked:'#7c3aed' };
    
    const dateInput = document.getElementById('date-input');
    const selectedDate = dateInput ? dateInput.value : '';

    const features = reports
      .filter(r => {
        if (r.reliability === 'likely_spam' || r.status === 'spam' || r.status === 'resolved' || !r.lat || !r.lon) return false;
        if (selectedDate && r.timestamp) return r.timestamp.startsWith(selectedDate);
        return true;
      })
      .map(r => ({
        type: 'Feature',
        properties: {
          color: sevColors[r.severity] || '#9ca3af',
          severity: r.severity?.replace(/_/g,' ') || 'Unknown',
          description: r.description || '',
          reliability: r.reliability,
          id: r.id
        },
        geometry: { type: 'Point', coordinates: [r.lon, r.lat] }
      }));
    map.getSource('report-points').setData({ type: 'FeatureCollection', features });
    console.log(`[Reports] Loaded ${features.length} markers`);
  } catch(e) {
    console.warn('[Reports] Failed to load:', e);
  }
}

function setToday() {
  const d = new Date();
  const iso = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  document.getElementById('date-input').value = iso;
  currentHour = d.getHours();
  document.getElementById('s-hour').value = currentHour;
  updateHourLabel();
}

function updateHourLabel() {
  document.getElementById('v-hour').textContent = currentHour + ':00';
  document.getElementById('t-label').textContent = 'Hour ' + currentHour;
  const dateVal = document.getElementById('date-input').value;
  document.getElementById('sim-clock').textContent = dateVal + ' ' + currentHour + ':00';
}

// ─── Mode Toggle ────────────────────────────────────────────────────────────
function onModeToggle() {
  isArchiveMode = document.getElementById('mode-toggle').checked;
  const badge = document.getElementById('mode-badge');
  const label = document.getElementById('mode-label');
  const badgeText = document.getElementById('badge-text');
  if (isArchiveMode) {
    label.textContent = 'Historical Archive';
    badgeText.textContent = 'Archive';
    badge.className = 'badge';
  } else {
    label.textContent = 'Live Forecast';
    badgeText.textContent = 'Live Forecast';
    badge.className = 'badge live';
  }
}

function onHourSlider() {
  currentHour = +document.getElementById('s-hour').value;
  updateHourLabel();
  if (weatherCache) renderForHour();
}

function stepHour(dir) {
  currentHour = Math.max(0, Math.min(23, currentHour + dir));
  document.getElementById('s-hour').value = currentHour;
  updateHourLabel();
  if (weatherCache) renderForHour();
}

// ─── Fetch Weather ──────────────────────────────────────────────────────────
async function fetchWeather(dateStr) {
  const base = isArchiveMode
    ? 'https://archive-api.open-meteo.com/v1/archive'
    : 'https://api.open-meteo.com/v1/forecast';

  // Archive API uses soil_moisture_0_to_7cm; forecast uses soil_moisture_0_to_1cm
  const soilField = isArchiveMode ? 'soil_moisture_0_to_7cm' : 'soil_moisture_0_to_1cm';
  const hourlyFields = `precipitation,wind_speed_10m,${soilField},temperature_2m,relative_humidity_2m`;

  const params = new URLSearchParams({
    latitude: BKK.lat, longitude: BKK.lon,
    hourly: hourlyFields, timezone: 'Asia/Bangkok'
  });

  if (isArchiveMode) {
    params.set('start_date', dateStr);
    params.set('end_date', dateStr);
  } else {
    // Forecast mode - just get the data (API returns current + future days)
  }

  const resp = await fetch(`${base}?${params}`);
  if (!resp.ok) throw new Error(`Weather API error: ${resp.status}`);
  const data = await resp.json();

  // Normalize soil moisture field name
  const hourly = data.hourly;
  if (hourly[soilField] && soilField !== 'soil_moisture_0_to_1cm') {
    hourly.soil_moisture_0_to_1cm = hourly[soilField];
  }

  // Find the index range for the requested date
  const times = hourly.time;
  const dayData = { time: [], precipitation: [], wind_speed_10m: [], soil_moisture_0_to_1cm: [], temperature_2m: [], relative_humidity_2m: [] };

  for (let i = 0; i < times.length; i++) {
    if (times[i].startsWith(dateStr)) {
      dayData.time.push(times[i]);
      dayData.precipitation.push(hourly.precipitation[i] || 0);
      dayData.wind_speed_10m.push(hourly.wind_speed_10m[i] || 0);
      let sm = hourly.soil_moisture_0_to_1cm[i] || 0;
      if (!isArchiveMode) {
        // Forecast API uses a different model (e.g. ICON) where soil moisture is ~0.35, 
        // whereas the ERA5 Archive used for training was ~0.05.
        // Scale it down so the Isolation Forest doesn't flag it as a massive anomaly.
        sm = sm / 7.0;
      }
      dayData.soil_moisture_0_to_1cm.push(sm);
      dayData.temperature_2m.push(hourly.temperature_2m[i] || 25);
      dayData.relative_humidity_2m.push(hourly.relative_humidity_2m[i] || 70);
    }
  }
  return dayData;
}

// ─── Predict ────────────────────────────────────────────────────────────────
async function predict(weather) {
  const resp = await fetch('/api/predict', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ weather })
  });
  if (!resp.ok) throw new Error(`Predict API error: ${resp.status}`);
  const results = (await resp.json()).results;
  console.log(`[Predict] Got ${results.length} results`);
  spatialIndex = buildSpatialIndex(results);
  return results;
}

// ─── Main Flow ──────────────────────────────────────────────────────────────
async function fetchAndPredict() {
  const btn = document.getElementById('fetch-btn');
  const loading = document.getElementById('loading');
  btn.disabled = true;
  btn.textContent = '⟳ Loading…';
  loading.classList.remove('hidden');

  try {
    const dateStr = document.getElementById('date-input').value;
    if (!dateStr) { alert('Please select a date'); return; }

    console.log(`[Predict] Fetching weather for ${dateStr}`);
    weatherCache = await fetchWeather(dateStr);
    if (weatherCache.time.length === 0) {
      alert('No data returned for this date. Try a different date.');
      return;
    }
    
    // Find the hour with the maximum precipitation
    let peakHour = 0;
    let maxRain = -1;
    for (let i = 0; i < weatherCache.precipitation.length; i++) {
      if (weatherCache.precipitation[i] > maxRain) {
        maxRain = weatherCache.precipitation[i];
        peakHour = i;
      }
    }
    
    // If there is rain, snap to the peak hour. Otherwise, clamp to available data
    if (maxRain > 0) {
      currentHour = peakHour;
    } else if (currentHour >= weatherCache.time.length) {
      currentHour = weatherCache.time.length - 1;
    }
    
    document.getElementById('s-hour').max = weatherCache.time.length - 1;
    document.getElementById('s-hour').value = currentHour;
    await renderForHour();
    refreshReportMarkers();
    let statusHTML = '<span class="sd sd-green"></span>' + (isArchiveMode ? 'Archive: ' : 'Live: ') + dateStr;
    if (predictions) {
      const zeroElevCount = predictions.filter(p => p.elevation_m === 0 || p.elevation_m === 0.0).length;
      if (zeroElevCount > predictions.length * 0.2) {
        statusHTML += ' <span class="badge" style="display:inline-flex; background:#ffedd5; color:#c2410c; border:1px solid #fdba74; margin-left:8px;">⚠ Elevation data incomplete — predictions may be less accurate</span>';
      }
      
      const gridCountSpan = document.getElementById('status-grid-count');
      if (gridCountSpan) {
        gridCountSpan.innerHTML = `<span class="sd sd-green"></span>${predictions.length.toLocaleString()} grid points`;
      }
    }
    document.getElementById('status-src').innerHTML = statusHTML;
  } catch (e) {
    console.error(e);
    alert('Error: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '⟳ Fetch & Predict';
    loading.classList.add('hidden');
  }
}

async function renderForHour() {
  if (!weatherCache) return;
  const h = Math.min(currentHour, weatherCache.time.length - 1);
  const weather = {
    precipitation: weatherCache.precipitation[h],
    wind_speed_10m: weatherCache.wind_speed_10m[h],
    soil_moisture_0_to_1cm: weatherCache.soil_moisture_0_to_1cm[h],
    temperature_2m: weatherCache.temperature_2m[h],
    relative_humidity_2m: weatherCache.relative_humidity_2m[h]
  };

  // Update sidebar metrics
  document.getElementById('m-rain').innerHTML = weather.precipitation.toFixed(1) + '<span class="mc-u"> mm</span>';
  document.getElementById('m-wind').innerHTML = weather.wind_speed_10m.toFixed(1) + '<span class="mc-u"> km/h</span>';
  document.getElementById('m-soil').innerHTML = weather.soil_moisture_0_to_1cm.toFixed(3) + '<span class="mc-u"> m³/m³</span>';
  document.getElementById('d-rain').textContent = weather.precipitation > 1 ? '▲ raining' : '— dry';
  document.getElementById('d-rain').className = 'mc-d ' + (weather.precipitation > 1 ? 'up' : 'dn');
  document.getElementById('d-wind').textContent = weather.wind_speed_10m > 15 ? '▲ strong' : '— calm';
  document.getElementById('d-wind').className = 'mc-d ' + (weather.wind_speed_10m > 15 ? 'up' : 'nt');
  document.getElementById('d-soil').textContent = weather.soil_moisture_0_to_1cm > 0.35 ? '▲ saturated' : '— normal';
  document.getElementById('d-soil').className = 'mc-d ' + (weather.soil_moisture_0_to_1cm > 0.35 ? 'up' : 'nt');

  updateHourLabel();
  predictions = await predict(weather);
  renderLayers();
  updateDataTable();
  if (selectedPoint !== null) updatePointDetails(selectedPoint);
}

function getRiskFromScore(anomalyScore) {
  if (anomalyScore <= -0.18) return { risk: 1.00, tier: 'Critical' };
  if (anomalyScore <= -0.13) return { risk: 0.80, tier: 'High' };
  if (anomalyScore <= -0.05) return { risk: 0.60, tier: 'Moderate' };
  if (anomalyScore <= 0.05)  return { risk: 0.40, tier: 'Low' };
  if (anomalyScore <= 0.12)  return { risk: 0.20, tier: 'Minimal' };
  return { risk: 0.0, tier: 'Safe' };
}

function getRiskColor(tier) {
  const colors = {
    'Critical': { fill: '#ef4444', border: '#b91c1c' },
    'High':     { fill: '#f97316', border: '#c2410c' },
    'Moderate': { fill: '#facc15', border: '#a16207' },
    'Low':      { fill: '#86efac', border: '#15803d' },
    'Minimal':  { fill: '#22c55e', border: '#15803d' },
    'Safe':     { fill: '#16a34a', border: '#14532d' },
  };
  return colors[tier] || colors['Safe'];
}

// ─── Map Rendering ──────────────────────────────────────────────────────────
async function renderLayers() {
  if (!predictions) return;

  // 1. Districts
  if (districtGeoJSON) {
    updateDistrictLayer(districtGeoJSON, predictions);
  }

  // 2. Roads
  updateRoadColors(predictions);

  // 3. Risk Points (Dots)
  updateRiskPoints(predictions);
}

function buildSpatialIndex(results) {
  const index = {};
  for (const r of results) {
    const key = `${Math.floor(r.lat * 200)},${Math.floor(r.lon * 200)}`;
    index[key] = r;
  }
  return index;
}

function nearestGridPoint(lat, lon, index) {
  if (!index) return null;
  // Check the 25 surrounding cells (+/- 2)
  let best = null, bestDist = Infinity;
  for (let dlat = -2; dlat <= 2; dlat++) {
    for (let dlon = -2; dlon <= 2; dlon++) {
      const key = `${Math.floor(lat * 200) + dlat},${Math.floor(lon * 200) + dlon}`;
      const r = index[key];
      if (!r) continue;
      const d = Math.hypot(r.lat - lat, r.lon - lon);
      if (d < bestDist) { bestDist = d; best = r; }
    }
  }
  return best;
}

function normalizeScore(score) {
  // Normalize anomaly score to 0-1 range for progress bar
  // More negative = more anomalous = higher flood risk
  // Typical range: -0.15 to +0.08
  return Math.max(0, Math.min(1, (score + 0.15) / 0.23));
}

// ─── Point Details Sidebar ──────────────────────────────────────────────────
function updatePointDetails(i) {
  const p = predictions[i];
  document.getElementById('point-details').classList.remove('hidden');
  document.getElementById('pt-pos').textContent = p.lat.toFixed(4) + ', ' + p.lon.toFixed(4);
  document.getElementById('pt-elev').textContent = p.elevation_m + ' m';
  document.getElementById('pt-canal').textContent = p.dist_to_canal_m.toFixed(0) + ' m';
  document.getElementById('pt-score').textContent = p.anomaly_score.toFixed(5);
  document.getElementById('pt-thresh').textContent = p.threshold.toFixed(5);
  document.getElementById('m-elev').innerHTML = p.elevation_m + '<span class="mc-u"> m</span>';
  document.getElementById('d-elev').textContent = p.elevation_m < 2 ? '▼ low-lying' : '— normal';
  document.getElementById('d-elev').className = 'mc-d ' + (p.elevation_m < 2 ? 'up' : 'nt');

  const isFlood = p.label === 'FLOOD';
  const bar = document.getElementById('pt-bar');
  bar.style.width = p.flood_confidence_pct + '%';
  bar.className = 'prog-fill ' + (isFlood ? 'pred-flood' : 'pred-safe');

  const pred = document.getElementById('pt-pred');
  pred.innerHTML = `<span class="pred-tag ${isFlood ? 'flood' : 'safe'}">${p.label}</span>`;
  
  const riskInfo = getRiskFromScore(p.anomaly_score);
  const rc = getRiskColor(riskInfo.tier);
  document.getElementById('pt-risk').innerHTML = `<span style="color:${rc.fill}; font-weight:bold">${riskInfo.tier}</span> (${(riskInfo.risk * 100).toFixed(1)}%)`;
}

// ─── Data Table ─────────────────────────────────────────────────────────────
function updateDataTable() {
  const tbody = document.getElementById('data-table-body');
  tbody.innerHTML = '';
  if (!predictions) return;

  const h = Math.min(currentHour, (weatherCache?.time.length || 1) - 1);
  
  // Sort predictions by anomaly score (lowest first = highest risk) and take top 50
  const sortedPredictions = [...predictions].sort((a, b) => a.anomaly_score - b.anomaly_score).slice(0, 50);
  
  sortedPredictions.forEach((p, index) => {
    // Find original index for updatePointDetails
    const origIndex = predictions.indexOf(p);
    const isFlood = p.label === 'FLOOD';
    const confVal = p.flood_confidence_pct;
    const confPill = `<span style="padding:2px 8px; border-radius:12px; font-weight:bold; font-size:10px; color:#fff; background:${isFlood ? '#ef4444' : '#22c55e'}">${confVal.toFixed(1)}%</span>`;
    
    let elevDisplay = p.elevation_m;
    if (p.elevation_m === 5.0 && p.dist_to_canal_m === 800.0) {
      elevDisplay = `<span style="color:#9ca3af; font-style:italic">~${p.elevation_m}</span>`;
    }
    
    const tr = document.createElement('tr');
    tr.style.cursor = 'pointer';
    tr.onclick = () => { selectedPoint = origIndex; updatePointDetails(origIndex); switchTab('map'); };
    
    tr.innerHTML = `
      <td>${index + 1}</td>
      <td>${p.lat.toFixed(4)}</td>
      <td>${p.lon.toFixed(4)}</td>
      <td>${elevDisplay}</td>
      <td>${p.dist_to_canal_m.toFixed(0)}</td>
      <td>${weatherCache ? weatherCache.precipitation[h].toFixed(1) : '--'}</td>
      <td>${weatherCache ? weatherCache.wind_speed_10m[h].toFixed(1) : '--'}</td>
      <td>${weatherCache ? weatherCache.soil_moisture_0_to_1cm[h].toFixed(3) : '--'}</td>
      <td>${p.anomaly_score.toFixed(4)}</td>
      <td>${confPill}</td>
      <td><span class="pred-tag ${isFlood ? 'flood' : 'safe'}">${p.label}</span></td>
    `;
    tbody.appendChild(tr);
  });
}

// ─── Tab Switching ──────────────────────────────────────────────────────────
function switchTab(tabId) {
  currentTab = tabId;
  const isMapVisible = (tabId === 'map' || tabId === 'points');
  
  document.getElementById('btn-map').classList.toggle('active', tabId === 'map');
  const btnPoints = document.getElementById('btn-points');
  if (btnPoints) btnPoints.classList.toggle('active', tabId === 'points');
  document.getElementById('btn-data').classList.toggle('active', tabId === 'data');
  
  document.getElementById('map').style.display = isMapVisible ? 'block' : 'none';
  document.getElementById('data-panel').style.display = tabId === 'data' ? 'block' : 'none';
  
  if (isMapVisible) map.resize();
  
  if (tabId === 'points') {
    document.getElementById('map').classList.add('points-tab-active');
  } else {
    document.getElementById('map').classList.remove('points-tab-active');
  }
  
  // Points tab is now handled by the roads/districts layer updates 
  // or can be added as a separate MapLibre layer.
}

// ─── REPORT DIALOG ──────────────────────────────────────────────
let reportLat = null, reportLon = null, reportSeverity = null, reportMap = null;

function openReportDialog() {
  const overlay = document.getElementById('report-overlay');
  overlay.style.display = 'flex';
  document.getElementById('report-success').style.display = 'none';
  document.getElementById('submit-btn').style.display = 'block';
  document.getElementById('report-error').style.display = 'none';
  // Init mini map inside dialog
  setTimeout(() => {
    if (reportMap) { reportMap.remove(); reportMap = null; }
    reportMap = new maplibregl.Map({
      container: 'report-map',
      style: 'https://tiles.openfreemap.org/styles/liberty',
      center: [100.5018, 13.7563],
      zoom: 12
    });
    
    let marker;
    
    const setPos = (lng, lat) => {
      reportLat = lat;
      reportLon = lng;
      document.getElementById('location-status').textContent = `📍 ${reportLat.toFixed(5)}, ${reportLon.toFixed(5)}`;
      if (!marker) {
        marker = new maplibregl.Marker({ draggable: true })
          .setLngLat([lng, lat])
          .addTo(reportMap);
        marker.on('dragend', () => {
          const lngLat = marker.getLngLat();
          reportLat = lngLat.lat;
          reportLon = lngLat.lng;
          document.getElementById('location-status').textContent = `📍 ${reportLat.toFixed(5)}, ${reportLon.toFixed(5)}`;
        });
      } else {
        marker.setLngLat([lng, lat]);
      }
    };

    // Try GPS
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(pos => {
        setPos(pos.coords.longitude, pos.coords.latitude);
        reportMap.setCenter([pos.coords.longitude, pos.coords.latitude]);
        reportMap.setZoom(15);
      }, () => {
        setPos(100.5018, 13.7563);
        document.getElementById('location-status').textContent = '⚠ GPS unavailable — drag pin to your location';
      });
    } else {
      setPos(100.5018, 13.7563);
    }
  }, 100);
}

function closeReportDialog() {
  document.getElementById('report-overlay').style.display = 'none';
  reportSeverity = null;
  document.querySelectorAll('.sev-btn').forEach(b => b.style.borderColor = '#e5e7eb');
  document.getElementById('report-desc').value = '';
  document.getElementById('report-photo').value = '';
  document.getElementById('photo-preview').style.display = 'none';
}

function selectSeverity(btn) {
  document.querySelectorAll('.sev-btn').forEach(b => {
    b.style.borderColor = '#e5e7eb';
    b.style.background = 'white';
  });
  btn.style.borderColor = '#1D4ED8';
  btn.style.background = '#eff6ff';
  reportSeverity = btn.dataset.sev;
}

function previewPhoto(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const img = document.getElementById('photo-preview');
    img.src = e.target.result;
    img.style.display = 'block';
  };
  reader.readAsDataURL(file);
}

async function submitReport() {
  const errEl = document.getElementById('report-error');
  errEl.style.display = 'none';
  if (!reportLat || !reportLon) {
    errEl.textContent = 'Please allow location access or drag the pin to your location.';
    errEl.style.display = 'block'; return;
  }
  if (!reportSeverity) {
    errEl.textContent = 'Please select a flood severity level.';
    errEl.style.display = 'block'; return;
  }
  const photoInput = document.getElementById('report-photo');
  let photoData = null;
  if (photoInput.files[0]) {
    photoData = await new Promise(res => {
      const r = new FileReader();
      r.onload = e => res(e.target.result);
      r.readAsDataURL(photoInput.files[0]);
    });
  }
  const btn = document.getElementById('submit-btn');
  btn.textContent = 'Submitting...';
  btn.disabled = true;
  try {
    const resp = await fetch('/api/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lat: reportLat, lon: reportLon,
        severity: reportSeverity,
        description: document.getElementById('report-desc').value,
        photo: photoData
      })
    });
    const result = await resp.json();
    document.getElementById('submit-btn').style.display = 'none';
    document.getElementById('report-success').style.display = 'block';
    document.getElementById('success-detail').textContent =
      `Report ID: ${result.report_id} · Status: ${result.reliability === 'verified' ? '✓ Verified' : result.reliability === 'suspicious' ? '⚠ Under review' : 'Received'}`;
    refreshReportMarkers();
  } catch(e) {
    errEl.textContent = 'Submission failed. Is the server running?';
    errEl.style.display = 'block';
    btn.textContent = 'Submit Report';
    btn.disabled = false;
  }
}

// ─── ADMIN PANEL ────────────────────────────────────────────────
let allReports = [], currentFilter = 'all';

async function openAdminPanel() {
  document.getElementById('admin-overlay').style.display = 'flex';
  await loadAdminReports();
}

function closeAdminPanel() {
  document.getElementById('admin-overlay').style.display = 'none';
}

async function loadAdminReports() {
  const resp = await fetch('/api/reports');
  allReports = await resp.json();
  allReports.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  renderAdminStats();
  renderAdminFeed(currentFilter);
}

function renderAdminStats() {
  const total = allReports.length;
  const pending = allReports.filter(r => r.status === 'pending').length;
  const dispatched = allReports.filter(r => r.status === 'dispatched').length;
  const verified = allReports.filter(r => r.reliability === 'verified').length;
  const statsEl = document.getElementById('admin-stats');
  if (statsEl) {
    statsEl.innerHTML = `
      <span style="background:#f3f4f6;padding:4px 10px;border-radius:20px"><b>${total}</b> Total</span>
      <span style="background:#fef3c7;padding:4px 10px;border-radius:20px"><b>${pending}</b> Pending</span>
      <span style="background:#dbeafe;padding:4px 10px;border-radius:20px"><b>${dispatched}</b> Dispatched</span>
      <span style="background:#dcfce7;padding:4px 10px;border-radius:20px"><b>${verified}</b> Verified</span>
    `;
  }
}

function renderAdminFeed(filter) {
  const filtered = filter === 'all' ? allReports : allReports.filter(r => r.status === filter);
  const sevColors = { ankle_deep:'#facc15', knee_deep:'#f97316', vehicle_submerged:'#ef4444', road_blocked:'#7c3aed' };
  const sevLabels = { ankle_deep:'Ankle-deep', knee_deep:'Knee-deep', vehicle_submerged:'Vehicle submerged', road_blocked:'Road blocked' };
  const statusColors = { pending:'#fef3c7', dispatched:'#dbeafe', resolved:'#dcfce7', spam:'#f3f4f6' };
  const feedEl = document.getElementById('admin-feed');
  if (feedEl) {
    feedEl.innerHTML = filtered.length === 0
      ? '<div style="text-align:center;color:#9ca3af;padding:40px;font-size:13px">No reports found</div>'
      : filtered.map(r => `
        <div style="border:1px solid #e5e7eb;border-radius:8px;padding:12px;margin-bottom:8px;cursor:pointer" onclick="adminSelectReport('${r.id}')">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
            <div style="display:flex;align-items:center;gap:8px">
              <span style="width:10px;height:10px;border-radius:50%;background:${sevColors[r.severity]||'#9ca3af'};display:inline-block"></span>
              <span style="font-size:12px;font-weight:600">${sevLabels[r.severity]||r.severity}</span>
              <span style="font-size:11px;color:#6b7280">${r.id}</span>
            </div>
            <span style="font-size:11px;padding:2px 8px;border-radius:20px;background:${statusColors[r.status]||'#f3f4f6'}">${r.status}</span>
          </div>
          <div style="font-size:11px;color:#6b7280;margin-bottom:4px">📍 ${r.lat?.toFixed(4)}, ${r.lon?.toFixed(4)} · ${new Date(r.timestamp).toLocaleTimeString()}</div>
          ${r.description ? `<div style="font-size:12px;color:#374151;margin-bottom:6px">${r.description}</div>` : ''}
          <div style="display:flex;gap:6px;margin-top:8px">
            ${r.status === 'pending' ? `<button onclick="event.stopPropagation();updateReportStatus('${r.id}','dispatched')" style="font-size:11px;padding:4px 10px;background:#1D4ED8;color:white;border:none;border-radius:4px;cursor:pointer">✓ Dispatch</button>` : ''}
            ${r.status !== 'resolved' ? `<button onclick="event.stopPropagation();updateReportStatus('${r.id}','resolved')" style="font-size:11px;padding:4px 10px;background:#15803d;color:white;border:none;border-radius:4px;cursor:pointer">✓ Resolve</button>` : ''}
            ${r.status === 'pending' ? `<button onclick="event.stopPropagation();updateReportStatus('${r.id}','spam')" style="font-size:11px;padding:4px 10px;background:#f3f4f6;color:#6b7280;border:1px solid #e5e7eb;border-radius:4px;cursor:pointer">✗ Spam</button>` : ''}
          </div>
        </div>
      `).join('');
  }
}

function filterReports(filter, btn) {
  currentFilter = filter;
  document.querySelectorAll('.filter-btn').forEach(b => {
    b.style.background = 'white'; b.style.color = '#374151'; b.style.borderColor = '#e5e7eb';
  });
  btn.style.background = '#1D4ED8'; btn.style.color = 'white'; btn.style.borderColor = '#1D4ED8';
  renderAdminFeed(filter);
}

async function updateReportStatus(id, status) {
  await fetch(`/api/reports/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status })
  });
  await loadAdminReports();
  refreshReportMarkers();
}

function adminSelectReport(id) {
  const r = allReports.find(x => x.id === id);
  if (!r || !r.lat || !r.lon) return;
  closeAdminPanel();
  map.flyTo({ center: [r.lon, r.lat], zoom: 15 });
}

// reportMarkerLayer and reportMarkers are no longer needed as reports are handled via GeoJSON layers.


// ─── Boot ───────────────────────────────────────────────────────────────────
async function boot() {
  await initMap();
  setToday();
}

boot();
