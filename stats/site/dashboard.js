const grid = document.querySelector("#metric-grid")
const status = document.querySelector("#status")
const windowButtons = [...document.querySelectorAll("[data-window]")]
const navigator_ = document.querySelector("#hour-navigator")
const previousButton = document.querySelector("#nav-previous")
const liveButton = document.querySelector("#nav-live")
const nextButton = document.querySelector("#nav-next")

// Every accepted window id, its button label, and its hour count. The single
// source of truth for range-label text and the 336-hour lookback math below.
const WINDOWS = {
  "1h": { label: "1 hour", hours: 1 },
  "4h": { label: "4 hours", hours: 4 },
  "24h": { label: "24 hours", hours: 24 },
  "7d": { label: "7 days", hours: 168 },
}
const MAX_LOOKBACK_HOURS = 336
const HOUR_MILLISECONDS = 3_600_000
const HOUR_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/

// { windowId, end } -- end is an exact-hour ISO string for a fixed anchor, or
// null for live/current. This is the entire public-safe state that round-trips
// through the URL via history.replaceState; nothing here is a credential.
let state = { windowId: "24h", end: null }
let activeRequest = null

const floorToHour = (date) => new Date(Math.floor(date.getTime() / HOUR_MILLISECONDS) * HOUR_MILLISECONDS)

const deepestAnchorMillis = (windowId, now) =>
  floorToHour(now).getTime() - (MAX_LOOKBACK_HOURS - WINDOWS[windowId].hours) * HOUR_MILLISECONDS

const parseStateFromLocation = () => {
  const parameters = new URLSearchParams(window.location.search)
  const windowId = parameters.get("window")
  const end = parameters.get("end")
  return {
    windowId: Object.hasOwn(WINDOWS, windowId) ? windowId : "24h",
    end: end && HOUR_TIMESTAMP.test(end) ? end : null,
  }
}

const syncUrl = () => {
  const parameters = new URLSearchParams({ window: state.windowId })
  if (state.end) parameters.set("end", state.end)
  history.replaceState(null, "", `?${parameters.toString()}`)
}

const clampStateToWindow = () => {
  if (!state.end) return
  const now = new Date()
  const deepest = deepestAnchorMillis(state.windowId, now)
  const live = floorToHour(now).getTime()
  const anchor = new Date(state.end).getTime()
  if (anchor < deepest) state.end = new Date(deepest).toISOString()
  else if (anchor > live) state.end = new Date(live).toISOString()
}

// Joins words with U+00A0 so a laid-out line can never end on one stranded
// word. The layout gate measures real line boxes and fails when it does.
const NON_BREAKING = (text) => text.replaceAll(" ", "\u00A0")

const formatValue = (series, value) => {
  if (!Number.isFinite(value)) return "no samples"
  if (series.unit === "milliseconds") return `${value.toFixed(value >= 100 ? 0 : 1)} ms`
  if (series.unit === "percent") return `${value.toFixed(value >= 10 ? 1 : 2)}%`
  return Math.round(value).toLocaleString()
}

const formatUtc = (iso) => new Date(iso).toISOString().replace("T", " ").replace(".000Z", " UTC")

// Readout placement. The readout tracks the marker horizontally and lives in
// its own band directly beneath the plot, so it cannot cover the value it
// reports -- not by a gap that happens to be big enough, but by construction.
//
// Overlaying it inside the plot was the first attempt and it does not fit here.
// These sparklines paint a 640x180 viewBox into roughly 90 CSS pixels of height
// on a phone, and a readout of about 30 pixels plus a gap simply has nowhere to
// go for a marker sitting mid-field: measured, it covered the marker on 12 of
// 24 points at 320 wide and 5 of 24 at 375. The tall uxuiai terrain has the
// room for an overlay; a sparkline in a card does not, and forcing the same
// treatment onto both would be a shape copied rather than a problem solved.
//
// The offset is measured from the MARKER's own client rect rather than from
// viewBox proportions, because this svg preserves its aspect ratio and is also
// capped by `max-height`, so the painted box is not a simple scale of the
// viewBox and a proportional mapping drifts the moment that cap engages.
//
// Unanimated on purpose: a readout that eases toward a moving pointer reads as
// lag, and it would then owe `prefers-reduced-motion` a second code path.
// The band is reserved in CSS (`figure` pads the bottom, the readout pins to
// it), so `left` is the only value this has to drive.
const placeReadout = (readout, figure, marker) => {
  const field = figure.getBoundingClientRect()
  const dot = marker.getBoundingClientRect()
  const box = readout.getBoundingClientRect()
  if (!field.width || !dot.width || !box.width) return

  const pointX = dot.x + dot.width / 2 - field.x
  readout.style.left = `${Math.min(Math.max(pointX - box.width / 2, 0), Math.max(field.width - box.width, 0))}px`
}

