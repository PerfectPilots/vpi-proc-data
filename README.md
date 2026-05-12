# VPI ATC — Procedure Data Pipeline

Automatically parses the [VATSIM UK Sector File](https://github.com/VATSIM-UK/UK-Sector-File) and publishes SID/STAR data as a JSON API for the VPI ATC Client.

## How it works

```
VATSIM UK GitHub ──► GitHub Action (every 28 days) ──► GitHub Pages ──► VPI ATC Client
```

1. **GitHub Actions** fetches the VATSIM-UK/UK-Sector-File repo directly (no clone needed)
2. Parses `Airports/ICAO/Sids.txt`, `Stars.txt`, `Fixes.txt` for each airport
3. Resolves waypoint names to lat/lon from global `Fixes/Fixes.txt` and `Navaids/`
4. Publishes `procedures.json` to GitHub Pages

## Data URL

Once deployed, your ATC client fetches from:
```
https://<your-username>.github.io/<this-repo>/procedures.json
```

## Setup

1. Fork or create this repo on your GitHub account
2. Go to **Settings → Pages → Source** → set to `gh-pages` branch
3. Go to **Actions** tab and run the workflow manually once
4. Update `VPI_PROC_URL` in the ATC client's `main.js` to your Pages URL

## Airports covered

Channel Islands: EGJB, EGJH, EGJA  
Ireland: EIDW, EINN, EICK  
London: EGKK, EGLL, EGLC, EGSS  
North England: EGCC, EGNM, EGGP, EGNT  
Scotland: EGPH, EGPF, EGPD  
South/SW: EGGD, EGHI, EGTE, EGHH  
Midlands: EGBB, EGBJ, EGNX  
Yorkshire: EGCN, EGNJ  
N. Ireland: EGAA, EGAC, EGPK  

## Data format

```json
{
  "EGJB": {
    "SID": [
      { "name": "ORTAC1A", "runway": "09", "fixes": [
        { "id": "GUR", "lat": 49.435, "lon": -2.601 },
        { "id": "ANGLA", "lat": 49.703, "lon": -2.021 },
        { "id": "ORTAC", "lat": 49.999, "lon": -2.005 }
      ]}
    ],
    "STAR": [...],
    "APPROACH": []
  }
}
```

## Updates

The workflow runs automatically on the 1st and 29th of each month, keeping data in sync with AIRAC cycles. You can also trigger a manual run from the Actions tab.

## Credits

- Procedure data from [VATSIM-UK/UK-Sector-File](https://github.com/VATSIM-UK/UK-Sector-File) (MIT licence)
- Parsed and hosted for the VPI virtual network
