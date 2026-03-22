// ── State ────────────────────────────────────────────────────────────────────
let allVMs = [];        // grouped VM data with pricing
let filteredVMs = [];
let currentPage = 1;
const PAGE_SIZE = 50;
let sortField = 'linuxPrice';
let sortDir = 'asc';

const BILLING_MULT = { hour: 1, day: 24, month: 730, year: 8760 };
const CURRENCY_SYM = {
  USD:'$', EUR:'\u20AC', GBP:'\u00A3', AUD:'A$', CAD:'C$', JPY:'\u00A5',
  KRW:'\u20A9', INR:'\u20B9', BRL:'R$', CHF:'CHF', SEK:'kr', NOK:'kr',
  DKK:'kr', TWD:'NT$', CNY:'\u00A5',
};

// Column definitions
const COLUMNS = [
  { key: 'name',          label: 'VM Name',        align: 'left',  visible: true,  sortable: true  },
  { key: 'familyDesc',    label: 'Type',           align: 'left',  visible: true,  sortable: true  },
  { key: 'vcpus',         label: 'vCPUs',          align: 'right', visible: true,  sortable: true  },
  { key: 'memoryGB',      label: 'Memory (GiB)',   align: 'right', visible: true,  sortable: true  },
  { key: 'arch',          label: 'Arch',           align: 'left',  visible: false, sortable: true  },
  { key: 'linuxPrice',    label: 'Linux',          align: 'right', visible: true,  sortable: true  },
  { key: 'windowsPrice',  label: 'Windows',        align: 'right', visible: true,  sortable: true  },
  { key: 'spotLinux',     label: 'Spot Linux',     align: 'right', visible: false, sortable: true  },
  { key: 'spotWindows',   label: 'Spot Windows',   align: 'right', visible: false, sortable: true  },
  { key: 'pricePerVcpu',  label: '$/vCPU',         align: 'right', visible: false, sortable: true  },
  { key: 'pricePerGB',    label: '$/GiB',          align: 'right', visible: false, sortable: true  },
  { key: 'savings1yr',    label: 'Save 1yr',       align: 'right', visible: false, sortable: true  },
  { key: 'savings3yr',    label: 'Save 3yr',       align: 'right', visible: false, sortable: true  },
  { key: 'productName',   label: 'Product',        align: 'left',  visible: false, sortable: true  },
];

let visibleColumns = COLUMNS.filter(c => c.visible).map(c => c.key);

// ── Init ─────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  const saved = localStorage.getItem('theme');
  if (saved) setTheme(saved);
  const savedCols = localStorage.getItem('visibleColumns_v2');
  if (savedCols) { try { visibleColumns = JSON.parse(savedCols); } catch(_) {} }
  buildColumnPicker();

  document.addEventListener('click', (e) => {
    const picker = document.getElementById('column-picker');
    const btn = document.getElementById('col-picker-btn');
    if (picker && picker.style.display !== 'none' && !picker.contains(e.target) && !btn.contains(e.target)) {
      picker.style.display = 'none';
    }
  });

  // Allow Enter key in selectors to trigger fetch
  document.getElementById('selector-bar').addEventListener('keydown', e => {
    if (e.key === 'Enter') fetchPricing();
  });
});

// ── Theme ────────────────────────────────────────────────────────────────────
function toggleTheme() {
  setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
}
function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  document.getElementById('theme-icon-sun').style.display  = theme === 'dark' ? 'block' : 'none';
  document.getElementById('theme-icon-moon').style.display = theme === 'dark' ? 'none'  : 'block';
}

