(() => {
  const table = (headers, rows) => rows.length
    ? '<div class="scroll"><table><thead><tr>' + headers.map(value => '<th scope="col">' + esc(value) + '</th>').join('') +
      '</tr></thead><tbody>' + rows.map(row => '<tr>' + row.map(value => '<td>' + esc(value) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>'
    : '<p>No records in this scope.</p>';
  const number = value => Number.isFinite(value) ? fmt(value, 2) : '—';

  function costRecords(kind) {
    const report = monthlyCostReport();
    let body = '';
    if (kind === 'total') {
      body += '<h4>Published labour by vehicle visit</h4>' + table(['Dept Reg No.', 'Vehicle', 'Operation', 'Crew role', 'Regular hours', 'OT hours', 'Cost', 'Status'],
        report.rows.flatMap(row => {
          const publication = operationPublication(row);
          const visit = [row.reg, row.vehicle, operationName(row.direction)];
          const status = publication ? (publication.complete ? 'Complete' : 'Partial') : 'Not published';
          return [
            [...visit, 'Visit total', '—', '—', publication ? money(publication.amount) : '—', status],
            ...(publication?.roles ?? []).map(role => [
              ...visit, role.role, number(role.dayMinutes == null ? null : role.dayMinutes / 60),
              number(role.otMinutes == null ? null : role.otMinutes / 60),
              role.totalCost == null ? '—' : money(role.totalCost), '—'
            ])
          ];
        }));
    }
    if (kind === 'area' || kind === 'total') {
      body += '<h4>Monthly area</h4>' + table(['Operation', 'Area (sq ft)', 'Rate', 'Cost', 'Status'],
        [['Loading', report.loading], ['Unloading', report.unloading]].map(([label, cost]) =>
          [label, number(cost.sqft), cost.rate == null ? '—' : money(cost.rate),
            cost.sqft == null || (cost.rate == null && cost.areaCost === 0) ? '—' : money(cost.areaCost),
            cost.sqft == null ? 'Area unavailable for this scope' : cost.rate == null ? 'Check job rates' : 'Available']));
    }
    if (kind === 'other' || kind === 'total') {
      body += '<h4>Operating charges</h4>' + table(['Category', 'Item', 'Job', 'Operation', 'Date', 'Quantity', 'Rate', 'Cost'],
        report.charges.map(({ job, label, entry, direction, amount }) => [
          label, entry.item || '—', jobCostScopeLabel(job), direction === 'UL' ? 'Both (U/L)' : operationName(direction),
          entry.date || 'Monthly', entry.quantity ?? 1, chargeRateFor(entry, direction) == null ? '—' : money(chargeRateFor(entry, direction)), money(amount)
        ]));
    }
    return body;
  }

  const monthlyCosts = el('monthlyCosts');
  monthlyCosts.addEventListener('click', event => {
    const toggle = event.target.closest('[data-monthly-breakdown]');
    if (!toggle || !payrollUser || monthlyCosts.hidden) return;
    const open = toggle.getAttribute('aria-expanded') === 'false';
    const breakdown = el(toggle.getAttribute('aria-controls'));
    const records = breakdown.querySelector('.monthly-breakdown-records');
    if (open && records) records.innerHTML = costRecords(toggle.dataset.monthlyBreakdown);
    for (const button of monthlyCosts.querySelectorAll('[data-monthly-breakdown]')) {
      const expanded = open && button === toggle;
      button.setAttribute('aria-expanded', String(expanded));
      el(button.getAttribute('aria-controls')).hidden = !expanded;
    }
  });
  const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
  const refreshAnimations = new Map();
  const chartRefresh = new MutationObserver(records => {
    for (const section of new Set(records.map(record => record.target))) {
      refreshAnimations.get(section)?.cancel();
      if (!section.hidden && section.childElementCount && !motionPreference.matches) {
        refreshAnimations.set(section, section.animate(
          [{ opacity: 0.45, transform: 'translateY(5px)' }, { opacity: 1, transform: 'translateY(0)' }],
          { duration: 220, easing: 'ease-out' }
        ));
      }
    }
  });
  for (const id of ['cards', 'charts', 'monthlyCosts']) chartRefresh.observe(el(id), { childList: true });
  motionPreference.addEventListener('change', event => {
    if (event.matches) {
      for (const animation of refreshAnimations.values()) animation.cancel();
      refreshAnimations.clear();
    }
  });

})();
