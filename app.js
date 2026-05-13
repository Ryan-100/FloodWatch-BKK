// ─── State ──────────────────────────────────────────────────────────────────
let map, weatherCache = null, predictions = null;
let districtGeoJSON = null, districtLayer = null;
let roadGeoJSON = null, roadLayer = null, allRoadsLayer = null;
let roadFeatures = [];
let pointsLayer = null, pointFeatures = [];
let canvasRenderer = null;
let currentTab = 'map';
let spatialIndex = null;
let districtsVisible = true, roadsVisible = true, allRoadsVisible = false, reportsVisible = true;
let reportsLayer = null;
let currentHour = 0, isArchiveMode = false, selectedPoint = null;
const BKK = { lat: 13.7563, lon: 100.5018 };
const LAT_STEP = 0.055556, LON_STEP = 0.066667;

// ─── Init ───────────────────────────────────────────────────────────────────
async function initMap() {
  map = L.map('map', { center: [13.75, 100.55], zoom: 11 });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap', maxZoom: 19
  }).addTo(map);
  
  canvasRenderer = L.canvas({ padding: 0.5 });
  pointsLayer = L.layerGroup();
  
  await fetchDistricts();
  await fetchRoads();
  
  reportsLayer = L.layerGroup().addTo(map);
  fetchAndRenderReports();
  setInterval(fetchAndRenderReports, 30000);
  
  addMapControls();
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

async function fetchRoads() {
  try {
    const statusSrc = document.getElementById('status-src');
    if (statusSrc) statusSrc.innerHTML = `<span class="sd sd-orange"></span>Fetching road network…`;
    
    const overpassQuery = `
      [out:json][timeout:60];
      way["highway"~"primary|secondary|tertiary|residential|trunk|motorway"]
        (13.55,100.35,13.95,100.85);
      out geom;
    `;
    const response = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: new URLSearchParams({ data: overpassQuery })
    });
    if (!response.ok) throw new Error(`Overpass API error: ${response.status}`);
    const data = await response.json();
    
    let features = [];
    if (data.elements) {
      data.elements.forEach(way => {
        if (way.type === 'way' && way.geometry) {
          const coords = way.geometry.map(node => [node.lon, node.lat]);
          features.push({
            type: 'Feature',
            properties: {
              name: way.tags && way.tags.name ? way.tags.name : 'Unnamed road',
              highway: way.tags && way.tags.highway ? way.tags.highway : 'unknown'
            },
            geometry: {
              type: 'LineString',
              coordinates: coords
            }
          });
        }
      });
    }
    roadGeoJSON = { type: 'FeatureCollection', features };
    
    // Build Leaflet layers ONCE to prevent UI freezing and layer disappearance
    roadLayer = L.layerGroup();
    allRoadsLayer = L.layerGroup();
    roadFeatures = [];
    
    const majorHighways = ['primary', 'secondary', 'trunk', 'motorway'];
    
    roadGeoJSON.features.forEach(feature => {
      let midLat = 0, midLon = 0;
      const coords = feature.geometry.coordinates;
      if (coords && coords.length > 0) {
        const midIndex = Math.floor(coords.length / 2);
        midLon = coords[midIndex][0];
        midLat = coords[midIndex][1];
      }
      
      const isMajor = majorHighways.includes(feature.properties.highway);
      
      const pl = L.polyline(coords.map(c => [c[1], c[0]]), {
        renderer: canvasRenderer,
        color: '#808080', weight: isMajor ? 2 : 1, opacity: 0.5
      });
      
      pl._midLat = midLat;
      pl._midLon = midLon;
      pl._isMajor = isMajor;
      pl._featureName = feature.properties.name;
      
      if (isMajor) roadLayer.addLayer(pl);
      else allRoadsLayer.addLayer(pl);
      
      roadFeatures.push(pl);
    });
    
    if (roadsVisible) roadLayer.addTo(map);
    if (allRoadsVisible) allRoadsLayer.addTo(map);
    
    if (statusSrc) statusSrc.innerHTML = `<span class="sd sd-orange"></span>Awaiting data`;
    
    // If predictions already loaded, style them immediately
    if (predictions) {
      console.log("Predictions already available, styling roads...");
      renderLayers();
    } else {
      console.log("Predictions not yet available, roads will be styled on next update.");
    }
  } catch (e) {
    console.warn('Road network fetch failed:', e);
    const statusSrc = document.getElementById('status-src');
    if (statusSrc) statusSrc.innerHTML = `<span class="sd sd-red"></span>Roads unavailable`;
  }
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