// ── Fetch Pricing ────────────────────────────────────────────────────────────
async function fetchPricing() {
  const region   = document.getElementById('sel-region').value;
  const currency = document.getElementById('sel-currency').value;

  setLoading(true, 'Fetching pricing from Azure...');
  document.getElementById('welcome').style.display = 'none';

  try {
    // Fetch Pay-as-you-go (Consumption) prices
    const consumptionItems = await fetchAllPages(region, currency, 'Consumption');

    // Also fetch Reservation prices for savings calculation
    const reservationItems = await fetchAllPages(region, currency, 'Reservation');

    // Also fetch Spot prices
    setLoading(true, 'Processing spot pricing...');
    const spotItems = consumptionItems.filter(i => /spot/i.test(i.skuName));
    const regularItems = consumptionItems.filter(i => !/spot|low priority/i.test(i.skuName));

    // Group and merge
    setLoading(true, 'Building VM table...');
    allVMs = buildVMList(regularItems, spotItems, reservationItems, region);

    document.getElementById('last-updated').textContent = `Updated: ${new Date().toLocaleTimeString()}`;
    document.getElementById('sku-count-badge').textContent = `${allVMs.length} VMs`;
    document.getElementById('sku-count-badge').style.display = 'inline';

    populateFilterDropdowns();
    applyFilters();
    setLoading(false);
    document.getElementById('toolbar').style.display = 'block';
    document.getElementById('table-section').style.display = 'block';

  } catch (e) {
    setLoading(false);
    alert('Error fetching pricing: ' + e.message);
  }
}

async function fetchAllPages(region, currency, priceType) {
  const items = [];
  const baseFilter = `serviceName eq 'Virtual Machines' and armRegionName eq '${region}' and priceType eq '${priceType}'`;
  let nextUrl = `/api/prices?currencyCode=${currency}&$filter=${encodeURIComponent(baseFilter)}`;
  let page = 0;

  while (nextUrl) {
    const res = await fetch(nextUrl);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    const data = await res.json();
    items.push(...(data.Items || []));
    page++;
    setLoading(true, `Fetching ${priceType.toLowerCase()} prices... ${items.length.toLocaleString()} items (page ${page})`);

    const progressBar = document.getElementById('progress-bar');
    progressBar.style.width = Math.min(90, page * 5) + '%';

    // Pass the full Azure NextPageLink URL to our proxy via query param
    if (data.NextPageLink) {
      nextUrl = '/api/prices?nextUrl=' + encodeURIComponent(data.NextPageLink);
    } else {
      nextUrl = null;
    }
  }
  return items;
}

