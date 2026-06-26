let allRows = [];
let chart;

function toInputDate(d){ return d.toISOString().slice(0,10); }
function toApiDate(s){ return s.replaceAll('-', '/'); }
function selectedPorts(){ return [...document.querySelectorAll('input[name="port"]:checked')].map(x=>x.value); }
function setStatus(text, cls=''){ const el=document.getElementById('statusDot'); el.textContent=text; el.className='status '+cls; }
function setMsg(text){ document.getElementById('message').textContent=text; }

function initDates(){
  const today = new Date();
  document.getElementById('startDate').value = toInputDate(today);
  document.getElementById('endDate').value = toInputDate(today);
}

function latestRows(rows, pollutant){
  const ports = ['P101','P201','P301'];
  return ports.map(port => rows.filter(r => r.port===port && r.pollutant===pollutant).sort((a,b)=>a.timestamp.localeCompare(b.timestamp)).at(-1)).filter(Boolean);
}

function statusBy(row){
  if(!row.standard) return {text:'資料', cls:''};
  const ratio = row.value / row.standard;
  if(ratio >= 1) return {text:'超標', cls:'danger'};
  if(ratio >= 0.8) return {text:'接近', cls:'warn'};
  return {text:'正常', cls:''};
}

function renderCards(rows){
  const pollutant = document.getElementById('pollutant').value;
  const cards = latestRows(rows, pollutant).map(r=>{
    const s = statusBy(r);
    const std = r.standard ? `標準 ${r.standard}` : '未列標準';
    return `<article class="card">
      <div class="card-top"><b>${r.port}</b><span class="badge ${s.cls}">${s.text}</span></div>
      <div class="value">${r.value}</div>
      <div class="unit">${pollutant}｜${std}</div>
      <div class="unit">${r.timestamp}${r.hourly_avg ? '｜小時平均' : ''}</div>
    </article>`;
  }).join('');
  document.getElementById('cards').innerHTML = cards || '<div class="message">目前沒有可顯示的最新值。</div>';
}

function renderChart(rows){
  const pollutant = document.getElementById('pollutant').value;
  const ctx = document.getElementById('trendChart');
  const filtered = rows.filter(r=>r.pollutant===pollutant).sort((a,b)=>a.timestamp.localeCompare(b.timestamp));
  const labels = [...new Set(filtered.map(r=>r.timestamp))];
  const ports = [...new Set(filtered.map(r=>r.port))];
  const datasets = ports.map(port=>({
    label: port,
    data: labels.map(t => {
      const found = filtered.find(r=>r.port===port && r.timestamp===t);
      return found ? found.value : null;
    }),
    tension:.28,
    spanGaps:true
  }));
  const std = filtered.find(r=>r.standard)?.standard;
  if(std){ datasets.push({label:'標準值', data:labels.map(()=>std), borderDash:[6,6], pointRadius:0, tension:0}); }
  if(chart) chart.destroy();
  chart = new Chart(ctx, { type:'line', data:{labels,datasets}, options:{responsive:true, plugins:{legend:{labels:{color:'#eef5ff'}}}, scales:{x:{ticks:{color:'#93a4bd', maxRotation:60}, grid:{color:'rgba(147,164,189,.12)'}}, y:{ticks:{color:'#93a4bd'}, grid:{color:'rgba(147,164,189,.12)'}}} } });
}

async function query(){
  const ports = selectedPorts();
  if(!ports.length){ setMsg('請至少選擇一個排放口。'); return; }
  const start = toApiDate(document.getElementById('startDate').value);
  const end = toApiDate(document.getElementById('endDate').value);
  setStatus('查詢中'); setMsg('正在查詢高雄 CEMS 網站，請稍候...');
  try{
    const res = await fetch(`/api/query?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&ports=${ports.join(',')}`);
    const json = await res.json();
    if(!json.ok) throw new Error(json.error || '查詢失敗');
    allRows = json.data || [];
    renderCards(allRows); renderChart(allRows);
    setStatus('完成','ok');
    setMsg(`完成：共取得 ${json.count} 筆資料。${json.errors?.length ? '\n提醒：' + json.errors.join('\n') : ''}`);
  }catch(e){ setStatus('錯誤','err'); setMsg('查詢失敗：' + e.message + '\n若部署在 Render 後失敗，可能需要設定 CEMS_COOKIE 環境變數。'); }
}

function csvDownload(){
  if(!allRows.length){ setMsg('目前沒有資料可匯出。'); return; }
  const cols = ['timestamp','port','pollutant','value','standard','hourly_avg','raw'];
  const csv = [cols.join(',')].concat(allRows.map(r=>cols.map(c=>JSON.stringify(r[c] ?? '')).join(','))).join('\n');
  const blob = new Blob(['\ufeff'+csv], {type:'text/csv;charset=utf-8'});
  const a = document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='gsp_cems_by_shawn.csv'; a.click(); URL.revokeObjectURL(a.href);
}

document.getElementById('queryBtn').addEventListener('click', query);
document.getElementById('pollutant').addEventListener('change', ()=>{ renderCards(allRows); renderChart(allRows); });
document.getElementById('downloadCsv').addEventListener('click', csvDownload);
initDates();
