const payrollAdminEmail='sandunpersonal@gmail.com';
const payrollConnection=[
  'https://grwpirvruekocuydrjhn.supabase.co',
  'sb_publishable_4CS6L84JSXxjm1TPUJWbCQ_ZwUwjzTm',
];
const payrollClient=window.supabase?.createClient(...payrollConnection,
  {auth:{storageKey:'gtl-payroll-auth',persistSession:true,detectSessionInUrl:true}}
);

function splitWorkingMinutes(start,end){
  // Parse the workbook's local wall-clock timestamps without browser timezone conversion.
  if(!start.includes('T')||!end.includes('T'))return null;
  const first=Date.parse(start+'Z'), last=Date.parse(end+'Z');
  const minute=60_000, day=1440*minute;
  if(!Number.isFinite(first)||!Number.isFinite(last)||last<first)return null;
  let regular=0;
  for(let date=Math.floor(first/day)*day;date<last;date+=day){
    regular+=Math.max(0,Math.min(last,date+17*60*minute)-Math.max(first,date+8*60*minute));
  }
  return {day:regular/minute,ot:(last-first-regular)/minute,total:(last-first)/minute};
}

const money=value=>new Intl.NumberFormat('en-LK',{style:'currency',currency:'LKR',minimumFractionDigits:2,maximumFractionDigits:2}).format(value);
const knownAmount=value=>Number.isFinite(value)&&value>=0;
const overtimeRate=basic=>knownAmount(basic)?basic/200*1.5:null;

const payrollEpf=value=>String(value??'').trim().replace(/^0+(?=\d)/,'');
const regularPay=person=>knownAmount(person?.regularPay)?person.regularPay:
  knownAmount(person?.basic)&&knownAmount(person?.allowance)?person.basic+person.allowance:null;


