let currentPayload = null;
const metricInfo = {
  opacity:['不透光率','%'], so2:['SO₂','ppm'], nox:['NOx','ppm'], co:['CO','ppm'], hcl:['HCl','ppm'], o2:['O₂','%'], flow:['排放流率','Nm³/hr'], temp:['溫度','°C']
};
const colors = {P101:'#138a3d', P201:'#0b63ce', P301:'#7030a0'};
function latestRow(rows){ return (rows || []).find(r => r.values && Object.keys(r.values).length) || (rows || [])[0]; }
function clsFor(v){ if(!v || v.value===null || !v.standard) return ''; const ratio = v.value / v.standard; if(ratio >= 1) return 'danger'; if(ratio >= .8) return 'warn'; return ''; }
function fmt(v){ return (v===null || v===undefined || Number.isNaN(v)) ? '--' : Number(v).toLocaleString(undefined,{maximumFractionDigits:2}); }
function renderCards(payload){
  const wrap = document.getElementById('cards'); wrap.innerHTML='';
  Object.entries(payload.data || {}).forEach(([pol, obj])=>{
    const row = latestRow(obj.rows || []); const values = row?.values || {}; const furnace = document.createElement('div'); furnace.className = `furnace ${pol}`;
    const title = pol==='P101'?'P101（1號爐）':pol==='P201'?'P201（2號爐）':'P301（3號爐）';
    furnace.innerHTML = `<div class="furnace-head"><span>${title}</span><span><i class="dot"></i>正常</span></div><div class="grid"></div>`;
    const grid = furnace.querySelector('.grid');
    ['hcl','so2','nox','co','o2','temp'].forEach(k=>{
      const info = metricInfo[k]; const v = values[k] || {}; const div = document.createElement('div'); div.className = `metric ${clsFor(v)}`;
      div.innerHTML = `<div class="label">${info[0]}</div><div class="value">${fmt(v.value)}</div><div class="unit">${info[1]}</div><div class="std">${v.standard ? '標準 '+fmt(v.standard) : '標準 --'}</div>`;
      grid.appendChild(div);
    });
    wrap.appendChild(furnace);
  });
}
function renderChart(payload){
  const metric = document.getElementById('metricSelect').value; const [label,unit] = metricInfo[metric];
  const traces = []; let standard = null;
  Object.entries(payload.data || {}).forEach(([pol,obj])=>{
    const rows = (obj.rows || []).slice().reverse();
    const x=[], y=[]; rows.forEach(r=>{ const v = r.values?.[metric]; if(v && v.value!==null){ x.push(r.time); y.push(v.value); if(v.standard) standard = v.standard; }});
    traces.push({x,y,type:'scatter',mode:'lines+markers',name:pol,line:{color:colors[pol],width:2},marker:{size:5}});
  });
  if(standard){ const allx = traces.flatMap(t=>t.x); if(allx.length){ traces.push({x:[allx[0], allx[allx.length-1]],y:[standard,standard],type:'scatter',mode:'lines',name:'標準值',line:{color:'#dc2626',dash:'dash',width:2}}); }}
  Plotly.newPlot('chart', traces, {margin:{l:42,r:10,t:10,b:38},height:330,paper_bgcolor:'rgba(0,0,0,0)',plot_bgcolor:'rgba(0,0,0,0)',yaxis:{title:`${label} ${unit}`},legend:{orientation:'h',x:0,y:1.16}}, {displayModeBar:false,responsive:true});
  document.getElementById('chartSubtitle').textContent = `${label}（${unit}）`;
}
function renderTable(payload){
  const wrap = document.getElementById('tableWrap'); const keys=['hcl','so2','nox','co','o2','temp','flow'];
  let html='<table class="data-table"><thead><tr><th>排放口</th><th>時間</th>'+keys.map(k=>`<th>${metricInfo[k][0]}</th>`).join('')+'</tr></thead><tbody>';
  Object.entries(payload.data || {}).forEach(([pol,obj])=>{ (obj.rows||[]).slice(0,12).forEach(r=>{ html+=`<tr><td>${pol}</td><td>${r.time}</td>`+keys.map(k=>`<td>${fmt(r.values?.[k]?.value)}</td>`).join('')+'</tr>'; }); });
  html+='</tbody></table>'; wrap.innerHTML=html;
}
async function query(){
  const date = document.getElementById('dateInput').value.trim(); const pols = document.getElementById('polSelect').value;
  const status = document.getElementById('status'); status.textContent='查詢中...'; status.className='status';
  try{
    const res = await fetch(`/api/cems?date=${encodeURIComponent(date)}&pols=${encodeURIComponent(pols)}`); const payload = await res.json(); currentPayload = payload;
    if(Object.keys(payload.errors||{}).length){ status.innerHTML='部分查詢失敗：<span class="err">'+Object.entries(payload.errors).map(([k,v])=>`${k}: ${v}`).join('；')+'</span>'; }
    else{ status.textContent=`查詢完成：${payload.date}`; }
    renderCards(payload); renderChart(payload); renderTable(payload);
  }catch(e){ status.innerHTML=`<span class="err">查詢失敗：${e.message}</span>`; }
}
function toCSV(){
  if(!currentPayload) return; const keys=['hcl','so2','nox','co','o2','temp','flow'];
  const rows=[['date','pol_no','time',...keys]];
  Object.entries(currentPayload.data||{}).forEach(([pol,obj])=>{ (obj.rows||[]).forEach(r=>rows.push([currentPayload.date,pol,r.time,...keys.map(k=>r.values?.[k]?.value ?? '')])); });
  const csv = rows.map(r=>r.map(c=>`"${String(c).replaceAll('"','""')}"`).join(',')).join('\n');
  const blob = new Blob(['\ufeff'+csv], {type:'text/csv;charset=utf-8'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='gsp_cems.csv'; a.click();
}
document.getElementById('queryBtn').addEventListener('click', query);
document.getElementById('refreshBtn').addEventListener('click', query);
document.getElementById('metricSelect').addEventListener('change', ()=> currentPayload && renderChart(currentPayload));
document.getElementById('csvBtn').addEventListener('click', toCSV);
query();
