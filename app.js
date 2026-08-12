// ------------------------------
// 研究用プロトタイプ設定
// ------------------------------
// これらは一律の規定距離ではなく、今回の仮想運航条件に基づく研究用の仮値です。
// 仮定：最大飛行高度 20 m、最大運航速度 10 m/s、機体最大寸法 1.5 m。
// 通常飛行として確認する幅 10 m は、この研究で置く仮定です。
// 約32.1 m と約66.0 m は、前段で採用した SORA 2.5 Annex A の計算例・簡易法を参考にした試算値です。
// 200 m は領域判定には使わず、地図情報を取得するためだけの検索範囲です。
const NORMAL_OPERATION_KM = 0.010;          // 予定経路から 10 m
const DEVIATION_CHECK_KM = 0.0321;          // 予定経路から約 32.1 m まで
const OUTER_SAFETY_KM = 0.0660;             // 予定経路から約 66.0 m まで
const MAP_SEARCH_DISTANCE_KM = 0.200;        // 地図情報取得用。領域判定とは別

const map = L.map('map', { doubleClickZoom: false }).setView([37.4948, 139.9298], 14);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 20,
  attribution: '&copy; OpenStreetMap の協力者'
}).addTo(map);

const routeGroup = L.layerGroup().addTo(map);
const areaGroup = L.layerGroup().addTo(map);
const utilityGroup = L.layerGroup().addTo(map);
const locationGroup = L.layerGroup().addTo(map);

const $ = id => document.getElementById(id);
const locateBtn = $('locateBtn');
const manualTolBtn = $('manualTolBtn');
const undoBtn = $('undoBtn');
const resetBtn = $('resetBtn');
const drawRouteBtn = $('drawRouteBtn');
const coachTitle = $('coachTitle');
const coachBody = $('coachBody');
const tolChip = $('tolChip');
const routeChip = $('routeChip');
const analysisChip = $('analysisChip');
const analysisState = $('analysisState');
const checks = $('checks');
const template = $('checkTemplate');
const objectCount = $('objectCount');
const routeCount = $('routeCount');
const tolCount = $('tolCount');
const uncheckedCount = $('uncheckedCount');
const actionCount = $('actionCount');

let mode = null;
let routeLatLngs = [];
let routeLine = null;
let route = null;
let routeBuffer = null;
let tolMarker = null;
let tol = null;
let tolBuffer = null;
let currentCoords = null;
let analysisTimer = null;
let currentFeatures = [];

const checkStates = new Map();
const featureLayers = new Map();

const AREA_RULES = {
  NORMAL: {
    areaName: '通常飛行として確認する範囲（予定経路から10 m以内）',
    relationship: object => `通常の飛行中に、${object}へ接近する可能性があります。`,
    verification: object => `${object}と予定飛行経路との間に、十分な間隔を確保できていますか？`,
    reason: object => `この${object}は、今回の仮定で通常飛行として確認する範囲内にあります。そのため、通常の飛行中に機体とどのような位置関係になるかを確認します。`
  },
  DEVIATION: {
    areaName: '経路を外れた場合に確認する範囲（約10〜32 m）',
    relationship: object => `予定飛行経路から外れた場合に、${object}へ接近する可能性があります。`,
    verification: object => `経路を外れた場合でも、${object}との十分な間隔を確保できますか？`,
    reason: object => `この${object}は通常飛行として確認する範囲の外側ですが、経路から外れた場合に考慮する範囲内にあります。そのため、経路ずれが起きた場合の位置関係を確認します。`
  },
  OUTER: {
    areaName: 'さらに外れた場合を考慮する範囲（約32〜66 m）',
    relationship: object => `機体が予定より大きく経路を外れた場合に、${object}が周辺の障害物になる可能性があります。`,
    verification: object => `想定外の経路ずれが起きた場合に、この${object}が運航へ影響しないことを確認できていますか？`,
    reason: object => `この${object}は経路からさらに離れていますが、今回の仮定でさらに外れた場合まで考慮する範囲内にあります。そのため、異常時に運航へ影響しないかを確認します。`
  },
  SURROUNDING: {
    areaName: '地図情報として確認する範囲（約66〜200 m）',
    relationship: object => `${object}は予定飛行経路から離れていますが、運航場所の周辺環境として確認対象になります。`,
    verification: object => `この${object}の位置と方向を把握し、異常時にも運航へ影響しないことを確認できていますか？`,
    reason: object => `この${object}は約66 mより外側にあり、上の三つの判定範囲には入りません。ただし、地図情報の検索範囲内にあるため、周辺環境の参考情報として位置を確認します。`
  }
};