async function buildMonthlyExcel(sheets){
  const zip=new JSZip();
  const ns='http://schemas.openxmlformats.org';
  const rel=ns+'/officeDocument/2006/relationships';
  const content='application/vnd.openxmlformats-officedocument.spreadsheetml';
  const xml=value=>esc(String(value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,''));
  const relationships=items=>`<Relationships xmlns="${ns}/package/2006/relationships">${items.map(([id,type,target])=>`<Relationship Id="${id}" Type="${rel}/${type}" Target="${target}"/>`).join('')}</Relationships>`;
  zip.file('[Content_Types].xml',`<Types xmlns="${ns}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${content}.sheet.main+xml"/>${sheets.map((_,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="${content}.worksheet+xml"/>`).join('')}</Types>`);
  zip.file('_rels/.rels',relationships([['rId1','officeDocument','xl/workbook.xml']]));
  zip.file('xl/workbook.xml',`<workbook xmlns="${ns}/spreadsheetml/2006/main" xmlns:r="${rel}"><sheets>${sheets.map(([name],i)=>`<sheet name="${xml(name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')}</sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels',relationships(sheets.map((_,i)=>[`rId${i+1}`,'worksheet',`worksheets/sheet${i+1}.xml`])));
  sheets.forEach(([,rows],i)=>{
    const body=rows.map((row,j)=>`<row r="${j+1}">${row.map((cell,k)=>{
      if(cell==null)return '';
      const address=String.fromCharCode(65+k)+(j+1);
      return Number.isFinite(cell)?`<c r="${address}"><v>${cell}</v></c>`:`<c r="${address}" t="inlineStr"><is><t xml:space="preserve">${xml(cell)}</t></is></c>`;
    }).join('')}</row>`).join('');
    zip.file(`xl/worksheets/sheet${i+1}.xml`,`<worksheet xmlns="${ns}/spreadsheetml/2006/main"><cols><col min="1" max="14" width="22" customWidth="1"/></cols><sheetData>${body}</sheetData></worksheet>`);
  });
  return zip.generateAsync({type:'blob',compression:'DEFLATE',mimeType:content+'.sheet'});
}
const el=id=>document.getElementById(id);
const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const roles=[['Supervisor','supervisors'],['Tally Clerk','tally'],['Operator','operators']];
const columns=['EPF','Designation','Loading vehicles','Unloading vehicles','Loading day h','Loading OT h','Unloading day h','Unloading OT h','Total day h','Day cost (LKR)','Total OT h','OT cost (LKR)','Paid day h','Idle / unallocated h','Total cost (LKR)'];
const dayColumns=[4,6,8,9],otColumns=[5,7,10,11],moneyColumns=[9,11,14];
const fmt=value=>value==null?'—':new Intl.NumberFormat('en-LK',{maximumFractionDigits:2}).format(value);
function calculateReport(operations,records,paidHours,designation){
  const countsByDirection=[0,0];
  const staff=new Map();
  let missingCrew=0,missingTimes=0;
  for(const operation of operations){
    const split=splitWorkingMinutes(operation.start,operation.end);
    if(!split)missingTimes++;
    if(operation.crewPrivate)missingCrew++;
    const seen=new Set();
    let counted=false;
    for(const [role,field] of roles){
      if(operation.crewPrivate)break;
      for(const epf of (operation[field]??[]).map(payrollEpf)){
        if(!/^\d+$/.test(epf)||epf==='0'||seen.has(epf))continue;
        seen.add(epf);
        if(designation&&role!==designation)continue;
        counted=true;
        const person=records.get(epf);
        if(!staff.has(epf))staff.set(epf,{person,role,counts:[0,0],minutes:[0,0,0,0],missingTime:false});
        const item=staff.get(epf);
        const direction=operation.direction==='L'?0:1;
        item.counts[direction]++;
        if(split){
          item.minutes[direction*2]+=split.day;
          item.minutes[direction*2+1]+=split.ot;
        }else item.missingTime=true;
      }
    }
    if(counted&&split)countsByDirection[operation.direction==='L'?0:1]++;
  }
  const rows=[...staff].sort(([a],[b])=>a.localeCompare(b,undefined,{numeric:true})).map(([epf,item])=>{
    const {person,role,counts,minutes,missingTime}=item;
    const h=minutes.map(n=>n/60);
    const day=h[0]+h[2],ot=h[1]+h[3];
    const regular=regularPay(person), overtime=overtimeRate(person?.basic);
    const paid=person&&paidHours>0?paidHours:null;
    const dayCost=day===0&&!missingTime?0:paid&&regular!==null?day*regular/paid:null;
    const otCost=ot===0&&!missingTime?0:overtime!==null?ot*overtime:null;
    const cost=dayCost===null&&otCost===null?null:(dayCost??0)+(otCost??0);
    return {missingTime,values:[epf,designation||person?.designation||role,...counts,...h,day,dayCost,ot,otCost,paid,
      paid===null||missingTime?null:Math.max(0,paid-day),cost],incomplete:!person||missingTime||dayCost===null||otCost===null};
  });
  const totals=columns.map((_,index)=>{
    if(index===0)return 'Total';
    if(index===1)return rows.length+' employees';
    const values=rows.map(row=>row.values[index]).filter(Number.isFinite);
    return values.length?values.reduce((a,b)=>a+b,0):null;
  });
  const comparable=rows.filter(row=>row.values[12]>0&&!row.missingTime);
  const day=comparable.reduce((sum,row)=>sum+row.values[8],0);
  const paid=comparable.reduce((sum,row)=>sum+row.values[12],0);
  return {rows,totals,missingCrew,missingTimes,countsByDirection,utilisation:paid?100*day/paid:null};
}

let operations=[],reportVersion=0,currentReport=null;
async function rpc(name,params){
  const {data,error}=await payrollClient.rpc(name,params);
  if(error)throw error;
  return data;
}
function isAdmin(user){return user?.email?.trim().toLowerCase()===payrollAdminEmail;}
function populateJobs(){
  const jobs=[...new Set(operations.filter(row=>row.customer===el('customer').value).map(row=>String(row.job)))].sort();
  el('job').replaceChildren(new Option('All Jobs',''),...jobs.map(job=>new Option(job,job)));
}
function renderReport(result){
  const {rows,totals,missingCrew,missingTimes}=result;
  const cell=(value,index)=>`<td class="${dayColumns.includes(index)?'day':otColumns.includes(index)?'ot':''}">${typeof value==='string'?esc(value):value!=null&&moneyColumns.includes(index)?money(value):fmt(value)}</td>`;
  el('body').innerHTML=rows.map(row=>'<tr>'+row.values.map(cell).join('')+'</tr>').join('')||
    '<tr><td colspan="15">No employee assignments found for this selection.</td></tr>';
  el('foot').innerHTML='<tr>'+totals.map(cell).join('')+'</tr>';
  const ranked=rows.slice().sort((a,b)=>b.values[8]-a.values[8]).slice(0,10);
  const max=Math.max(1,...ranked.map(({values:r})=>r[8]+(r[13]??0)));
  el('chart').innerHTML=ranked.map(({values:r})=>{
    const description=`EPF ${r[0]} · Day ${fmt(r[8])} h · Idle / unallocated ${fmt(r[13])} h`;
    return `<div class="chart-row" title="${esc(description)}" aria-label="${esc(description)}"><b>EPF ${esc(r[0])}</b><div class="track"><i class="worked" style="width:${100*r[8]/max}%"></i><i class="idle" style="width:${100*(r[13]??0)/max}%"></i></div><small>${fmt(r[8])} / ${fmt(r[13])} h</small></div>`;
  }).join('');
  const partial=rows.filter(row=>row.incomplete).length;
  el('status').textContent=[partial?`${partial} employee row(s) have incomplete costing or hours.`:'',
    missingCrew?`${missingCrew} operation(s) have no accessible crew assignments.`:'',
    missingTimes?`${missingTimes} operation(s) have missing or invalid timestamps.`:''].filter(Boolean).join(' ');
  el('download').disabled=!rows.length;
}
const monthLabel=(month,style='long')=>new Intl.DateTimeFormat('en',{month:style,year:'numeric',timeZone:'UTC'}).format(new Date(month+'-01T00:00:00Z'));
const hours=value=>value==null?'—':fmt(value)+' h';
const percent=value=>value==null?'—':fmt(value)+'%';
const actual=result=>result?.totals[8]==null?null:result.totals[8]+result.totals[10];
const operationsCount=result=>result?.rows.length?result.countsByDirection[0]+result.countsByDirection[1]:null;
function tableMarkup(headers,rows){
  return '<thead><tr>'+headers.map(item=>'<th scope="col">'+esc(item)+'</th>').join('')+'</tr></thead><tbody>'+
    rows.map(row=>'<tr><th scope="row">'+esc(row[0])+'</th>'+row.slice(1).map(item=>'<td>'+esc(item)+'</td>').join('')+'</tr>').join('')+'</tbody>';
}
function renderOverview(history,result){
  const months=[...history.keys()], current=months.at(-1), previous=months.at(-2), prior=history.get(previous);
  document.querySelectorAll('[data-report-month]').forEach(node=>{node.textContent=monthLabel(current);node.dateTime=current;});
  const metrics=[
    ['Labour utilisation',result.utilisation,prior?.utilisation,percent,' pp'],
    ['Actual labour hours',actual(result),actual(prior),hours,' h'],
    ['Overtime hours',result.totals[10],prior?.totals[10],hours,' h'],
    ['Vehicle operations',operationsCount(result),operationsCount(prior),fmt,'']
  ];
  el('metrics').innerHTML=metrics.map(([name,now,before,format,unit])=>{
    const delta=now==null||before==null?null:now-before;
    const change=delta==null?'Previous month unavailable':(delta>0?'+':'')+fmt(delta)+unit+' vs '+monthLabel(previous,'short');
    return `<div>${esc(name)}<strong>${esc(format(now))}</strong><small>${esc(change)}</small></div>`;
  }).join('');
  el('comparison').innerHTML=tableMarkup(['Metric',monthLabel(previous,'short'),monthLabel(current,'short')],[
    ...metrics.map(([name,now,before,format])=>[name,format(before),format(now)]),
    ['Paid day hours',hours(prior?.totals[12]),hours(result.totals[12])],
    ['Known labour cost',prior?.totals[14]==null?'—':money(prior.totals[14]),result.totals[14]==null?'—':money(result.totals[14])]
  ]);
  const values=[...history.values()].map(item=>item?.utilisation??null);
  const ceiling=Math.max(100,Math.ceil(Math.max(...values.map(v=>v??0))/25)*25);
  const x=index=>52+index*92, y=value=>111-92*value/ceiling;
  if(values.some(value=>value!==null)){
    const ticks=[0,ceiling/4,ceiling/2,ceiling*3/4,ceiling];
    const grid=ticks.map(v=>`<path d="M43 ${y(v)}H525" stroke="#dbe6f1"/><text x="38" y="${y(v)+4}" text-anchor="end">${fmt(v)}%</text>`).join('');
    const dots=values.map((v,i)=>v===null?'':`<circle cx="${x(i)}" cy="${y(v)}" r="4" fill="#245eb2"><title>${monthLabel(months[i])} · ${percent(v)}</title></circle><text x="${x(i)}" y="${y(v)-8}" text-anchor="middle">${percent(v)}</text>`).join('');
    const segments=values.map((v,i)=>i>0&&v!==null&&values[i-1]!==null?`<path d="M${x(i-1)} ${y(values[i-1])}L${x(i)} ${y(v)}" stroke="#245eb2" stroke-width="2.5"/>`:'').join('');
    const labels=months.map((m,i)=>`<text x="${x(i)}" y="133" text-anchor="middle">${monthLabel(m,'short')}</text>`).join('');
    el('trend').innerHTML=`<svg class="plot" viewBox="0 0 540 140" role="img" aria-label="Six-month labour utilisation trend" fill="#435c75" font-size="11">${grid}${segments}${dots}${labels}</svg>`;
  }else el('trend').textContent='No months have comparable paid and recorded hours.';
  const activity=['Loading','Unloading'].map((label,i)=>({label,count:result.countsByDirection[i],day:result.totals[i*2+4],ot:result.totals[i*2+5]}));
  const max=Math.max(1,...activity.map(item=>item.day+item.ot));
  el('activity-hours').innerHTML=activity.map(({label,day,ot})=>`<div class="activity-row"><b>${label}</b><div class="track" title="Day ${hours(day)} · OT ${hours(ot)}"><i class="worked" style="width:${100*day/max}%"></i><i class="overtime" style="width:${100*ot/max}%"></i></div><strong>${day===null?'—':hours(day+ot)}</strong></div>`).join('');
  el('variance').innerHTML=activity.map(({label})=>`<div class="variance"><span>${label}</span><b>—</b></div>`).join('');
  el('activities').innerHTML=tableMarkup(['Activity','Operations','Standard h','Actual h','OT h','Efficiency'],[
    ...activity.map(({label,count,day,ot})=>[label,fmt(count),'—',day===null?'—':fmt(day+ot),fmt(ot),'—']),
    ['Total',fmt(operationsCount(result)),'—',fmt(actual(result)),fmt(result.totals[10]),'—']
  ]);
}
async function refreshReport(){
  const version=++reportVersion;
  currentReport=null;
  el('download').disabled=true;
  el('status').textContent='Loading report…';
  const month=el('month').value,customer=el('customer').value,job=el('job').value,role=el('role').value;
  el('report').classList.add('report-loading');
  try{
    if(!month||!customer)throw new Error('Select a month and customer.');
    const months=Array.from({length:6},(_,i)=>{
      const date=new Date(month+'-01T00:00:00Z');
      date.setUTCMonth(date.getUTCMonth()+i-5);
      return date.toISOString().slice(0,7);
    });
    const scoped=operations.filter(row=>row.customer===customer&&(!job||String(row.job)===job));
    const loadMonth=async period=>{
      const selected=scoped.filter(row=>row.start?.slice(0,7)===period);
      const [payroll,crew]=await Promise.all([
        selected.length?rpc('gtl_monthly_payroll',{payroll_month:period,epfs:[]}):null,
        selected.some(row=>row.crewPrivate)?rpc('gtl_private_movement_crews',{period}):[]
      ]);
      const byOperation=new Map((crew??[]).map(row=>[String(row.id),row]));
      const full=selected.map(row=>row.crewPrivate&&byOperation.has(String(row.id))
        ?{...row,...byOperation.get(String(row.id)),crewPrivate:false}:row);
      return calculateReport(full,new Map(payroll?.records??[]),Number(payroll?.hours),role);
    };
    const result=await loadMonth(month);
    if(version!==reportVersion)return;
    const history=new Map(months.map(period=>[period,period===month?result:null]));
    currentReport={month,customer,job,role,...result};
    renderReport(result);
    renderOverview(history,result);
    el('report').classList.remove('report-loading');
    const comparisons=await Promise.allSettled(months.slice(0,-1).map(loadMonth));
    if(version!==reportVersion)return;
    comparisons.forEach((entry,i)=>{if(entry.status==='fulfilled')history.set(months[i],entry.value);});
    renderOverview(history,result);
  }catch(error){
    if(version!==reportVersion)return;
    for(const id of ['metrics','chart','body','foot','trend','comparison','activity-hours','variance','activities'])el(id).replaceChildren();
    el('status').textContent=error.message;
  }finally{
    if(version===reportVersion)el('report').classList.remove('report-loading');
  }
}
async function openReport(){
  if(!payrollClient)throw new Error('Payroll service unavailable.');
  const {data,error}=await payrollClient.auth.getUser();
  if(error||!isAdmin(data?.user))throw new Error('Sign in with the payroll administrator account on the dashboard, then reopen this report.');
  const [response,live]=await Promise.all([fetch('./index.html',{cache:'no-cache'}),rpc('gtl_public_movement_operations')]);
  if(!response.ok)throw new Error('Could not load dashboard baseline operations.');
  const source=await response.text();
  const baseline=source.match(/const initialOperations = (\[[^\n]*\]);/);
  if(!baseline)throw new Error('Could not read dashboard baseline operations.');
  const key=row=>JSON.stringify([row.customer,String(row.job),String(row.reg)]);
  const all=new Map(JSON.parse(baseline[1]).map(row=>[key(row),row]));
  for(const row of live??[])all.set(key(row),row);
  operations=[...all.values()];
  el('customer').replaceChildren(...[...new Set(operations.map(row=>row.customer))].sort().map(name=>new Option(name,name)));
  populateJobs();
  el('report').hidden=false;
  await refreshReport();
}
el('head').innerHTML='<tr>'+columns.map(label=>`<th scope="col">${esc(label)}</th>`).join('')+'</tr>';
el('customer').addEventListener('change',()=>{populateJobs();void refreshReport();});
for(const id of ['month','job','role'])el(id).addEventListener('change',refreshReport);
el('download').addEventListener('click',async()=>{
  const snapshot=currentReport;
  if(!snapshot)return;
  el('download').disabled=true;
  try{
    const {data}=await payrollClient.auth.getUser();
    if(!isAdmin(data?.user))throw new Error('Payroll administrator sign-in required.');
    const sheet=[['Labour Productivity Report'],['Month',snapshot.month],['Customer',snapshot.customer],['Job',snapshot.job||'All Jobs'],['Designation',snapshot.role||'All designations'],[],columns,
      ...snapshot.rows.map(row=>row.values),snapshot.totals];
    const notes=[['Metric','Definition'],['Idle / unallocated','Monthly paid hours less recorded day hours, minimum zero. Filtered views omit hours outside the selection.'],
      ['Total cost','Sum of known day and overtime costs. Blank cells indicate unavailable rates or hours.'],
      ['Incomplete employee rows',snapshot.rows.filter(row=>row.incomplete).length],['Operations missing crew',snapshot.missingCrew],['Operations missing timestamps',snapshot.missingTimes]];
    const blob=await buildMonthlyExcel([['Labour Productivity',sheet],['Calculation Notes',notes]]);
    if(snapshot!==currentReport)return;
    const url=URL.createObjectURL(blob),link=document.createElement('a');
    link.href=url;link.download=`GTL-Labour-${snapshot.customer}-${snapshot.job||'All-Jobs'}-${snapshot.month}.xlsx`.replace(/[^a-z0-9_.-]/gi,'-');
    link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
  }catch(error){el('status').textContent=error.message;}
  finally{if(snapshot===currentReport)el('download').disabled=false;}
});
void openReport().catch(error=>{el('status').textContent=error.message;});
