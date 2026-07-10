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
    properties?: Record<string, any>
  }

  type LayerId = 'bucket' | 'packet' | 'gps' | 'connectors'
  type ScoreMetric = 'roughness' | 'rms' | 'comfort' | 'peak' | 'vibration' | 'speed'
  type RouteDefinition = {
    points: [number, number][]
    rideDate?: string
    label: string
    source: 'reconstructed'
  }

  const reconstructedRouteFiles = [
    '/data/group3-bike-comfort-ride-2026-06-27-reconstructed-route.geojson',
    '/data/group3-bike-comfort-ride-2026-07-02-reconstructed-route.geojson',
  ]
  const snapMaxDistanceM = 35
  let metricColorMax: Record<ScoreMetric, number> = {
    roughness: 1,
    rms: 1,
    comfort: 2.5,
    peak: 1,
    vibration: 100,
    speed: 20,
  }

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

  let mapEl: HTMLDivElement
  let map: L.Map
  let featureLayer = L.layerGroup()
  let routeLayer = L.layerGroup()
  let data: Partial<Record<LayerId, FeatureCollection>> = {}
  let loadError = ''
  let isLoading = true

  let visibleLayers = new Set<LayerId>(['bucket'])
  let scoreMetric: ScoreMetric = 'roughness'
  let hideStationaryPackets = true
  let minRideMaxSpeedKmh = 2
  let showReconstructedRoute = true
  let showColoredSegments = true
  let fillRouteColorGaps = true
  let snapEnabled = false
  let reconstructedRoutes: RouteDefinition[] = []
  let currentFeatures: GeoJsonFeature[] = []
  let snappedPointCount = 0
  let totalPointCount = 0
  let hasFitted = false
  let viewBeforePrint: { center: L.LatLng; zoom: number } | null = null

  $: stats = buildStats(currentFeatures)
  $: routeLineCount = reconstructedRoutes.filter((route) => route.points.length > 1).length
  $: canSnap = routeLineCount > 0
  $: {
    visibleLayers
    scoreMetric
    hideStationaryPackets
    minRideMaxSpeedKmh
    showReconstructedRoute
    showColoredSegments
    fillRouteColorGaps
    snapEnabled
    reconstructedRoutes
    data
    metricColorMax
    if (map && !isLoading) {
      currentFeatures = getFilteredFeatures()
      renderMap()
    }
  }

  onMount(async () => {
    map = L.map(mapEl, { zoomControl: false }).setView([48.1482, 11.5655], 14)
    L.control.zoom({ position: 'bottomright' }).addTo(map)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd',
      maxZoom: 20,
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    }).addTo(map)
    featureLayer.addTo(map)
    routeLayer.addTo(map)
    window.addEventListener('beforeprint', prepareFullRoutePrint)
    window.addEventListener('afterprint', restoreInteractiveView)

    try {
      const [entries, reconstructedRouteCollections] = await Promise.all([
        Promise.all(
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
        ),
        Promise.all(reconstructedRouteFiles.map(async (file) => {
          const response = await fetch(withBase(file))
          if (!response.ok) throw new Error(`${file}: ${response.status}`)
          return response.json() as Promise<FeatureCollection>
        })),
      ])
      data = Object.fromEntries(entries) as Record<LayerId, FeatureCollection>
      metricColorMax = calculateGlobalMetricScales(data.bucket?.features ?? [])
      reconstructedRoutes = reconstructedRouteCollections.flatMap(extractReconstructedRoutes)
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

  function toggleLayer(id: LayerId) {
    const next = new Set(visibleLayers)
    next.has(id) ? next.delete(id) : next.add(id)
    visibleLayers = next
  }

  function resetFilters() {
    visibleLayers = new Set(['bucket'])
    scoreMetric = 'roughness'
    hideStationaryPackets = true
    minRideMaxSpeedKmh = 2
  }

  function getFilteredFeatures() {
    const movingPacketTimes = getMovingPacketTimes()
    const out: GeoJsonFeature[] = []
    snappedPointCount = 0
    totalPointCount = 0

    for (const layerId of layerOrder) {
      if (!visibleLayers.has(layerId)) continue
      for (const feature of data[layerId]?.features ?? []) {
        if (!passesDataCleaning(feature, movingPacketTimes)) continue
        out.push(prepareFeatureForDisplay(feature, layerId))
      }
    }

    return out
  }

  function getMovingPacketTimes() {
    if (!hideStationaryPackets) {
      return new Set(
        layerOrder.flatMap((id) => data[id]?.features ?? []).map((feature) => feature.properties.packet_time).filter(Boolean),
      )
    }
    const minimumSpeed = numeric(minRideMaxSpeedKmh) ?? 0
    return new Set(
      layerOrder
        .flatMap((id) => data[id]?.features ?? [])
        .filter((feature) => (numeric(feature.properties.max_speed_kmh_window) ?? -Infinity) >= minimumSpeed)
        .map((feature) => feature.properties.packet_time)
        .filter(Boolean),
    )
  }

  function passesDataCleaning(feature: GeoJsonFeature, movingPacketTimes: Set<any>) {
    const packetTime = feature.properties.packet_time
    if (packetTime && !movingPacketTimes.has(packetTime)) return false
    return true
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
    const snap = findNearestRoutePoint([lat, lng], cloned.properties.ride_date ?? String(cloned.properties.packet_time ?? '').slice(0, 10))
    if (snap && snap.distanceM <= snapMaxDistanceM) {
      snappedPointCount += 1
      cloned.geometry.coordinates = [snap.point[1], snap.point[0]]
      cloned.properties.snap_original_longitude = lng
      cloned.properties.snap_original_latitude = lat
      cloned.properties.snap_distance_m = Math.round(snap.distanceM * 10) / 10
      cloned.properties.snap_method = 'nearest point on same-date reconstructed route'
    }
    return cloned
  }

  function renderMap() {
    featureLayer.clearLayers()
    routeLayer.clearLayers()
    drawRoutes()
    drawColoredRouteSegments()

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
    for (const route of allRouteDefinitions()) {
      if (route.points.length < 2 || (route.source === 'reconstructed' && !showReconstructedRoute)) continue
      L.polyline(route.points, {
        color: route.source === 'reconstructed' ? '#64748b' : '#0f766e',
        weight: route.source === 'reconstructed' ? 5 : 4,
        opacity: route.source === 'reconstructed' ? 0.62 : 0.9,
        dashArray: route.source === 'reconstructed' ? '7 7' : undefined,
      }).bindPopup(route.source === 'reconstructed'
        ? `<div class="popup"><h3>${escapeHtml(route.label)}</h3><p><strong>Ride:</strong> ${escapeHtml(route.rideDate ?? 'unknown')}</p><p>Approximate screenshot reconstruction; no timestamped phone GPS was available.</p></div>`
        : `<div class="popup"><h3>${escapeHtml(route.label)}</h3></div>`).addTo(routeLayer)
    }
  }

  function drawColoredRouteSegments() {
    for (const feature of getMeasuredSegmentFeatures()) {
      const coordinates = feature.geometry.coordinates as [number, number][]
      const points = coordinates.map(([lng, lat]) => [lat, lng] as [number, number])
      const p = feature.properties
      L.polyline(points, {
        color: colorForScore(p.score_median, p.roughness_class),
        weight: 9,
        opacity: p.color_estimated ? 0.9 : p.position_uncertain ? 0.82 : 1,
        dashArray: !p.color_estimated && p.position_uncertain ? '4 5' : undefined,
      }).bindPopup(`<div class="popup"><h3>${p.color_estimated ? 'Estimated' : 'Measured'} road segment</h3>
        <p><strong>Metric median:</strong> ${escapeHtml(fmt(p.score_median))}</p>
        <p><strong>Samples:</strong> ${p.sample_count}</p>
        <p><strong>Mean match distance:</strong> ${escapeHtml(fmt(p.mean_match_distance_m))} m</p>
        <p><strong>Ride:</strong> ${escapeHtml(p.ride_date)}</p>
        ${p.color_estimated ? '<p><strong>Estimate:</strong> interpolated from the nearest measured route segments.</p>' : ''}
        ${!p.color_estimated && p.position_uncertain ? '<p><strong>Warning:</strong> dashed because all contributing positions have uncertain headings.</p>' : ''}
      </div>`).addTo(routeLayer)
    }
  }

  function getMeasuredSegmentFeatures(): GeoJsonFeature[] {
    if (!showReconstructedRoute || !showColoredSegments) return []
    const movingPacketTimes = getMovingPacketTimes()
    const bucketFeatures = (data.bucket?.features ?? []).filter((feature) => passesDataCleaning(feature, movingPacketTimes))
    const segmentFeatures: GeoJsonFeature[] = []

    for (const route of reconstructedRoutes) {
      const measurements = bucketFeatures.filter((feature) => {
        const rideDate = feature.properties.ride_date ?? String(feature.properties.packet_time ?? '').slice(0, 10)
        return Boolean(route.rideDate) && rideDate === route.rideDate
      })
      const bySegment = new Map<number, { scores: number[]; distances: number[]; qualities: string[] }>()

      for (const feature of measurements) {
        if (feature.geometry.type !== 'Point') continue
        const [lng, lat] = feature.geometry.coordinates as [number, number]
        const match = findNearestPointOnRoute([lat, lng], route.points)
        const score = getScore(feature, 'bucket')
        if (!match || match.distanceM > snapMaxDistanceM || score == null) continue
        const values = bySegment.get(match.segmentIndex) ?? { scores: [], distances: [], qualities: [] }
        values.scores.push(score)
        values.distances.push(match.distanceM)
        values.qualities.push(feature.properties.position_estimation_quality ?? 'unknown_no_previous_heading')
        bySegment.set(match.segmentIndex, values)
      }

      const measuredIndexes = [...bySegment.keys()].sort((a, b) => a - b)
      const segmentIndexes = fillRouteColorGaps && measuredIndexes.length
        ? Array.from({ length: route.points.length - 1 }, (_, index) => index)
        : measuredIndexes

      for (const segmentIndex of segmentIndexes) {
        const directValues = bySegment.get(segmentIndex)
        const lowerIndex = measuredIndexes.findLast((index) => index < segmentIndex)
        const upperIndex = measuredIndexes.find((index) => index > segmentIndex)
        const lowerValues = lowerIndex == null ? undefined : bySegment.get(lowerIndex)
        const upperValues = upperIndex == null ? undefined : bySegment.get(upperIndex)
        const values = directValues ?? lowerValues ?? upperValues
        if (!values) continue

        let score = median(values.scores)
        const sourceValues = directValues ? [directValues] : [lowerValues, upperValues].filter(Boolean) as { scores: number[]; distances: number[]; qualities: string[] }[]
        if (!directValues && lowerValues && upperValues && lowerIndex != null && upperIndex != null) {
          const progress = (segmentIndex - lowerIndex) / (upperIndex - lowerIndex)
          score = median(lowerValues.scores) + (median(upperValues.scores) - median(lowerValues.scores)) * progress
        }
        const allDistances = sourceValues.flatMap((source) => source.distances)
        const allQualities = sourceValues.flatMap((source) => source.qualities)
        const roughnessClass = classForScore(score)
        const meanDistance = allDistances.reduce((sum, value) => sum + value, 0) / allDistances.length
        const uncertain = allQualities.every((quality) => quality !== 'good')
        segmentFeatures.push({
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [route.points[segmentIndex], route.points[segmentIndex + 1]].map(([lat, lng]) => [lng, lat]),
          },
          properties: {
            feature_kind: 'measured_route_segment',
            route_source: route.source,
            route_label: route.label,
            ride_date: route.rideDate,
            score_metric: scoreMetric,
            score_median: score,
            roughness_class: roughnessClass,
            sample_count: sourceValues.reduce((sum, source) => sum + source.scores.length, 0),
            mean_match_distance_m: Math.round(meanDistance * 10) / 10,
            position_uncertain: uncertain,
            color_estimated: !directValues,
            color_source_segment_indexes: directValues ? [segmentIndex] : [lowerIndex, upperIndex].filter((index) => index != null),
            match_max_distance_m: snapMaxDistanceM,
          },
        })
      }
    }
    return segmentFeatures
  }

  function classForScore(score: number) {
    if (score < 0.25) return 'low roughness'
    if (score < 0.5) return 'moderate roughness'
    if (score < 0.75) return 'high roughness'
    return 'very high roughness'
  }

  function median(values: number[]) {
    const sorted = [...values].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
  }

  function percentile(values: number[], pct: number) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
    if (!sorted.length) return 1
    if (sorted.length === 1) return sorted[0]
    const position = (sorted.length - 1) * pct / 100
    const low = Math.floor(position)
    const high = Math.ceil(position)
    return sorted[low] + (sorted[high] - sorted[low]) * (position - low)
  }

  function calculateGlobalMetricScales(features: GeoJsonFeature[]): Record<ScoreMetric, number> {
    const values = (property: string) => features.map((feature) => numeric(feature.properties[property])).filter((value): value is number => value != null)
    return {
      roughness: 1,
      rms: percentile(values('vertical_accel_rms_g'), 90),
      comfort: 2.5,
      peak: percentile(values('vertical_accel_peak_g'), 90),
      vibration: percentile(values('vibration_hit_rate_pct'), 90),
      speed: percentile(values('avg_speed_kmh_window'), 90),
    }
  }

  function allRouteDefinitions(): RouteDefinition[] {
    return reconstructedRoutes
  }

  function getTime(feature: GeoJsonFeature) {
    return feature.properties.estimated_bucket_center_time ?? feature.properties.packet_time ?? ''
  }

  function getScore(feature: GeoJsonFeature, layerId: LayerId): number | null {
    const p = feature.properties
    if (scoreMetric === 'roughness') {
      return getGlobalRoughnessScore(feature, layerId)
    }
    if (scoreMetric === 'rms') {
      if (layerId === 'packet') return numeric(p.vertical_accel_rms_g_window_rms_combined)
      return numeric(p.vertical_accel_rms_g)
    }
    if (scoreMetric === 'comfort') {
      return getComfortScore(feature, layerId)
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

  function getComfortScore(feature: GeoJsonFeature, layerId: LayerId): number | null {
    const p = feature.properties
    const rawRmsMps2 = layerId === 'packet'
      ? numeric(p.vertical_accel_rms_mps2_window_rms_combined_unweighted)
      : numeric(p.vertical_accel_rms_mps2_unweighted)
    const referenceHighMps2 = metricColorMax.rms * 9.80665
    return rawRmsMps2 == null ? null : 2.5 * Math.min(rawRmsMps2 / referenceHighMps2, 1)
  }

  function getGlobalRoughnessScore(feature: GeoJsonFeature, layerId: LayerId): number | null {
    const p = feature.properties
    if (layerId === 'packet') {
      const rmsValues = p.vertical_accel_rms_g_buckets_old_to_new
      const peakValues = p.vertical_accel_peak_g_buckets_old_to_new
      const vibrationValues = p.vibration_hit_rate_pct_buckets_old_to_new
      if (!Array.isArray(rmsValues) || !Array.isArray(peakValues) || !Array.isArray(vibrationValues)) return null
      const scores = rmsValues.map((rms, index) => calculateGlobalRoughnessScore(rms, peakValues[index], vibrationValues[index]))
      return scores.length ? Math.max(...scores) : null
    }
    if (layerId !== 'bucket') return null
    return calculateGlobalRoughnessScore(p.vertical_accel_rms_g, p.vertical_accel_peak_g, p.vibration_hit_rate_pct)
  }

  function calculateGlobalRoughnessScore(rmsValue: any, peakValue: any, vibrationValue: any): number {
    const rms = numeric(rmsValue) ?? 0
    const peak = numeric(peakValue) ?? 0
    const vibration = numeric(vibrationValue) ?? 0
    const rmsNorm = Math.min(1, rms / metricColorMax.rms)
    const peakNorm = Math.min(1, peak / metricColorMax.peak)
    const crestNorm = rms > 0 ? Math.max(0, Math.min(1, (peak / rms - 3) / 6)) : 0
    return Math.min(1, 0.7 * rmsNorm + 0.2 * Math.max(peakNorm, crestNorm) + 0.1 * Math.min(1, vibration / 100))
  }

  function getRoughnessClass(feature: GeoJsonFeature, layerId: LayerId) {
    const score = getGlobalRoughnessScore(feature, layerId)
    if (score == null) return 'low roughness'
    return classForScore(score)
  }

  function colorForScore(score: number | null, roughnessClass: string) {
    if (scoreMetric === 'roughness') {
      if (roughnessClass === 'very high roughness') return '#d7191c'
      if (roughnessClass === 'high roughness') return '#f97316'
      if (roughnessClass === 'moderate roughness') return '#facc15'
      return '#22c55e'
    }
    if (score == null) return '#64748b'
    if (scoreMetric === 'comfort') {
      if (score > 1.25) return '#d7191c'
      if (score > 0.63) return '#f97316'
      if (score > 0.315) return '#facc15'
      return '#22c55e'
    }
    const normalized = Math.max(0, Math.min(1, score / metricColorMax[scoreMetric]))
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
      ['Global roughness', fmt(getGlobalRoughnessScore(feature, layerId))],
      ['Class', getRoughnessClass(feature, layerId)],
      ['RMS g', fmt(layerId === 'packet' ? p.vertical_accel_rms_g_window_rms_combined : p.vertical_accel_rms_g)],
      ['Relative comfort proxy (0–2.5)', fmt(getComfortScore(feature, layerId))],
      ['Raw unweighted RMS m/s²', fmt(layerId === 'packet' ? p.vertical_accel_rms_mps2_window_rms_combined_unweighted : p.vertical_accel_rms_mps2_unweighted)],
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
    for (const feature of pointFeatures) {
      const layerId = feature.properties.app_layer as LayerId
      classes[getRoughnessClass(feature, layerId)] = (classes[getRoughnessClass(feature, layerId)] ?? 0) + 1
    }
    return {
      count: features.length,
      points: pointFeatures.length,
      min: scores.length ? Math.min(...scores) : null,
      max: scores.length ? Math.max(...scores) : null,
      avg: scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : null,
      classes,
    }
  }

  function prepareFullRoutePrint() {
    if (!map || !reconstructedRoutes.length) return
    if (!viewBeforePrint) viewBeforePrint = { center: map.getCenter(), zoom: map.getZoom() }
    const bounds = L.latLngBounds(reconstructedRoutes.flatMap((route) => route.points))
    map.invalidateSize({ animate: false })
    map.fitBounds(bounds, { animate: false, padding: [48, 48] })
  }

  function restoreInteractiveView() {
    if (!viewBeforePrint) return
    const view = viewBeforePrint
    viewBeforePrint = null
    requestAnimationFrame(() => {
      map.invalidateSize({ animate: false })
      map.setView(view.center, view.zoom, { animate: false })
    })
  }

  function printFullRouteMap() {
    prepareFullRoutePrint()
    window.setTimeout(() => window.print(), 250)
  }

  function extractRoutes(value: any): [number, number][][] {
    if (!value) return []
    if (value.type === 'FeatureCollection') return value.features.flatMap(extractRoutes)
    if (value.type === 'Feature') return extractRoutes(value.geometry)
    if (value.type === 'LineString') return [value.coordinates.map(([lng, lat]: [number, number]) => [lat, lng])]
    if (value.type === 'MultiLineString') return value.coordinates.map((line: [number, number][]) => line.map(([lng, lat]) => [lat, lng]))
    return []
  }

  function extractReconstructedRoutes(collection: FeatureCollection): RouteDefinition[] {
    return collection.features.flatMap((feature, featureIndex) => {
      const properties = { ...collection.properties, ...feature.properties }
      return extractRoutes(feature.geometry).map((rawPoints, routeIndex) => {
        let points = rawPoints
        if (properties.ride_date === '2026-06-27') {
          const cornerMatches = points
            .map(([lat, lng], index) => lat === 48.155748 && lng === 11.573279 ? index : -1)
            .filter((index) => index >= 0)
          if (cornerMatches.length === 2) {
            points = [...points.slice(0, cornerMatches[0] + 1), ...points.slice(cornerMatches[1] + 1)]
          }
        }
        return {
          points,
          rideDate: properties.ride_date,
          label: properties.label ?? `Reconstructed route ${featureIndex + 1}.${routeIndex + 1}`,
          source: 'reconstructed' as const,
        }
      })
    })
  }

  function findNearestRoutePoint(point: [number, number], rideDate?: string) {
    let best: { point: [number, number]; distanceM: number; segmentIndex: number } | null = null
    for (const route of allRouteDefinitions()) {
      if (route.source === 'reconstructed' && route.rideDate !== rideDate) continue
      const candidate = findNearestPointOnRoute(point, route.points)
      if (candidate && (!best || candidate.distanceM < best.distanceM)) best = candidate
    }
    return best
  }

  function findNearestPointOnRoute(point: [number, number], route: [number, number][]) {
    let best: { point: [number, number]; distanceM: number; segmentIndex: number } | null = null
    for (let i = 0; i < route.length - 1; i += 1) {
      const candidate = { ...nearestPointOnSegment(point, route[i], route[i + 1]), segmentIndex: i }
      if (!best || candidate.distanceM < best.distanceM) best = candidate
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
      <label class="check-row">
        <input type="checkbox" bind:checked={showReconstructedRoute} />
        <span><strong>Reconstructed ride routes</strong><small>Approximate June 27 and July 2 routes reconstructed from phone screenshots and OSM routing.</small></span>
      </label>
      <label class="check-row">
        <input type="checkbox" bind:checked={showColoredSegments} disabled={!showReconstructedRoute} />
        <span><strong>Colored measured segments</strong><small><a href="https://pmc.ncbi.nlm.nih.gov/articles/PMC12526540/" target="_blank" rel="noreferrer">Cycling comfort mapping research</a> supports road-segment summaries; evidence-only mode requires a nearby same-ride measurement.</small></span>
      </label>
      <label class="check-row">
        <input type="checkbox" bind:checked={fillRouteColorGaps} disabled={!showReconstructedRoute || !showColoredSegments} />
        <span><strong>Estimate colors around full route</strong><small>Fills unmeasured sections by interpolating the nearest same-ride segment colors; disable for evidence-only coloring.</small></span>
      </label>
      <label class="check-row">
        <input type="checkbox" bind:checked={snapEnabled} disabled={!canSnap} />
        <span><strong>Snap points to reconstructed routes</strong><small>{snapEnabled ? `${snappedPointCount}/${totalPointCount} visible points snapped` : 'Show original point positions'}</small></span>
      </label>
    </section>

    <section class="card controls">
      <h2>Color and score</h2>
      <label>
        Score metric
        <select bind:value={scoreMetric}>
          <option value="roughness">Roughness proxy / compound comfort score</option>
          <option value="rms">Vertical acceleration RMS</option>
          <option value="comfort">Relative comfort proxy (0–2.5)</option>
          <option value="peak">Acceleration peak</option>
          <option value="vibration">Vibration hit-rate</option>
          <option value="speed">Average speed</option>
        </select>
        {#if scoreMetric === 'roughness'}
          <small>Project heuristic (70% RMS, 20% shock, 10% hit-rate), normalized once across both rides; it is inspired by <a href="https://www.iso.org/obp/ui/#iso:std:iso:2631:-1:ed-2:v1:en" target="_blank" rel="noreferrer">ISO 2631-1</a> but not standards-compliant.</small>
        {:else if scoreMetric === 'rms'}
          <small>This shows raw unweighted RMS on one global 0–{fmt(metricColorMax.rms)} g p90 color scale calculated across both rides.</small>
        {:else if scoreMetric === 'comfort'}
          <small>This relative index uses 2.5 × min(raw RMS / {fmt(metricColorMax.rms * 9.80665)} m/s², 1), where the reference is the global p90 across both rides. Its bands echo <a href="https://pmc.ncbi.nlm.nih.gov/articles/PMC11134141/" target="_blank" rel="noreferrer">ISO 2631 comfort ranges</a>, but it is not an ISO assessment.</small>
        {:else if scoreMetric === 'peak'}
          <small><a href="https://www.iso.org/obp/ui/#iso:std:iso:2631:-1:ed-2:v1:en" target="_blank" rel="noreferrer">ISO 2631-1</a> calls for additional evaluation of high-crest-factor vibration; this map’s simple peak is only a shock indicator.</small>
        {:else if scoreMetric === 'vibration'}
          <small>SW-420 hit-rate is a project-specific event-density heuristic and is not an ISO 2631 comfort quantity.</small>
        {:else}
          <small>Speed is context rather than an ISO comfort measure, but <a href="https://doi.org/10.3390/s24227210" target="_blank" rel="noreferrer">cycling roughness research</a> identifies it as a key influence on measured vibration.</small>
        {/if}
      </label>
      <div class="legend" aria-label="Color legend">
        {#if scoreMetric === 'comfort'}
          <span class="low">≤0.315</span><span class="moderate">0.315–0.63</span><span class="high">0.63–1.25</span><span class="very-high">≥1.25</span>
        {:else}
          <span class="low">low</span><span class="moderate">moderate</span><span class="high">high</span><span class="very-high">very high</span>
        {/if}
      </div>
    </section>

    <section class="card controls">
      <h2>Data cleaning</h2>
      <label class="check-row">
        <input type="checkbox" bind:checked={hideStationaryPackets} />
        <span><strong>Hide low-speed packets</strong><small>Disable this refinement to restore all raw packet windows.</small></span>
      </label>
      <label>
        Minimum packet max speed (km/h)
        <input type="number" min="0" step="0.1" bind:value={minRideMaxSpeedKmh} disabled={!hideStationaryPackets} />
        <small>The 2 km/h default removes a packet only when its maximum—not average—speed stays below the threshold; this is a project cleaning rule, not ISO 2631-1.</small>
      </label>
      <button type="button" onclick={resetFilters}>Reset view</button>
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
      <div class="button-row print-actions">
        <button type="button" onclick={printFullRouteMap} disabled={!routeLineCount}>Print / save full map</button>
      </div>
    </section>
  </aside>

  <main class="map-stage">
    <div class="map-toolbar">
      <div>
        <strong>{visibleLayers.size} layer{visibleLayers.size === 1 ? '' : 's'} active</strong>
        <span>{currentFeatures.length} filtered features</span>
      </div>
    </div>
    <div class="map" bind:this={mapEl}></div>
  </main>
</div>
