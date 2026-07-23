/* ═══════════════════════════════════════════════════════════
   ISL CanSat GCS — gcs.js
   Ground Control Software JavaScript
   All logic written from scratch per project brief
   ═══════════════════════════════════════════════════════════ */

'use strict';

// ──────────────────────────────────────────────────────────────
// 1. GLOBAL STATE
// ──────────────────────────────────────────────────────────────
const GCS = {
  isStreaming:   false,
  packetCount:   0,
  missionStart:  null,
  telemetryLog:  [],     // raw CSV strings for export
  serialPort:    null,
  serialReader:  null,
  simInterval:   null,
  missionTimer:  null,
  videoStream:   null,

  // Separation & parachute state (toggled by mission controls)
  separationState:  0,   // 0 = not yet separated, 1 = separated
  parachuteActive:  0,   // 0 = inactive, 1 = emergency deployed
};

// Last known good telemetry (for error code logic)
let lastT = { alt: 0, pres: 101325, temp: 25, volt: 8.4,
              desc: 0, lat: 0, lng: 0, sats: 0,
              pitch: 0, roll: 0, yaw: 0 };

// ──────────────────────────────────────────────────────────────
// 2. DOM REFERENCES
// ──────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const DOM = {
  // Status
  connStatus:   $('connStatus'),
  missionClock: $('missionClock'),
  pktCount:     $('pktCount'),
  faultCode:    $('faultCodeDisplay'),
  cmdLog:       $('cmdLog'),
  coordDisplay: $('coordDisplay'),

  // Top bar buttons
  btnConnect:     $('btnConnect'),
  btnSimulate:    $('btnSimulate'),
  btnStop:        $('btnStop'),
  btnExportCSV:   $('btnExportCSV'),
  btnExportGraph: $('btnExportGraph'),
  btnSyncTime:    $('btnSyncTime'),
  btnReset:       $('btnReset'),

  // Mission control buttons
  btnManualSep:  $('btnManualSep'),
  btnEmergPara:  $('btnEmergPara'),
  btnRedundant:  $('btnRedundant'),

  // Error LEDs
  errDesc: $('errDesc'),
  errGPS:  $('errGPS'),
  errSep:  $('errSep'),
  errPara: $('errPara'),

  // Container telemetry values
  valAlt:  $('valAlt'),
  valPres: $('valPres'),
  valTemp: $('valTemp'),
  valBat:  $('valBat'),

  // Payload telemetry values
  valDesc:  $('valDesc'),
  valSats:  $('valSats'),
  valPitch: $('valPitch'),
  valRoll:  $('valRoll'),
  valYaw:   $('valYaw'),

  // Attitude readout (orientation panel)
  attPitch: $('attPitch'),
  attRoll:  $('attRoll'),
  attYaw:   $('attYaw'),

  // Progress bars
  barAlt:   $('barAlt'),
  barPres:  $('barPres'),
  barTemp:  $('barTemp'),
  barBat:   $('barBat'),
  barDesc:  $('barDesc'),
  barSats:  $('barSats'),
  barPitch: $('barPitch'),
  barRoll:  $('barRoll'),
  barYaw:   $('barYaw'),

  // Video
  videoElement: $('videoElement'),
  videoOverlay: $('videoOverlay'),
  camSelect:    $('camSelect'),
  camStatus:    $('camStatus'),
  btnStartVideo: $('btnStartVideo'),
  btnStopVideo:  $('btnStopVideo'),
};

// ──────────────────────────────────────────────────────────────
// 3. MISSION ELAPSED TIME CLOCK
// ──────────────────────────────────────────────────────────────
function startMissionClock() {
  if (GCS.missionTimer) return;
  GCS.missionStart = Date.now();
  GCS.missionTimer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - GCS.missionStart) / 1000);
    const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
    const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
    const s = String(elapsed % 60).padStart(2, '0');
    DOM.missionClock.textContent = `T+ ${h}:${m}:${s}`;
  }, 1000);
}

