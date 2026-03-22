/**
 * Azure VM Specs Parser — derives hardware specs from VM SKU names.
 * Uses naming conventions + known overrides for accuracy.
 *
 * Azure VM naming: Standard_{Family}{vCPUs}{Suffix}_{Version}
 *   Family:  B=Burstable, D=General, E=Memory, F=Compute, G=Memory, H=HPC, L=Storage, M=Memory, N=GPU, DC=Confidential
 *   Suffix:  s=Premium SSD, d=Local Disk, a=AMD, p=ARM, l=Low Mem, m=High Mem, i=Isolated, t=Tiny Mem
 *   Version: v2, v3, v4, v5, etc.
 */

// Memory ratio per vCPU (GiB) by family prefix
const FAMILY_MEM_RATIO = {
  'A':  2,    // General purpose (older)
  'B':  4,    // Burstable
  'D':  4,    // General purpose
  'DC': 4,    // Confidential
  'E':  8,    // Memory optimized
  'F':  2,    // Compute optimized
  'FX': 4,    // Compute optimized (special)
  'G':  8,    // Memory/storage (older)
  'H':  8,    // HPC
  'HB': 4,    // HPC (AMD)
  'HC': 4,    // HPC (Intel)
  'HX': 8,    // HPC memory
  'L':  8,    // Storage optimized
  'M':  16,   // Memory optimized (large)
  'NC': 7,    // GPU compute
  'ND': 12,   // GPU deep learning
  'NV': 7,    // GPU visualization
  'NP': 8,    // GPU (FPGA)
};

// Family descriptions
const FAMILY_DESC = {
  'A':  'General Purpose (Legacy)',
  'B':  'Burstable',
  'D':  'General Purpose',
  'DC': 'Confidential Computing',
  'E':  'Memory Optimized',
  'F':  'Compute Optimized',
  'FX': 'Compute Optimized',
  'G':  'Memory & Storage (Legacy)',
  'H':  'High Performance Compute',
  'HB': 'HPC (AMD EPYC)',
  'HC': 'HPC (Intel Xeon)',
  'HX': 'HPC Memory Optimized',
  'L':  'Storage Optimized',
  'M':  'Memory Optimized (Large)',
  'NC': 'GPU Compute',
  'ND': 'GPU Deep Learning',
  'NV': 'GPU Visualization',
  'NP': 'FPGA Accelerated',
};

// Known overrides for VMs that don't follow naming patterns
const KNOWN_SPECS = {
  'Standard_B1ls':  { vcpus: 1, memoryGB: 0.5 },
  'Standard_B1s':   { vcpus: 1, memoryGB: 1 },
  'Standard_B1ms':  { vcpus: 1, memoryGB: 2 },
  'Standard_B2s':   { vcpus: 2, memoryGB: 4 },
  'Standard_B2ms':  { vcpus: 2, memoryGB: 8 },
  'Standard_B2ts_v2':  { vcpus: 2, memoryGB: 1 },
  'Standard_B2ats_v2': { vcpus: 2, memoryGB: 1 },
  'Standard_B2als_v2': { vcpus: 2, memoryGB: 4 },
  'Standard_B2as_v2':  { vcpus: 2, memoryGB: 8 },
  'Standard_B4ms':  { vcpus: 4, memoryGB: 16 },
  'Standard_B8ms':  { vcpus: 8, memoryGB: 32 },
  'Standard_B12ms': { vcpus: 12, memoryGB: 48 },
  'Standard_B16ms': { vcpus: 16, memoryGB: 64 },
  'Standard_B20ms': { vcpus: 20, memoryGB: 80 },
  'Standard_A1_v2': { vcpus: 1, memoryGB: 2 },
  'Standard_A2_v2': { vcpus: 2, memoryGB: 4 },
  'Standard_A4_v2': { vcpus: 4, memoryGB: 8 },
  'Standard_A8_v2': { vcpus: 8, memoryGB: 16 },
  'Standard_A2m_v2': { vcpus: 2, memoryGB: 16 },
  'Standard_A4m_v2': { vcpus: 4, memoryGB: 32 },
  'Standard_A8m_v2': { vcpus: 8, memoryGB: 64 },
  'Standard_M8ms':    { vcpus: 8,   memoryGB: 218.75 },
  'Standard_M16ms':   { vcpus: 16,  memoryGB: 437.5 },
  'Standard_M32ts':   { vcpus: 32,  memoryGB: 192 },
  'Standard_M32ls':   { vcpus: 32,  memoryGB: 256 },
  'Standard_M32ms':   { vcpus: 32,  memoryGB: 875 },
  'Standard_M64s':    { vcpus: 64,  memoryGB: 1024 },
  'Standard_M64ms':   { vcpus: 64,  memoryGB: 1792 },
  'Standard_M128s':   { vcpus: 128, memoryGB: 2048 },
  'Standard_M128ms':  { vcpus: 128, memoryGB: 3892 },
  'Standard_HB120rs_v3':  { vcpus: 120, memoryGB: 448 },
  'Standard_HB120rs_v2':  { vcpus: 120, memoryGB: 456 },
  'Standard_HB120-16rs_v3':  { vcpus: 16, memoryGB: 448 },
  'Standard_HB120-32rs_v3':  { vcpus: 32, memoryGB: 448 },
  'Standard_HB120-64rs_v3':  { vcpus: 64, memoryGB: 448 },
  'Standard_HB120-96rs_v3':  { vcpus: 96, memoryGB: 448 },
  'Standard_HC44rs':  { vcpus: 44, memoryGB: 352 },
};

