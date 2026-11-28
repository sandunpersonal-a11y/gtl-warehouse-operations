'use strict';

function summariseLabourEmployees(operations) {
  const employees = new Map();
  for (const row of operations) {
    const people = new Map();
    for (const [role, ids] of [['Supervisor',row.supervisors],['Tally Clerk',row.clerks],['Operator',row.operators]]) {
      for (const id of ids) {
        const epf = id.replace(/^0+(?=\d)/,'');
        if (/^[1-9]\d*$/.test(epf) && !people.has(epf)) people.set(epf,role);
      }
    }
    for (const [epf, role] of people) {
      if (!employees.has(epf)) employees.set(epf,{epf,roles:new Set(),loading:0,unloading:0,intervals:[]});
      const employee = employees.get(epf);
      employee.roles.add(role);
      employee[row.direction]++;
      employee.intervals.push([Date.parse(row.start+'Z'),Date.parse(row.end+'Z')]);
    }
  }
  const day = 86400000;
  const hour = 3600000;
  for (const employee of employees.values()) {
    const merged = [];
    for (const [start,end] of employee.intervals.sort(([a],[b])=>a-b)) {
      const last = merged.at(-1);
      if (last && start<=last[1]) last[1] = Math.max(last[1],end);
      else merged.push([start,end]);
    }
    let work = 0;
    let regular = 0;
    for (const [start,end] of merged) {
      work += end-start;
      for (let date=Math.floor(start/day)*day;date<end;date+=day) {
        regular += Math.max(0,Math.min(end,date+17*hour)-Math.max(start,date+8*hour));
      }
    }
    employee.day = regular/hour;
    employee.ot = (work-regular)/hour;
  }
  return employees;
}

function rankLabourEmployees(filtered, monthRows, payroll) {
  const people = summariseLabourEmployees(filtered);
  const full = filtered === monthRows ? people : summariseLabourEmployees(monthRows);
  const records = new Map((payroll?.records ?? []).map(([epf,person])=>[String(epf).replace(/^0+(?=\d)/,''),person]));
  const paid = Number(payroll?.hours);
  const valid = value => Number.isFinite(value) && value>=0;
  return [...people.values()].map(employee => {
    const person = records.get(employee.epf);
    const basic = person?.basic;
    const regular = valid(person?.regularPay)?person.regularPay:valid(basic)&&valid(person?.allowance)?basic+person.allowance:null;
    const dayCost = employee.day===0?0:regular!==null&&paid>0?employee.day*regular/paid:null;
    const otCost = employee.ot===0?0:valid(basic)?employee.ot*basic/200*1.5:null;
    return {...employee,name:person?.name??'',worked:employee.day+employee.ot,
      idle:person&&paid>0?Math.max(0,paid-(full.get(employee.epf)?.day??0)):null,
      vehicles:employee.loading+employee.unloading,cost:dayCost===null||otCost===null?null:dayCost+otCost};
  }).sort((a,b)=>b.worked-a.worked||b.vehicles-a.vehicles||a.epf.localeCompare(b.epf,undefined,{numeric:true}));
}
