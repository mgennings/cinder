const form = document.querySelector("#login")
const status = document.querySelector("#status")
const button = form.querySelector("button")

const open_dashboard = () => window.location.replace("/")

const exchange_fragment = async () => {
  const parameters = new URLSearchParams(window.location.hash.slice(1))
  const grant = parameters.get("g")
  const navigation_grant = parameters.get("n")
  if (!grant && !navigation_grant) return false

  history.replaceState(null, "", window.location.pathname)
  try {
    if (navigation_grant) {
      const response = await fetch("/api/navigation/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant: navigation_grant }),
      })
      if (!response.ok) throw new Error()
    }
    if (grant) {
      const response = await fetch("/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant }),
      })
      if (!response.ok) throw new Error()
      open_dashboard()
      return true
    }
    status.textContent = "private destinations ready. enter the operator password."
  } catch {
    status.textContent = "that private link expired. the password still works."
  }
  return false
}

form.addEventListener("submit", async (event) => {
  event.preventDefault()
  status.textContent = "checking the origin…"
  button.disabled = true
  try {
    const response = await fetch("/api/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: document.querySelector("#password").value }),
    })
    if (response.ok) return open_dashboard()
    status.textContent = "that credential did not open this surface."
  } catch {
    status.textContent = "the origin did not answer. try again."
  }
  button.disabled = false
})

exchange_fragment().then((opened) => {
  if (opened) return
  fetch("/api/session")
    .then((response) => {
      if (response.ok) open_dashboard()
    })
    .catch(() => {})
})