const BASELINE_RULE = {
  id: 'baseline-check',
  objectType: '周辺環境',
  title: '地図に表示されない障害物も現地で確認してください',
  location: '今回取得できた地図情報だけでは、現地のすべての障害物を確認できません。',
  relationship: '細い電線、通信線、支線、付属設備などは、地図に登録されていない場合があります。',
  verification: '予定飛行経路と離着陸地点の周辺を現地で見て、飛行に影響する障害物がないことを確認できていますか？',
  reason: '地図上で対象物が見つからなかった場合でも、実際の環境に障害物が存在しないとは限らないためです。',
  limitation: '地図情報は確認候補を見つけるための補助として使用し、最終判断は現地確認と組み合わせてください。',
  source: '確認根拠：国土交通省の飛行前安全確認要求と、運航場所に応じて確認内容を具体化する考え方。',
  feature: null
};

function setChip(el, text, state='pending') {
  el.textContent = text;
  el.className = `chip ${state}`;
}

function featureId(feature, index = 0) {
  if (feature.id) return String(feature.id);
  const p = feature.properties || {};
  if (p.id) return String(p.id);
  return `対象-${index}-${JSON.stringify(feature.geometry?.coordinates || []).slice(0, 80)}`;
}

function redrawRoute() {
  routeGroup.clearLayers();
  routeLatLngs.forEach(ll => {
    L.circleMarker(ll, {
      radius: 4.5, weight: 2, color: '#18587c',
      fillColor: '#fff', fillOpacity: 1
    }).addTo(routeGroup);
  });

  if (routeLatLngs.length >= 2) {
    routeLine = L.polyline(routeLatLngs, {
      color: '#18587c', weight: 4
    }).addTo(routeGroup);
  } else {
    routeLine = null;
  }

  undoBtn.disabled = routeLatLngs.length === 0;
}

function makeRouteBuffers() {
  if (!route) return null;
  return {
    normal: turf.buffer(route, NORMAL_OPERATION_KM, { units:'kilometers' }),
    deviation: turf.buffer(route, DEVIATION_CHECK_KM, { units:'kilometers' }),
    outer: turf.buffer(route, OUTER_SAFETY_KM, { units:'kilometers' }),
    analysis: turf.buffer(route, MAP_SEARCH_DISTANCE_KM, { units:'kilometers' })
  };
}

function redrawAreas() {
  areaGroup.clearLayers();

  if (route) {
    const b = makeRouteBuffers();
    routeBuffer = b.analysis;

    const layers = [
      [b.analysis, '#7f919c', '#c8d2d8', .08, '7 6'],
      [b.outer, '#6d8490', '#aebfc8', .08, '5 5'],
      [b.deviation, '#4e7488', '#92acb9', .10, '4 4'],
      [b.normal, '#18587c', '#70a0b8', .14, null]
    ];

    layers.forEach(([geometry, color, fillColor, fillOpacity, dashArray]) => {
      L.geoJSON(geometry, {
        style: { color, weight: 1.4, fillColor, fillOpacity, dashArray },
        interactive: false
      }).addTo(areaGroup);
    });
  }

  if (tol) {
    tolBuffer = turf.buffer(tol, MAP_SEARCH_DISTANCE_KM, { units:'kilometers' });
    L.geoJSON(tolBuffer, {
      style: {
        color:'#666', weight:1.3, dashArray:'5 5',
        fillColor:'#999', fillOpacity:.05
      },
      interactive:false
    }).addTo(areaGroup);
  }
}

function setTolAt(latlng, popupText='離着陸地点') {
  if (tolMarker) map.removeLayer(tolMarker);

  tolMarker = L.marker(latlng, {
    draggable: true,
    title: '離着陸地点'
  }).addTo(map);

  tolMarker.bindPopup(
    `<strong>${popupText}</strong><br><small>ドラッグして位置を変更できます。</small>`
  );

  tol = turf.point([latlng.lng, latlng.lat]);
  redrawAreas();

  tolMarker.on('dragend', () => {
    const ll = tolMarker.getLatLng();
    tol = turf.point([ll.lng, ll.lat]);
    redrawAreas();
    setChip(tolChip, '離着陸地点：設定済み', 'done');
    scheduleAutoAnalysis();
  });

  setChip(tolChip, '離着陸地点：設定済み', 'done');
}

