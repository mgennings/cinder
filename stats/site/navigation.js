const navigation_mount = document.querySelector("#private-navigation")
let navigation_signature = ""
let navigation_handoffs = new Map()

const navigation_shape = (destinations) =>
  JSON.stringify(destinations.map(({ id, group, label, href }) => ({ id, group, label, href })))

const remember_navigation_handoffs = (destinations) => {
  navigation_handoffs = new Map(
    destinations
      .filter(({ handoff }) => handoff)
      .map(({ href, handoff }) => [href, handoff]),
  )
}

const navigation_item = (destination) => {
  const item = document.createElement("li")
  const link = document.createElement("a")
  link.href = destination.href
  link.textContent = destination.label
  link.addEventListener("click", (event) => {
    const handoff = navigation_handoffs.get(destination.href)
    if (
      !handoff ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) return
    event.preventDefault()
    const target = new URL(destination.href)
    target.hash = new URLSearchParams({ g: handoff }).toString()
    window.location.assign(target)
  })
  if (new URL(destination.href).hostname === window.location.hostname) {
    link.setAttribute("aria-current", "page")
  }
  item.append(link)
  return item
}

const render_navigation = (destinations) => {
  if (!navigation_mount || !destinations.length) return
  const details = document.createElement("details")
  details.className = "switcher"
  const summary = document.createElement("summary")
  summary.textContent = "private constellation"
  summary.setAttribute("aria-label", "open private destination switcher")
  const list = document.createElement("ul")
  for (const group of ["signals", "places"]) {
    const members = destinations.filter((item) => item.group === group)
    if (!members.length) continue
    const heading = document.createElement("li")
    heading.className = "group"
    heading.textContent = group
    list.append(heading)
    for (const destination of members) list.append(navigation_item(destination))
  }
  details.addEventListener("toggle", () => {
    if (!details.open) return
    list.hidden = true
    void refresh_navigation(true)
  })
  details.append(summary, list)
  navigation_mount.replaceChildren(details)
  navigation_signature = navigation_shape(destinations)
}

const clear_navigation = () => {
  navigation_signature = ""
  navigation_handoffs.clear()
  navigation_mount?.replaceChildren()
}

const refresh_navigation = async (reveal = false) => {
  try {
    const response = await fetch("/api/navigation", { cache: "no-store", credentials: "same-origin" })
    if (!response.ok) return clear_navigation()
    const document = await response.json()
    if (!Array.isArray(document?.destinations) || !document.destinations.length) return clear_navigation()
    remember_navigation_handoffs(document.destinations)
    const signature = navigation_shape(document.destinations)
    if (signature !== navigation_signature) render_navigation(document.destinations)
    if (reveal) {
      const details = navigation_mount.querySelector("details")
      const list = details?.querySelector("ul")
      if (details?.open && list) list.hidden = false
    }
  } catch {
    clear_navigation()
  }
}

void refresh_navigation()
window.setInterval(refresh_navigation, 30_000)
window.addEventListener("focus", () => void refresh_navigation())
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refresh_navigation()
})
