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
function calculateReport(operations,records,paidHours){
  const staff=new Map();
  let missingCrew=0,missingTimes=0;
  for(const operation of operations){
    const split=splitWorkingMinutes(operation.start,operation.end);
    if(!split)missingTimes++;
    if(operation.crewPrivate)missingCrew++;
    const seen=new Set();
    for(const [role,field] of roles){
      if(operation.crewPrivate)break;
      for(const epf of (operation[field]??[]).map(payrollEpf)){
        if(!/^\d+$/.test(epf)||epf==='0'||seen.has(epf))continue;
        seen.add(epf);
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
    return {values:[epf,person?.designation||role,...counts,...h,day,dayCost,ot,otCost,paid,
      paid===null||missingTime?null:Math.max(0,paid-day),cost],incomplete:!person||missingTime||dayCost===null||otCost===null};
  });
  const totals=columns.map((_,index)=>{
    if(index===0)return 'Total';
    if(index===1)return rows.length+' employees';
    const values=rows.map(row=>row.values[index]).filter(Number.isFinite);
    return values.length?values.reduce((a,b)=>a+b,0):null;
  });
  return {rows,totals,missingCrew,missingTimes};
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
  el('metrics').innerHTML=[['Day hours',fmt(totals[8])],['OT hours',fmt(totals[10])],['Idle / unallocated hours',fmt(totals[13])],['Total labour cost',totals[14]===null?'—':money(totals[14])]]
    .map(([label,value])=>`<div>${label}<strong>${value}</strong></div>`).join('');
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
async function refreshReport(){
  const version=++reportVersion;
  currentReport=null;
  el('download').disabled=true;
  el('status').textContent='Loading report…';
  const month=el('month').value,customer=el('customer').value,job=el('job').value;
  el('report').classList.add('report-loading');
  try{
    if(!month||!customer)throw new Error('Select a month and customer.');
    const selected=operations.filter(row=>row.customer===customer&&(!job||String(row.job)===job)&&row.start?.slice(0,7)===month);
    const [payroll,crew]=await Promise.all([
      rpc('gtl_monthly_payroll',{payroll_month:month,epfs:[]}),
      selected.some(row=>row.crewPrivate)?rpc('gtl_private_movement_crews',{period:month}):[]
    ]);
    if(version!==reportVersion)return;
    const byOperation=new Map((crew??[]).map(row=>[String(row.id),row]));
    const full=selected.map(row=>row.crewPrivate&&byOperation.has(String(row.id))
      ?{...row,...byOperation.get(String(row.id)),crewPrivate:false}:row);
    const result=calculateReport(full,new Map(payroll?.records??[]),Number(payroll?.hours));
    currentReport={month,customer,job,...result};
    renderReport(result);
    if(!payroll?.hours)el('status').textContent='Monthly payroll or paid hours are unavailable. '+el('status').textContent;
  }catch(error){
    if(version!==reportVersion)return;
    for(const id of ['metrics','chart','body','foot'])el(id).replaceChildren();
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
for(const id of ['month','job'])el(id).addEventListener('change',refreshReport);
el('download').addEventListener('click',async()=>{
  const snapshot=currentReport;
  if(!snapshot)return;
  el('download').disabled=true;
  try{
    const {data}=await payrollClient.auth.getUser();
    if(!isAdmin(data?.user))throw new Error('Payroll administrator sign-in required.');
    const sheet=[['Labour Productivity Report'],['Month',snapshot.month],['Customer',snapshot.customer],['Job',snapshot.job||'All Jobs'],[],columns,
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