function buildSyntheticGrid() {
  console.log('Building synthetic grid');
  const features = [];
  const latStart = 13.50, latEnd = 14.00;
  const lonStart = 100.30, lonEnd = 100.90;
  const latStep = (latEnd - latStart) / 7;
  const lonStep = (lonEnd - lonStart) / 7;
  const rows = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
  
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const minLat = latStart + r * latStep;
      const maxLat = minLat + latStep;
      const minLon = lonStart + c * lonStep;
      const maxLon = minLon + lonStep;
      
      features.push({
        type: 'Feature',
        properties: { name: `Zone ${rows[r]}${c+1}` },
        geometry: {
          type: 'Polygon',
          coordinates: [[[minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat]]]
        }
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

function addMapControls() {
  const ctrl = L.control({ position: 'topright' });
  ctrl.onAdd = function() {
    const div = L.DomUtil.create('div', 'map-toggle-ctrl');
    div.innerHTML = `
      <button id="tog-dist" class="map-toggle-btn active" onclick="toggleLayer('dist')">Districts</button>
      <button id="tog-roads" class="map-toggle-btn active" onclick="toggleLayer('roads')">Roads</button>
      <button id="tog-all-roads" class="map-toggle-btn" onclick="toggleLayer('all-roads')">All Roads</button>
      <button id="tog-reports" class="map-toggle-btn active" onclick="toggleLayer('reports')">Reports</button>
    `;
    L.DomEvent.disableClickPropagation(div);
    return div;
  };
  ctrl.addTo(map);
}

function toggleLayer(type) {
  if (type === 'dist') {
    if (!districtLayer) return;
    const has = map.hasLayer(districtLayer);
    has ? map.removeLayer(districtLayer) : map.addLayer(districtLayer);
    districtsVisible = !has;
    const btn = document.getElementById('tog-dist');
    btn.style.backgroundColor = districtsVisible ? '#1D4ED8' : '#ffffff';
    btn.style.color = districtsVisible ? '#ffffff' : '#444444';
  } else if (type === 'roads') {
    if (!roadLayer) return;
    const has = map.hasLayer(roadLayer);
    if (has) {
      map.removeLayer(roadLayer);
    } else {
      map.addLayer(roadLayer);
    }
    roadsVisible = !has;
    const btn = document.getElementById('tog-roads');
    btn.style.backgroundColor = roadsVisible ? '#1D4ED8' : '#ffffff';
    btn.style.color = roadsVisible ? '#ffffff' : '#444444';
  } else if (type === 'all-roads') {
    if (!allRoadsLayer) return;
    const has = map.hasLayer(allRoadsLayer);
    has ? map.removeLayer(allRoadsLayer) : map.addLayer(allRoadsLayer);
    allRoadsVisible = !has;
    const btn = document.getElementById('tog-all-roads');
    btn.style.backgroundColor = allRoadsVisible ? '#1D4ED8' : '#ffffff';
    btn.style.color = allRoadsVisible ? '#ffffff' : '#444444';
  } else if (type === 'reports') {
    if (!reportsLayer) return;
    const has = map.hasLayer(reportsLayer);
    has ? map.removeLayer(reportsLayer) : map.addLayer(reportsLayer);
    reportsVisible = !has;
    const btn = document.getElementById('tog-reports');
    btn.style.backgroundColor = reportsVisible ? '#1D4ED8' : '#ffffff';
    btn.style.color = reportsVisible ? '#ffffff' : '#444444';
  }
}

async function fetchAndRenderReports() {
  if (!reportsLayer) return;
  try {
    const resp = await fetch('/api/reports');
    const data = await resp.json();
    reportsLayer.clearLayers();
    
    // Only show verified + pending/dispatched reports on main map
    data.filter(r => r.reliability === 'verified' && r.status !== 'spam' && r.status !== 'resolved').forEach(r => {
      const marker = L.circleMarker([r.lat, r.lon], {
        radius: 6,
        fillColor: '#ef4444',
        color: '#fff',
        weight: 1,
        fillOpacity: 0.8,
        className: 'citizen-report-dot'
      });
      marker.bindTooltip(`Citizen Report: ${r.severity.replace('_',' ')}`, { sticky: true });
      marker.addTo(reportsLayer);
    });
  } catch (e) { console.warn("Failed to fetch reports for main map", e); }
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
function renderLayers() {
  if (districtLayer) map.removeLayer(districtLayer);

  // 1. Districts
  if (districtGeoJSON) {
    const h = Math.min(currentHour, weatherCache.time.length - 1);
    const currentRain = weatherCache.precipitation[h].toFixed(1);
    
    districtGeoJSON.features.forEach(feature => {
      let centroid = BKK;
      if (feature.properties.centroid) centroid = feature.properties.centroid;
      else if (feature.geometry) centroid = getFeatureCentroid(feature);
      
      const p = nearestGridPoint(centroid.lat, centroid.lon, predictions);
      feature.properties.label = p.label;
      feature.properties.anomaly_score = p.anomaly_score;
      feature.properties.threshold = p.threshold;
      feature.properties.rainfall = currentRain;
      feature.properties.flood_confidence_pct = p.flood_confidence_pct;
      
      const riskInfo = getRiskFromScore(p.anomaly_score);
      feature.properties.riskValue = riskInfo.risk;
      feature.properties.riskTier = riskInfo.tier;
    });

    districtLayer = L.geoJSON(districtGeoJSON, {
      style: (feature) => {
        const rc = getRiskColor(feature.properties.riskTier);
        return {
          fillColor: rc.fill,
          fillOpacity: 0.45,
          color: rc.border,
          weight: 1.5,
          className: 'district-polygon'
        };
      },
      onEachFeature: (feature, layer) => {
        layer.on({
          mouseover: function(e) {
            e.target.setStyle({ weight: 3, color: '#ffffff' });
            e.target.bindTooltip(`
              <strong>${feature.properties.name}</strong><br>
              Risk Level: ${feature.properties.riskTier}<br>
              Risk Score: ${(feature.properties.riskValue * 100).toFixed(1)}%<br>
              Anomaly Score: ${feature.properties.anomaly_score?.toFixed(4)}<br>
              Rainfall: ${feature.properties.rainfall} mm
            `, { sticky: true }).openTooltip();
          },
          mouseout: function(e) {
            districtLayer.resetStyle(e.target);
            e.target.closeTooltip();
          },
          click: function(e) {
            // update sidebar Selected Point panel with this district's data
            document.getElementById('point-details').classList.remove('hidden');
            document.getElementById('pt-pos').textContent = feature.properties.name;
            document.getElementById('pt-score').textContent = feature.properties.anomaly_score?.toFixed(6);
            document.getElementById('pt-thresh').textContent = feature.properties.threshold?.toFixed(6);
            document.getElementById('pt-pred').textContent = feature.properties.label;
            document.getElementById('pt-pred').style.color = feature.properties.label === 'FLOOD' ? '#ef4444' : '#22c55e';
            const rc = getRiskColor(feature.properties.riskTier);
            document.getElementById('pt-risk').innerHTML = `<span style="color:${rc.fill}; font-weight:bold">${feature.properties.riskTier}</span> (${(feature.properties.riskValue * 100).toFixed(1)}%)`;
            const bar = document.getElementById('pt-bar');
            bar.style.width = feature.properties.flood_confidence_pct + '%';
            bar.style.background = feature.properties.label === 'FLOOD' ? '#ef4444' : '#22c55e';
          }
        });
      }
    });
    if (districtsVisible) districtLayer.addTo(map);
  }

  // 2. Roads (fast update via setStyle)
  if (roadFeatures && roadFeatures.length > 0 && predictions) {
    const roadColors = {
      'Critical': { color: '#ef4444', weight: 3, opacity: 0.85 },
      'High':     { color: '#f97316', weight: 2.5, opacity: 0.80 },
      'Moderate': { color: '#facc15', weight: 2, opacity: 0.75 },
      'Low':      { color: '#86efac', weight: 1.5, opacity: 0.60 },
      'Minimal':  { color: '#22c55e', weight: 1.5, opacity: 0.50 },
      'Safe':     { color: '#16a34a', weight: 1, opacity: 0.40 },
    };
    
    roadFeatures.forEach(pl => {
      const nearest = nearestGridPoint(pl._midLat, pl._midLon, predictions);
      const riskInfo = getRiskFromScore(nearest.anomaly_score);
      const rc = roadColors[riskInfo.tier] || roadColors['Safe'];
      
      pl.setStyle({
        color: rc.color,
        weight: pl._isMajor ? rc.weight : Math.max(1, rc.weight - 0.5),
        opacity: rc.opacity
      });
      
      const tooltipHtml = `
        <strong>${pl._featureName}</strong><br>
        Risk Tier: ${riskInfo.tier}<br>
        Anomaly Score: ${nearest.anomaly_score.toFixed(4)}
      `;
      if (pl.getTooltip()) {
        pl.setTooltipContent(tooltipHtml);
      } else {
        pl.bindTooltip(tooltipHtml, { sticky: true });
      }
    });
    console.log(`Styled ${roadFeatures.length} roads.`);
  }

  // 3. Risk Points (Dots)
  if (predictions) {
    if (pointFeatures.length === 0) {
      predictions.forEach((p, i) => {
        const marker = L.circleMarker([p.lat, p.lon], { renderer: canvasRenderer });
        marker._origIndex = i;
        marker.on('click', (e) => {
          selectedPoint = e.target._origIndex;
          updatePointDetails(e.target._origIndex);
        });
        pointsLayer.addLayer(marker);
        pointFeatures.push(marker);
      });
    }

    pointFeatures.forEach(marker => {
      const p = predictions[marker._origIndex];
      const riskInfo = getRiskFromScore(p.anomaly_score);
      const rc = getRiskColor(riskInfo.tier);
      const radius = 2 + (p.flood_confidence_pct / 100) * 3;
      
      marker.setStyle({
        radius: radius,
        fillColor: rc.fill,
        color: rc.border,
        weight: 1,
        fillOpacity: 0.8
      });
      
      marker.bindTooltip(`
        <strong>Grid Point</strong><br>
        Risk Level: ${riskInfo.tier}<br>
        Confidence: ${p.flood_confidence_pct.toFixed(1)}%<br>
        Prediction: ${p.label}<br>
        Anomaly Score: ${p.anomaly_score.toFixed(4)}<br>
        Elevation: ${p.elevation_m} m<br>
        Canal Dist: ${p.dist_to_canal_m.toFixed(0)} m<br>
        Lat: ${p.lat.toFixed(4)}, Lon: ${p.lon.toFixed(4)}
      `, { sticky: true });
    });
  }
}

function buildSpatialIndex(results) {
  const index = {};
  for (const r of results) {
    const key = `${Math.floor(r.lat * 200)},${Math.floor(r.lon * 200)}`;
    index[key] = r;
  }
  return index;
}

function nearestGridPoint(lat, lon, results) {
  // Check the 9 surrounding cells
  let best = null, bestDist = Infinity;
  for (let dlat = -1; dlat <= 1; dlat++) {
    for (let dlon = -1; dlon <= 1; dlon++) {
      const key = `${Math.floor(lat * 200) + dlat},${Math.floor(lon * 200) + dlon}`;
      const r = spatialIndex ? spatialIndex[key] : null;
      if (!r) continue;
      const d = Math.hypot(r.lat - lat, r.lon - lon);
      if (d < bestDist) { bestDist = d; best = r; }
    }
  }
  
  if (!best) {
    // Fallback to linear search
    for (const r of results) {
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
  
  if (isMapVisible) map.invalidateSize();
  
  if (tabId === 'points') {
    document.getElementById('map').classList.add('points-tab-active');
  } else {
    document.getElementById('map').classList.remove('points-tab-active');
  }
  
  if (pointsLayer) {
    if (tabId === 'points') {
      if (!map.hasLayer(pointsLayer)) map.addLayer(pointsLayer);
    } else {
      if (map.hasLayer(pointsLayer)) map.removeLayer(pointsLayer);
    }
  }
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
    reportMap = L.map('report-map').setView([13.7563, 100.5018], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(reportMap);
    // Try GPS
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(pos => {
        reportLat = pos.coords.latitude;
        reportLon = pos.coords.longitude;
        reportMap.setView([reportLat, reportLon], 15);
        const marker = L.marker([reportLat, reportLon], { draggable: true }).addTo(reportMap);
        marker.on('dragend', e => {
          reportLat = e.target.getLatLng().lat;
          reportLon = e.target.getLatLng().lng;
        });
        document.getElementById('location-status').textContent = `📍 ${reportLat.toFixed(5)}, ${reportLon.toFixed(5)}`;
      }, () => {
        reportLat = 13.7563; reportLon = 100.5018;
        document.getElementById('location-status').textContent = '⚠ GPS unavailable — drag pin to your location';
        const marker = L.marker([reportLat, reportLon], { draggable: true }).addTo(reportMap);
        marker.on('dragend', e => {
          reportLat = e.target.getLatLng().lat;
          reportLon = e.target.getLatLng().lng;
          document.getElementById('location-status').textContent = `📍 ${reportLat.toFixed(5)}, ${reportLon.toFixed(5)}`;
        });
      });
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
  map.flyTo([r.lat, r.lon], 15);
}

// ─── REPORT MARKERS ON MAIN MAP ─────────────────────────────────
let reportMarkerLayer = L.layerGroup();

async function refreshReportMarkers() {
  if (!map) return;
  if (!map.hasLayer(reportMarkerLayer)) reportMarkerLayer.addTo(map);
  
  const dateInput = document.getElementById('date-input');
  const selectedDate = dateInput ? dateInput.value : '';
  
  reportMarkerLayer.clearLayers();
  const resp = await fetch('/api/reports');
  const reports = await resp.json();
  const sevColors = { ankle_deep:'#facc15', knee_deep:'#f97316', vehicle_submerged:'#ef4444', road_blocked:'#7c3aed' };
  
  reports.filter(r => {
    // Basic status filters
    if (r.reliability === 'likely_spam' || r.status === 'spam' || r.status === 'resolved') return false;
    
    // Date filter: only show reports from the selected date
    if (selectedDate && r.timestamp) {
      return r.timestamp.startsWith(selectedDate);
    }
    return true;
  }).forEach(r => {
    if (!r.lat || !r.lon) return;
    const color = sevColors[r.severity] || '#9ca3af';
    const size = r.severity === 'vehicle_submerged' || r.severity === 'road_blocked' ? 20 : r.severity === 'knee_deep' ? 16 : 12;
    const icon = L.divIcon({
      className: '',
      html: `<div style="position:relative;width:${size}px;height:${size}px">
        <div style="position:absolute;inset:0;border-radius:50%;background:${color};opacity:0.3;animation:pulse-ring 1.5s ease-out infinite"></div>
        <div style="position:absolute;inset:3px;border-radius:50%;background:${color}"></div>
      </div>`,
      iconSize: [size, size], iconAnchor: [size/2, size/2]
    });
    L.marker([r.lat, r.lon], { icon })
      .bindTooltip(`<b>${r.severity?.replace('_',' ')}</b><br>${r.description || 'No description'}<br><small>${r.reliability}</small>`)
      .addTo(reportMarkerLayer);
  });
}

// Refresh report markers every 30 seconds
setInterval(refreshReportMarkers, 30000);

// ─── Boot ───────────────────────────────────────────────────────────────────
async function boot() {
  await initMap();
  setToday();
  fetchAndPredict();
  refreshReportMarkers();
}

boot();