function stopMissionClock() {
  clearInterval(GCS.missionTimer);
  GCS.missionTimer = null;
}

// ──────────────────────────────────────────────────────────────
// 4. COMMAND LOG
// ──────────────────────────────────────────────────────────────
function logCmd(message, level = 'info') {
  const now = new Date();
  const ts = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map(n => String(n).padStart(2, '0')).join(':');

  const colorMap = { info: '#00ff88', warn: '#ffaa00', error: '#ff2244', cmd: '#00d4ff' };
  const color = colorMap[level] || colorMap.info;

  DOM.cmdLog.innerHTML =
    `<span class="log-time">[${ts}]</span> ` +
    `<span class="log-msg" style="color:${color}">${message}</span>`;
}

// ──────────────────────────────────────────────────────────────
// 5. ERROR CODE ENGINE (4-digit system per spec)
//    Digit 1 — Descent Rate : 0 = 8-10 m/s safe, 1 = outside range
//    Digit 2 — GPS          : 0 = available (sats > 0), 1 = unavailable
//    Digit 3 — Payload Sep  : 0 = separated OK, 1 = failure
//    Digit 4 — Parachute    : 0 = inactive, 1 = emergency activated
// ──────────────────────────────────────────────────────────────
function updateErrorCodes(descRate, gpsSats, sepState, paraState) {
  const codes = [
    (descRate < 8 || descRate > 10) ? 1 : 0,   // descent rate fault
    (gpsSats <= 0) ? 1 : 0,                      // GPS unavailable
    (sepState === 0) ? 1 : 0,                     // separation not yet done
    (paraState === 1) ? 1 : 0,                    // emergency chute active
  ];

  const ids = ['errDesc', 'errGPS', 'errSep', 'errPara'];
  ids.forEach((id, i) => {
    const el = DOM[id];
    el.textContent = String(codes[i]);
    el.className = 'led-digit ' + (codes[i] === 1 ? 'digit-fault' : 'digit-normal');
  });

  // Update code display in panel header
  DOM.faultCode.textContent = 'CODE: ' + codes.join('');
}