function buildVMList(regular, spot, reserved, region) {
  // Group regular items by armSkuName + OS type
  const vmMap = {};

  for (const item of regular) {
    const sku = item.armSkuName;
    if (!sku) continue;

    if (!vmMap[sku]) {
      const specs = parseVmSpecs(sku);
      vmMap[sku] = {
        name: sku,
        vcpus: specs.vcpus,
        memoryGB: specs.memoryGB,
        familyDesc: specs.familyDesc,
        arch: specs.arch,
        hasPremiumSSD: specs.hasPremiumSSD,
        productName: item.productName || '',
        linuxPrice: null,
        windowsPrice: null,
        spotLinux: null,
        spotWindows: null,
        reserved1yrLinux: null,
        reserved3yrLinux: null,
        region: region,
      };
    }

    const vm = vmMap[sku];
    const isWindows = /windows/i.test(item.productName) || /windows/i.test(item.meterName);

    if (isWindows) {
      vm.windowsPrice = (vm.windowsPrice === null) ? item.retailPrice : Math.min(vm.windowsPrice, item.retailPrice);
    } else {
      vm.linuxPrice = (vm.linuxPrice === null) ? item.retailPrice : Math.min(vm.linuxPrice, item.retailPrice);
    }
  }

  // Add spot prices
  for (const item of spot) {
    const sku = item.armSkuName;
    if (!sku || !vmMap[sku]) continue;
    const isWindows = /windows/i.test(item.productName) || /windows/i.test(item.meterName);
    if (isWindows) {
      vmMap[sku].spotWindows = (vmMap[sku].spotWindows === null) ? item.retailPrice : Math.min(vmMap[sku].spotWindows, item.retailPrice);
    } else {
      vmMap[sku].spotLinux = (vmMap[sku].spotLinux === null) ? item.retailPrice : Math.min(vmMap[sku].spotLinux, item.retailPrice);
    }
  }

  // Add reservation prices (1yr, 3yr) for Linux
  for (const item of reserved) {
    const sku = item.armSkuName;
    if (!sku || !vmMap[sku]) continue;
    if (/windows/i.test(item.productName)) continue; // skip Windows reserved for now

    // Reservation prices are monthly — convert to hourly for comparison
    const hourly = item.retailPrice / 730;
    if (item.reservationTerm === '1 Year') {
      vmMap[sku].reserved1yrLinux = (vmMap[sku].reserved1yrLinux === null) ? hourly : Math.min(vmMap[sku].reserved1yrLinux, hourly);
    } else if (item.reservationTerm === '3 Years') {
      vmMap[sku].reserved3yrLinux = (vmMap[sku].reserved3yrLinux === null) ? hourly : Math.min(vmMap[sku].reserved3yrLinux, hourly);
    }
  }

  // Calculate derived fields
  return Object.values(vmMap)
    .filter(vm => vm.vcpus > 0 && (vm.linuxPrice !== null || vm.windowsPrice !== null))
    .map(vm => {
      const basePrice = vm.linuxPrice || vm.windowsPrice || 0;
      vm.pricePerVcpu = vm.vcpus > 0 ? basePrice / vm.vcpus : 0;
      vm.pricePerGB   = vm.memoryGB > 0 ? basePrice / vm.memoryGB : 0;

      // Savings percentages
      vm.savings1yr = (vm.linuxPrice && vm.reserved1yrLinux)
        ? Math.round((1 - vm.reserved1yrLinux / vm.linuxPrice) * 100) : null;
      vm.savings3yr = (vm.linuxPrice && vm.reserved3yrLinux)
        ? Math.round((1 - vm.reserved3yrLinux / vm.linuxPrice) * 100) : null;

      return vm;
    });
}

// ── Filters ──────────────────────────────────────────────────────────────────
function populateFilterDropdowns() {
  const families = [...new Set(allVMs.map(v => v.familyDesc))].sort();
  const famSel = document.getElementById('filter-family');
  famSel.innerHTML = '<option value="">All</option>' + families.map(f => `<option value="${f}">${f}</option>`).join('');
}

function applyFilters() {
  const search  = document.getElementById('search').value.toLowerCase();
  const family  = document.getElementById('filter-family').value;
  const vcpuVal = document.getElementById('filter-vcpus').value;
  const memVal  = document.getElementById('filter-memory').value;
  const typeVal = document.getElementById('filter-type').value;

  const TYPE_MAP = {
    general:      ['General Purpose', 'General Purpose (Legacy)', 'Burstable'],
    compute:      ['Compute Optimized'],
    memory:       ['Memory Optimized', 'Memory Optimized (Large)', 'Memory & Storage (Legacy)'],
    storage:      ['Storage Optimized'],
    gpu:          ['GPU Compute', 'GPU Deep Learning', 'GPU Visualization', 'FPGA Accelerated'],
    hpc:          ['High Performance Compute', 'HPC (AMD EPYC)', 'HPC (Intel Xeon)', 'HPC Memory Optimized'],
    confidential: ['Confidential Computing'],
  };

  filteredVMs = allVMs.filter(v => {
    if (search && !v.name.toLowerCase().includes(search) && !v.familyDesc.toLowerCase().includes(search) && !v.productName.toLowerCase().includes(search)) return false;
    if (family && v.familyDesc !== family) return false;
    if (vcpuVal) {
      if (vcpuVal === '128+') { if (v.vcpus < 128) return false; }
      else { if (v.vcpus !== parseInt(vcpuVal)) return false; }
    }
    if (memVal) {
      const [lo, hi] = memVal.includes('+') ? [parseInt(memVal), Infinity] : memVal.split('-').map(Number);
      if (v.memoryGB < lo || v.memoryGB > hi) return false;
    }
    if (typeVal && TYPE_MAP[typeVal]) {
      if (!TYPE_MAP[typeVal].includes(v.familyDesc)) return false;
    }
    return true;
  });

  sortData();
  currentPage = 1;
  renderTable();
}