// A root text-size change can widen the readout without changing the selected
// marker. Observe both boxes so the saved `left` is always recomputed from the
// current geometry, rather than from the font size at selection time.
const chartReflowObservers = new WeakMap()

const chart = (series) => {
  const figure = document.createElement("figure")
  const values = series.points.map((point) => point.value)
  const width = 640
  const height = 180
  const padding = 10
  const maximum = Math.max(...values, 1)
  const denominator = Math.max(series.points.length - 1, 1)
  const geometry = series.points.map((point, index) => ({
    x: padding + (index / denominator) * (width - padding * 2),
    y: height - padding - (point.value / maximum) * (height - padding * 2),
  }))
  const coordinates = geometry.map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`)

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`)
  // The exact record lives in the table beside this figure and the current
  // value is spoken through the figure's own `aria-valuetext`, so the drawing
  // itself is decoration and announcing it twice only adds noise.
  svg.setAttribute("aria-hidden", "true")
  const baseline = document.createElementNS(svg.namespaceURI, "line")
  baseline.setAttribute("x1", String(padding))
  baseline.setAttribute("x2", String(width - padding))
  baseline.setAttribute("y1", String(height - padding))
  baseline.setAttribute("y2", String(height - padding))
  baseline.setAttribute("class", "chart-baseline")
  svg.append(baseline)
  if (coordinates.length) {
    const line = document.createElementNS(svg.namespaceURI, "polyline")
    line.setAttribute("points", coordinates.join(" "))
    line.setAttribute("class", "chart-line")
    svg.append(line)
  }

  const cursor = document.createElementNS(svg.namespaceURI, "line")
  cursor.setAttribute("class", "chart-cursor")
  cursor.setAttribute("y1", String(padding))
  cursor.setAttribute("y2", String(height - padding))
  const marker = document.createElementNS(svg.namespaceURI, "circle")
  marker.setAttribute("class", "chart-marker")
  marker.setAttribute("r", "6")
  svg.append(cursor, marker)

  const readout = document.createElement("figcaption")
  readout.className = "chart-readout"
  figure.append(svg, readout)

  if (!geometry.length) {
    readout.textContent = "no samples in this window"
    return figure
  }

  // `role="slider"` is what makes a scrubbable series both operable by keyboard
  // and legible to a screen reader: arrow keys are the slider's documented
  // interaction, and `aria-valuetext` is announced on each step with no live
  // region to double-speak it.
  figure.tabIndex = 0
  figure.setAttribute("role", "slider")
  figure.setAttribute("aria-orientation", "horizontal")
  figure.setAttribute("aria-label", `inspect ${series.label.toLowerCase()}`)
  figure.setAttribute("aria-valuemin", "0")
  figure.setAttribute("aria-valuemax", String(geometry.length - 1))

  let selected = geometry.length - 1
  const select = (index) => {
    selected = Math.max(0, Math.min(index, geometry.length - 1))
    const point = series.points[selected]
    cursor.setAttribute("x1", String(geometry[selected].x))
    cursor.setAttribute("x2", String(geometry[selected].x))
    marker.setAttribute("cx", String(geometry[selected].x))
    marker.setAttribute("cy", String(geometry[selected].y))
    readout.textContent = `${formatUtc(point.at)} · ${formatValue(series, point.value)}`
    figure.setAttribute("aria-valuenow", String(selected))
    figure.setAttribute("aria-valuetext", readout.textContent)
    placeReadout(readout, figure, marker)
  }

  // Moving `left` changes position only, not either observed box's size, so
  // this cannot create a ResizeObserver loop. Observe the readout itself for
  // text-scale reflow and the figure for width changes from responsive layout.
  const reflowObserver = new ResizeObserver(() => placeReadout(readout, figure, marker))
  reflowObserver.observe(readout)
  reflowObserver.observe(figure)
  chartReflowObservers.set(figure, reflowObserver)

  // A tap emits pointerdown and pointerup and no pointermove at all, so a
  // hover-only handler leaves every phone unable to read a single value.
  const inspect = (event) => {
    const bounds = figure.getBoundingClientRect()
    select(Math.round(((event.clientX - bounds.left) / bounds.width) * (geometry.length - 1)))
  }
  figure.addEventListener("pointerdown", inspect)
  figure.addEventListener("pointermove", inspect)
  figure.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
    event.preventDefault()
    if (event.key === "Home") return select(0)
    if (event.key === "End") return select(geometry.length - 1)
    select(selected + (event.key === "ArrowRight" ? 1 : -1))
  })

  select(selected)
  // The first placement runs before layout has settled on a freshly created
  // node, so its box measures zero and the readout lands in the corner.
  requestAnimationFrame(() => select(selected))
  return figure
}