// ──────────────────────────────────────────────────────────────
// 6. TELEMETRY PARSING
//    Expected CSV format (15+ fields):
//    TEAM_ID, TIME, ALT, PRES, TEMP, VOLT, DESC, LAT, LNG,
//    SATS, PITCH, ROLL, YAW, SEP, PARA
// ──────────────────────────────────────────────────────────────
function parseTelemetry(csvLine) {
  const fields = csvLine.trim().split(',');
  if (fields.length < 15) return;

  GCS.packetCount++;
  GCS.telemetryLog.push(csvLine.trim());

  const t = {
    time:  GCS.packetCount,
    alt:   parseFloat(fields[2])  || 0,
    pres:  parseFloat(fields[3])  || 0,
    temp:  parseFloat(fields[4])  || 0,
    volt:  parseFloat(fields[5])  || 0,
    desc:  parseFloat(fields[6])  || 0,
    lat:   parseFloat(fields[7])  || 0,
    lng:   parseFloat(fields[8])  || 0,
    sats:  parseInt(fields[9])    || 0,
    pitch: parseFloat(fields[10]) || 0,
    roll:  parseFloat(fields[11]) || 0,
    yaw:   parseFloat(fields[12]) || 0,
    sep:   parseInt(fields[13])   || 0,
    para:  parseInt(fields[14])   || 0,
  };

  lastT = t;

  // Container telemetry display
  DOM.valAlt.textContent  = t.alt.toFixed(1);
  DOM.valPres.textContent = t.pres.toFixed(0);
  DOM.valTemp.textContent = t.temp.toFixed(1);
  DOM.valBat.textContent  = t.volt.toFixed(2);

  // Payload telemetry display
  DOM.valDesc.textContent  = t.desc.toFixed(1);
  DOM.valSats.textContent  = t.sats;
  DOM.valPitch.textContent = t.pitch.toFixed(0);
  DOM.valRoll.textContent  = t.roll.toFixed(0);
  DOM.valYaw.textContent   = t.yaw.toFixed(0);

  // Attitude readout
  DOM.attPitch.textContent = t.pitch.toFixed(0) + '°';
  DOM.attRoll.textContent  = t.roll.toFixed(0)  + '°';
  DOM.attYaw.textContent   = t.yaw.toFixed(0)   + '°';

  // Packet counter
  DOM.pktCount.textContent = GCS.packetCount;

  // Progress bars (normalised 0–100%)
  DOM.barAlt.style.width   = clamp(t.alt / 1000 * 100, 0, 100) + '%';
  DOM.barPres.style.width  = clamp((t.pres - 80000) / 40000 * 100, 0, 100) + '%';
  DOM.barTemp.style.width  = clamp((t.temp + 20) / 80 * 100, 0, 100) + '%';
  DOM.barBat.style.width   = clamp(t.volt / 12 * 100, 0, 100) + '%';
  DOM.barDesc.style.width  = clamp(t.desc / 20 * 100, 0, 100) + '%';
  DOM.barSats.style.width  = clamp(t.sats / 12 * 100, 0, 100) + '%';
  DOM.barPitch.style.width = clamp((t.pitch + 180) / 360 * 100, 0, 100) + '%';
  DOM.barRoll.style.width  = clamp((t.roll + 180) / 360 * 100, 0, 100) + '%';
  DOM.barYaw.style.width   = clamp(t.yaw / 360 * 100, 0, 100) + '%';

  // GPS coordinates
  if (t.lat !== 0 && t.lng !== 0) {
    DOM.coordDisplay.textContent =
      t.lat.toFixed(4) + '°, ' + t.lng.toFixed(4) + '°';
  }

  // Sub-modules
  updateErrorCodes(t.desc, t.sats, t.sep, t.para);
  updateCharts(t);
  updateMap(t.lat, t.lng);
  update3DModel(t.pitch, t.roll, t.yaw);
}

function clamp(v, mn, mx) { return Math.min(mx, Math.max(mn, v)); }

// ──────────────────────────────────────────────────────────────
// 7. CHART.JS — 5 real-time line graphs
// ──────────────────────────────────────────────────────────────
const CHART_MAX_PTS = 60;

// Shared dark-theme chart options factory
function makeChartOptions(color, label) {
  return {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label,
        data: [],
        borderColor: color,
        backgroundColor: hexToRgba(color, .08),
        borderWidth: 1.5,
        pointRadius: 0,
        fill: true,
        tension: .4,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          labels: { color: '#7b9bbf', font: { family: 'Rajdhani', size: 11, weight: '600' }, boxWidth: 12 }
        },
        tooltip: {
          backgroundColor: '#0a101f',
          borderColor: '#1b3060',
          borderWidth: 1,
          titleColor: '#00d4ff',
          bodyColor: '#ddeeff',
          titleFont: { family: 'Share Tech Mono', size: 11 },
          bodyFont:  { family: 'Share Tech Mono', size: 11 },
        }
      },
      scales: {
        x: {
          display: false,
          ticks: { color: '#2a4060' },
          grid:  { color: '#0d1428' },
        },
        y: {
          ticks: { color: '#4a6080', font: { family: 'Share Tech Mono', size: 10 }, maxTicksLimit: 5 },
          grid:  { color: '#0d1428' },
          border: { color: '#141e36' },
        }
      }
    }
  };
}

