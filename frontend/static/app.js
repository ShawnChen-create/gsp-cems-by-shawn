const POL_NAMES={opacity:'不透光率',so2:'SO₂',nox:'NOx',co:'CO',hcl:'HCl',nh3:'NH₃',o2:'O₂',flow:'排放流率',temp:'溫度'};
let charts=[];
async function loadData(){
  const date=document.getElementById('dateInput').value;
  const mode=document.getElementById('sourceMode').value;
  const url=mode==='offline'?'/api/offline-test':`/api/cems?date=${encodeURIComponent(date)}&pols=P101,P201,P301`;
  document.getElementById('status').textContent='查詢中...';
  const res=await fetch(url);
  const json=await res.json();
  if(!json.ok && json.errors){document.getElementById('status').textContent='部分查詢失敗：'+JSON.stringify(json.errors);}
  else{document.getElementById('status').textContent='更新完成';}
  renderLatest(json.data||{},json.pollutants||[]);
  renderCharts(json.data||{},json.pollutants||[]);
}
function latestValue(obj,key){
  if(!obj) return '—';
  const latest=obj.latest;
  if(latest?.values?.[key]?.value!=null) return latest.values[key].value;
  const rows=obj.rows||[];
  for(let i=rows.length-1;i>=0;i--){const v=rows[i].values?.[key]?.value;if(v!=null)return v;}
  return '—';
}
function renderLatest(data,pollutants){
  let html='<table><thead><tr><th>項目</th><th class="p101">P101 一號爐</th><th class="p201">P201 二號爐</th><th class="p301">P301 三號爐</th></tr></thead><tbody>';
  pollutants.forEach(p=>{html+=`<tr><th>${p.label}<br><small>${p.unit}</small></th><td class="p101">${latestValue(data.P101,p.key)}</td><td class="p201">${latestValue(data.P201,p.key)}</td><td class="p301">${latestValue(data.P301,p.key)}</td></tr>`});
  html+='</tbody></table>';
  document.getElementById('latestTable').innerHTML=html;
}
function series(data,pol,key){
  const rows=data[pol]?.rows||[];
  return rows.filter(r=>r.values?.[key]?.value!=null).map(r=>({x:r.time,y:r.values[key].value}));
}
function renderCharts(data,pollutants){
  charts.forEach(c=>c.destroy());charts=[];
  const wrap=document.getElementById('charts');wrap.innerHTML='';
  pollutants.forEach(p=>{
    const div=document.createElement('div');div.className='chart-card';div.innerHTML=`<h3>${p.label} (${p.unit})｜資料頻率 ${p.interval_min} 分鐘</h3><canvas></canvas>`;wrap.appendChild(div);
    const ctx=div.querySelector('canvas');
    const labels=[...new Set(['P101','P201','P301'].flatMap(pol=>series(data,pol,p.key).map(d=>d.x)))].sort();
    const datasets=['P101','P201','P301'].map(pol=>{const m=new Map(series(data,pol,p.key).map(d=>[d.x,d.y]));return{label:pol,data:labels.map(x=>m.get(x)??null),spanGaps:true,tension:.25}});
    charts.push(new Chart(ctx,{type:'line',data:{labels,datasets},options:{responsive:true,plugins:{legend:{labels:{color:'#d9ecff'}}},scales:{x:{ticks:{color:'#9fb8d8'}},y:{ticks:{color:'#9fb8d8'},grid:{color:'#1e3854'}}}}}));
  });
}
document.getElementById('btnQuery').addEventListener('click',loadData);
document.getElementById('btnRefresh').addEventListener('click',loadData);
loadData();