function resetFilters() {
  document.getElementById('search').value = '';
  document.getElementById('filter-family').value = '';
  document.getElementById('filter-vcpus').value = '';
  document.getElementById('filter-memory').value = '';
  document.getElementById('filter-type').value = '';
  applyFilters();
}

// ── Column Picker ────────────────────────────────────────────────────────────
function buildColumnPicker() {
  const list = document.getElementById('column-picker-list');
  if (!list) return;
  list.innerHTML = COLUMNS.map(c => `
    <label><input type="checkbox" value="${c.key}" ${visibleColumns.includes(c.key) ? 'checked' : ''} onchange="toggleColumn('${c.key}', this.checked)" />${c.label}</label>
  `).join('');
}

function toggleColumnPicker() {
  const p = document.getElementById('column-picker');
  p.style.display = p.style.display === 'none' ? 'block' : 'none';
}

function toggleColumn(key, show) {
  if (show && !visibleColumns.includes(key)) visibleColumns.push(key);
  if (!show) visibleColumns = visibleColumns.filter(k => k !== key);
  localStorage.setItem('visibleColumns_v2', JSON.stringify(visibleColumns));
  renderTable();
}

function resetColumns() {
  visibleColumns = COLUMNS.filter(c => c.visible).map(c => c.key);
  localStorage.setItem('visibleColumns_v2', JSON.stringify(visibleColumns));
  buildColumnPicker();
  renderTable();
}

// ── Sorting ──────────────────────────────────────────────────────────────────
function sortBy(field) {
  if (sortField === field) { sortDir = sortDir === 'asc' ? 'desc' : 'asc'; }
  else { sortField = field; sortDir = (field === 'name' || field === 'familyDesc' || field === 'arch') ? 'asc' : 'asc'; }
  sortData();
  renderTable();
}

