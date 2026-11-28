'use strict';

const cleanLabourValue = value => String(value ?? '').replace(/\s+/g, ' ').trim();

function labourVehicleCategory(value) {
  const type = cleanLabourValue(value).toUpperCase();
  if (type==='INT' || type==='INTERNAL TRANSFER') return 'INT';
  if (['40HC','40GP','4GB'].includes(type)) return '40HC';
  if (type==='20GP' || !type) return type;
  return 'LRY';
}

function labourVehicleLabel(type) {
  return type==='INT'?'Internal Transfer':type==='40HC'?'40HC / 40GP':type;
}

function parseLabourSheet(rows) {
  const headerIndex = rows.findIndex(row => cleanLabourValue(row[0]).toLowerCase() === 'tally #');
  const columns = ['Tally #','Customer','Department','Ref No','Type','Start','End','Operaters','Tally Cleak','Supervisor','GTL Heads Qty','Contract','Man Power Agent','Total Man Hrs','Container Number','Lorry Number','Shift','Type','Qty','Qty'];
  if (headerIndex < 0 || columns.some((name, index) => cleanLabourValue(rows[headerIndex][index]).toLowerCase() !== name.toLowerCase())) {
    throw new Error('Sheet1 does not match the Labour Working Summary layout.');
  }

  function timestamp(value) {
    const numeric = /^\d{5}(?:\.\d+)?$/.test(value);
    if (numeric) return new Date(Date.UTC(1899, 11, 30) + Math.round(Number(value) * 86400) * 1000).toISOString().slice(0, 19);
    const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i.exec(value);
    if (!match) return null;
    const [, day, month, year, hours, minutes, seconds = '0', meridiem] = match;
    const monthIndex = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(month.toLowerCase());
    const pm = meridiem.toUpperCase() === 'PM';
    if (monthIndex < 0 || +hours > 12 || (+hours === 0 && pm) || +minutes > 59 || +seconds > 59) return null;
    const date = new Date(Date.UTC(+year, monthIndex, +day, +hours % 12 + (pm ? 12 : 0), +minutes, +seconds));
    return date.getUTCDate() === +day ? date.toISOString().slice(0, 19) : null;
  }

  const operations = new Map();
  const issues = [];
  const conflicts = new Set();
  let duplicates = 0;
  rows.slice(headerIndex + 1).forEach((row, index) => {
    const line = headerIndex + index + 2;
    if (!row.some(cleanLabourValue)) return;
    const [tally, customer, account, reference, direction, rawStart, rawEnd, operators, clerks, supervisors,
      heads, contract, agentValue, manHours, container, vehicle, shift, vehicleType] = columns.map((_, i) => cleanLabourValue(row[i]));
    const start = timestamp(rawStart);
    const end = timestamp(rawEnd);
    if (!/^\d+$/.test(tally) || !customer || !account || !/^(loading|unloading)$/i.test(direction) || !start || !end || end < start) {
      const reason = !start ? 'Start time is missing or invalid'
        : !end ? 'Finish time is missing or invalid'
        : end < start ? 'Finish time is before start time'
        : 'Missing or invalid Tally #, customer, department or operation type';
      issues.push({line, tally, reason});
      return;
    }
    const agent = /^(?:0|n\/a|[-.])$/i.test(agentValue) ? '' : agentValue.toUpperCase();
    const epfs = value => [...new Set(value.split(/[,;\s]+/).filter(id => id && id !== '0'))];
    const record = {tally, customer, account, reference, direction:direction.toLowerCase(), start, end,
      operators:epfs(operators), clerks:epfs(clerks), supervisors:epfs(supervisors), heads, contract, agent,
      manHours, container, vehicle, shift, vehicleType:labourVehicleCategory(vehicleType)};
    const previous = operations.get(tally);
    if (conflicts.has(tally) || (previous && JSON.stringify(previous.record) !== JSON.stringify(record))) {
      if (previous) issues.push({line:previous.line, tally, reason:'Conflicting records for this Tally #'});
      operations.delete(tally);
      conflicts.add(tally);
      issues.push({line, tally, reason:'Conflicting records for this Tally #'});
    } else if (previous) {
      duplicates++;
    } else {
      operations.set(tally, {line, record});
    }
  });
  return {operations:[...operations.values()].map(item => item.record), issues, duplicates};
}
