'use strict';

(() => {
  const el = id => document.getElementById(id);
  const make = (tag, value) => Object.assign(document.createElement(tag), {textContent:value});
  const pageSize = 25;
  let operations = [];
  let page = 0;
  let reportMonth = '';
  let role = '';
  let loadVersion = 0;
  let pending = null;
  let filteredRows = [];
  let departmentSummary = [];
  const speech = window.speechSynthesis;
  let reportSpeech = null;
  let profile = null;
  let photoUrl = '';
  let efficiencyVersion = 0;
  const sriLankaTime = new Intl.DateTimeFormat('en-LK',{timeZone:'Asia/Colombo',dateStyle:'medium',timeStyle:'short'});
  const localMonths = new Map();
  let rates = new Map();
  const keys = row => JSON.stringify([row.agent,row.vehicleType,row.direction]);
  const hourText = new Intl.NumberFormat('en-LK',{minimumFractionDigits:1,maximumFractionDigits:2});
  const currency = new Intl.NumberFormat('en-LK',{style:'currency',currency:'LKR'});
  const elapsed = row => (Date.parse(row.end+'Z')-Date.parse(row.start+'Z'))/3600000;
  const duration = value => hourText.format(value)+' h';
  function averageVehicleTime(hours, operations) {
    const minutes = Math.round(hours*60/operations);
    return minutes<60 ? minutes+'m' : Math.floor(minutes/60)+'h'+(minutes%60?' '+minutes%60+'m':'');
  }

  // The workbook stores the customer name before its comma-separated address.
  const shortCustomer = value => String(value??'').split(',')[0].trim() || String(value??'').trim();
  const vehicleTypes = rows => {
    const counts = new Map();
    for (const row of rows) counts.set(row.vehicleType || 'Unclassified',(counts.get(row.vehicleType || 'Unclassified')??0)+1);
    return [...counts].sort(([a],[b])=>a.localeCompare(b)).map(([type,count])=>labourVehicleLabel(type)+' '+count).join(' · ') || '—';
  };
  function refreshCustomers() {
    const account = el('account').value;
    const select = el('customerFilter');
    const customers = account ? [...new Set(operations.filter(row=>row.account===account).map(row=>row.customer).filter(Boolean))] : [];
    customers.sort((a,b)=>shortCustomer(a).localeCompare(shortCustomer(b))||a.localeCompare(b));
    const labels = new Map();
    for (const customer of customers) {
      const name = shortCustomer(customer);
      labels.set(name,(labels.get(name)??0)+1);
    }
    select.replaceChildren(new Option(account?'All customers':'Select a department',''),...customers.map(customer=>{
      const name = shortCustomer(customer);
      const option = new Option(labels.get(name)>1?customer:name,customer);
      option.title = customer;
      return option;
    }));
    select.value = '';
    select.disabled = !customers.length;
  }

  function updateDepartmentSummary(rows, count, time) {
    const account = el('account').value;
    const customer = el('customerFilter').value;
    const subject = customer ? shortCustomer(customer)+' in '+account : account;
    el('departmentSummary').hidden = !account;
    if (!account) return;

    const vehicles = n => n.toLocaleString('en-LK')+(n===1?' vehicle operation':' vehicle operations');
    const hourPhrase = n => hourText.format(n)+(n===1?' hour':' hours');
    const month = new Intl.DateTimeFormat('en-LK',{month:'long',year:'numeric',timeZone:'UTC'})
      .format(new Date(reportMonth+'-01T00:00:00Z'));
    const total = time.loading+time.unloading;
    const overview = rows.length
      ? 'In '+month+', '+subject+' recorded '+vehicles(rows.length)+' across '+hourPhrase(total)+' of combined loading and unloading time for the current filters.'
      : 'No vehicle operations matched the current filters for '+subject+' in '+month+'.';
    departmentSummary = [overview];
    if (rows.length) {
      departmentSummary.push(
        'Loading accounted for '+vehicles(count.loading)+' and '+hourPhrase(time.loading)+'.',
        'Unloading accounted for '+vehicles(count.unloading)+' and '+hourPhrase(time.unloading)+'.'
      );
      if (total>0 && time.loading!==time.unloading) {
        const higher = time.loading>time.unloading?'Loading':'Unloading';
        const share = Math.round(Math.max(time.loading,time.unloading)/total*100);
        departmentSummary.push(higher+' took the larger share of recorded operation time, at '+share+' percent.');
      }
    }
    el('departmentBrief').textContent = overview;
    el('departmentReportScope').textContent = [account,month,customer?shortCustomer(customer):'All customers'].join(' · ');
    el('departmentNarrative').replaceChildren(...departmentSummary.map(sentence=>make('p',sentence)));
  }

  function totals(rows) {
    const count = {loading:0,unloading:0};
    const time = {loading:0,unloading:0};
    let cost = 0;
    let missing = 0;
    for (const row of rows) {
      const rowHours = elapsed(row);
      count[row.direction]++;
      time[row.direction] += rowHours;
      if (row.agent) {
        const rate = rates.get(keys(row));
        if (rate === undefined) missing++;
        else cost += Math.round(rate*100);
      }

    }
    updateDepartmentSummary(rows,count,time);
    const metrics = [
      ['Loading vehicles',count.loading.toLocaleString('en-LK'),'Total loading time · '+duration(time.loading)],
      ['Unloading vehicles',count.unloading.toLocaleString('en-LK'),'Total unloading time · '+duration(time.unloading)],
      ['Manpower cost',currency.format(cost/100),missing ? missing+' operations missing rates' : 'Rates matched']
    ];
    el('metrics').replaceChildren(...metrics.map(([label,value,note]) => {
      const item = make('article',label);
      item.className = 'metric';
      item.append(make('strong',value));
      if (note) item.append(make('span',note));
      return item;
    }));
    const byDirection = {loading:new Map(),unloading:new Map()};
    for (const row of rows) {
      const types = byDirection[row.direction];
      const type = row.vehicleType || 'Unclassified';
      if (!types.has(type)) types.set(type,{count:0,time:0});
      const group = types.get(type);
      group.count++;
      group.time += elapsed(row);
    }
    const scale = Math.max(1/60,...Object.values(byDirection).flatMap(groups=>Array.from(groups.values(),group=>group.time/group.count)));
    const categories = [['LRY','#317aa6'],['20GP','#208879'],['40HC','#7861a9'],['INT','#9b7145'],['Unclassified','#5d7594']];

    for (const direction of ['loading','unloading']) {
      const vehicles = count[direction];
      const average = vehicles ? averageVehicleTime(time[direction],vehicles) : '—';
      el(direction+'Summary').replaceChildren(
        make('strong',vehicles.toLocaleString('en-LK')+(vehicles===1?' vehicle':' vehicles')),
        make('span','Avg '+average),
        make('span','Total time '+duration(time[direction]))
      );
      const types = byDirection[direction];
      const chart = categories.filter(([type])=>types.has(type)).map(([type,color])=>[type,types.get(type),color]);
      el(direction+'Chart').replaceChildren(...(chart.length ? chart.map(([type,group,color]) => {
        const item = make('div','');item.className='direction-chart-row';
        const track = make('div','');track.className='hour-track';
        const fill = make('span','');fill.className='hour-fill';fill.setAttribute('aria-hidden','true');
        fill.style.setProperty('--share',group.time/group.count/scale);
        fill.style.setProperty('--vehicle-color',color);
        const meter = make('div','');meter.className='hour-track-meter';meter.append(fill);
        const averageLabel = make('strong','');
        averageLabel.className = 'direction-average-time';
        averageLabel.append(make('span','AVG'),make('span',averageVehicleTime(group.time,group.count)));
        track.append(meter,averageLabel);
        const label = make('span',labourVehicleLabel(type));
        const countBadge = make('span',group.count.toLocaleString('en-LK'));
        countBadge.className = 'direction-vehicle-count';
        countBadge.setAttribute('aria-label',group.count+' vehicles');
        item.append(label,countBadge,track);
        return item;
      }) : [make('p','No operations for these filters.')]));


    }
  }

  function renderCrewActivity(rows) {
    const selectedRole = el('crewActivityRole').value;
    const roles = [['supervisors','Supervisor'],['clerks','Tally Clerk'],['operators','Operator']];
    const result = [];
    for (const [field,role] of roles) {
      if (selectedRole && selectedRole!==field) continue;
      const crew = new Map();
      for (const row of rows) {
        const ids = new Set(row[field].map(epf=>String(epf).trim().replace(/^0+(?=\d)/,'')));
        for (const epf of ids) {
          if (!/^[1-9]\d*$/.test(epf)) continue;
          if (!crew.has(epf)) crew.set(epf,{loading:[],unloading:[]});
          crew.get(epf)[row.direction].push(row);
        }
      }
      for (const [epf,visits] of [...crew].sort(([a],[b])=>a.localeCompare(b,undefined,{numeric:true}))) {
        const tr = document.createElement('tr');
        tr.append(...[epf,role,duration(visits.loading.reduce((sum,row)=>sum+elapsed(row),0)),
          duration(visits.unloading.reduce((sum,row)=>sum+elapsed(row),0)),
          visits.loading.length+' · '+vehicleTypes(visits.loading),
          visits.unloading.length+' · '+vehicleTypes(visits.unloading)].map(value=>make('td',value)));
        result.push(tr);
      }
    }
    if (!result.length) {
      const row = document.createElement('tr');
      const cell = make('td','No crew activity for these filters.');
      cell.colSpan = 6;
      row.append(cell);
      result.push(row);
    }
    el('crewActivityRows').replaceChildren(...result);
  }

  const showOperation = row => {
    el('operationTitle').textContent = 'Tally # ' + row.tally;
    const details = [
      ['Customer',row.customer], ['Department',row.account], ['Reference',row.reference],
      ['Operation',row.direction], ['Start · Sri Lanka',row.start.replace('T',' ')],
      ['Finish · Sri Lanka',row.end.replace('T',' ')], ['Vehicle type',labourVehicleLabel(row.vehicleType)],
      ['Vehicle',row.vehicle], ['Container',row.container], ['Agency',row.agent],
      ['Supervisor EPF',row.supervisors.join(', ')], ['Tally Clerk EPF',row.clerks.join(', ')],
      ['Operator EPF',row.operators.join(', ')], ['GTL heads',row.heads], ['Recorded man-hours',row.manHours], ['Shift',row.shift]
    ];
    el('detail').replaceChildren(...details.flatMap(([label,value]) => [make('dt',label),make('dd',value || '—')]));
    el('operation').showModal();
  };

  function render() {
    const query = el('query').value.trim().toLowerCase();
    const account = el('account').value;
    const customer = el('customerFilter').value;
    const direction = el('direction').value;
    const source = el('source').value;
    const matches = operations.filter(row => (!account || row.account === account) &&
      (!customer || row.customer === customer) &&
      (!direction || row.direction === direction) &&
      (!source || Boolean(row.agent) === (source === 'agency')) &&
      (!query || [row.tally,row.customer,row.account,row.reference,row.container,row.vehicle,row.agent,
        ...row.operators,...row.clerks,...row.supervisors].some(value => value.toLowerCase().includes(query))));
    filteredRows = matches;
    totals(matches);
    renderCrewActivity(matches);
    const first = page * pageSize;
    const visible = matches.slice(first,first + pageSize).map(row => {
      const tr = document.createElement('tr');
      const cell = document.createElement('td');
      const action = make('button',row.tally);
      action.type = 'button';
      action.addEventListener('click',() => showOperation(row));
      cell.append(action);
      const customer = make('td',shortCustomer(row.customer) || '—');
      customer.title = row.customer || '';
      tr.append(cell,make('td',row.account),customer,...[row.direction,labourVehicleLabel(row.vehicleType),row.agent,row.start.replace('T',' ')].map(value=>make('td',value || '—')));
      return tr;
    });
    el('rows').replaceChildren(...visible);
    el('matchCount').textContent = matches.length ? (first + 1) + '–' + (first + visible.length) + ' of ' + matches.length + ' operations' : 'No matching operations.';
    el('previous').disabled = page === 0;
    el('next').disabled = first + visible.length >= matches.length;
  }

  function refreshRateFields() {
    const agent = el('rateAgent').value;
    const previousType = el('rateVehicle').value;
    const types = [...new Set(operations.filter(row=>row.agent===agent).map(row=>row.vehicleType).filter(Boolean))].sort();
    el('rateVehicle').replaceChildren(...types.map(type=>new Option(labourVehicleLabel(type),type)));
    if (types.includes(previousType)) el('rateVehicle').value = previousType;
    const rate = rates.get(keys({agent,vehicleType:el('rateVehicle').value,direction:el('rateDirection').value}));
    el('rateAmount').value = rate ?? '';
  }

  function showMonth(month, rows, nextRates) {
    reportMonth = month;
    rates = nextRates;
    operations = rows.map(row=>({...row,vehicleType:labourVehicleCategory(row.vehicleType)}))
      .sort((a,b)=>b.start.localeCompare(a.start));
    page = 0;
    el('query').value = '';
    for (const id of ['direction','source']) el(id).value = '';
    el('account').replaceChildren(new Option('All departments',''),
      ...[...new Set(operations.map(row=>row.account))].sort().map(account=>new Option(account)));
    refreshCustomers();
    const agents = [...new Set(operations.map(row=>row.agent).filter(Boolean))].sort();
    el('rateAgent').replaceChildren(...agents.map(agent=>new Option(agent)));
    el('ratePanel').hidden = !agents.length;
    el('rateStatus').textContent = role==='payroll_admin'?'':'Shared rates are editable by payroll administrators.';
    for (const field of el('rateForm').elements) field.disabled = role!=='payroll_admin';
    refreshRateFields();
    for (const id of ['reportFilters','metrics','register','workload','crewActivity']) el(id).hidden = false;
    el('openEfficiency').disabled = !operations.length;
    render();
  }

  async function openMonth(useLatest = false) {
    const month = el('month').value;
    if (!month) return;
    const version = ++loadVersion;
    const local = localMonths.get(month);
    el('lastUpload').textContent = 'No shared upload loaded for '+month+'.';
    el('sharedStatus').textContent = 'Loading '+month+'…';
    showMonth(month,local?.operations??[],local?.rates??new Map());
    try {
      const activeRole = await labourRole();
      if (version!==loadVersion) return;
      role = activeRole;
      el('saveMonth').hidden = !pending || role!=='payroll_admin';
      if (!role) {
        el('sharedStatus').textContent = local?'Local import preview. Sign in on the dashboard to access shared records.':'Sign in on the dashboard to access shared records, or preview a workbook below.';
        return;
      }
      const shared = await loadLabourMonth(month);
      if (version!==loadVersion) return;
      if (useLatest && !local && !shared.upload) {
        const latest = await labourClient.from('gtl_labour_months').select('month').order('month',{ascending:false}).limit(1).maybeSingle();
        if (latest.error) throw latest.error;
        if (version!==loadVersion) return;
        if (latest.data?.month && latest.data.month!==month) {
          el('month').value = latest.data.month;
          await openMonth();
          return;
        }
      }
      const monthlyRates = new Map(shared.rates.map(row=>[keys({agent:row.agent,vehicleType:row.vehicle_type,direction:row.direction}),Number(row.amount)]));
      if (local) local.rates = monthlyRates;
      showMonth(month,local?.operations??shared.upload?.operations??[],monthlyRates);
      if (shared.upload) {
        const stamp = shared.upload.updated_at ? sriLankaTime.format(new Date(shared.upload.updated_at))+' (Sri Lanka)' : 'Time unavailable';
        el('lastUpload').textContent = 'Saved upload · '+month+' · '+(shared.upload.source_name||'Workbook')+' · '+shared.upload.operations.length+' operations · '+stamp;
      }
      el('sharedStatus').textContent = local?'Local import preview for '+month+'.':shared.upload?'Shared data · '+month:'No shared upload for '+month+'.';
    } catch (error) {
      if (version===loadVersion) el('sharedStatus').textContent = 'Shared data unavailable: '+error.message;
    }
  }

  el('importForm').addEventListener('submit',async event => {
    event.preventDefault();
    const file = el('workbook').files[0];
    const month = el('uploadMonth').value;
    if (!file || !month) return;
    el('importButton').disabled = true;
    el('importStatus').textContent = 'Reading Sheet1…';
    try {
      const [sheet] = await readPayrollWorkbook(file,'Sheet1');
      const result = parseLabourSheet(sheet.rows);
      const rows = result.operations.filter(row=>row.start.slice(0,7)===month);
      pending = rows.length?{month,operations:rows,source_name:file.name}:null;
      el('saveMonth').hidden = !pending || role!=='payroll_admin';
      el('issueList').replaceChildren(...result.issues.map(issue =>
        make('li','Row '+issue.line+(issue.tally?' · Tally '+issue.tally:'')+' · '+issue.reason)));
      el('issues').hidden = !result.issues.length;
      el('issues').open = false;
      el('importStatus').textContent = month+' · '+rows.length+' accepted · '+(result.operations.length-rows.length)+' from other months · '+result.duplicates+' duplicates skipped · '+result.issues.length+' workbook rows need review';
      localMonths.set(month,{operations:rows,rates:new Map()});
      el('month').value = month;
      await openMonth();
      if (pending?.month===month) {
        if (role==='payroll_admin') await savePendingMonth();
        else el('importStatus').textContent += ' · Preview only. Sign in as payroll admin to save.';
      }
    } catch (error) {
      el('importStatus').textContent = 'Import failed: '+error.message;
    } finally {
      el('importButton').disabled = false;
    }
  });

  async function savePendingMonth() {
    if (role!=='payroll_admin' || !pending || el('saveMonth').disabled) return;
    const snapshot = pending;
    el('saveMonth').disabled = true;
    try {
      const table = labourClient.from('gtl_labour_months');
      const existing = await table.select('updated_at').eq('month',snapshot.month).maybeSingle();
      if (existing.error) throw existing.error;
      if (existing.data && !confirm('Replace all shared operations for '+snapshot.month+' with this import?')) {
        el('importStatus').textContent += ' · Preview only. The previous shared upload is still saved.';
        return;
      }
      const values = {...snapshot,updated_at:new Date().toISOString()};
      const query = existing.data
        ? table.update(values).eq('month',snapshot.month).eq('updated_at',existing.data.updated_at)
        : table.insert(values);
      const saved = await query.select('month').maybeSingle();
      if (saved.error) throw saved.error;
      if (!saved.data) throw new Error('The shared month changed. Review it and try again.');
      if (pending===snapshot) pending = null;
      localMonths.delete(snapshot.month);
      el('saveMonth').hidden = !pending;
      el('importStatus').textContent = 'Shared month saved · '+snapshot.month+' · '+sriLankaTime.format(new Date(values.updated_at))+' (Sri Lanka)';
      if (el('month').value===snapshot.month) await openMonth();
    } catch (error) {
      el('importStatus').textContent = 'Could not save: '+error.message;
    } finally {
      el('saveMonth').disabled = false;
    }
  }
  el('saveMonth').addEventListener('click',savePendingMonth);

  el('rateForm').addEventListener('submit',async event => {
    event.preventDefault();
    if (role!=='payroll_admin' || !reportMonth) return;
    const month = reportMonth;
    const amount = el('rateAmount').valueAsNumber;
    const agent = el('rateAgent').value;
    const vehicleType = el('rateVehicle').value;
    const direction = el('rateDirection').value;
    if (!agent || !vehicleType || !Number.isFinite(amount) || amount<0) return;
    const submit = event.submitter;
    if (submit) submit.disabled = true;
    try {
      const {error} = await labourClient.from('gtl_labour_agency_rates').upsert({month,agent,vehicle_type:vehicleType,direction,amount});
      if (error) throw error;
      if (reportMonth===month) {
        rates.set(keys({agent,vehicleType,direction}),amount);
        render();
        el('rateStatus').textContent = 'Shared rate saved for '+month+'.';
      }
    } catch (error) {
      el('rateStatus').textContent = 'Could not save rate: '+error.message;
    } finally {
      if (submit) submit.disabled = role!=='payroll_admin';
    }
  });
  const costText = value => value===null?'—':currency.format(value);
  function paintPhoto(blob) {
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    photoUrl = blob ? URL.createObjectURL(blob) : '';
    const image = el('employeePhoto');
    image.hidden = !photoUrl;
    if (photoUrl) image.src = photoUrl;
    else image.removeAttribute('src');
    el('employeeInitials').hidden = Boolean(photoUrl);
  }

  async function openProfile(employee) {
    const current = {employee};
    profile = current;
    el('employeeName').textContent = employee.name || 'Employee';
    el('employeeEpf').textContent = 'EPF '+employee.epf+' · '+[...employee.roles].join(' / ');
    el('employeeInitials').textContent = employee.name ? employee.name.trim().split(/\s+/).slice(0,2).map(part=>part[0]).join('').toUpperCase() : employee.epf.slice(-2);
    paintPhoto(null);
    el('employeeNumbers').replaceChildren(...[
      ['Day hours',duration(employee.day)],['OT hours',duration(employee.ot)],
      ['Idle / unallocated',employee.idle===null?'—':duration(employee.idle)],
      ['Loading vehicles',employee.loading],['Unloading vehicles',employee.unloading],
      ['Total vehicles',employee.vehicles],['Labour cost',costText(employee.cost)]
    ].flatMap(([label,value])=>[make('dt',label),make('dd',value)]));
    el('photoForm').hidden = role!=='payroll_admin';
    el('photoFile').value = '';
    el('photoStatus').textContent = '';
    el('employee').showModal();
    if (!role || !labourClient) return;
    try {
      const {data,error} = await labourClient.storage.from('gtl-labour-photos').download(employee.epf);
      if (!error && profile===current) paintPhoto(data);
    } catch {
      // The profile remains usable with initials if the photo service cannot be reached.
    }
  }

  function paintEfficiency(people) {
    el('efficiencyRows').replaceChildren(...people.map((employee,index) => {
      const tr = document.createElement('tr');
      const epf = document.createElement('td');
      const action = make('button',employee.epf);
      action.type = 'button';
      action.addEventListener('click',()=>void openProfile(employee));
      epf.append(action);
      tr.append(make('td',index+1),epf,...[
        [...employee.roles].join(' / '),duration(employee.worked),duration(employee.day),duration(employee.ot),
        employee.idle===null?'—':duration(employee.idle),employee.loading,employee.unloading,employee.vehicles,costText(employee.cost)
      ].map(value=>make('td',value)));
      return tr;
    }));
  }

  el('openEfficiency').addEventListener('click',async () => {
    const version = ++efficiencyVersion;
    const month = reportMonth;
    const selected = filteredRows;
    const full = operations;
    el('efficiencyScope').textContent = [month,el('account').value||'All departments',shortCustomer(el('customerFilter').value)||'All customers',selected.length+' vehicle operations'].join(' · ');
    paintEfficiency(rankLabourEmployees(selected,full,null));
    el('efficiencyStatus').textContent = role?'Loading monthly payroll…':'Monthly payroll required for idle hours and labour cost.';
    el('efficiency').showModal();
    if (!role || !labourClient) return;
    try {
      const {data,error} = await labourClient.rpc('gtl_monthly_payroll',{payroll_month:month,epfs:[]});
      if (error) throw error;
      if (version!==efficiencyVersion) return;
      paintEfficiency(rankLabourEmployees(selected,full,data));
      el('efficiencyStatus').textContent = data?.records?.length?'':'No payroll records for this month. Idle hours and cost are unavailable.';
    } catch {
      if (version===efficiencyVersion) el('efficiencyStatus').textContent = 'Payroll figures are unavailable for this account or month.';
    }
  });
  el('efficiency').addEventListener('close',()=>{efficiencyVersion++;});
  el('employee').addEventListener('close',()=>{profile=null;paintPhoto(null);});
  el('employeePhoto').addEventListener('error',()=>paintPhoto(null));
  el('photoForm').addEventListener('submit',async event => {
    event.preventDefault();
    const current = profile;
    const file = el('photoFile').files[0];
    if (!current || role!=='payroll_admin' || !file) return;
    if (!['image/jpeg','image/png','image/webp'].includes(file.type) || file.size>5242880) {
      el('photoStatus').textContent = 'Choose a JPEG, PNG or WebP image up to 5 MB.';
      return;
    }
    const submit=event.submitter;
    if (submit) submit.disabled=true;
    try {
      const {error} = await labourClient.storage.from('gtl-labour-photos').upload(current.employee.epf,file,{upsert:true,contentType:file.type});
      if (error) throw error;
      if (profile===current) {
        paintPhoto(file);
        el('photoStatus').textContent = 'Photo saved.';
      }
    } catch (error) {
      if (profile===current) el('photoStatus').textContent = 'Could not save photo: '+error.message;
    } finally {
      if (submit) submit.disabled=false;
    }
  });
  const localEnglishVoice = () => speech?.getVoices().find(voice=>voice.localService && /^en(?:-|$)/i.test(voice.lang));
  function refreshSpeechControl() {
    const voice = localEnglishVoice();
    el('readDepartmentReport').disabled = !voice;
    el('departmentVoiceStatus').textContent = voice ? '' : 'An on-device English voice is unavailable in this browser.';
  }
  function stopReportSpeech() {
    if (!reportSpeech) return;
    reportSpeech = null;
    speech.cancel();
    el('readDepartmentReport').textContent = 'Listen to summary';
  }
  el('openDepartmentReport').addEventListener('click',() => {
    refreshSpeechControl();
    el('departmentReport').showModal();
  });
  el('readDepartmentReport').addEventListener('click',() => {
    if (reportSpeech) { stopReportSpeech(); return; }
    const voice = localEnglishVoice();
    if (!voice) return;
    const current = new SpeechSynthesisUtterance(departmentSummary.join(' '));
    current.voice = voice;
    current.lang = voice.lang;
    current.rate = .94;
    const finish = () => {
      if (reportSpeech!==current) return;
      reportSpeech = null;
      el('readDepartmentReport').textContent = 'Listen to summary';
    };
    current.onend = finish;
    current.onerror = () => {
      if (reportSpeech!==current) return;
      finish();
      el('departmentVoiceStatus').textContent = 'This browser could not play the summary.';
    };
    reportSpeech = current;
    el('readDepartmentReport').textContent = 'Stop reading';
    speech.speak(current);
  });
  el('departmentReport').addEventListener('close',stopReportSpeech);
  speech?.addEventListener('voiceschanged',refreshSpeechControl);

  for (const id of ['rateAgent','rateVehicle','rateDirection']) el(id).addEventListener('change',refreshRateFields);
  el('month').addEventListener('change',()=>void openMonth());
  el('loadMonth').addEventListener('click',()=>void openMonth());
  const date = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Colombo',year:'numeric',month:'2-digit'}).formatToParts();
  el('month').value = el('uploadMonth').value = ['year','month'].map(type=>date.find(part=>part.type===type).value).join('-');
  void openMonth(true);
  for (const id of ['query','account','customerFilter','direction','source']) {
    el(id).addEventListener(id === 'query' ? 'input' : 'change',() => {
      if (id==='account') refreshCustomers();
      page = 0;
      render();
    });
  }
  el('crewActivityRole').addEventListener('change',()=>renderCrewActivity(filteredRows));
  el('previous').addEventListener('click',() => {page--; render();});
  el('next').addEventListener('click',() => {page++; render();});
})();