const table = (series) => {
  const details = document.createElement("details")
  details.className = "data-table"
  const summary = document.createElement("summary")
  summary.textContent = `read ${series.label.toLowerCase()} data`
  const tableElement = document.createElement("table")
  const caption = document.createElement("caption")
  caption.textContent = `${series.label} aggregate samples`
  const head = document.createElement("thead")
  const headRow = document.createElement("tr")
  for (const label of ["time (UTC)", series.label]) {
    const cell = document.createElement("th")
    cell.scope = "col"
    cell.textContent = label
    headRow.append(cell)
  }
  head.append(headRow)
  const body = document.createElement("tbody")
  for (const point of series.points) {
    const row = document.createElement("tr")
    const time = document.createElement("td")
    time.textContent = formatUtc(point.at)
    const value = document.createElement("td")
    value.textContent = formatValue(series, point.value)
    row.append(time, value)
    body.append(row)
  }
  tableElement.append(caption, head, body)
  details.append(summary, tableElement)
  return details
}

const rangeLabel = (range) => {
  const config = WINDOWS[range.id]
  if (range.mode === "live") {
    return `${config.label} ending now (live) · checked ${new Date(range.end).toLocaleTimeString()}`
  }
  const local = new Date(range.end).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
  const zoneParts = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(new Date(range.end))
  const zone = zoneParts.find((part) => part.type === "timeZoneName")?.value ?? ""
  return `${config.label} ending ${local} ${zone} · UTC anchor ${range.end.slice(11, 16)}`
}

const updateNavigatorState = () => {
  const now = new Date()
  for (const button of windowButtons) button.setAttribute("aria-pressed", String(button.dataset.window === state.windowId))
  liveButton.setAttribute("aria-pressed", String(state.end === null))
  nextButton.disabled = state.end === null
  previousButton.disabled = state.end !== null && new Date(state.end).getTime() <= deepestAnchorMillis(state.windowId, now)
}

const renderRange = (payload) => {
  document.querySelector("#scope").textContent = `${payload.scope.functionCount} exact functions`
  document.querySelector("#checked-at").textContent = `checked ${new Date(payload.checkedAt).toLocaleString()}`
  const cards = payload.series.map((series) => {
    const card = document.createElement("article")
    card.className = `metric-card metric-${series.id}`
    const heading = document.createElement("div")
    heading.className = "metric-heading"
    const label = document.createElement("h2")
    // Bind the card title so it can never strand its last word.
    label.textContent = NON_BREAKING(series.label)
    const unit = document.createElement("span")
    unit.textContent = series.aggregation
    heading.append(label, unit)
    const value = document.createElement("strong")
    value.textContent = formatValue(series, series.summary)
    const context = document.createElement("p")
    context.textContent = `${payload.range.label} ${NON_BREAKING(`· ${series.unit}`)}`
    card.append(heading, value, context, chart(series), table(series))
    return card
  })
  for (const figure of grid.querySelectorAll("figure")) {
    chartReflowObservers.get(figure)?.disconnect()
  }
  grid.replaceChildren(...cards)
  grid.setAttribute("aria-busy", "false")
  status.textContent = rangeLabel(payload.range)
  updateNavigatorState()
}

