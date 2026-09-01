const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store, no-cache, must-revalidate",
};

function reply(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

export async function onRequestGet({ env }) {
  if (!env.DB) return reply({ error: "Cloudflare D1 尚未綁定為 DB" }, 503);

  try {
    const versionResult = await env.DB.prepare("SELECT value FROM meta WHERE key = 'version'").first();
    return reply({ version: Number(versionResult?.value || 0), serverTime: Date.now() });
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : "讀取資料版本失敗" }, 500);
  }
}