function requestLocation(auto=false) {
  if (!navigator.geolocation) return;

  locateBtn.disabled = true;
  locateBtn.textContent = '現在地取得中…';

  navigator.geolocation.getCurrentPosition(
    pos => {
      const { latitude, longitude, accuracy } = pos.coords;
      currentCoords = { latitude, longitude, accuracy };
      const ll = L.latLng(latitude, longitude);

      locationGroup.clearLayers();

      L.circle(ll, {
        radius: accuracy,
        color:'#2478c5', weight:1.3,
        fillColor:'#5da8df', fillOpacity:.10
      }).addTo(locationGroup);

      L.circleMarker(ll, {
        radius:7, color:'#fff', weight:3,
        fillColor:'#2478c5', fillOpacity:1
      }).addTo(locationGroup)
        .bindTooltip(`現在地（精度 約${Math.round(accuracy)} m）`);

      map.setView(ll, 17);

      if (!tol) {
        setTolAt(ll, '離着陸地点（現在地を初期値として設定）');
      }

      locateBtn.textContent = '◎ 現在地';
      locateBtn.disabled = false;

      if (auto) {
        coachTitle.textContent = '現在地を離着陸地点の初期値にしました';
        coachBody.textContent = '違う場所から離着陸する場合は、黒いマーカーをドラッグして移動できます。';
      }
    },
    () => {
      locateBtn.textContent = '◎ 現在地';
      locateBtn.disabled = false;
      if (auto) {
        coachTitle.textContent = '経路を描いてください';
        coachBody.textContent = '現在地は取得できませんでした。離着陸地点はあとから地図上で設定できます。';
      }
    },
    { enableHighAccuracy:true, timeout:9000, maximumAge:30000 }
  );
}

locateBtn.addEventListener('click', () => requestLocation(false));

manualTolBtn.addEventListener('click', () => {
  mode = 'tol';
  coachTitle.textContent = '離着陸地点を変更';
  coachBody.textContent = '地図上で新しい離着陸地点を1回クリックしてください。';
});

drawRouteBtn.addEventListener('click', () => {
  if (mode !== 'route') {
    routeLatLngs = [];
    route = null;
    routeBuffer = null;
    routeGroup.clearLayers();
    areaGroup.clearLayers();
    redrawAreas();
    utilityGroup.clearLayers();
    featureLayers.clear();
    currentFeatures = [];

    mode = 'route';
    drawRouteBtn.textContent = '経路を確定して分析';
    drawRouteBtn.classList.add('finish');
    coachTitle.textContent = '地図上を順番にクリック';
    coachBody.textContent = '通過点を追加してください。2点以上入力すると、このボタンでそのまま分析できます。';
    setChip(routeChip, '経路：入力中', 'loading');
    setChip(analysisChip, '未分析', 'pending');
    return;
  }

  finishRouteAndAnalyze();
});

undoBtn.addEventListener('click', () => {
  if (!routeLatLngs.length) return;
  routeLatLngs.pop();
  redrawRoute();
  if (routeLatLngs.length === 0) setChip(routeChip, '経路：入力中', 'loading');
});

resetBtn.addEventListener('click', () => {
  routeLatLngs = [];
  route = null;
  routeBuffer = null;
  routeLine = null;
  routeGroup.clearLayers();
  areaGroup.clearLayers();
  utilityGroup.clearLayers();
  featureLayers.clear();
  currentFeatures = [];
  checkStates.clear();

  if (tolMarker) map.removeLayer(tolMarker);
  tolMarker = null;
  tol = null;
  tolBuffer = null;

  mode = null;
  setChip(tolChip, '離着陸地点：未設定', 'pending');
  setChip(routeChip, '経路：未設定', 'pending');
  setChip(analysisChip, '未分析', 'pending');
  analysisState.textContent = '待機中';
  analysisState.className = 'state-badge';
  objectCount.textContent = routeCount.textContent = tolCount.textContent = '—';
  uncheckedCount.textContent = actionCount.textContent = '—';
  drawRouteBtn.textContent = '経路を描く';
  drawRouteBtn.classList.remove('finish');
  undoBtn.disabled = true;
  coachTitle.textContent = 'まず経路を描きます';
  coachBody.textContent = 'ボタンを押したら、地図上の通過点を順番にクリックしてください。';
  checks.innerHTML = '<div class="empty-state">経路を描き終えると、自動で分析結果がここに表示されます。</div>';
});

