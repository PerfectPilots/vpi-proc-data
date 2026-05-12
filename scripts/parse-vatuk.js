#!/usr/bin/env node
/**
 * VPI ATC — VATSIM UK Sector File Parser
 * Fetches the VATSIM-UK/UK-Sector-File from GitHub and converts
 * SID/STAR data into the VPI procedures.json format.
 *
 * Runs in GitHub Actions on a schedule (every AIRAC = every 28 days).
 * Output: docs/procedures.json  (served via GitHub Pages)
 */

const https  = require('https');
const fs     = require('fs');
const path   = require('path');

const REPO   = 'VATSIM-UK/UK-Sector-File';
const BRANCH = 'main';
const RAW    = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;

// Airports to process — add any ICAO that has a folder in the VATSIM UK sector file
const AIRPORTS = [
  'EGJB','EGJH','EGJA',            // Channel Islands
  'EIDW','EINN','EICK',            // Ireland
  'EGKK','EGLL','EGLC','EGSS',     // London
  'EGCC','EGNM','EGGP','EGNT',     // North England
  'EGPH','EGPF','EGPD',            // Scotland
  'EGGD','EGHI','EGTE','EGHH',     // South/SW England
  'EGBB','EGBJ','EGNX',            // Midlands
  'EGCN','EGNJ',                   // Yorkshire/Humber
  'EGAA','EGAC','EGPK',            // Northern Ireland / SW Scotland
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'VPI-ATC-Pipeline/1.0' } }, res => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        return fetch(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return resolve(null); // file doesn't exist — skip silently
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

/**
 * Parse EuroScope DMS coordinate: N049.26.06.000 or S049.26.06.000
 * Also handles: N49.26.06.000 (no leading zero on degrees)
 */
function parseDMS(str) {
  if (!str) return null;
  const m = str.match(/^([NS])(\d+)\.(\d+)\.(\d+\.?\d*)$/);
  if (!m) return null;
  const [, hem, d, min, sec] = m;
  const val = parseInt(d) + parseInt(min)/60 + parseFloat(sec)/3600;
  return hem === 'S' ? -val : val;
}

function parseLon(str) {
  if (!str) return null;
  const m = str.match(/^([EW])(\d+)\.(\d+)\.(\d+\.?\d*)$/);
  if (!m) return null;
  const [, hem, d, min, sec] = m;
  const val = parseInt(d) + parseInt(min)/60 + parseFloat(sec)/3600;
  return hem === 'W' ? -val : val;
}

/**
 * Parse a Fixes.txt or Navaids file.
 * Lines: FIXNAME  N049.26.06.000  W002.36.10.000
 */
function parseFixes(text) {
  const fixes = {};
  if (!text) return fixes;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';')) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) continue;
    const [name, latStr, lonStr] = parts;
    const lat = parseDMS(latStr);
    const lon = parseLon(lonStr);
    if (lat != null && lon != null) {
      fixes[name.toUpperCase()] = { lat: +lat.toFixed(6), lon: +lon.toFixed(6) };
    }
  }
  return fixes;
}

/**
 * Parse a Sids.txt or Stars.txt file.
 * EuroScope SID format:
 *   SID_NAME:RUNWAY:FIX1:FIX2:...:FIXn
 * or the line-drawing format:
 *   SID_NAME       FIX1  N049.xx.xx.xxx  W002.xx.xx.xxx  FIX2  N049.xx.xx.xxx  W002.xx.xx.xxx
 *
 * The VATSIM UK sector file uses this format in Sids.txt (ESE-style):
 *   SIDNAME:RWY:transition:fix1:fix2:...
 */
function parseProcFile(text, type) {
  const procs = [];
  if (!text) return procs;

  // ESE-style: NAME:RWY:trans:fix1:fix2...
  // Also plain format without colon
  for (const rawLine of text.split('\n')) {
    const line = rawLine.split(';')[0].trim(); // strip comments
    if (!line) continue;

    if (line.includes(':')) {
      // Colon-delimited ESE format
      const parts = line.split(':');
      if (parts.length < 2) continue;
      const name    = parts[0].trim();
      const runway  = parts[1].trim();
      // parts[2] might be a transition name or first fix — heuristic: if it looks
      // like a fix name (all caps 2-5 chars) it's a waypoint, otherwise transition
      const fixes = [];
      for (let i = 2; i < parts.length; i++) {
        const f = parts[i].trim();
        if (f && /^[A-Z0-9]{2,6}$/.test(f)) fixes.push(f);
      }
      if (name && runway) {
        procs.push({ name, runway, fixNames: fixes });
      }
    }
  }
  return procs;
}

