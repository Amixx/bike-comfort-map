<script lang="ts">
  import { onMount } from 'svelte'
  import L from 'leaflet'

  type Geometry = {
    type: 'Point' | 'LineString' | 'MultiLineString'
    coordinates: any
  }

  type GeoJsonFeature = {
    type: 'Feature'
    geometry: Geometry
    properties: Record<string, any>
  }

  type FeatureCollection = {
    type: 'FeatureCollection'
    features: GeoJsonFeature[]
  }

  type LayerId = 'bucket' | 'packet' | 'gps' | 'connectors'
  type ScoreMetric = 'roughness' | 'rms' | 'peak' | 'vibration' | 'speed'
  type PacketRoughnessMode = 'max' | 'mean'

  const dataSources: Record<LayerId, { label: string; files: string[]; help: string }> = {
    bucket: {
      label: 'Estimated bucket points',
      files: [
        '/data/group3-bike-comfort-final-speed-estimated.geojson',
        '/data/group3-bike-comfort-latest-speed-estimated.geojson',
      ],
      help: 'Two 12.5s bucket centers per uplink, positioned by speed back-projection.',
    },
    packet: {
      label: 'Raw packet windows',
      files: [
        '/data/group3-bike-comfort-final-packet-windows.geojson',
        '/data/group3-bike-comfort-latest-packet-windows.geojson',
      ],
      help: 'One real GPS point per uplink with both bucket values attached.',
    },
    gps: {
      label: 'Real packet GPS dots',
      files: [
        '/data/group3-bike-comfort-final-real-packet-gps.geojson',
        '/data/group3-bike-comfort-latest-real-packet-gps.geojson',
      ],
      help: 'Actual packet coordinates only.',
    },
    connectors: {
      label: 'Diagnostic connectors',
      files: [
        '/data/group3-bike-comfort-final-packet-connectors.geojson',
        '/data/group3-bike-comfort-latest-packet-connectors.geojson',
      ],
      help: 'Dashed provenance lines from bucket 0 → bucket 1 → packet GPS. Not route geometry.',
    },
  }

  const layerOrder: LayerId[] = ['bucket', 'packet', 'gps', 'connectors']
  const qualityLabels: Record<string, string> = {
    good: 'good',
    weak_heading_may_span_turn: 'weak',
    poor_heading_from_large_gap: 'poor',
    unknown_no_previous_heading: 'unknown',
  }
  const qualityOpacity: Record<string, number> = {
    good: 0.92,
    weak_heading_may_span_turn: 0.62,
    poor_heading_from_large_gap: 0.38,
    unknown_no_previous_heading: 0.46,
  }
  const classOrder = ['low roughness', 'moderate roughness', 'high roughness', 'very high roughness']
  const qualityOrder = ['good', 'weak_heading_may_span_turn', 'poor_heading_from_large_gap', 'unknown_no_previous_heading']

  let mapEl: HTMLDivElement
  let fileInput: HTMLInputElement
  let map: L.Map
  let featureLayer = L.layerGroup()
  let routeLayer = L.layerGroup()
  let data: Partial<Record<LayerId, FeatureCollection>> = {}
  let loadError = ''
  let isLoading = true

  let visibleLayers = new Set<LayerId>(['bucket'])
  let selectedQualities = new Set<string>(qualityOrder)
  let selectedClasses = new Set<string>(classOrder)
  let scoreMetric: ScoreMetric = 'roughness'
  let packetRoughnessMode: PacketRoughnessMode = 'max'
  let timeStart = ''
  let timeEnd = ''
  let fullTimeStart = ''
  let fullTimeEnd = ''
  let minScore = 0
  let maxScore = 1
  let minRideSpeedKmh = 1
  let snapEnabled = false
  let snapMaxDistanceM = 35
  let routeEditMode = false
  let manualRoute: [number, number][] = []
  let uploadedRoutes: [number, number][][] = []
  let currentFeatures: GeoJsonFeature[] = []
  let snappedPointCount = 0
  let totalPointCount = 0
  let hasFitted = false

  $: stats = buildStats(currentFeatures)
  $: routePointCount = manualRoute.length + uploadedRoutes.reduce((sum, route) => sum + route.length, 0)
  $: routeLineCount = (manualRoute.length > 1 ? 1 : 0) + uploadedRoutes.filter((route) => route.length > 1).length
  $: canSnap = routeLineCount > 0
  $: {
    visibleLayers
    selectedQualities
    selectedClasses
    scoreMetric
    packetRoughnessMode
    timeStart
    timeEnd
    minScore
    maxScore
    minRideSpeedKmh
    snapEnabled
    snapMaxDistanceM
    manualRoute
    uploadedRoutes
    data
    if (map && !isLoading) {
      currentFeatures = getFilteredFeatures()
      renderMap()
    }
  }

  onMount(async () => {
    map = L.map(mapEl, { zoomControl: false }).setView([48.1482, 11.5655], 14)
    L.control.zoom({ position: 'bottomright' }).addTo(map)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map)
    featureLayer.addTo(map)
    routeLayer.addTo(map)
    map.on('click', (event: L.LeafletMouseEvent) => {
      if (!routeEditMode) return
      manualRoute = [...manualRoute, [event.latlng.lat, event.latlng.lng]]
    })

    try {
      const entries = await Promise.all(
        layerOrder.map(async (id) => {
          const collections = await Promise.all(
            dataSources[id].files.map(async (file) => {
              const response = await fetch(withBase(file))
              if (!response.ok) throw new Error(`${file}: ${response.status}`)
              return response.json() as Promise<FeatureCollection>
            }),
          )
          return [id, { type: 'FeatureCollection', features: collections.flatMap((collection) => collection.features) }] as const
        }),
      )
      data = Object.fromEntries(entries) as Record<LayerId, FeatureCollection>
      setFullTimeRange()
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error)
    } finally {
      isLoading = false
    }
  })

  function withBase(path: string) {
    const base = import.meta.env.BASE_URL || '/'
    return `${base.replace(/\/$/, '')}${path}`
  }

  function setFullTimeRange() {
    const times = layerOrder
      .flatMap((id) => data[id]?.features ?? [])
      .map((feature) => getTime(feature))
      .filter(Boolean)
      .sort() as string[]
    if (!times.length) return
    fullTimeStart = toDatetimeLocal(times[0], 'floor')
    fullTimeEnd = toDatetimeLocal(times[times.length - 1], 'ceil')
    timeStart = fullTimeStart
    timeEnd = fullTimeEnd
  }

  function toggleLayer(id: LayerId) {
    const next = new Set(visibleLayers)
    next.has(id) ? next.delete(id) : next.add(id)
    visibleLayers = next
  }

  function toggleQuality(quality: string) {
    const next = new Set(selectedQualities)
    next.has(quality) ? next.delete(quality) : next.add(quality)
    selectedQualities = next
  }

  function toggleClass(className: string) {
    const next = new Set(selectedClasses)
    next.has(className) ? next.delete(className) : next.add(className)
    selectedClasses = next
  }

  function selectAllQualities() {
    selectedQualities = new Set(qualityOrder)
  }

  function selectTrustedQualities() {
    selectedQualities = new Set(['good'])
  }

  function selectAllClasses() {
    selectedClasses = new Set(classOrder)
  }

  function resetFilters() {
    visibleLayers = new Set(['bucket'])
    selectedQualities = new Set(qualityOrder)
    selectedClasses = new Set(classOrder)
    scoreMetric = 'roughness'
    packetRoughnessMode = 'max'
    minScore = 0
    maxScore = 1
    minRideSpeedKmh = 1
    timeStart = fullTimeStart
    timeEnd = fullTimeEnd
  }

  function getFilteredFeatures() {
    const start = timeStart ? new Date(timeStart).getTime() : -Infinity
    const end = timeEnd ? new Date(timeEnd).getTime() : Infinity
    const minimumSpeed = numeric(minRideSpeedKmh) ?? 0
    const movingPacketTimes = new Set(
      layerOrder
        .flatMap((id) => data[id]?.features ?? [])
        .filter((feature) => (numeric(feature.properties.avg_speed_kmh_window) ?? -Infinity) >= minimumSpeed)
        .map((feature) => feature.properties.packet_time)
        .filter(Boolean),
    )
    const out: GeoJsonFeature[] = []
    snappedPointCount = 0
    totalPointCount = 0

    for (const layerId of layerOrder) {
      if (!visibleLayers.has(layerId)) continue
      for (const feature of data[layerId]?.features ?? []) {
        const packetTime = feature.properties.packet_time
        if (packetTime && !movingPacketTimes.has(packetTime)) continue

        const t = getTime(feature)
        const millis = t ? new Date(t).getTime() : NaN
        if (Number.isFinite(millis) && (millis < start || millis > end)) continue

        if (layerId !== 'connectors' && layerId !== 'gps') {
          const quality = feature.properties.position_estimation_quality ?? 'unknown_no_previous_heading'
          if (!selectedQualities.has(quality)) continue
          const roughnessClass = getRoughnessClass(feature, layerId)
          if (!selectedClasses.has(roughnessClass)) continue
          const score = getScore(feature, layerId)
          if (score != null && (score < minScore || score > maxScore)) continue
        }

        out.push(prepareFeatureForDisplay(feature, layerId))
      }
    }

    return out
  }

  function prepareFeatureForDisplay(feature: GeoJsonFeature, layerId: LayerId): GeoJsonFeature {
    const cloned: GeoJsonFeature = {
      ...feature,
      geometry: { ...feature.geometry, coordinates: structuredClone(feature.geometry.coordinates) },
      properties: { ...feature.properties, app_layer: layerId },
    }

    if (!snapEnabled || !canSnap || cloned.geometry.type !== 'Point') return cloned
    totalPointCount += 1
    const [lng, lat] = cloned.geometry.coordinates as [number, number]
    const snap = findNearestRoutePoint([lat, lng])
    if (snap && snap.distanceM <= snapMaxDistanceM) {
      snappedPointCount += 1
      cloned.geometry.coordinates = [snap.point[1], snap.point[0]]
      cloned.properties.snap_original_longitude = lng
      cloned.properties.snap_original_latitude = lat
      cloned.properties.snap_distance_m = Math.round(snap.distanceM * 10) / 10
      cloned.properties.snap_method = 'nearest point on user-provided route'
    }
    return cloned
  }

  function renderMap() {
    featureLayer.clearLayers()
    routeLayer.clearLayers()
    drawRoutes()

    const bounds = L.latLngBounds([])
    for (const feature of currentFeatures) {
      const layerId = (feature.properties.app_layer ?? 'bucket') as LayerId
      if (feature.geometry.type === 'LineString') {
        const latlngs = (feature.geometry.coordinates as [number, number][]).map(([lng, lat]) => [lat, lng] as [number, number])
        if (latlngs.length > 1) {
          const line = L.polyline(latlngs, {
            color: '#111827',
            weight: 1.5,
            opacity: 0.48,
            dashArray: '5 7',
          }).bindPopup(popupHtml(feature, layerId))
          line.addTo(featureLayer)
          latlngs.forEach((latlng) => bounds.extend(latlng))
        }
        continue
      }

      if (feature.geometry.type === 'Point') {
        const [lng, lat] = feature.geometry.coordinates as [number, number]
        const score = getScore(feature, layerId)
        const roughnessClass = getRoughnessClass(feature, layerId)
        const quality = feature.properties.position_estimation_quality
        const marker = L.circleMarker([lat, lng], {
          radius: layerId === 'packet' ? 8 : layerId === 'gps' ? 4 : 6,
          weight: layerId === 'packet' ? 2 : 1.4,
          color: layerId === 'gps' ? '#101820' : '#ffffff',
          fillColor: layerId === 'gps' ? '#101820' : colorForScore(score, roughnessClass),
          fillOpacity: layerId === 'gps' ? 0.8 : qualityOpacity[quality] ?? 0.82,
          opacity: layerId === 'gps' ? 0.75 : 0.95,
        }).bindPopup(popupHtml(feature, layerId))
        marker.addTo(featureLayer)
        bounds.extend([lat, lng])
      }
    }

    if (!hasFitted && bounds.isValid()) {
      map.fitBounds(bounds.pad(0.18))
      hasFitted = true
    }
  }

  function drawRoutes() {
    for (const route of allRoutes()) {
      if (route.length < 2) continue
      L.polyline(route, { color: '#0f766e', weight: 4, opacity: 0.8 }).addTo(routeLayer)
    }
    if (manualRoute.length) {
      for (const latlng of manualRoute) {
        L.circleMarker(latlng, { radius: 4, color: '#0f766e', fillColor: '#ccfbf1', fillOpacity: 1, weight: 2 }).addTo(routeLayer)
      }
    }
  }

  function allRoutes() {
    const routes = [...uploadedRoutes]
    if (manualRoute.length > 1) routes.push(manualRoute)
    return routes
  }

  function getTime(feature: GeoJsonFeature) {
    return feature.properties.estimated_bucket_center_time ?? feature.properties.packet_time ?? ''
  }

  function getScore(feature: GeoJsonFeature, layerId: LayerId): number | null {
    const p = feature.properties
    if (scoreMetric === 'roughness') {
      if (layerId === 'packet') return numeric(packetRoughnessMode === 'max' ? p.roughness_proxy_0_1_window_max : p.roughness_proxy_0_1_window_mean)
      return numeric(p.roughness_proxy_0_1)
    }
    if (scoreMetric === 'rms') {
      if (layerId === 'packet') return numeric(p.vertical_accel_rms_g_window_rms_combined)
      return numeric(p.vertical_accel_rms_g)
    }
    if (scoreMetric === 'peak') {
      if (layerId === 'packet') return numeric(p.vertical_accel_peak_g_window_max)
      return numeric(p.vertical_accel_peak_g)
    }
    if (scoreMetric === 'vibration') {
      if (layerId === 'packet') return numeric(p.vibration_hit_rate_pct_window_mean)
      return numeric(p.vibration_hit_rate_pct)
    }
    return numeric(p.avg_speed_kmh_window)
  }

  function getRoughnessClass(feature: GeoJsonFeature, layerId: LayerId) {
    const p = feature.properties
    const named = layerId === 'packet' ? p.roughness_proxy_class_window_max : p.roughness_proxy_class
    if (named) return named
    const score = getScore(feature, layerId)
    if (score == null) return 'low roughness'
    if (score < 0.25) return 'low roughness'
    if (score < 0.5) return 'moderate roughness'
    if (score < 0.75) return 'high roughness'
    return 'very high roughness'
  }

  function colorForScore(score: number | null, roughnessClass: string) {
    if (scoreMetric === 'roughness') {
      if (roughnessClass === 'very high roughness') return '#d7191c'
      if (roughnessClass === 'high roughness') return '#f97316'
      if (roughnessClass === 'moderate roughness') return '#facc15'
      return '#22c55e'
    }
    if (score == null) return '#64748b'
    const normalized = Math.max(0, Math.min(1, (score - minScore) / Math.max(0.0001, maxScore - minScore)))
    if (normalized > 0.8) return '#d7191c'
    if (normalized > 0.58) return '#f97316'
    if (normalized > 0.35) return '#facc15'
    return '#22c55e'
  }

  function popupHtml(feature: GeoJsonFeature, layerId: LayerId) {
    const p = feature.properties
    const rows: [string, any][] = [
      ['Layer', dataSources[layerId].label],
      ['Time', getTime(feature)],
      ['Bucket', p.bucket_index != null ? `${p.bucket_index} (${p.bucket_order})` : null],
      ['Roughness', fmt(layerId === 'packet' ? p.roughness_proxy_0_1_window_max : p.roughness_proxy_0_1)],
      ['Class', getRoughnessClass(feature, layerId)],
      ['RMS g', fmt(layerId === 'packet' ? p.vertical_accel_rms_g_window_rms_combined : p.vertical_accel_rms_g)],
      ['Peak g', fmt(layerId === 'packet' ? p.vertical_accel_peak_g_window_max : p.vertical_accel_peak_g)],
      ['Vibration %', fmt(layerId === 'packet' ? p.vibration_hit_rate_pct_window_mean : p.vibration_hit_rate_pct)],
      ['Avg speed km/h', fmt(p.avg_speed_kmh_window)],
      ['Position quality', p.position_estimation_quality ? qualityLabels[p.position_estimation_quality] ?? p.position_estimation_quality : null],
      ['Interpolation gap s', fmt(p.interpolation_gap_s)],
      ['Snap distance m', fmt(p.snap_distance_m)],
    ]
    return `<div class="popup"><h3>${escapeHtml(dataSources[layerId].label)}</h3>${rows
      .filter(([, value]) => value != null && value !== '')
      .map(([label, value]) => `<p><strong>${escapeHtml(label)}:</strong> ${escapeHtml(String(value))}</p>`)
      .join('')}</div>`
  }

  function buildStats(features: GeoJsonFeature[]) {
    const pointFeatures = features.filter((feature) => feature.geometry.type === 'Point')
    const scores = pointFeatures.map((feature) => getScore(feature, feature.properties.app_layer)).filter((x): x is number => x != null)
    const classes = Object.fromEntries(classOrder.map((className) => [className, 0])) as Record<string, number>
    const qualities = Object.fromEntries(qualityOrder.map((quality) => [quality, 0])) as Record<string, number>
    for (const feature of pointFeatures) {
      const layerId = feature.properties.app_layer as LayerId
      classes[getRoughnessClass(feature, layerId)] = (classes[getRoughnessClass(feature, layerId)] ?? 0) + 1
      const q = feature.properties.position_estimation_quality
      if (q) qualities[q] = (qualities[q] ?? 0) + 1
    }
    return {
      count: features.length,
      points: pointFeatures.length,
      min: scores.length ? Math.min(...scores) : null,
      max: scores.length ? Math.max(...scores) : null,
      avg: scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : null,
      classes,
      qualities,
    }
  }

  function downloadFilteredGeoJson() {
    const collection: FeatureCollection = { type: 'FeatureCollection', features: currentFeatures }
    downloadBlob(JSON.stringify(collection, null, 2), 'group3-bike-comfort-filtered.geojson', 'application/geo+json')
  }

  function downloadFilteredCsv() {
    const rows = currentFeatures
      .filter((feature) => feature.geometry.type === 'Point')
      .map((feature) => {
        const [lng, lat] = feature.geometry.coordinates as [number, number]
        const layerId = feature.properties.app_layer as LayerId
        return {
          layer: layerId,
          time: getTime(feature),
          longitude: lng,
          latitude: lat,
          score: getScore(feature, layerId),
          roughness_class: getRoughnessClass(feature, layerId),
          position_quality: feature.properties.position_estimation_quality ?? '',
          vertical_accel_rms_g: layerId === 'packet' ? feature.properties.vertical_accel_rms_g_window_rms_combined : feature.properties.vertical_accel_rms_g,
          vertical_accel_peak_g: layerId === 'packet' ? feature.properties.vertical_accel_peak_g_window_max : feature.properties.vertical_accel_peak_g,
          vibration_hit_rate_pct: layerId === 'packet' ? feature.properties.vibration_hit_rate_pct_window_mean : feature.properties.vibration_hit_rate_pct,
          avg_speed_kmh_window: feature.properties.avg_speed_kmh_window,
          snap_distance_m: feature.properties.snap_distance_m ?? '',
        }
      })
    const headers = Object.keys(rows[0] ?? { layer: '', time: '', longitude: '', latitude: '' })
    const csv = [headers.join(','), ...rows.map((row) => headers.map((header) => csvCell((row as any)[header])).join(','))].join('\n')
    downloadBlob(csv, 'group3-bike-comfort-filtered.csv', 'text/csv')
  }

  function downloadRouteGeoJson() {
    const features = allRoutes().map((route, index) => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: route.map(([lat, lng]) => [lng, lat]) },
      properties: { route_index: index + 1, source: index < uploadedRoutes.length ? 'uploaded' : 'manual' },
    }))
    downloadBlob(JSON.stringify({ type: 'FeatureCollection', features }, null, 2), 'group3-bike-comfort-snap-route.geojson', 'application/geo+json')
  }

  function downloadBlob(body: string, name: string, type: string) {
    const blob = new Blob([body], { type })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    URL.revokeObjectURL(url)
  }

  async function uploadRoute(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    const parsed = JSON.parse(await file.text())
    const routes = extractRoutes(parsed)
    uploadedRoutes = [...uploadedRoutes, ...routes]
    input.value = ''
  }

  function extractRoutes(value: any): [number, number][][] {
    if (!value) return []
    if (value.type === 'FeatureCollection') return value.features.flatMap(extractRoutes)
    if (value.type === 'Feature') return extractRoutes(value.geometry)
    if (value.type === 'LineString') return [value.coordinates.map(([lng, lat]: [number, number]) => [lat, lng])]
    if (value.type === 'MultiLineString') return value.coordinates.map((line: [number, number][]) => line.map(([lng, lat]) => [lat, lng]))
    return []
  }

  function clearRoutes() {
    manualRoute = []
    uploadedRoutes = []
    snapEnabled = false
  }

  function undoManualRoutePoint() {
    manualRoute = manualRoute.slice(0, -1)
  }

  function findNearestRoutePoint(point: [number, number]) {
    let best: { point: [number, number]; distanceM: number } | null = null
    for (const route of allRoutes()) {
      for (let i = 0; i < route.length - 1; i += 1) {
        const candidate = nearestPointOnSegment(point, route[i], route[i + 1])
        if (!best || candidate.distanceM < best.distanceM) best = candidate
      }
    }
    return best
  }

  function nearestPointOnSegment(p: [number, number], a: [number, number], b: [number, number]) {
    const originLat = p[0]
    const pp = projectMeters(p, originLat)
    const aa = projectMeters(a, originLat)
    const bb = projectMeters(b, originLat)
    const abx = bb.x - aa.x
    const aby = bb.y - aa.y
    const denom = abx * abx + aby * aby || 1
    const t = Math.max(0, Math.min(1, ((pp.x - aa.x) * abx + (pp.y - aa.y) * aby) / denom))
    const x = aa.x + abx * t
    const y = aa.y + aby * t
    const nearest: [number, number] = unprojectMeters({ x, y }, originLat)
    return { point: nearest, distanceM: Math.hypot(pp.x - x, pp.y - y) }
  }

  function projectMeters([lat, lng]: [number, number], originLat: number) {
    const r = 6371000
    return {
      x: (lng * Math.PI / 180) * r * Math.cos(originLat * Math.PI / 180),
      y: (lat * Math.PI / 180) * r,
    }
  }

  function unprojectMeters({ x, y }: { x: number; y: number }, originLat: number): [number, number] {
    const r = 6371000
    return [y / r * 180 / Math.PI, x / (r * Math.cos(originLat * Math.PI / 180)) * 180 / Math.PI]
  }

  function toDatetimeLocal(iso: string, rounding: 'floor' | 'ceil') {
    const date = new Date(iso)
    if (rounding === 'floor') {
      date.setSeconds(0, 0)
    } else if (date.getSeconds() || date.getMilliseconds()) {
      date.setMinutes(date.getMinutes() + 1, 0, 0)
    }
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  function numeric(value: any): number | null {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }

  function fmt(value: any) {
    const n = numeric(value)
    if (n == null) return value ?? ''
    if (Math.abs(n) >= 100) return n.toFixed(0)
    if (Math.abs(n) >= 10) return n.toFixed(1)
    return n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
  }

  function escapeHtml(value: string) {
    return value.replace(/[&<>'"]/g, (char) => ({ '&': '&#38;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]!)
  }

  function csvCell(value: any) {
    if (value == null) return ''
    const s = String(value)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
</script>

<svelte:head>
  <title>Group 3 Bike Comfort Map</title>
  <meta name="description" content="Interactive map for Group 3 Seeeduino LoRaWAN cycling comfort and road damage data." />
</svelte:head>

<div class="app-shell">
  <aside class="panel">
    <section class="intro card">
      <p class="eyebrow">Group 3 · Seeeduino LoRaWAN</p>
      <h1>Bike comfort map</h1>
      <p>
        Explore sampled cycling comfort / road-damage points from FROST exports. Estimated bucket points are useful for route-shaped maps;
        packet windows keep the original GPS positions.
      </p>
    </section>

    {#if loadError}
      <section class="card error">Could not load bundled GeoJSON: {loadError}</section>
    {:else if isLoading}
      <section class="card">Loading bundled ride data…</section>
    {/if}

    <section class="card controls">
      <h2>Layers</h2>
      {#each layerOrder as id}
        <label class="check-row">
          <input type="checkbox" checked={visibleLayers.has(id)} onchange={() => toggleLayer(id)} />
          <span>
            <strong>{dataSources[id].label}</strong>
            <small>{dataSources[id].help}</small>
          </span>
        </label>
      {/each}
    </section>

    <section class="card controls two-col">
      <h2>Color and score</h2>
      <label>
        Score metric
        <select bind:value={scoreMetric}>
          <option value="roughness">Roughness proxy / compound comfort score</option>
          <option value="rms">Vertical acceleration RMS</option>
          <option value="peak">Acceleration peak</option>
          <option value="vibration">Vibration hit-rate</option>
          <option value="speed">Average speed</option>
        </select>
      </label>
      <label>
        Packet roughness
        <select bind:value={packetRoughnessMode} disabled={scoreMetric !== 'roughness'}>
          <option value="max">Window max</option>
          <option value="mean">Window mean</option>
        </select>
      </label>
      <label>
        Min score
        <input type="number" step="0.01" bind:value={minScore} />
      </label>
      <label>
        Max score
        <input type="number" step="0.01" bind:value={maxScore} />
      </label>
      <div class="legend" aria-label="Color legend">
        <span class="low">low</span><span class="moderate">moderate</span><span class="high">high</span><span class="very-high">very high</span>
      </div>
    </section>

    <section class="card controls">
      <h2>Filters</h2>
      <div class="button-row">
        <button type="button" onclick={selectAllQualities}>All quality</button>
        <button type="button" onclick={selectTrustedQualities}>Good only</button>
        <button type="button" onclick={selectAllClasses}>All classes</button>
      </div>
      <div class="pill-grid">
        {#each qualityOrder as quality}
          <label class:muted={!selectedQualities.has(quality)}>
            <input type="checkbox" checked={selectedQualities.has(quality)} onchange={() => toggleQuality(quality)} />
            {qualityLabels[quality]}
          </label>
        {/each}
      </div>
      <div class="pill-grid roughness-grid">
        {#each classOrder as className}
          <label class:muted={!selectedClasses.has(className)}>
            <input type="checkbox" checked={selectedClasses.has(className)} onchange={() => toggleClass(className)} />
            {className.replace(' roughness', '')}
          </label>
        {/each}
      </div>
      <label>
        Start time
        <input type="datetime-local" bind:value={timeStart} />
      </label>
      <label>
        End time
        <input type="datetime-local" bind:value={timeEnd} />
      </label>
      <label>
        Minimum ride speed (km/h)
        <input type="number" min="0" step="0.1" bind:value={minRideSpeedKmh} />
        <small>Defaults to 1 km/h to hide stationary packet windows from every layer and export.</small>
      </label>
      <button type="button" onclick={resetFilters}>Reset view</button>
    </section>

    <section class="card controls snap-card">
      <h2>Route snap lab</h2>
      <p>
        For multiple rides, use separate uploaded/manual route lines. Snapping only moves displayed points to the nearest route segment within the chosen distance;
        it does not connect different rides into one continuous route.
      </p>
      <label class="check-row">
        <input type="checkbox" bind:checked={routeEditMode} />
        <span><strong>Click map to draw a route</strong><small>Use when you know the ride line better than the packet GPS.</small></span>
      </label>
      <input class="hidden-input" bind:this={fileInput} type="file" accept=".geojson,.json,application/geo+json,application/json" onchange={uploadRoute} />
      <div class="button-row">
        <button type="button" onclick={() => fileInput.click()}>Upload route GeoJSON</button>
        <button type="button" onclick={undoManualRoutePoint} disabled={!manualRoute.length}>Undo point</button>
        <button type="button" onclick={clearRoutes} disabled={!routePointCount}>Clear routes</button>
      </div>
      <label>
        Snap distance: {snapMaxDistanceM} m
        <input type="range" min="5" max="120" step="5" bind:value={snapMaxDistanceM} />
      </label>
      <label class="check-row">
        <input type="checkbox" bind:checked={snapEnabled} disabled={!canSnap} />
        <span><strong>Snap points to route</strong><small>{canSnap ? `${snappedPointCount}/${totalPointCount} points snapped` : 'Draw or upload a route first'}</small></span>
      </label>
    </section>

    <section class="card stats-card">
      <h2>Current selection</h2>
      <div class="stat-grid">
        <div><strong>{stats.count}</strong><span>features</span></div>
        <div><strong>{stats.points}</strong><span>points</span></div>
        <div><strong>{fmt(stats.avg)}</strong><span>avg score</span></div>
        <div><strong>{fmt(stats.max)}</strong><span>max score</span></div>
      </div>
      <div class="compact-list">
        {#each classOrder as className}
          <span>{className.replace(' roughness', '')}: {stats.classes[className] ?? 0}</span>
        {/each}
      </div>
      <div class="button-row exports">
        <button type="button" onclick={downloadFilteredGeoJson} disabled={!currentFeatures.length}>Download filtered GeoJSON</button>
        <button type="button" onclick={downloadFilteredCsv} disabled={!currentFeatures.length}>Download CSV</button>
        <button type="button" onclick={downloadRouteGeoJson} disabled={!routeLineCount}>Download snap route</button>
        <button type="button" onclick={() => window.print()}>Print / save map</button>
      </div>
    </section>

    <section class="card note-card">
      <h2>Read before presenting</h2>
      <ul>
        <li>The map shows sampled LoRaWAN uplinks, not continuous route coverage.</li>
        <li>Estimated bucket points use speed back-projection from one GPS coordinate per packet; weak/poor headings are transparent.</li>
        <li>Packet windows are conservative: real GPS only, two bucket measurements in properties.</li>
        <li>Stationary packet windows below 1 km/h are hidden by default; the minimum ride speed filter is adjustable.</li>
        <li>The roughness proxy is relative and ISO-2631-inspired, not ISO-compliant.</li>
        <li>Bundled data includes the June 27 and July 2 rides; each ride was exported separately to avoid cross-ride position estimation.</li>
      </ul>
    </section>
  </aside>

  <main class="map-stage">
    <div class="map-toolbar">
      <div>
        <strong>{visibleLayers.size} layer{visibleLayers.size === 1 ? '' : 's'} active</strong>
        <span>{currentFeatures.length} filtered features</span>
      </div>
      <div>
        <span>OSM tiles · static GitHub Pages app</span>
      </div>
    </div>
    <div class="map" bind:this={mapEl}></div>
  </main>
</div>
