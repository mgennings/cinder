const grid = document.querySelector("#metric-grid")
const status = document.querySelector("#status")
const windowButtons = [...document.querySelectorAll("[data-window]")]
let metrics = null
let selectedWindow = "24h"

const formatValue = (series, value) => {
  if (!Number.isFinite(value)) return "no samples"
  if (series.unit === "milliseconds") return `${value.toFixed(value >= 100 ? 0 : 1)} ms`
  return Math.round(value).toLocaleString()
}

const chart = (series) => {
  const figure = document.createElement("figure")
  const values = series.points.map((point) => point.value)
  const width = 640
  const height = 180
  const padding = 10
  const maximum = Math.max(...values, 1)
  const denominator = Math.max(series.points.length - 1, 1)
  const coordinates = series.points.map((point, index) => {
    const x = padding + (index / denominator) * (width - padding * 2)
    const y = height - padding - (point.value / maximum) * (height - padding * 2)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`)
  svg.setAttribute("role", "img")
  svg.setAttribute("aria-label", `${series.label} trend, ${series.points.length} aggregate samples`)
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
  figure.append(svg)
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
  for (const label of ["time", series.label]) {
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
    time.textContent = new Date(point.at).toLocaleString()
    const value = document.createElement("td")
    value.textContent = formatValue(series, point.value)
    row.append(time, value)
    body.append(row)
  }
  tableElement.append(caption, head, body)
  details.append(summary, tableElement)
  return details
}

const render = () => {
  const window = metrics?.windows.find((candidate) => candidate.id === selectedWindow)
  if (!window) return
  const cards = window.series.map((series) => {
    const card = document.createElement("article")
    card.className = `metric-card metric-${series.id}`
    const heading = document.createElement("div")
    heading.className = "metric-heading"
    const label = document.createElement("h2")
    label.textContent = series.label
    const unit = document.createElement("span")
    unit.textContent = series.aggregation
    heading.append(label, unit)
    const value = document.createElement("strong")
    value.textContent = formatValue(series, series.summary)
    const context = document.createElement("p")
    context.textContent = `${window.label} · ${series.unit}`
    card.append(heading, value, context, chart(series), table(series))
    return card
  })
  grid.replaceChildren(...cards)
  grid.setAttribute("aria-busy", "false")
}

for (const button of windowButtons) {
  button.addEventListener("click", () => {
    selectedWindow = button.dataset.window
    for (const candidate of windowButtons) {
      candidate.setAttribute("aria-pressed", String(candidate === button))
    }
    render()
  })
}

document.querySelector("#logout").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" })
  window.location.assign("/")
})

fetch("/api/metrics", { cache: "no-store" })
  .then(async (response) => {
    if (response.status === 401) return window.location.assign("/")
    const payload = await response.json()
    if (!response.ok) throw new Error("aggregate metrics are unavailable")
    metrics = payload
    document.querySelector("#scope").textContent = `${payload.scope.functionCount} exact functions`
    document.querySelector("#checked-at").textContent = `checked ${new Date(payload.checkedAt).toLocaleString()}`
    render()
    status.textContent = "aggregate AWS/Lambda metrics read from the authenticated origin."
  })
  .catch((error) => {
    grid.setAttribute("aria-busy", "false")
    status.textContent = `${error.message}. refresh in a moment.`
  })