function hexToRgba(hex, a) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${a})`;
}

const charts = {
  alt:  new Chart($('chartAlt').getContext('2d'),  makeChartOptions('#00d4ff', 'Altitude (m)')),
  pres: new Chart($('chartPres').getContext('2d'), makeChartOptions('#facc15', 'Pressure (Pa)')),
  temp: new Chart($('chartTemp').getContext('2d'), makeChartOptions('#f43f5e', 'Temperature (°C)')),
  desc: new Chart($('chartDesc').getContext('2d'), makeChartOptions('#00ff88', 'Descent Rate (m/s)')),
  bat:  new Chart($('chartBat').getContext('2d'),  makeChartOptions('#a855f7', 'Battery (V)')),
};

function updateCharts(t) {
  const label = String(t.time);
  const pushPoint = (chart, value) => {
    if (chart.data.labels.length >= CHART_MAX_PTS) {
      chart.data.labels.shift();
      chart.data.datasets[0].data.shift();
    }
    chart.data.labels.push(label);
    chart.data.datasets[0].data.push(value);
    chart.update('none');
  };
  pushPoint(charts.alt,  t.alt);
  pushPoint(charts.pres, t.pres);
  pushPoint(charts.temp, t.temp);
  pushPoint(charts.desc, t.desc);
  pushPoint(charts.bat,  t.volt);
}

// ──────────────────────────────────────────────────────────────
// 8. LEAFLET MAP — real-time GPS tracking
// ──────────────────────────────────────────────────────────────
const mapInstance = L.map('map').setView([28.6139, 77.2090], 15);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap',
  maxZoom: 19,
}).addTo(mapInstance);

// Custom marker
const svgMarker = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="28" viewBox="0 0 20 28">
  <circle cx="10" cy="10" r="8" fill="#ff2244" stroke="#ffffff" stroke-width="1.5"/>
  <line x1="10" y1="18" x2="10" y2="28" stroke="#ff2244" stroke-width="1.5"/>
</svg>`;

const canSatIcon = L.divIcon({
  html: svgMarker,
  className: '',
  iconSize: [20, 28],
  iconAnchor: [10, 28],
});

const mapMarker   = L.marker([28.6139, 77.2090], { icon: canSatIcon }).addTo(mapInstance);
const flightPath  = L.polyline([], { color: '#00d4ff', weight: 2, opacity: .8 }).addTo(mapInstance);
const pathHistory = [];

function updateMap(lat, lng) {
  if (!lat || !lng || (lat === 0 && lng === 0)) return;
  const pos = L.latLng(lat, lng);
  mapMarker.setLatLng(pos);
  pathHistory.push(pos);
  flightPath.setLatLngs(pathHistory);
  mapInstance.panTo(pos);
}

// ──────────────────────────────────────────────────────────────
// 9. THREE.JS — 3D attitude visualisation
// ──────────────────────────────────────────────────────────────
const scene3D    = new THREE.Scene();
const camera3D   = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
const renderer3D = new THREE.WebGLRenderer({ alpha: true, antialias: true });
renderer3D.setClearColor(0x000000, 0);

const container3D = $('3d-container');

// Resize renderer once the panel is laid out
setTimeout(() => {
  const w = container3D.clientWidth  || 140;
  const h = container3D.clientHeight || 140;
  renderer3D.setSize(w, h);
  camera3D.aspect = w / h;
  camera3D.updateProjectionMatrix();
  container3D.appendChild(renderer3D.domElement);
}, 120);

// CanSat cylinder body
const bodyGeo = new THREE.CylinderGeometry(0.7, 0.7, 2.5, 24);
const bodyMat = new THREE.MeshBasicMaterial({ color: 0x00d4ff, wireframe: false, transparent: true, opacity: .25 });
const bodyWire = new THREE.MeshBasicMaterial({ color: 0x00d4ff, wireframe: true });
const canSatBody = new THREE.Mesh(bodyGeo, bodyMat);
const canSatWire = new THREE.Mesh(bodyGeo, bodyWire);

// Top cap (nose cone)
const capGeo = new THREE.ConeGeometry(0.7, 0.8, 24);
const capMat = new THREE.MeshBasicMaterial({ color: 0x00ff88, wireframe: true });
const capMesh = new THREE.Mesh(capGeo, capMat);
capMesh.position.y = 1.65;

