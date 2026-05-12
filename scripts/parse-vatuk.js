#!/usr/bin/env node
/**
 * VPI ATC — VATSIM UK Sector File Parser
 *
 * EuroScope Sids.txt format:
 *   SID:AIRPORT:RUNWAY:NAME:FIX1 FIX2 FIX3
 *   e.g. SID:EGLL:09L:CPT4K:D113B D256K WOD CPT
 *
 * Stars.txt same format with STAR: prefix.
 * Fixes.txt: FIXNAME   N049.26.06.000 W002.36.10.000
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const REPO   = 'VATSIM-UK/UK-Sector-File';
const BRANCH = 'main';
const RAW    = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;

const AIRPORTS = [
  'EGJB','EGJH','EGJA',
  'EIDW','EINN','EICK',
  'EGKK','EGLL','EGLC','EGSS',
  'EGCC','EGNM','EGGP','EGNT',
  'EGPH','EGPF','EGPD',
  'EGGD','EGHI','EGTE','EGHH',
  'EGBB','EGBJ','EGNX',
  'EGCN','EGNJ',
  'EGAA','EGAC','EGPK',
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

// N049.26.06.000 or W002.36.10.000
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

// SID:EGLL:09L:CPT4K:D113B D256K WOD CPT
// or SID:09L:CPT4K:D113B D256K WOD (no airport field)
function parseProcFile(text) {
  const procs = [];
  if (!text) return procs;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.split(';')[0].trim();
    if (!/^(SID|STAR):/i.test(line)) continue;
    const parts = line.split(':');
    if (parts.length < 4) continue;

    const p1IsICAO = /^EG[A-Z]{2}$|^EI[A-Z]{2}$/.test(parts[1]);
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

  console.log('Fetching global fixes...');
  const [fixText, vorText, ndbText] = await Promise.all([
    fetch(`${RAW}/Fixes/Fixes.txt`),
    fetch(`${RAW}/Navaids/VORs.txt`),
    fetch(`${RAW}/Navaids/NDBs.txt`),
  ]);
  const globalFixes = { ...parseFixes(fixText), ...parseFixes(vorText), ...parseFixes(ndbText) };
  console.log(`  Global fixes loaded: ${Object.keys(globalFixes).length}`);

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
    const SIDs  = parseProcFile(sidText) .map(p => ({ name: p.name, runway: p.runway, fixes: resolveFixes(p.fixNames, fixMap) })).filter(p => p.fixes.length >= 1);
    const STARs = parseProcFile(starText).map(p => ({ name: p.name, runway: p.runway, fixes: resolveFixes(p.fixNames, fixMap) })).filter(p => p.fixes.length >= 1);

    if (SIDs.length || STARs.length) {
      output[icao] = { SID: SIDs, STAR: STARs, APPROACH: [] };
      totalSIDs += SIDs.length; totalSTARs += STARs.length;
      console.log(`${SIDs.length} SIDs, ${STARs.length} STARs`);
    } else {
      const hint = sidText ? `sidText=${sidText.slice(0,80).replace(/\n/g,' ')}` : 'no sidText';
      console.log(`no data — ${hint}`);
    }
  }

  const outDir = path.join(__dirname, '..', 'docs');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'procedures.json'), JSON.stringify(output));
  fs.writeFileSync(path.join(outDir, 'procedures-meta.json'), JSON.stringify({
    generated: new Date().toISOString(),
    source: `https://github.com/${REPO}`,
    airports: Object.keys(output).length,
    sids: totalSIDs, stars: totalSTARs,
  }, null, 2));

  console.log(`\n✓ ${Object.keys(output).length} airports — ${totalSIDs} SIDs, ${totalSTARs} STARs`);
}

main().catch(e => { console.error(e); process.exit(1); });
