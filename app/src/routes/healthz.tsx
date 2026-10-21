// Render health check. No authentication, no database access.
export const loader = () => new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