const loadRange = async () => {
  activeRequest?.abort()
  const controller = new AbortController()
  activeRequest = controller
  syncUrl()
  updateNavigatorState()
  grid.setAttribute("aria-busy", "true")
  try {
    const parameters = new URLSearchParams({ window: state.windowId })
    if (state.end) parameters.set("end", state.end)
    const response = await fetch(`/api/metrics?${parameters.toString()}`, { cache: "no-store", signal: controller.signal })
    if (controller !== activeRequest) return // superseded by a later selection
    if (response.status === 401) return window.location.assign("/")
    if (!response.ok) throw new Error("aggregate metrics are unavailable")
    const payload = await response.json()
    if (controller !== activeRequest) return
    renderRange(payload)
  } catch (error) {
    if (error.name === "AbortError" || controller !== activeRequest) return
    grid.setAttribute("aria-busy", "false")
    status.textContent = `${error.message}. refresh in a moment.`
  }
}

const previousHour = () => {
  const now = new Date()
  const reference = state.end ? new Date(state.end) : floorToHour(now)
  const deepest = deepestAnchorMillis(state.windowId, now)
  state.end = new Date(Math.max(reference.getTime() - HOUR_MILLISECONDS, deepest)).toISOString()
  loadRange()
}

const nextHour = () => {
  if (!state.end) return // already live; nothing comes after live
  const now = new Date()
  const candidate = new Date(state.end).getTime() + HOUR_MILLISECONDS
  const live = floorToHour(now).getTime()
  state.end = candidate >= live ? null : new Date(candidate).toISOString()
  loadRange()
}

const goLive = () => {
  state.end = null
  loadRange()
}

for (const button of windowButtons) {
  button.addEventListener("click", () => {
    state.windowId = button.dataset.window
    clampStateToWindow()
    loadRange()
  })
}

previousButton.addEventListener("click", previousHour)
nextButton.addEventListener("click", nextHour)
liveButton.addEventListener("click", goLive)
navigator_.addEventListener("keydown", (event) => {
  if (event.key === "ArrowLeft") { event.preventDefault(); previousHour() }
  else if (event.key === "ArrowRight") { event.preventDefault(); nextHour() }
})

// Pointer Events on the explorer shell only -- never document-global. CSS
// `touch-action: pan-y` leaves vertical scrolling to the browser; this handler
// only ever claims the horizontal axis, and only once the drag has committed
// to it. One hour moves per completed gesture (on pointerup), never per
// pointermove, and there is no inertia or gesture library.
{
  const shell = grid
  const AXIS_LOCK_PIXELS = 6
  const HORIZONTAL_THRESHOLD_PIXELS = 48
  let pointerId = null
  let startX = 0
  let startY = 0
  let axis = null

  const reset = () => { pointerId = null; axis = null }

  shell.addEventListener("pointerdown", (event) => {
    if (pointerId !== null || !event.isPrimary) return
    pointerId = event.pointerId
    startX = event.clientX
    startY = event.clientY
    axis = null
  })

  shell.addEventListener("pointermove", (event) => {
    if (event.pointerId !== pointerId) return
    const dx = event.clientX - startX
    const dy = event.clientY - startY
    if (axis === null && (Math.abs(dx) > AXIS_LOCK_PIXELS || Math.abs(dy) > AXIS_LOCK_PIXELS)) {
      axis = Math.abs(dy) > Math.abs(dx) ? "y" : "x"
      // Vertical won: abandon the gesture and let the page scroll normally.
      if (axis === "y") reset()
    }
  })

  shell.addEventListener("pointerup", (event) => {
    if (event.pointerId !== pointerId) return
    const dx = event.clientX - startX
    if (axis === "x" && Math.abs(dx) >= HORIZONTAL_THRESHOLD_PIXELS) {
      if (dx < 0) nextHour()
      else previousHour()
    }
    reset()
  })

  shell.addEventListener("pointercancel", reset)
}

document.querySelector("#logout").addEventListener("click", async () => {
  activeRequest?.abort()
  await fetch("/api/logout", { method: "POST" })
  window.location.assign("/")
})

state = parseStateFromLocation()
clampStateToWindow()
loadRange()
