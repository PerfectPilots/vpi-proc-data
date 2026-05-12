#!/usr/bin/env node
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const REPO   = 'VATSIM-UK/UK-Sector-File';
const BRANCH = 'main';
const RAW    = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;

const AIRPORTS = [
  'EGJB','EGJJ','EGJA',
  'EIDW','EINN','EICK',
  'EGKK','EGLL','EGLC','EGSS',
  'EGCC','EGNM','EGGP','EGNT',
  'EGPH','EGPF','EGPD',
  'EGGD','EGHI','EGTE','EGHH',
  'EGBB','EGBJ','EGNX',
  'EGCN','EGNJ',
  'EGAA','EGAC','EGPK',
];

// Global fix files — all of them
const GLOBAL_FIX_FILES = [
  'Navaids/FIXES_UK.txt',
  'Navaids/FIXES_CICZ.txt',       // Channel Islands fixes
  'Navaids/FIXES_Virtual.txt',
  'Navaids/FIXES_PHONETIC.txt',
  'Navaids/FIXES_TACAN-Routes.txt',
  'Navaids/FIXES_HMRI-Gates.txt',
  'Navaids/FIXES_Lat Lon.txt',
  'Navaids/VOR_UK.txt',
  'Navaids/VOR_Non-UK.txt',
  'Navaids/NDB_All.txt',
  'Navaids/Fixes_Non-UK/FIXES_IE.txt',  // Irish fixes (EIDW etc)
  'Navaids/Fixes_Non-UK/FIXES_FR.txt',  // French fixes (Channel Islands area)
];

function fetch(url) {
  return new Promise((resolve, reject) => {
    const get = (u) => {
      https.get(u, { headers: { 'User-Agent': 'VPI-ATC-Pipeline/1.0' } }, res => {
        if (res.statusCode === 301 || res.statusCode === 302) return get(res.headers.location);
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve(data));
      }).on('error', reject);
    };
    get(url);
  });
}

function parseDMS(str) {
  if (!str) return null;
  const m = str.trim().match(/^([NSEW])(\d+)\.(\d+)\.(\d+\.?\d*)$/);
  if (!m) return null;
  const [, dir, d, min, sec] = m;
  const val = parseInt(d) + parseInt(min)/60 + parseFloat(sec)/3600;
  return (dir === 'S' || dir === 'W') ? -val : val;
}

function parseFixes(text) {
  const fixes = {};
  if (!text) return fixes;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.split(';')[0].trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const name = parts[0].toUpperCase();
    let lat = null, lon = null;
    for (const p of parts.slice(1)) {
      if (/^[NS]/i.test(p) && lat === null) lat = parseDMS(p);
      else if (/^[EW]/i.test(p) && lon === null) lon = parseDMS(p);
    }
    if (lat !== null && lon !== null && !isNaN(lat) && !isNaN(lon)) {
      fixes[name] = { lat: +lat.toFixed(6), lon: +lon.toFixed(6) };
    }
  }
  return fixes;
}

function parseProcFile(text) {
  const procs = [];
  if (!text) return procs;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.split(';')[0].trim();
    if (!/^(SID|STAR):/i.test(line)) continue;
    const parts = line.split(':');
    if (parts.length < 4) continue;
    const p1 = parts[1].trim();
    const p1IsICAO = /^[A-Z]{4}$/.test(p1);
    let runway, name, fixStr;
    if (p1IsICAO) {
      runway = parts[2].trim();
      name   = parts[3].trim();
      fixStr = parts.slice(4).join(':').trim();
    } else {
      runway = parts[1].trim();
      name   = parts[2].trim();
      fixStr = parts.slice(3).join(':').trim();
    }
    if (!runway || !name) continue;
    const fixNames = fixStr.split(/\s+/).filter(f => f && /^[A-Z0-9]{2,6}$/.test(f));
    procs.push({ name, runway, fixNames });
  }
  return procs;
}

function resolveFixes(fixNames, fixMap) {
  return fixNames
    .map(id => { const p = fixMap[id]; return p ? { id, ...p } : null; })
    .filter(Boolean);
}

async function main() {
  console.log('VPI ATC — VATSIM UK Sector File Parser');
  console.log('========================================');

  // Fetch all global fix files in parallel
  console.log(`Fetching ${GLOBAL_FIX_FILES.length} global fix files...`);
  const fixTexts = await Promise.all(
    GLOBAL_FIX_FILES.map(f => fetch(`${RAW}/${f}`))
  );

  const globalFixes = {};
  GLOBAL_FIX_FILES.forEach((f, i) => {
    const parsed = parseFixes(fixTexts[i]);
    const count  = Object.keys(parsed).length;
    if (count > 0) {
      Object.assign(globalFixes, parsed);
      console.log(`  ${f}: ${count} fixes`);
    } else {
      console.log(`  ${f}: not found / empty`);
    }
  });
  console.log(`  Total: ${Object.keys(globalFixes).length} fixes`);

  // Debug key Channel Islands fixes
  ['GUR','JSY','ALD','ORTAC','LUSIT','ANGLA','SKERY','SKESO'].forEach(f => {
    console.log(`  ${f}: ${globalFixes[f] ? JSON.stringify(globalFixes[f]) : 'MISSING'}`);
  });

  const output = {};
  let totalSIDs = 0, totalSTARs = 0;

  for (const icao of AIRPORTS) {
    process.stdout.write(`  ${icao}... `);
    const [sidText, starText, localFixText] = await Promise.all([
      fetch(`${RAW}/Airports/${icao}/Sids.txt`),
      fetch(`${RAW}/Airports/${icao}/Stars.txt`),
      fetch(`${RAW}/Airports/${icao}/Fixes.txt`),
    ]);

    const fixMap = { ...globalFixes, ...parseFixes(localFixText) };

    const rawSIDs  = parseProcFile(sidText);
    const rawSTARs = parseProcFile(starText);

    // Debug missing fixes for first STAR
    if (rawSTARs.length > 0 && (icao === 'EGJB' || icao === 'EGLL')) {
      const s = rawSTARs[0];
      const missing = s.fixNames.filter(f => !fixMap[f]);
      if (missing.length) console.log(`\n    ${icao} STAR "${s.name}" missing fixes: [${missing}]`);
    }

    const SIDs  = rawSIDs .map(p => ({ name: p.name, runway: p.runway, fixes: resolveFixes(p.fixNames, fixMap) })).filter(p => p.fixes.length >= 1);
    const STARs = rawSTARs.map(p => ({ name: p.name, runway: p.runway, fixes: resolveFixes(p.fixNames, fixMap) })).filter(p => p.fixes.length >= 1);

    if (SIDs.length || STARs.length) {
      output[icao] = { SID: SIDs, STAR: STARs, APPROACH: [] };
      totalSIDs += SIDs.length; totalSTARs += STARs.length;
      console.log(`${SIDs.length} SIDs, ${STARs.length} STARs`);
    } else {
      console.log(`no data (rawSID=${rawSIDs.length} rawSTAR=${rawSTARs.length})`);
    }
  }

  const outDir = path.join(__dirname, '..', 'docs');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'procedures.json'), JSON.stringify(output));
  fs.writeFileSync(path.join(outDir, 'procedures-meta.json'), JSON.stringify({
    generated: new Date().toISOString(),
    source: `https://github.com/${REPO}`,
    airports: Object.keys(output).length,
    sids: totalSIDs,
    stars: totalSTARs,
  }, null, 2));

  console.log(`\n✓ ${Object.keys(output).length} airports — ${totalSIDs} SIDs, ${totalSTARs} STARs`);
}

main().catch(e => { console.error(e); process.exit(1); });
