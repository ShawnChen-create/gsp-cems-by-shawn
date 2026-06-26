const POLS = ['P101', 'P201', 'P301'];
const POL_COLORS = { P101: '#4f8cff', P201: '#5eea82', P301: '#ff8a2a' };
const POL_LABELS = { P101: 'P101 一號爐', P201: 'P201 二號爐', P301: 'P301 三號爐' };
let mode = 'online';
let chartInstances = [];
let liveEnabled = false;
let liveTimer = null;
let countdownTimer = null;
let nextRefreshAt = null;
let lastJson = null;

function getDateForApi() {
  const raw = document.getElementById('dateInput').value;
  if (!raw) return window.INITIAL_TODAY;
  return raw.replaceAll('-', '/');
}
function formatDateForInput(dateStr) { return (dateStr || '').replaceAll('/', '-'); }

function axisFmt(value, key, isMobile=false) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '';
  const n = Number(value);
  if (key === 'flow') return isMobile ? `${Math.round(n/1000)}k` : Math.round(n).toLocaleString();
  if (Math.abs(n) >= 100) return Math.round(n).toLocaleString();
  return Number(n).toFixed(1).replace(/\.0$/, '');
}

function fmt(value, key, fixed = false) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '--';
  const n = Number(value);
  if (key === 'flow') return Math.round(n).toLocaleString();
  if (fixed) return n.toFixed(2);
  return n.toFixed(2);
}
function fmt2(value, key) { return fmt(value, key, true); }
function statusClass(v) {
  const value = v?.value;
  const standard = v?.standard;
  if (value === null || value === undefined || standard === null || standard === undefined || standard <= 0) return 'normal';
  const ratio = value / standard;
  if (ratio >= 1) return 'danger';
  if (ratio >= 0.9) return 'orange';
  if (ratio >= 0.8) return 'warn';
  return 'normal';
}
function getLatest(data, pol, key) { return data?.[pol]?.latest?.values?.[key] || { value: null, standard: null, time: null }; }
function getAllTimes(data) { return POLS.map(pol => data?.[pol]?.latest?.time).filter(Boolean); }
function rowsFor(data, pol) { return data?.[pol]?.rows || data?.[pol]?.history || []; }

function numericValue(v) {
  if (!v || v.value === null || v.value === undefined || Number.isNaN(Number(v.value))) return null;
  return Number(v.value);
}
function currentHourBlock(rows, key) {
  const sortedRows = rows.slice().sort((a,b)=>rowOrderKey(a)-rowOrderKey(b));
  const vals = [];
  let standard = null;
  sortedRows.forEach(row => {
    const v = row?.values?.[key];
    const value = numericValue(v);
    if (v?.standard !== null && v?.standard !== undefined && standard === null) standard = Number(v.standard);
    if (value === null) return;
    vals.push({ time: row.time, value, standard: v.standard });
  });
  const latestRow = [...sortedRows].reverse().find(row => timeToMinute(row?.time) !== null);
  const latestMinute = timeToMinute(latestRow?.time || vals.at(-1)?.time);
  if (latestMinute === null) return null;

  // 小時平均區間採 00、15、30、45 四筆；整點不歸到前一小時。
  const blockStart = Math.floor(latestMinute / 60) * 60;
  const blockEnd = blockStart + 60;
  const slotMinutes = [blockStart, blockStart + 15, blockStart + 30, blockStart + 45];
  const byMinute = new Map(vals.map(item => [timeToMinute(item.time), item]));
  const slots = slotMinutes.map(m => {
    const h = Math.floor((m % 1440) / 60);
    const mm = m % 60;
    const time = `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    const hit = byMinute.get(m) || null;
    return hit ? { time, value: hit.value, standard: hit.standard, missing: false } : { time, value: null, standard: null, missing: true };
  });
  const valid = slots.filter(s => s.value !== null && s.value !== undefined);
  const std = standard || valid.find(s => s.standard !== null && s.standard !== undefined)?.standard || null;
  const avg = valid.length ? valid.reduce((a, b) => a + b.value, 0) / valid.length : null;
  const remain = std && valid.length < 4 ? (std * 4 - valid.reduce((a, b) => a + b.value, 0)) : null;
  return { samples: slots, avg, standard: std, remain, endTime: `${String(Math.floor((blockEnd % 1440) / 60)).padStart(2, '0')}:00` };
}
function hourlyAvgHtml(data, pol, key) {
  if (!['so2','nox','co','hcl'].includes(key)) return '';
  const block = currentHourBlock(rowsFor(data, pol), key);
  if (!block) return '';
  const std = block.standard;
  const sampleLines = block.samples.map(s => {
    const cls = std && s.value > std ? 'over' : 'under';
    return `<span class="avg-row avg-sample ${cls}"><span class="avg-time">${s.time}</span><span class="avg-num">${s.value === null || s.value === undefined ? '-' : fmt2(s.value, key)}</span></span>`;
  }).join('');
  const avgCls = std && block.avg !== null && block.avg > std ? 'over' : 'under';
  const limit = block.remain !== null && block.remain !== undefined
    ? `<span class="avg-row avg-limit"><span class="avg-label">次筆餘裕</span><span class="avg-num">&lt; ${fmt2(block.remain, key)}</span></span>`
    : '';
  const avgText = block.avg === null || block.avg === undefined ? '-' : fmt2(block.avg, key);
  return `<span class="avg-block">${sampleLines}<span class="avg-row avg-current ${avgCls}"><span class="avg-label">小時均值</span><span class="avg-num">${avgText}</span></span>${limit}</span>`;
}


function renderLatest(data, pollutants) {
  const body = document.getElementById('latestBody');
  body.innerHTML = '';
  pollutants.forEach(p => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<th><span class="item-name">${p.label}</span><span class="item-meta">${p.unit}</span></th>`;
    POLS.forEach(pol => {
      const v = getLatest(data, pol, p.key);
      const standardText = v.standard ? `<span class="std">標準 ${fmt(v.standard, p.key)}</span>` : '<span class="std">無標準</span>';
      tr.innerHTML += `<td class="${statusClass(v)}"><span class="latest-main"><span class="value">${fmt(v.value, p.key)}</span><span class="meta">${v.time || '--'}</span>${standardText}</span>${hourlyAvgHtml(data, pol, p.key)}</td>`;
    });
    body.appendChild(tr);
  });
  const times = getAllTimes(data);
  document.getElementById('latestTime').textContent = times.length ? `最新有效時間 ${times.sort().at(-1)}` : '尚無資料';
  renderExceedance(data, pollutants);
}

