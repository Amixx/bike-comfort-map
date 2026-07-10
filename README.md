# Bike Comfort Map

Static Svelte + TypeScript + Leaflet app for the Group 3 Seeeduino LoRaWAN bike sensor project.

Proposed repo name: `bike-comfort-map`.

## What it shows

- Estimated bucket-level points from the separately exported June 27 and July 2 rides
- Raw packet/window points from both rides
- Optional real packet GPS dots and diagnostic bucket→packet connector lines
- Roughness, RMS, peak acceleration, vibration, and speed coloring
- Quality, roughness class, time, and score filters
- Adjustable minimum ride-speed filter (1 km/h by default) to exclude stationary measurements consistently across layers and exports
- Optional route snapping from a manually clicked or uploaded GeoJSON LineString route
- Filtered GeoJSON / CSV export

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

The app uses OpenStreetMap raster tiles (`https://tile.openstreetmap.org`). That is free and needs no key for a small project/demo. If the page becomes high-traffic, switch to a dedicated tile provider.

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
