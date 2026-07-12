const BACKEND = localStorage.getItem("formcoach.backend") || "http://localhost:8001";

async function api(path, payload) {
  const res = await fetch(`${BACKEND}${path}`, {
    // hosted-page hint only — it breaks fetches from a localhost page
    ...(location.protocol === "https:" ? { targetAddressSpace: "loopback" } : {}),
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Backend ${res.status}`);
  return res.json();
}

export async function syncCoachMemory(athlete, sessions) {
  return api("/api/memory/sync", { athlete, sessions });
}

export async function askMemoryCoach({ athlete, question, sessions, chatHistory }) {
  return api("/api/coach/chat", { athlete, question, sessions, chatHistory });
}