function timeToMinute(time) {
  if (!time || !time.includes(':')) return null;
  const [h, m] = time.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}
function rowOrderKey(row) {
  if (row?.timestamp) {
    const d = new Date(String(row.timestamp).replace(' ', 'T'));
    if (!Number.isNaN(d.getTime())) return d.getTime();
  }
  const m = timeToMinute(row?.time);
  return m === null ? 0 : m;
}
function hourGroupKey(time) {
  const min = timeToMinute(time);
  if (min === null) return null;
  const startHour = Math.floor(min / 60);
  if (startHour < 0 || startHour > 23) return null;
  return `${String(startHour).padStart(2, '0')}:00`;
}
function expectedSamples(p) { return Math.max(1, Math.round(60 / Number(p.interval_min || 60))); }
function exceedanceCount(data, pol, pollutant) {
  const rows = rowsFor(data, pol);
  const key = pollutant.key;
  const groups = new Map();
  let standard = null;
  rows.slice().sort((a,b)=>rowOrderKey(a)-rowOrderKey(b)).forEach(row => {
    const v = row?.values?.[key];
    if (!v || v.value === null || v.value === undefined) return;
    if (v.standard !== null && v.standard !== undefined && standard === null) standard = Number(v.standard);
    const group = hourGroupKey(row.time);
    if (!group) return;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(Number(v.value));
  });
  if (!standard || standard <= 0) return { count: null, checked: 0, standard: null };
  const need = expectedSamples(pollutant);
  let count = 0;
  let checked = 0;
  for (const vals of groups.values()) {
    if (vals.length < need) continue;
    checked += 1;
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    if (avg > standard) count += 1;
  }
  return { count, checked, standard };
}
function renderExceedance(data, pollutants) {
  const body = document.getElementById('exceedBody');
  body.innerHTML = '';
  const target = pollutants.filter(p => ['so2', 'nox', 'co', 'hcl'].includes(p.key));
  target.forEach(p => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<th><span class="item-name">${p.label}</span><span class="item-meta">${p.unit}</span></th>`;
    POLS.forEach(pol => {
      const result = exceedanceCount(data, pol, p);
      const countText = result.count === null ? '--' : result.count;
      const cls = result.count && result.count > 0 ? 'nonzero' : 'zero';
      const detail = result.count === null ? '無標準' : `${result.checked} 小時`;
      tr.innerHTML += `<td><span class="exceed-count ${cls}">${countText}</span><span class="exceed-detail">${detail}</span></td>`;
    });
    body.appendChild(tr);
  });
}

function seriesFor(data, pol, key) {
  const rows = rowsFor(data, pol);
  const map = new Map();
  rows.slice().sort((a,b)=>rowOrderKey(a)-rowOrderKey(b)).forEach(r => {
    const v = r?.values?.[key];
    if (!r?.time || v?.value === null || v?.value === undefined) return;
    const m = timeToMinute(r.time);
    if (m === null) return;
    const order = rowOrderKey(r);
    // 同一時間若有重複值，保留最後一次；依 timestamp 排序，避免 O₂ / 排放流率折線回跳。
    map.set(r.time, { time: r.time, minute: m, order, value: Number(v.value) });
  });
  return Array.from(map.values()).sort((a, b) => a.order - b.order);
}
function standardFor(data, key) {
  for (const pol of POLS) {
    for (const row of rowsFor(data, pol)) {
      const standard = row?.values?.[key]?.standard;
      if (standard !== null && standard !== undefined) return standard;
    }
  }
  return null;
}
function hasAnySeries(data, key) { return POLS.some(pol => seriesFor(data, pol, key).length > 0); }
function chartLabels(data, key) {
  const labelMap = new Map();
  POLS.forEach(pol => seriesFor(data, pol, key).forEach(p => {
    if (!labelMap.has(p.time)) labelMap.set(p.time, p.order);
  }));
  return Array.from(labelMap.entries()).sort((a,b) => a[1]-b[1]).map(([time]) => time);
}
function chartAxisLabel(value) {
  if (!value || !value.includes(':')) return '';
  const [hh, mm] = value.split(':').map(Number);
  if (Number.isNaN(hh) || Number.isNaN(mm)) return '';
  if (mm !== 0) return '';
  if (hh % 2 === 0 || hh === 23) return String(hh).padStart(2, '0');
  return '';
}

function renderCharts(data, pollutants) {
  chartInstances.forEach(c => c.dispose());
  chartInstances = [];
  const wrap = document.getElementById('charts');
  wrap.innerHTML = '';
  pollutants.filter(p => hasAnySeries(data, p.key)).forEach(p => {
    const card = document.createElement('div');
    card.className = 'chart-card';
    card.innerHTML = `<div class="chart-title"><strong>${p.label} (${p.unit})</strong><span>24 小時｜${p.interval_min} 分鐘</span></div><div class="chart" id="chart-${p.key}"></div>`;
    wrap.appendChild(card);
    const chart = echarts.init(card.querySelector('.chart'));
    const standard = standardFor(data, p.key);
    const isMobile = window.innerWidth <= 620;
    const labels = chartLabels(data, p.key);
    const mainWidth = isMobile ? 0.85 : 1.15;
    const standardWidth = isMobile ? 0.65 : 0.85;
    const intervalStep = p.key === 'flow' || p.key === 'temp' ? 1 : (isMobile ? 6 : 4);
    const series = POLS.map(pol => {
      const pointMap = new Map(seriesFor(data, pol, p.key).map(item => [item.time, item.value]));
      return {
        name: pol,
        type: 'line',
        smooth: false,
        showSymbol: false,
        connectNulls: false,
        data: labels.map(t => pointMap.has(t) ? pointMap.get(t) : null),
        lineStyle: { width: mainWidth, color: POL_COLORS[pol] },
        itemStyle: { color: POL_COLORS[pol] },
        emphasis: { lineStyle: { width: mainWidth + 0.7 } }
      };
    });
    if (standard) {
      series.push({
        name: `標準 ${fmt(standard, p.key)}`,
        type: 'line',
        showSymbol: false,
        data: labels.map(() => standard),
        lineStyle: { width: standardWidth, type: 'dashed', color: '#fb7185' },
        itemStyle: { color: '#fb7185' }
      });
    }
    chart.setOption({
      color: POLS.map(p => POL_COLORS[p]),
      backgroundColor: 'transparent',
      tooltip: { trigger: 'axis', backgroundColor: '#061321', borderColor: '#28415f', textStyle: { color: '#e8f1ff' } },
      legend: { top: 0, itemWidth: isMobile ? 12 : 20, itemHeight: isMobile ? 7 : 10, textStyle: { color: '#b9cbe4', fontSize: isMobile ? 10 : 12 } },
      grid: { left: isMobile ? 34 : 44, right: isMobile ? 10 : 18, top: isMobile ? 34 : 42, bottom: isMobile ? 28 : 36 },
      xAxis: {
        type: 'category',
        data: labels,
        boundaryGap: false,
        axisLabel: {
          color: '#9fb8d8',
          fontSize: isMobile ? 10 : 12,
          interval: 0,
          hideOverlap: true,
          formatter: chartAxisLabel,
        },
        axisLine: { lineStyle: { color: '#28415f' } }
      },
      yAxis: { type: 'value', splitNumber: isMobile ? 3 : 4, axisLabel: { color: '#9fb8d8', fontSize: isMobile ? 10 : 12, formatter: (value) => axisFmt(value, p.key, isMobile) }, splitLine: { lineStyle: { color: 'rgba(255,255,255,.08)', width: 0.8 } } },
      series,
    });
    chartInstances.push(chart);
  });
  if (!wrap.children.length) wrap.innerHTML = '<p class="hint">尚無可繪製的趨勢資料。</p>';
}

function buildUrl() {
  const date = getDateForApi();
  return `/api/live?mode=${encodeURIComponent(mode)}&date=${encodeURIComponent(date)}&pols=P101,P201,P301`;
}
function updateLiveUi() {
  const dot = document.getElementById('liveDot');
  const liveText = document.getElementById('liveText');
  const nextText = document.getElementById('nextText');
  const btn = document.getElementById('liveBtn');
  dot.className = liveEnabled ? 'live-dot on' : 'live-dot off';
  liveText.textContent = liveEnabled ? 'LIVE 自動更新中' : 'LIVE 已停止';
  btn.textContent = liveEnabled ? '停止 LIVE' : '啟動 LIVE';
  btn.classList.toggle('active', liveEnabled);
  if (!liveEnabled || !nextRefreshAt) { nextText.textContent = ''; return; }
  const left = Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000));
  nextText.textContent = `下次更新 ${left} 秒`;
}
function scheduleNext() {
  clearTimeout(liveTimer);
  clearInterval(countdownTimer);
  if (!liveEnabled) { updateLiveUi(); return; }
  const seconds = Number(document.getElementById('intervalSelect').value || 300);
  nextRefreshAt = Date.now() + seconds * 1000;
  countdownTimer = setInterval(updateLiveUi, 1000);
  liveTimer = setTimeout(async () => { await loadData(false); scheduleNext(); }, seconds * 1000);
  updateLiveUi();
}
async function loadData(resetLiveTimer = true) {
  document.getElementById('statusText').textContent = '查詢中...';
  try {
    const res = await fetch(buildUrl());
    const json = await res.json();
    lastJson = json;
    if (!json.ok && json.errors) document.getElementById('statusText').textContent = `部分查詢失敗｜${mode}｜${json.updated_at || ''}`;
    else document.getElementById('statusText').textContent = `更新成功｜線上查詢｜${json.updated_at || ''}`;
    renderLatest(json.data || {}, json.pollutants || window.POLLUTANTS || []);
    renderCharts(json.data || {}, json.pollutants || window.POLLUTANTS || []);
    const stats = json.cache_stats || {};
    document.getElementById('cacheInfo').textContent = `快取項目 ${Object.keys(stats).length} 組`;
    if (resetLiveTimer && liveEnabled) scheduleNext();
  } catch (err) {
    document.getElementById('statusText').textContent = `查詢失敗：${err.message}`;
  }
}
function setMode(nextMode) {
  mode = nextMode;
  ['offline','online','cache'].forEach(m => { const btn = document.getElementById(`${m}Btn`); if (btn) btn.classList.toggle('active', m === nextMode); });
  loadData();
}
window.addEventListener('resize', () => chartInstances.forEach(c => c.resize()));
document.getElementById('dateInput').value = formatDateForInput(window.INITIAL_TODAY);
const dateInputEl = document.getElementById('dateInput');
dateInputEl.addEventListener('change', () => {
  document.getElementById('statusText').textContent = '日期已變更，請點右上角「更新」並等待查詢完成。';
});
['offlineBtn','onlineBtn','cacheBtn'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', () => setMode(id.replace('Btn','')));
});
document.getElementById('refreshBtn').addEventListener('click', () => loadData());
document.getElementById('liveBtn').addEventListener('click', () => { liveEnabled = !liveEnabled; if (liveEnabled) { loadData(false).then(scheduleNext); } else { scheduleNext(); } });
document.getElementById('intervalSelect').addEventListener('change', () => { if (liveEnabled) scheduleNext(); });
updateLiveUi();
loadData();