map.on('click', e => {
  if (mode === 'route') {
    routeLatLngs.push(e.latlng);
    redrawRoute();

    if (routeLatLngs.length >= 2) {
      coachTitle.textContent = `${routeLatLngs.length}点入力済み`;
      coachBody.textContent = 'さらに通過点を追加するか、「経路を確定して分析」を押してください。';
    }
    return;
  }

  if (mode === 'tol') {
    setTolAt(e.latlng);
    mode = null;
    coachTitle.textContent = '離着陸地点を変更しました';
    coachBody.textContent = '黒いマーカーはドラッグでも位置を変更できます。経路設定済みなら自動で再分析します。';
    scheduleAutoAnalysis();
  }
});

map.on('dblclick', e => {
  if (mode === 'route' && routeLatLngs.length >= 2) {
    L.DomEvent.stop(e);
    if (routeLatLngs.length >= 2) {
      const a = routeLatLngs[routeLatLngs.length - 1];
      const b = routeLatLngs[routeLatLngs.length - 2];
      if (a.distanceTo(b) < 2) routeLatLngs.pop();
    }
    redrawRoute();
    finishRouteAndAnalyze();
  }
});

async function finishRouteAndAnalyze() {
  if (routeLatLngs.length < 2) {
    coachTitle.textContent = '経路には2点以上必要です';
    coachBody.textContent = '地図上でもう1点以上クリックしてください。';
    return;
  }

  route = turf.lineString(routeLatLngs.map(ll => [ll.lng, ll.lat]));
  routeBuffer = turf.buffer(route, MAP_SEARCH_DISTANCE_KM, { units:'kilometers' });
  redrawAreas();

  setChip(routeChip, `経路：${routeLatLngs.length}点`, 'done');
  mode = null;
  drawRouteBtn.textContent = '経路を描き直す';
  drawRouteBtn.classList.remove('finish');

  if (!tol) {
    setTolAt(routeLatLngs[0], '離着陸地点（経路始点を初期値として設定）');
  }

  coachTitle.textContent = '入力完了';
  coachBody.textContent = '予定経路周辺の電線・電柱などの地図情報を取得しています。';
  await analyze();
}

function scheduleAutoAnalysis() {
  if (!(route && tol)) return;
  clearTimeout(analysisTimer);
  analysisTimer = setTimeout(() => analyze(), 450);
}

function queryFor(bbox) {
  const [w,s,e,n] = bbox;
  return `[out:json][timeout:25];
(
  nwr["power"~"^(pole|tower|line|minor_line)$"](${s},${w},${n},${e});
  nwr["man_made"="utility_pole"](${s},${w},${n},${e});
);
out geom;`;
}