// Orientation axis lines
const axisHelper = new THREE.AxesHelper(1.5);

// Group everything
const canSatGroup = new THREE.Group();
canSatGroup.add(canSatBody, canSatWire, capMesh, axisHelper);
scene3D.add(canSatGroup);

// Ambient lighting
const ambientLight = new THREE.AmbientLight(0x00d4ff, 0.4);
scene3D.add(ambientLight);

camera3D.position.set(3, 2, 5);
camera3D.lookAt(0, 0, 0);

// Idle rotation when no live data
let idleRotation = true;

function animate3D() {
  requestAnimationFrame(animate3D);
  if (idleRotation) {
    canSatGroup.rotation.y += 0.008;
  }
  renderer3D.render(scene3D, camera3D);
}
animate3D();

function update3DModel(pitch, roll, yaw) {
  idleRotation = false;
  canSatGroup.rotation.x = pitch * (Math.PI / 180);
  canSatGroup.rotation.z = roll  * (Math.PI / 180);
  canSatGroup.rotation.y = yaw   * (Math.PI / 180);
}

// ──────────────────────────────────────────────────────────────
// 10. SIMULATION ENGINE
//     Generates realistic CanSat descent packets at 1 Hz
// ──────────────────────────────────────────────────────────────
let simAlt = 500;

function runSimulation() {
  clearInterval(GCS.simInterval);
  GCS.isStreaming = true;
  idleRotation = false;
  simAlt = 500;

  setOnlineStatus(true);
  startMissionClock();
  logCmd('Simulation mode active — generating telemetry at 1 Hz', 'info');

  GCS.simInterval = setInterval(() => {
    if (!GCS.isStreaming) return;

    const t = Date.now();
    const descRate = 8.5 + (Math.random() * 2.5);   // 8.5–11 (may trigger fault)
    simAlt = Math.max(0, simAlt - descRate);
    const temp = 25 - (simAlt * 0.0065);             // lapse rate
    const pres = 101325 * Math.pow(1 - (simAlt * 2.25577e-5), 5.25588);
    const volt = 8.4 - (GCS.packetCount * 0.002);
    const lat  = 28.6139 + (Math.sin(GCS.packetCount / 10) * 0.001);
    const lng  = 77.2090 + (Math.cos(GCS.packetCount / 10) * 0.001);
    const sats = simAlt > 50 ? 6 + Math.floor(Math.random() * 4) : 0;
    const pitch = Math.sin(GCS.packetCount / 8) * 25;
    const roll  = Math.cos(GCS.packetCount / 6) * 20;
    const yaw   = (GCS.packetCount * 4) % 360;
    const sep   = simAlt < 300 ? 1 : 0;   // separates at 300 m
    const para  = GCS.parachuteActive;

    // TEAM_ID, TIME, ALT, PRES, TEMP, VOLT, DESC, LAT, LNG,
    // SATS, PITCH, ROLL, YAW, SEP, PARA
    const csv = [
      '1001', GCS.packetCount,
      simAlt.toFixed(1), pres.toFixed(0), temp.toFixed(1),
      volt.toFixed(2), descRate.toFixed(1),
      lat.toFixed(5), lng.toFixed(5),
      sats, pitch.toFixed(1), roll.toFixed(1), yaw.toFixed(0),
      sep, para
    ].join(',');

    parseTelemetry(csv);

    if (simAlt <= 0) {
      stopStreaming();
      logCmd('Simulation complete — CanSat landed.', 'info');
    }
  }, 1000);
}

