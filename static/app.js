let currentPayload = null;

const metricInfo = {
  opacity:{label:'不透光率', unit:'%', interval:6},
  so2:{label:'SO₂', unit:'ppm', interval:15},
  nox:{label:'NOx', unit:'ppm', interval:15},
  co:{label:'CO', unit:'ppm', interval:15},
  hcl:{label:'HCl', unit:'ppm', interval:15},
  nh3:{label:'NH₃', unit:'ppm', interval:15},
  o2:{label:'O₂', unit:'%', interval:15},
  flow:{label:'排放流率', unit:'Nm³/hr', interval:60},
  temp:{label:'溫度', unit:'°C', interval:60},
};
const metricOrder = ['opacity','so2','nox','co','hcl','nh3','o2','flow','temp'];
const colors = {P101:'#2f8cff', P201:'#50d266', P301:'#ff8a1f'};
const polName = {P101:'P101 一號爐', P201:'P201 二號爐', P301:'P301 三號爐'};

function fmt(v){
  if(v === null || v === undefined || Number.isNaN(v)) return '--';
  return Number(v).toLocaleString('zh-TW', {maximumFractionDigits:2});
}
function parseTs(row){
  const s = `${row.date} ${row.time}`.replaceAll('/', '-');
  return new Date(s);
}
function getValue(row, key){ return row?.values?.[key]?.value ?? null; }
function getStandard(rows, key){
  for(const r of rows || []){
    const s = r?.values?.[key]?.standard;
    if(s !== null && s !== undefined) return s;
  }
  return null;
}
function latestValueForMetric(rows, key){
  for(const r of rows || []){
    const v = getValue(r, key);
    if(v !== null) return {row:r, value:r.values[key]};
  }
  return {row:null, value:null};
}
function statusClass(v){
  if(!v || v.value === null || !v.standard) return '';
  const ratio = v.value / v.standard;
  if(ratio >= 1) return 'danger';
  if(ratio >= 0.8) return 'warn';
  return 'ok';
}