function sortData() {
  filteredVMs.sort((a, b) => {
    let av = a[sortField], bv = b[sortField];
    // Treat null prices as Infinity (push to bottom)
    if (av === null || av === undefined) av = sortDir === 'asc' ? Infinity : -Infinity;
    if (bv === null || bv === undefined) bv = sortDir === 'asc' ? Infinity : -Infinity;
    if (typeof av === 'string') { av = av.toLowerCase(); bv = (bv || '').toLowerCase(); }
    if (av < bv) return sortDir === 'asc' ? -1 : 1;
    if (av > bv) return sortDir === 'asc' ?  1 : -1;
    return 0;
  });
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderTable() {
  const cols = COLUMNS.filter(c => visibleColumns.includes(c.key));
  const billing = document.getElementById('sel-billing').value;
  const pricing = document.getElementById('sel-pricing').value;
  const region  = document.getElementById('sel-region');
  const regionLabel = region.options[region.selectedIndex].text;
  const currency = document.getElementById('sel-currency').value;
  const mult = BILLING_MULT[billing];
  const sym = CURRENCY_SYM[currency] || currency;

  // Update toolbar meta
  document.getElementById('results-count').textContent = `${filteredVMs.length.toLocaleString()} VMs`;
  document.getElementById('region-display').textContent = regionLabel;
  document.getElementById('pricing-model-display').textContent =
    { payg: 'Pay-as-you-go', spot: 'Spot', '1yr': 'Reserved 1yr', '3yr': 'Reserved 3yr' }[pricing];

  // Determine price column label suffix
  const periodLabel = { hour: '/hr', day: '/day', month: '/mo', year: '/yr' }[billing];

  // Header
  const thead = document.getElementById('sku-thead');
  thead.innerHTML = '<tr>' + cols.map(c => {
    const alignClass = c.align === 'right' ? ' align-right' : '';
    const activeSort = sortField === c.key ? (sortDir === 'asc' ? ' sort-asc' : ' sort-desc') : '';
    const onclick = c.sortable ? ` onclick="sortBy('${c.key}')"` : '';
    const sortableClass = c.sortable ? ' sortable' : '';
    let label = c.label;
    if (['linuxPrice','windowsPrice','spotLinux','spotWindows','pricePerVcpu','pricePerGB'].includes(c.key)) {
      label = `${c.label} ${periodLabel}`;
    }
    return `<th class="${sortableClass}${alignClass}${activeSort}"${onclick}>${label}${c.sortable ? ' <span class="sort-icon"></span>' : ''}</th>`;
  }).join('') + '</tr>';

  // Body
  const tbody = document.getElementById('sku-tbody');
  const start = (currentPage - 1) * PAGE_SIZE;
  const page  = filteredVMs.slice(start, start + PAGE_SIZE);

  if (filteredVMs.length === 0) {
    tbody.innerHTML = '';
    document.getElementById('empty-state').style.display = 'block';
    document.getElementById('pagination').innerHTML = '';
    return;
  }
  document.getElementById('empty-state').style.display = 'none';

  tbody.innerHTML = page.map(vm => {
    return '<tr>' + cols.map(c => renderCell(vm, c, mult, sym, pricing)).join('') + '</tr>';
  }).join('');

  renderPagination();
}

function getPrice(vm, pricing, field) {
  if (pricing === 'spot') {
    if (field === 'linuxPrice') return vm.spotLinux;
    if (field === 'windowsPrice') return vm.spotWindows;
  }
  if (pricing === '1yr' && field === 'linuxPrice') return vm.reserved1yrLinux;
  if (pricing === '3yr' && field === 'linuxPrice') return vm.reserved3yrLinux;
  return vm[field];
}

function renderCell(vm, col, mult, sym, pricing) {
  const align = col.align === 'right' ? ' class="align-right cell-number"' : '';

  switch (col.key) {
    case 'name':
      return `<td class="cell-name"><a href="javascript:void(0)" onclick="toggleVMDetail('${vm.name}', this.closest('tr'))" title="Click for details">${vm.name}</a></td>`;
    case 'familyDesc':
      return `<td><span class="family-badge">${vm.familyDesc}</span></td>`;
    case 'vcpus':
      return `<td${align}>${vm.vcpus}</td>`;
    case 'memoryGB':
      return `<td${align}>${fmtNum(vm.memoryGB)}</td>`;
    case 'arch':
      return `<td><span class="cap-tag cap-tag--arch">${vm.arch}</span></td>`;
    case 'linuxPrice': {
      const p = getPrice(vm, pricing, 'linuxPrice');
      return `<td${align}>${fmtPrice(p, mult, sym)}</td>`;
    }
    case 'windowsPrice': {
      const p = getPrice(vm, pricing, 'windowsPrice');
      return `<td${align}>${fmtPrice(p, mult, sym)}</td>`;
    }
    case 'spotLinux':
      return `<td${align}>${fmtPrice(vm.spotLinux, mult, sym)}</td>`;
    case 'spotWindows':
      return `<td${align}>${fmtPrice(vm.spotWindows, mult, sym)}</td>`;
    case 'pricePerVcpu':
      return `<td${align}>${fmtPrice(vm.pricePerVcpu, mult, sym)}</td>`;
    case 'pricePerGB':
      return `<td${align}>${fmtPrice(vm.pricePerGB, mult, sym)}</td>`;
    case 'savings1yr':
      return `<td${align}>${vm.savings1yr !== null ? `<span class="savings-tag">${vm.savings1yr}%</span>` : '<span class="cell-dim">-</span>'}</td>`;
    case 'savings3yr':
      return `<td${align}>${vm.savings3yr !== null ? `<span class="savings-tag">${vm.savings3yr}%</span>` : '<span class="cell-dim">-</span>'}</td>`;
    case 'productName':
      return `<td class="cell-dim">${vm.productName}</td>`;
    default:
      return `<td>-</td>`;
  }
}

// ── VM Detail Panel ──────────────────────────────────────────────────────────
let expandedVM = null;

function toggleVMDetail(name, rowEl) {
  const tbody = document.getElementById('sku-tbody');
  const existing = document.getElementById('detail-row');
  if (existing) existing.remove();

  if (expandedVM === name) { expandedVM = null; return; }
  expandedVM = name;

  const vm = allVMs.find(v => v.name === name);
  if (!vm) return;

  const colCount = COLUMNS.filter(c => visibleColumns.includes(c.key)).length;
  const currency = document.getElementById('sel-currency').value;
  const sym = CURRENCY_SYM[currency] || currency;

  const detailRow = document.createElement('tr');
  detailRow.id = 'detail-row';
  detailRow.innerHTML = `<td colspan="${colCount}" class="detail-cell">
    <div class="detail-panel">
      <div class="detail-header">
        <h3>${vm.name}</h3>
        <span class="detail-product">${vm.productName}</span>
        <button class="btn-icon btn-sm" onclick="toggleVMDetail('${name}')">Close</button>
      </div>
      <div class="detail-body">
        <div class="detail-specs">
          <h4>Specifications</h4>
          <table class="specs-table">
            <tr><td>vCPUs</td><td><strong>${vm.vcpus}</strong></td></tr>
            <tr><td>Memory</td><td><strong>${vm.memoryGB} GiB</strong></td></tr>
            <tr><td>Architecture</td><td>${vm.arch}</td></tr>
            <tr><td>Type</td><td>${vm.familyDesc}</td></tr>
            <tr><td>Premium SSD</td><td>${vm.hasPremiumSSD ? 'Yes' : 'No'}</td></tr>
            <tr><td>Linux ${sym}/hr</td><td>${vm.linuxPrice !== null ? sym + vm.linuxPrice.toFixed(4) : '-'}</td></tr>
            <tr><td>Windows ${sym}/hr</td><td>${vm.windowsPrice !== null ? sym + vm.windowsPrice.toFixed(4) : '-'}</td></tr>
            <tr><td>Spot Linux ${sym}/hr</td><td>${vm.spotLinux !== null ? sym + vm.spotLinux.toFixed(4) : '-'}</td></tr>
            ${vm.savings1yr !== null ? `<tr><td>Reserved 1yr savings</td><td><span class="savings-tag">${vm.savings1yr}%</span></td></tr>` : ''}
            ${vm.savings3yr !== null ? `<tr><td>Reserved 3yr savings</td><td><span class="savings-tag">${vm.savings3yr}%</span></td></tr>` : ''}
          </table>
          <div class="detail-links">
            <a href="https://learn.microsoft.com/en-us/azure/virtual-machines/${vm.name.replace('Standard_','').toLowerCase().replace(/_/g,'-')}" target="_blank" class="btn-outline btn-sm">Microsoft Docs</a>
            <a href="https://cloudprice.net/vm/${vm.name}" target="_blank" class="btn-outline btn-sm">CloudPrice</a>
          </div>
        </div>
        <div class="detail-regional">
          <h4>Regional Pricing <span class="detail-dim">(Linux, Pay-as-you-go, ${sym}/hr)</span></h4>
          <div id="regional-prices" class="regional-loading">
            <div class="spinner" style="width:24px;height:24px;border-width:2px;"></div>
            <span>Loading regional prices...</span>
          </div>
        </div>
      </div>
    </div>
  </td>`;

  rowEl.after(detailRow);
  fetchRegionalPricing(vm.name, currency, sym);
}

async function fetchRegionalPricing(vmName, currency, sym) {
  const container = document.getElementById('regional-prices');
  try {
    const filter = `serviceName eq 'Virtual Machines' and armSkuName eq '${vmName}' and priceType eq 'Consumption'`;
    let nextUrl = `/api/prices?currencyCode=${currency}&$filter=${encodeURIComponent(filter)}`;
    const items = [];

    while (nextUrl) {
      const res = await fetch(nextUrl);
      if (!res.ok) throw new Error(`API ${res.status}`);
      const data = await res.json();
      items.push(...(data.Items || []));
      if (data.NextPageLink) {
        nextUrl = '/api/prices?nextUrl=' + encodeURIComponent(data.NextPageLink);
      } else {
        nextUrl = null;
      }
    }

    // Group by region, separate Linux/Windows
    const regionMap = {};
    for (const item of items) {
      if (/spot|low priority/i.test(item.skuName)) continue;
      const region = item.armRegionName;
      const loc = item.location || region;
      if (!regionMap[region]) regionMap[region] = { region, location: loc, linux: null, windows: null };
      const isWin = /windows/i.test(item.productName) || /windows/i.test(item.meterName);
      if (isWin) {
        regionMap[region].windows = regionMap[region].windows === null ? item.retailPrice : Math.min(regionMap[region].windows, item.retailPrice);
      } else {
        regionMap[region].linux = regionMap[region].linux === null ? item.retailPrice : Math.min(regionMap[region].linux, item.retailPrice);
      }
    }

    const regions = Object.values(regionMap).filter(r => r.linux !== null).sort((a, b) => a.linux - b.linux);
    const bestPrice = regions.length > 0 ? regions[0].linux : 0;

    if (regions.length === 0) {
      container.innerHTML = '<span class="cell-dim">No regional pricing data available.</span>';
      return;
    }

    container.className = 'regional-table-wrap';
    container.innerHTML = `
      <div class="regional-summary">${regions.length} regions available. Best price: <strong>${sym}${bestPrice.toFixed(4)}/hr</strong> in <strong>${regions[0].location}</strong></div>
      <table class="regional-table">
        <thead>
          <tr><th>Region</th><th>Location</th><th class="align-right">Linux ${sym}/hr</th><th class="align-right">Windows ${sym}/hr</th><th class="align-right">vs Best</th></tr>
        </thead>
        <tbody>
          ${regions.map(r => {
            const diff = bestPrice > 0 ? ((r.linux - bestPrice) / bestPrice * 100).toFixed(1) : 0;
            const diffLabel = diff == 0 ? '<span class="best-tag">Best</span>' : `<span class="diff-tag">+${diff}%</span>`;
            return `<tr>
              <td><strong>${r.region}</strong></td>
              <td class="cell-dim">${r.location}</td>
              <td class="align-right cell-number">${sym}${r.linux.toFixed(4)}</td>
              <td class="align-right cell-number">${r.windows !== null ? sym + r.windows.toFixed(4) : '-'}</td>
              <td class="align-right">${diffLabel}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
  } catch (e) {
    container.innerHTML = `<span class="error-msg">Failed to load regional pricing: ${e.message}</span>`;
  }
}

function fmtNum(n) {
  if (n === null || n === undefined) return '-';
  return Number(n) % 1 === 0 ? Number(n).toLocaleString() : Number(n).toFixed(2);
}

function fmtPrice(hourlyPrice, mult, sym) {
  if (hourlyPrice === null || hourlyPrice === undefined) return '<span class="cell-dim">-</span>';
  const val = hourlyPrice * mult;
  if (val === 0) return '<span class="cell-dim">-</span>';
  if (val < 0.01) return `<span class="price">${sym}${val.toFixed(4)}</span>`;
  if (val < 1) return `<span class="price">${sym}${val.toFixed(4)}</span>`;
  if (val < 100) return `<span class="price">${sym}${val.toFixed(2)}</span>`;
  return `<span class="price">${sym}${val.toFixed(2)}</span>`;
}

// ── Pagination ───────────────────────────────────────────────────────────────
function renderPagination() {
  const total = Math.ceil(filteredVMs.length / PAGE_SIZE);
  if (total <= 1) { document.getElementById('pagination').innerHTML = ''; return; }
  let html = `<button class="page-btn" onclick="goPage(${currentPage-1})" ${currentPage===1?'disabled':''}>&#8249; Prev</button>`;
  pageRange(currentPage, total).forEach(p => {
    if (p === '...') html += `<span style="padding:0 4px;color:var(--text-dim)">&hellip;</span>`;
    else html += `<button class="page-btn ${p===currentPage?'active':''}" onclick="goPage(${p})">${p}</button>`;
  });
  html += `<button class="page-btn" onclick="goPage(${currentPage+1})" ${currentPage===total?'disabled':''}>Next &#8250;</button>`;
  document.getElementById('pagination').innerHTML = html;
}
function pageRange(cur, total) {
  if (total <= 7) return Array.from({length: total}, (_, i) => i+1);
  if (cur <= 4) return [1,2,3,4,5,'...',total];
  if (cur >= total-3) return [1,'...',total-4,total-3,total-2,total-1,total];
  return [1,'...',cur-1,cur,cur+1,'...',total];
}
function goPage(p) {
  const total = Math.ceil(filteredVMs.length / PAGE_SIZE);
  if (p < 1 || p > total) return;
  currentPage = p;
  renderTable();
  document.getElementById('table-wrapper').scrollTo({ top: 0, behavior: 'smooth' });
}

// ── Utilities ────────────────────────────────────────────────────────────────
function setLoading(on, message) {
  document.getElementById('loading').style.display = on ? 'block' : 'none';
  document.getElementById('fetch-btn').disabled = on;
  if (message) {
    const el = document.querySelector('#loading p');
    if (el) el.textContent = message;
  }
}

// Re-render when billing/pricing selectors change
document.addEventListener('DOMContentLoaded', () => {
  ['sel-billing', 'sel-pricing'].forEach(id => {
    document.getElementById(id).addEventListener('change', () => {
      if (allVMs.length > 0) renderTable();
    });
  });
});

// ── Export ────────────────────────────────────────────────────────────────────
function exportCSV() {
  const billing = document.getElementById('sel-billing').value;
  const mult = BILLING_MULT[billing];
  const headers = ['VM Name','Type','vCPUs','Memory (GiB)','Linux Price','Windows Price','Spot Linux','Spot Windows','Save 1yr %','Save 3yr %','Product'];
  const rows = filteredVMs.map(v => [
    v.name, v.familyDesc, v.vcpus, v.memoryGB,
    v.linuxPrice !== null ? (v.linuxPrice * mult).toFixed(4) : '',
    v.windowsPrice !== null ? (v.windowsPrice * mult).toFixed(4) : '',
    v.spotLinux !== null ? (v.spotLinux * mult).toFixed(4) : '',
    v.spotWindows !== null ? (v.spotWindows * mult).toFixed(4) : '',
    v.savings1yr !== null ? v.savings1yr : '',
    v.savings3yr !== null ? v.savings3yr : '',
    `"${v.productName}"`,
  ]);
  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  downloadFile(csv, `azure-vm-pricing-${datestamp()}.csv`, 'text/csv');
}

function exportJSON() {
  const billing = document.getElementById('sel-billing').value;
  const mult = BILLING_MULT[billing];
  const data = filteredVMs.map(v => ({
    name: v.name, type: v.familyDesc, vcpus: v.vcpus, memoryGB: v.memoryGB,
    arch: v.arch, region: v.region,
    linuxPrice: v.linuxPrice !== null ? +(v.linuxPrice * mult).toFixed(4) : null,
    windowsPrice: v.windowsPrice !== null ? +(v.windowsPrice * mult).toFixed(4) : null,
    spotLinux: v.spotLinux !== null ? +(v.spotLinux * mult).toFixed(4) : null,
    savings1yr: v.savings1yr, savings3yr: v.savings3yr,
    productName: v.productName,
  }));
  downloadFile(JSON.stringify(data, null, 2), `azure-vm-pricing-${datestamp()}.json`, 'application/json');
}

function downloadFile(content, filename, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
function datestamp() { return new Date().toISOString().slice(0, 10); }