// ──────────────────────────────────────────────────────────────
// 11. USB SERIAL (Web Serial API)
// ──────────────────────────────────────────────────────────────
async function connectSerial() {
  if (!navigator.serial) {
    logCmd('Web Serial API not supported in this browser.', 'error');
    return;
  }
  try {
    GCS.serialPort = await navigator.serial.requestPort();
    await GCS.serialPort.open({ baudRate: 9600 });

    const decoder = new TextDecoderStream();
    GCS.serialPort.readable.pipeTo(decoder.writable);
    const reader = decoder.readable.getReader();
    GCS.serialReader = reader;
    GCS.isStreaming = true;

    setOnlineStatus(true);
    startMissionClock();
    logCmd('USB serial connected — reading telemetry at 9600 baud.', 'info');

    let buffer = '';
    while (GCS.isStreaming) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      lines.forEach(line => { if (line.trim()) parseTelemetry(line); });
    }
  } catch (err) {
    logCmd('Serial connection failed: ' + err.message, 'error');
    setOnlineStatus(false);
  }
}

// ──────────────────────────────────────────────────────────────
// 12. STOP STREAMING
// ──────────────────────────────────────────────────────────────
async function stopStreaming() {
  GCS.isStreaming = false;
  clearInterval(GCS.simInterval);
  stopMissionClock();

  if (GCS.serialReader) {
    try { await GCS.serialReader.cancel(); } catch (_) {}
    GCS.serialReader = null;
  }
  if (GCS.serialPort) {
    try { await GCS.serialPort.close(); } catch (_) {}
    GCS.serialPort = null;
  }

  setOnlineStatus(false);
  idleRotation = true;
  logCmd('Telemetry stream stopped.', 'warn');
}

// ──────────────────────────────────────────────────────────────
// 13. STATUS INDICATOR
// ──────────────────────────────────────────────────────────────
function setOnlineStatus(online) {
  DOM.connStatus.textContent = online ? '● ONLINE' : '● OFFLINE';
  DOM.connStatus.className   = 'ph-status ' + (online ? 'online' : 'offline');
}

// ──────────────────────────────────────────────────────────────
// 14. DATA EXPORT
// ──────────────────────────────────────────────────────────────
function exportCSV() {
  if (GCS.telemetryLog.length === 0) {
    logCmd('No telemetry data to export.', 'warn');
    return;
  }
  const header = 'TEAM_ID,TIME,ALT,PRES,TEMP,VOLT,DESC,LAT,LNG,SATS,PITCH,ROLL,YAW,SEP,PARA';
  const blob = new Blob([header + '\n' + GCS.telemetryLog.join('\n')], { type: 'text/csv' });
  triggerDownload(URL.createObjectURL(blob), 'cansat_telemetry_' + dateStamp() + '.csv');
  logCmd('Telemetry CSV exported (' + GCS.telemetryLog.length + ' packets).', 'info');
}

function exportGraph() {
  const graphList = [
    { id: 'chartAlt',  name: 'altitude_profile' },
    { id: 'chartPres', name: 'pressure_profile' },
    { id: 'chartTemp', name: 'temperature_profile' },
    { id: 'chartDesc', name: 'descent_rate_profile' },
    { id: 'chartBat',  name: 'battery_profile' }
  ];

  graphList.forEach((graph, index) => {
    setTimeout(() => {
      const canvas = $(graph.id);
      triggerDownload(
        canvas.toDataURL('image/png'),
        `${graph.name}_${dateStamp()}.png`
      );
    }, index * 300);
  });

  logCmd('All graphs exported as PNG files.', 'info');
}

function triggerDownload(href, filename) {
  const a = document.createElement('a');
  a.href = href; a.download = filename; a.click();
}

function dateStamp() {
  const d = new Date();
  return [d.getFullYear(),
    String(d.getMonth()+1).padStart(2,'0'),
    String(d.getDate()).padStart(2,'0'),
    String(d.getHours()).padStart(2,'0'),
    String(d.getMinutes()).padStart(2,'0'),
  ].join('');
}