function renderLatestTable(payload){
  const wrap = document.getElementById('latestTable');
  const pols = ['P101','P201','P301'];
  let html = '<table class="latest-table"><thead><tr><th>項目</th>' + pols.map(p=>`<th class="${p}">${polName[p]}</th>`).join('') + '</tr></thead><tbody>';
  metricOrder.forEach(key=>{
    const info = metricInfo[key];
    html += `<tr><td><b>${info.label}</b><small>${info.unit}｜${info.interval}分鐘/筆</small></td>`;
    pols.forEach(pol=>{
      const rows = payload.data?.[pol]?.rows || [];
      const {row, value} = latestValueForMetric(rows, key);
      const cls = statusClass(value);
      html += `<td class="value-cell ${cls}"><div class="num">${fmt(value?.value)}</div><div class="sub">${row?.time || '--'}${value?.standard ? `｜標準 ${fmt(value.standard)}` : ''}</div></td>`;
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

function rolling24h(rows, key){
  const points = (rows || [])
    .map(r => ({t: parseTs(r), time: r.time, date: r.date, y: getValue(r, key)}))
    .filter(p => p.t.toString() !== 'Invalid Date' && p.y !== null)
    .sort((a,b)=>a.t-b.t);
  if(!points.length) return [];
  const latest = points[points.length - 1].t;
  const start = new Date(latest.getTime() - 24*60*60*1000);
  const out = [];
  let left = 0, sum = 0;
  for(let right=0; right<points.length; right++){
    sum += points[right].y;
    const minT = new Date(points[right].t.getTime() - 24*60*60*1000);
    while(points[left] && points[left].t < minT){
      sum -= points[left].y;
      left++;
    }
    if(points[right].t >= start){
      const n = right - left + 1;
      out.push({t: points[right].t, x: points[right].t, y: sum / n});
    }
  }
  return out;
}

function makeChartDiv(key){
  const info = metricInfo[key];
  const div = document.createElement('div');
  div.className = 'chart-card';
  div.innerHTML = `<div class="chart-head"><h3>${info.label} <span>(${info.unit})</span></h3><div class="latest-mini" id="mini-${key}"></div></div><div id="chart-${key}" class="chart"></div>`;
  return div;
}

function renderCharts(payload){
  const selected = document.getElementById('metricSelect').value;
  const keys = selected === 'all' ? metricOrder : [selected];
  const wrap = document.getElementById('charts');
  wrap.innerHTML = '';
  keys.forEach(k => wrap.appendChild(makeChartDiv(k)));

  keys.forEach(key=>{
    const info = metricInfo[key];
    const traces = [];
    let standard = null;
    const mini = [];
    ['P101','P201','P301'].forEach(pol=>{
      const obj = payload.data?.[pol];
      if(!obj) return;
      const history = obj.history_rows || obj.rows || [];
      const avg = rolling24h(history, key);
      const x = avg.map(p=>p.x);
      const y = avg.map(p=>Number(p.y.toFixed(3)));
      standard = standard ?? getStandard(history, key);
      const latest = latestValueForMetric(obj.rows || [], key);
      mini.push(`<span style="color:${colors[pol]}">${pol}: ${fmt(latest.value?.value)}</span>`);
      traces.push({
        x, y, type:'scatter', mode:'lines', name:pol,
        line:{color:colors[pol], width:2.5},
        hovertemplate:`${pol}<br>%{x|%m/%d %H:%M}<br>24h移動平均: %{y:.2f} ${info.unit}<extra></extra>`
      });
    });
    if(standard && traces.some(t=>t.x.length)){
      const allx = traces.flatMap(t=>t.x);
      traces.push({
        x:[new Date(Math.min(...allx.map(d=>d.getTime()))), new Date(Math.max(...allx.map(d=>d.getTime())))],
        y:[standard, standard], type:'scatter', mode:'lines', name:'標準值',
        line:{color:'#ff4d4d', dash:'dash', width:2},
        hovertemplate:`標準值 ${standard} ${info.unit}<extra></extra>`
      });
    }
    document.getElementById(`mini-${key}`).innerHTML = mini.join('　');
    Plotly.newPlot(`chart-${key}`, traces, {
      margin:{l:42,r:12,t:8,b:34}, height:260,
      paper_bgcolor:'rgba(0,0,0,0)', plot_bgcolor:'rgba(0,0,0,0)',
      font:{color:'#dbeafe'},
      xaxis:{gridcolor:'rgba(148,163,184,.18)', tickformat:'%H:%M'},
      yaxis:{title:info.unit, gridcolor:'rgba(148,163,184,.18)', zerolinecolor:'rgba(148,163,184,.25)'},
      legend:{orientation:'h', x:0, y:-0.18}
    }, {displayModeBar:false, responsive:true});
  });
  document.getElementById('chartSubtitle').textContent = selected === 'all' ? '全部項目｜每張圖顯示 P101 / P201 / P301' : `${metricInfo[selected].label}｜24小時移動平均`;
}

async function query(){
  const date = document.getElementById('dateInput').value.trim();
  const status = document.getElementById('status');
  status.textContent = '查詢中，正在讀取 P101／P201／P301...';
  status.className = 'status';
  try{
    const res = await fetch(`/api/cems?date=${encodeURIComponent(date)}&pols=P101,P201,P301&history=1`);
    const payload = await res.json();
    currentPayload = payload;
    const now = new Date();
    document.getElementById('lastUpdate').textContent = `最後更新：${now.toLocaleString('zh-TW', {hour12:false})}`;
    const errs = Object.entries(payload.errors || {});
    if(errs.length){
      status.innerHTML = '部分查詢失敗：<span class="err">' + errs.map(([k,v])=>`${k}: ${v}`).join('；') + '</span>';
    }else{
      status.textContent = `查詢完成：${payload.date}，三爐資料已更新。`;
    }
    renderLatestTable(payload);
    renderCharts(payload);
  }catch(e){
    status.innerHTML = `<span class="err">查詢失敗：${e.message}</span>`;
  }
}

function toCSV(){
  if(!currentPayload) return;
  const rows = [['date','pol_no','time',...metricOrder]];
  Object.entries(currentPayload.data || {}).forEach(([pol,obj])=>{
    (obj.rows || []).forEach(r=>{
      rows.push([currentPayload.date, pol, r.time, ...metricOrder.map(k=>r.values?.[k]?.value ?? '')]);
    });
  });
  const csv = rows.map(r=>r.map(c=>`"${String(c).replaceAll('"','""')}"`).join(',')).join('\n');
  const blob = new Blob(['\ufeff'+csv], {type:'text/csv;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `gsp_cems_${currentPayload.date.replaceAll('/','')}.csv`;
  a.click();
}

document.getElementById('queryBtn').addEventListener('click', query);
document.getElementById('refreshBtn').addEventListener('click', query);
document.getElementById('metricSelect').addEventListener('change', ()=> currentPayload && renderCharts(currentPayload));
document.getElementById('csvBtn').addEventListener('click', toCSV);
query();