async function fetchOverpass(query) {
  let lastError;
  for (const endpoint of [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
  ]) {
    try {
      const response = await fetch(endpoint, {
        method:'POST',
        headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8'},
        body:'data=' + encodeURIComponent(query)
      });
      if (!response.ok) throw new Error('通信エラー ' + response.status);
      return await response.json();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

function intersects(feature, polygon) {
  try { return !!(feature && feature.geometry && polygon && turf.booleanIntersects(feature, polygon)); }
  catch { return false; }
}

function label(feature) {
  const p = feature.properties || {};
  if (p.power === 'pole') return '電柱';
  if (p.power === 'tower') return '鉄塔';
  if (p.power === 'line') return '送電線';
  if (p.power === 'minor_line') return '配電線';
  if (p.man_made === 'utility_pole') return '電柱';
  return '電線・電柱';
}

function distanceToRoute(feature) {
  try {
    let min = Infinity;
    turf.flattenEach(feature, part => {
      const g = part.geometry;
      if (!g) return;
      if (g.type === 'Point') {
        min = Math.min(min, turf.pointToLineDistance(part, route, {units:'kilometers'}));
      } else if (g.type === 'LineString') {
        g.coordinates.forEach(c => {
          min = Math.min(min, turf.pointToLineDistance(turf.point(c), route, {units:'kilometers'}));
        });
        // 線と経路が交差する場合は距離を0として扱う。
        try {
          if (turf.lineIntersect(part, route).features.length) min = 0;
        } catch {}
      }
    });
    return Number.isFinite(min) ? min : null;
  } catch { return null; }
}

function distanceToTol(feature) {
  if (!tol) return null;
  try {
    let min = Infinity;
    turf.flattenEach(feature, part => {
      const g = part.geometry;
      if (!g) return;
      if (g.type === 'Point') {
        min = Math.min(min, turf.distance(tol, part, {units:'kilometers'}));
      } else if (g.type === 'LineString') {
        try {
          min = Math.min(min, turf.pointToLineDistance(tol, part, {units:'kilometers'}));
        } catch {
          g.coordinates.forEach(c => {
            min = Math.min(min, turf.distance(tol, turf.point(c), {units:'kilometers'}));
          });
        }
      }
    });
    return Number.isFinite(min) ? min : null;
  } catch { return null; }
}

function classifyArea(feature) {
  const b = makeRouteBuffers();
  if (!b) return 'SURROUNDING';
  if (intersects(feature, b.normal)) return 'NORMAL';
  if (intersects(feature, b.deviation)) return 'DEVIATION';
  if (intersects(feature, b.outer)) return 'OUTER';
  return 'SURROUNDING';
}

function locationText(feature) {
  const routeDistance = distanceToRoute(feature);
  const tolDistance = distanceToTol(feature);
  const parts = [];
  if (routeDistance != null) parts.push(`予定経路から約${Math.round(routeDistance * 1000)} m`);
  if (tolDistance != null && tolDistance <= MAP_SEARCH_DISTANCE_KM) parts.push(`離着陸地点から約${Math.round(tolDistance * 1000)} m`);
  return parts.join('・') || '位置関係を地図上で確認してください。';
}

function buildItem(feature, index) {
  const objectType = label(feature);
  const areaKey = classifyArea(feature);
  const rule = AREA_RULES[areaKey];
  const nearTol = (distanceToTol(feature) ?? Infinity) <= MAP_SEARCH_DISTANCE_KM;
  const id = featureId(feature, index);

  let title;
  if (areaKey === 'NORMAL') title = `予定飛行経路の近くに${objectType}があります`;
  else if (areaKey === 'DEVIATION') title = `経路を外れた場合に${objectType}へ接近する可能性があります`;
  else if (areaKey === 'OUTER') title = `さらに経路を外れた場合に関係する${objectType}があります`;
  else title = `周辺情報として${objectType}があります`;

  let verification = rule.verification(objectType);
  let relationship = rule.relationship(objectType);
  let reason = rule.reason(objectType);

  if (nearTol) {
    relationship += ` また、この${objectType}は離着陸地点の周辺にもあります。`;
    verification += ` あわせて、離着陸時の機体移動方向との関係も確認してください。`;
    reason += ` 離着陸時は機体の移動方向や上空の確認も必要になるため、離着陸地点との位置関係も合わせて確認します。`;
  }

  return {
    id,
    objectType,
    title,
    areaName: rule.areaName,
    location: locationText(feature),
    relationship,
    verification,
    reason,
    limitation: '地図上の位置や種類が実際の状況と異なる場合があります。対象物の実際の位置、高さ、方向、見え方は現地で確認してください。',
    source: '確認根拠：国土交通省の飛行前安全確認要求と、運航範囲との位置関係に応じて確認内容を具体化する考え方。',
    feature
  };
}

function ensureState(id) {
  if (!checkStates.has(id)) {
    checkStates.set(id, { status: '未確認', actions: [] });
  }
  return checkStates.get(id);
}

function updateSummary(items) {
  const ids = items.map(i => i.id);
  const states = ids.map(id => ensureState(id));
  uncheckedCount.textContent = states.filter(s => s.status === '未確認').length;
  actionCount.textContent = states.filter(s => s.status === '対応が必要').length;
}

function setCardStatus(cardEl, item, status) {
  const state = ensureState(item.id);
  state.status = status;

  const badge = cardEl.querySelector('.check-status');
  badge.textContent = status;
  badge.className = 'check-status';

  if (status === '問題なし') badge.classList.add('safe');
  if (status === '対応が必要') badge.classList.add('action');
  if (status === '対応済み') badge.classList.add('complete');

  const panel = cardEl.querySelector('.action-panel');
  panel.hidden = status !== '対応が必要';

  updateSummary(currentRenderedItems());
}

function currentRenderedItems() {
  return Array.from(checks.querySelectorAll('.check-card')).map(el => ({ id: el.dataset.itemId }));
}

function getFeatureCenter(feature) {
  try {
    const c = turf.center(feature).geometry.coordinates;
    return L.latLng(c[1], c[0]);
  } catch { return null; }
}

function focusItem(item, cardEl) {
  document.querySelectorAll('.check-card').forEach(el => el.classList.remove('is-highlighted'));
  cardEl.classList.add('is-highlighted');

  if (!item.feature) return;
  const layer = featureLayers.get(item.id);
  if (layer && typeof layer.getBounds === 'function') {
    const bounds = layer.getBounds();
    if (bounds.isValid()) map.fitBounds(bounds.pad(.8), { maxZoom: 19 });
  } else {
    const center = getFeatureCenter(item.feature);
    if (center) map.setView(center, 18);
  }

  if (layer && typeof layer.openPopup === 'function') layer.openPopup();
}

function bindCard(node, item) {
  const cardEl = node.querySelector('.check-card');
  cardEl.dataset.itemId = item.id;
  cardEl.id = `確認-${item.id.replace(/[^a-zA-Z0-9ぁ-んァ-ヶ一-龯_-]/g, '-')}`;

  node.querySelector('.check-type').textContent = item.objectType;
  node.querySelector('.check-title').textContent = item.title;
  node.querySelector('.check-location').textContent = `${item.areaName}・${item.location}`;
  node.querySelector('.check-relationship').textContent = item.relationship;
  node.querySelector('.check-verification').textContent = item.verification;
  node.querySelector('.check-reason').textContent = item.reason;
  node.querySelector('.check-limitation').textContent = item.limitation;
  node.querySelector('.check-source').textContent = item.source;

  const state = ensureState(item.id);
  const badge = node.querySelector('.check-status');
  badge.textContent = state.status;
  if (state.status === '問題なし') badge.classList.add('safe');
  if (state.status === '対応が必要') badge.classList.add('action');
  if (state.status === '対応済み') badge.classList.add('complete');

  const actionPanel = node.querySelector('.action-panel');
  actionPanel.hidden = state.status !== '対応が必要';

  node.querySelectorAll('.action-panel input[type="checkbox"]').forEach(input => {
    input.checked = state.actions.includes(input.value);
    input.addEventListener('change', () => {
      state.actions = Array.from(actionPanel.querySelectorAll('input:checked')).map(x => x.value);
    });
  });

  node.querySelector('.safe-button').addEventListener('click', () => {
    state.actions = [];
    setCardStatus(cardEl, item, '問題なし');
  });

  node.querySelector('.warning-button').addEventListener('click', () => {
    setCardStatus(cardEl, item, '対応が必要');
  });

  node.querySelector('.complete-button').addEventListener('click', () => {
    const selected = Array.from(actionPanel.querySelectorAll('input:checked')).map(x => x.value);
    if (!selected.length) {
      actionPanel.animate(
        [{ transform: 'translateX(0)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' }, { transform: 'translateX(0)' }],
        { duration: 220 }
      );
      return;
    }
    state.actions = selected;
    setCardStatus(cardEl, item, '対応済み');
  });

  node.querySelector('.focus-button').addEventListener('click', () => focusItem(item, cardEl));

  return cardEl;
}

function renderUtility(features) {
  utilityGroup.clearLayers();
  featureLayers.clear();

  features.forEach((feature, index) => {
    const id = featureId(feature, index);
    const distance = distanceToRoute(feature);
    const d = distance == null ? '予定経路との距離を取得できません' : `予定経路から約${Math.round(distance*1000)} m`;
    const geoLayer = L.geoJSON(feature, {
      pointToLayer:(_,ll)=>L.circleMarker(ll,{radius:6,color:'#8f3828',fillColor:'#b24830',fillOpacity:.9,weight:2}),
      style:{color:'#b24830',weight:4,opacity:.9},
      onEachFeature:(_,layer)=>{
        layer.bindPopup(`<strong>${label(feature)}</strong><br>${d}<br><small>実際の位置や高さは現地で確認してください。</small>`);
        layer.on('click', () => {
          const cardEl = checks.querySelector(`[data-item-id="${CSS.escape(id)}"]`);
          if (cardEl) {
            document.querySelectorAll('.check-card').forEach(el => el.classList.remove('is-highlighted'));
            cardEl.classList.add('is-highlighted');
            cardEl.scrollIntoView({ behavior:'smooth', block:'center' });
          }
        });
      }
    }).addTo(utilityGroup);

    featureLayers.set(id, geoLayer);
  });
}

function renderChecks(features) {
  checks.innerHTML = '';

  const items = features.map((feature, index) => buildItem(feature, index));
  if (!items.length) items.push(BASELINE_RULE);

  items.forEach(item => {
    const node = template.content.cloneNode(true);
    bindCard(node, item);
    checks.appendChild(node);
  });

  updateSummary(items);
}

async function analyze() {
  if (!(route && routeBuffer && tol)) return;

  tolBuffer = turf.buffer(tol, MAP_SEARCH_DISTANCE_KM, { units:'kilometers' });
  redrawAreas();

  setChip(analysisChip, '分析中', 'loading');
  analysisState.textContent = '分析中';
  analysisState.className = 'state-badge loading';
  checks.innerHTML = '<div class="empty-state">周辺地図情報を取得しています…</div>';

  try {
    const bbox = turf.bbox(turf.featureCollection([routeBuffer, tolBuffer]));
    const osm = await fetchOverpass(queryFor(bbox));
    const geojson = osmtogeojson(osm);

    const all = (geojson.features || []).filter(
      f => intersects(f, routeBuffer) || intersects(f, tolBuffer)
    );
    const routeFeatures = all.filter(f => intersects(f, routeBuffer));
    const tolFeatures = all.filter(f => intersects(f, tolBuffer));

    currentFeatures = all;
    renderUtility(all);
    renderChecks(all);

    objectCount.textContent = all.length;
    routeCount.textContent = routeFeatures.length;
    tolCount.textContent = tolFeatures.length;

    setChip(analysisChip, '分析完了', 'done');
    analysisState.textContent = '分析完了';
    analysisState.className = 'state-badge done';

    coachTitle.textContent = '分析完了';
    coachBody.textContent = all.length
      ? '右側に対象物ごとの確認内容を表示しました。地図と現地の両方を見ながら確認してください。'
      : '地図上では対象物が見つかりませんでした。右側の現地確認項目を確認してください。';
  } catch (err) {
    console.error(err);
    utilityGroup.clearLayers();
    featureLayers.clear();
    currentFeatures = [];

    setChip(analysisChip, '取得失敗', 'error');
    analysisState.textContent = '取得失敗';
    analysisState.className = 'state-badge error';
    objectCount.textContent = '—';
    routeCount.textContent = tolCount.textContent = '—';

    const unavailable = {
      ...BASELINE_RULE,
      id: 'data-unavailable',
      objectType: '地図情報',
      title: '地図情報を取得できませんでした',
      location: '対象物の自動抽出を完了できませんでした。',
      relationship: '地図情報が取得できないため、予定飛行経路と周辺の対象物との位置関係を自動で確認できません。',
      verification: '予定飛行経路と離着陸地点の周辺を現地で確認し、電線、通信線、支線、電柱などが運航に影響しないことを確認できていますか？',
      reason: '地図情報の取得失敗を「対象物が存在しない」と判断しないための確認です。',
      limitation: '時間をおいて再度分析するか、地図情報に頼らず現地確認を行ってください。'
    };

    checks.innerHTML = '';
    const node = template.content.cloneNode(true);
    bindCard(node, unavailable);
    checks.appendChild(node);
    updateSummary([unavailable]);

    coachTitle.textContent = '地図情報を取得できませんでした';
    coachBody.textContent = '時間をおいて再度経路を確定するか、現地で周辺を確認してください。';
  }
}

window.addEventListener('load', () => {
  setTimeout(() => requestLocation(true), 350);
});