/**
 * Resolve fix names to lat/lon using the collected fixes map
 */
function resolveFixes(fixNames, fixMap) {
  return fixNames
    .map(id => {
      const pos = fixMap[id];
      if (!pos) return null;
      return { id, ...pos };
    })
    .filter(Boolean);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('VPI ATC — VATSIM UK Sector File Parser');
  console.log('========================================');
  console.log(`Fetching from: ${REPO}@${BRANCH}`);

  // 1. Fetch the global ENR fixes (enroute waypoints used in procedures)
  console.log('\nFetching enroute fixes...');
  const enrFixText = await fetch(`${RAW}/Fixes/Fixes.txt`);
  const globalFixes = parseFixes(enrFixText);
  console.log(`  Enroute fixes: ${Object.keys(globalFixes).length}`);

  // Also fetch VORs/NDBs as they're used as procedure fixes
  const vorText = await fetch(`${RAW}/Navaids/VORs.txt`);
  const ndbText = await fetch(`${RAW}/Navaids/NDBs.txt`);
  const vorFixes = parseFixes(vorText);
  const ndbFixes = parseFixes(ndbText);
  Object.assign(globalFixes, vorFixes, ndbFixes);
  console.log(`  Total fixes (inc. VOR/NDB): ${Object.keys(globalFixes).length}`);

  const output = {};
  let totalProcs = 0;

  // 2. Process each airport
  for (const icao of AIRPORTS) {
    process.stdout.write(`  ${icao}... `);

    // Fetch airport-specific files in parallel
    const [sidText, starText, fixText] = await Promise.all([
      fetch(`${RAW}/Airports/${icao}/Sids.txt`),
      fetch(`${RAW}/Airports/${icao}/Stars.txt`),
      fetch(`${RAW}/Airports/${icao}/Fixes.txt`),
    ]);

    // Build fix map: global + airport-local
    const localFixes = parseFixes(fixText);
    const fixMap = { ...globalFixes, ...localFixes };

    // Parse procedures
    const rawSIDs  = parseProcFile(sidText,  'SID');
    const rawSTARs = parseProcFile(starText, 'STAR');

    // Resolve waypoints
    const SIDs  = rawSIDs .map(p => ({ ...p, fixes: resolveFixes(p.fixNames, fixMap) })).filter(p => p.fixes.length >= 1);
    const STARs = rawSTARs.map(p => ({ ...p, fixes: resolveFixes(p.fixNames, fixMap) })).filter(p => p.fixes.length >= 1);

    if (SIDs.length || STARs.length) {
      output[icao] = {
        SID:      SIDs .map(({ name, runway, fixes }) => ({ name, runway, fixes })),
        STAR:     STARs.map(({ name, runway, fixes }) => ({ name, runway, fixes })),
        APPROACH: [],  // Approaches come from a different source — left empty for now
      };
      totalProcs += SIDs.length + STARs.length;
      console.log(`${SIDs.length} SIDs, ${STARs.length} STARs`);
    } else {
      console.log('no data');
    }
  }

  // 3. Write output
  const outDir = path.join(__dirname, '..', 'docs');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'procedures.json');
  fs.writeFileSync(outPath, JSON.stringify(output));

  // Write a metadata file so clients know when data was last updated
  const meta = {
    generated:  new Date().toISOString(),
    source:     `https://github.com/${REPO}`,
    airports:   Object.keys(output).length,
    procedures: totalProcs,
  };
  fs.writeFileSync(path.join(outDir, 'procedures-meta.json'), JSON.stringify(meta, null, 2));

  const sizeKB = (fs.statSync(outPath).size / 1024).toFixed(1);
  console.log(`\n✓ Written: ${outPath} (${sizeKB} KB)`);
  console.log(`✓ ${Object.keys(output).length} airports, ${totalProcs} procedures`);
  console.log('\nServed at: https://<your-github-username>.github.io/<repo-name>/procedures.json');
}

main().catch(e => { console.error(e); process.exit(1); });