// ──────────────────────────────────────────────────────────────
// 15. LIVE VIDEO STREAM (MediaDevices API)
// ──────────────────────────────────────────────────────────────
async function populateCameraList() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter(d => d.kind === 'videoinput');
    DOM.camSelect.innerHTML = '<option value="">— Select Camera —</option>';
    cameras.forEach((cam, i) => {
      const opt = document.createElement('option');
      opt.value = cam.deviceId;
      opt.textContent = cam.label || `Camera ${i + 1}`;
      DOM.camSelect.appendChild(opt);
    });
  } catch (err) {
    logCmd('Could not list cameras: ' + err.message, 'warn');
  }
}

async function startVideo() {
  try {
    const constraints = { video: { deviceId: DOM.camSelect.value || undefined } };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    GCS.videoStream = stream;
    DOM.videoElement.srcObject = stream;
    DOM.videoOverlay.classList.add('hidden');
    DOM.camStatus.textContent = '● LIVE';
    DOM.camStatus.className   = 'ph-status camOn';
    logCmd('Camera feed active.', 'info');
    // Refresh camera list with real labels now that permission is granted
    await populateCameraList();
  } catch (err) {
    logCmd('Camera access denied: ' + err.message, 'error');
  }
}

function stopVideo() {
  if (GCS.videoStream) {
    GCS.videoStream.getTracks().forEach(t => t.stop());
    GCS.videoStream = null;
    DOM.videoElement.srcObject = null;
  }
  DOM.videoOverlay.classList.remove('hidden');
  DOM.camStatus.textContent = '● INACTIVE';
  DOM.camStatus.className   = 'ph-status';
  logCmd('Camera feed stopped.', 'warn');
}

// ──────────────────────────────────────────────────────────────
// 16. EVENT LISTENERS — wire everything up
// ──────────────────────────────────────────────────────────────

// Top bar
DOM.btnConnect.addEventListener('click',     () => connectSerial());
DOM.btnSimulate.addEventListener('click',    () => runSimulation());
DOM.btnStop.addEventListener('click',        () => stopStreaming());
DOM.btnExportCSV.addEventListener('click',   () => exportCSV());
DOM.btnExportGraph.addEventListener('click', () => exportGraph());

DOM.btnSyncTime.addEventListener('click', () => {
  const now = new Date().toLocaleString();
  logCmd('RTC synchronised with PC time: ' + now, 'info');
});

DOM.btnReset.addEventListener('click', () => {
  GCS.packetCount = 0;
  GCS.telemetryLog = [];
  DOM.pktCount.textContent = '0';
  logCmd('Packet counter and telemetry log reset.', 'warn');
});

// Mission critical controls
DOM.btnManualSep.addEventListener('click', () => {
  GCS.separationState = 1;
  logCmd('⊕ CMD EXECUTED: MANUAL SEPARATION TRIGGERED', 'cmd');
  updateErrorCodes(lastT.desc, lastT.sats, 1, GCS.parachuteActive);
});

DOM.btnEmergPara.addEventListener('click', () => {
  GCS.parachuteActive = 1;
  logCmd('⚠ CMD EXECUTED: EMERGENCY PARACHUTE DEPLOYED', 'error');
  updateErrorCodes(lastT.desc, lastT.sats, GCS.separationState, 1);
});

DOM.btnRedundant.addEventListener('click', () => {
  logCmd('⚡ CMD EXECUTED: REDUNDANT SYSTEMS ACTIVATED', 'warn');
});

// Video controls
DOM.btnStartVideo.addEventListener('click', () => startVideo());
DOM.btnStopVideo.addEventListener('click',  () => stopVideo());

// ──────────────────────────────────────────────────────────────
// 17. INITIALISATION
// ──────────────────────────────────────────────────────────────
(function init() {
  // Seed LEDs at nominal state
  updateErrorCodes(9, 6, 1, 0);
  setOnlineStatus(false);

  // Populate camera dropdown (may be empty until permission granted)
  if (navigator.mediaDevices) {
    populateCameraList();
    navigator.mediaDevices.addEventListener('devicechange', populateCameraList);
  }

  logCmd('System initialized. Awaiting stream...', 'info');
})();