/**
 * Parse a VM SKU name and return derived specs.
 * @param {string} name - e.g. "Standard_D2s_v5"
 * @returns {{ vcpus: number, memoryGB: number, family: string, familyDesc: string, arch: string, hasPremiumSSD: boolean }}
 */
function parseVmSpecs(name) {
  // Check known overrides first
  if (KNOWN_SPECS[name]) {
    const k = KNOWN_SPECS[name];
    const parsed = parseNameParts(name);
    return {
      vcpus: k.vcpus,
      memoryGB: k.memoryGB,
      family: parsed.family,
      familyDesc: FAMILY_DESC[parsed.familyPrefix] || parsed.family,
      arch: parsed.arch,
      hasPremiumSSD: parsed.hasPremiumSSD,
    };
  }

  const parsed = parseNameParts(name);
  const ratio = FAMILY_MEM_RATIO[parsed.familyPrefix] || 4;
  let memoryGB = parsed.vcpus * ratio;

  // Adjust for suffixes
  if (parsed.suffix.includes('m')) memoryGB *= 2;       // 'm' = more memory
  if (parsed.suffix.includes('l')) memoryGB /= 2;       // 'l' = less memory
  if (parsed.suffix.includes('t')) memoryGB = Math.max(1, parsed.vcpus); // 't' = tiny memory

  return {
    vcpus: parsed.vcpus,
    memoryGB: Math.round(memoryGB * 100) / 100,
    family: parsed.family,
    familyDesc: FAMILY_DESC[parsed.familyPrefix] || parsed.family,
    arch: parsed.arch,
    hasPremiumSSD: parsed.hasPremiumSSD,
  };
}

function parseNameParts(name) {
  // Remove "Standard_" prefix
  let rest = name.replace(/^Standard_/i, '');

  // Detect architecture
  let arch = 'x64';
  if (/p[sbld]*_v\d/i.test(rest) || /ps\d/i.test(rest)) arch = 'Arm64';

  // Detect premium SSD support
  const hasPremiumSSD = /s/i.test(rest.replace(/Standard/g, '').replace(/_v\d+$/g, ''));

  // Try to parse: {FamilyLetters}{vCPUcount}{suffixLetters}_{version}
  // Examples: D2s_v5, E4as_v5, NC24ads_A100_v4, HB120rs_v3
  const match = rest.match(/^([A-Z]+?)(\d+)([-a-z]*)(?:_(.+))?$/i);

  if (!match) {
    return { vcpus: 0, family: rest, familyPrefix: rest.charAt(0), suffix: '', arch, hasPremiumSSD };
  }

  const familyLetters = match[1];
  const vcpuNum = parseInt(match[2]);
  const suffix = match[3] || '';
  const version = match[4] || '';

  // Map family prefix
  let familyPrefix = familyLetters.toUpperCase();
  // Reduce to known prefix
  for (const key of ['DC', 'FX', 'HB', 'HC', 'HX', 'NC', 'ND', 'NV', 'NP']) {
    if (familyPrefix.startsWith(key)) { familyPrefix = key; break; }
  }
  if (!FAMILY_MEM_RATIO[familyPrefix]) {
    familyPrefix = familyPrefix.charAt(0);
  }

  const family = familyLetters + (suffix ? suffix : '') + (version ? '_' + version : '');

  // AMD detection
  if (suffix.includes('a')) arch = arch === 'Arm64' ? 'Arm64' : 'x64'; // 'a' = AMD (still x64)

  return {
    vcpus: vcpuNum,
    family,
    familyPrefix,
    suffix,
    arch,
    hasPremiumSSD,
  };
}

// Export for browser
window.parseVmSpecs = parseVmSpecs;
window.FAMILY_DESC = FAMILY_DESC;
