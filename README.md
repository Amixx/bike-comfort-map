# Bike Comfort Map

Static Svelte + TypeScript + Leaflet app for the Group 3 Seeeduino LoRaWAN bike sensor project.

Proposed repo name: `bike-comfort-map`.

## What it shows

- Estimated bucket-level points from the separately exported June 27 and July 2 rides
- Raw packet/window points from both rides
- Optional real packet GPS dots and diagnostic bucket→packet connector lines
- Roughness, RMS, peak acceleration, vibration, and speed coloring
- Metric-specific color scales with a constant feature count when the selected color metric changes
- Adjustable packet maximum-speed filter (2 km/h by default) to exclude windows whose maximum speed stays below the threshold consistently across layers and print output
- Toggleable June 27 and July 2 screenshot-route reconstructions with same-ride measurement-colored road segments and an optional full-route color interpolation
- Optional point snapping to the bundled same-date reconstructed route, using a fixed 35 m safeguard
- Borderless landscape print/save output that always fits the complete reconstructed routes with fixed padding, independent of the interactive viewport

The app bundles static GeoJSON files in `public/data`, so it works on GitHub Pages without VPN or FROST CORS access. The browser never calls the FROST API. The June 27 and July 2 rides are exported separately so position estimation never crosses the gap between rides. Regenerate or add files locally while connected to the university VPN when adding another ride.

## Local development

```sh
npm install
npm run dev
```

## Build for GitHub Pages

```sh
npm run build
npm run preview
```

The production build is written to `docs/`. In GitHub, set Pages to deploy from the `main` branch and `/docs` folder. `vite.config.ts` uses `base: './'`, so assets work under a project page path even if the repository is renamed.

## Map tiles

The app uses CARTO's label-free light raster tiles, based on OpenStreetMap data, to keep the measurement overlay legible. If the page becomes high-traffic, switch to a dedicated tile plan.

## Updating data later

1. Connect to the university VPN.
2. In the Arduino/FROST workspace, run the export script, e.g. `python3 scripts/export_group3_comfort_map.py`.
3. Copy the regenerated final GeoJSON files into this app's `public/data/` directory.
4. Run `npm run build`; commit/push the updated `public/data/` and `docs/` files.

Do not make the GitHub Pages app fetch FROST live; it will not work for public users because the API requires VPN access.

## Data caveats shown in the UI

- The sensor data is sampled LoRaWAN uplinks, not continuous route coverage.
- Bucket points are estimated by speed back-projection from one GPS coordinate per packet.
- Packet-window points use real GPS only and keep both bucket values in properties.
- Different rides should be handled as separate route segments; the app does not assume cross-ride continuity.
- The roughness proxy is relative and ISO-2631-inspired, not ISO-compliant.
- The June 27 reconstruction removes a short northwest-corner routing backtrack so the two road sides meet at the intended corner.

## Method references

- [ISO 2631-1:1997, *Mechanical vibration and shock — Evaluation of human exposure to whole-body vibration — Part 1: General requirements*](https://www.iso.org/obp/ui/#iso:std:iso:2631:-1:ed-2:v1:en) defines frequency-weighted RMS evaluation and additional methods for vibration with substantial peaks; this project lacks the raw frequency-weighted time history and measurement setup required for compliance.
- Bíl, Andrášik & Kubeček (2015), [*How comfortable are your cycling tracks? A new method for objective bicycle vibration measurement*](https://doi.org/10.1016/j.trc.2015.05.007), supports acceleration-based comparison of cycling infrastructure comfort.
- Gao et al. (2018), [*Evaluating the cycling comfort on urban roads based on cyclists’ perception of vibration*](https://doi.org/10.1016/j.jclepro.2018.04.275), relates measured vibration to perceived cycling comfort.
- Ahmed et al. (2024), [*Evaluating Bicycle Path Roughness: A Comparative Study Using Smartphone and Smart Bicycle Light Sensors*](https://doi.org/10.3390/s24227210), highlights speed and sensor setup as important influences on measured bicycle-path roughness.
- Gao et al. (2025), [*Network-Wide GIS Mapping of Cycling Vibration Comfort: From Methodology to Real-World Implementation*](https://pmc.ncbi.nlm.nih.gov/articles/PMC12526540/), demonstrates mapping acceleration-derived comfort levels onto road segments.

The compound score weights, SW-420 hit-rate, 2 km/h packet maximum-speed cutoff, packet max/mean choice, snapping distance, and color thresholds are project heuristics rather than ISO requirements.
