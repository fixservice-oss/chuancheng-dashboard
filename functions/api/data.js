const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store, no-cache, must-revalidate",
};

function reply(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function normalizeDate(value) {
  const match = String(value || "").trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!match) return "";
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function cleanRecord(input) {
  const id = String(input?.id || "").trim();
  const date = normalizeDate(input?.date);
  const customer = String(input?.customer || "").trim();
  const item = String(input?.item || "").trim();
  const freq = Number(input?.freq);
  const allowedStatuses = new Set(["待處理", "已保養", "已逾期"]);
  const status = allowedStatuses.has(input?.status) ? input.status : "待處理";
  const remarks = String(input?.remarks || "").slice(0, 2000);

  if (!id || id.length > 100 || !date || !customer || customer.length > 300 || !item || item.length > 300 || !Number.isFinite(freq) || freq <= 0 || freq > 120) {
    throw new Error("保養資料格式不正確");
  }
  return { id, date, customer, item, freq, status, remarks };
}

async function ensureSchema(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      customer TEXT NOT NULL,
      item TEXT NOT NULL,
      freq REAL NOT NULL,
      status TEXT NOT NULL DEFAULT '待處理',
      remarks TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS customers (
      name TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT '正常營業',
      updated_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS records_date_idx ON records(date)"),
    db.prepare("CREATE INDEX IF NOT EXISTS records_customer_idx ON records(customer)"),
  ]);
  await db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('version', '0')").run();
}

async function bumpVersion(db) {
  await db.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'version'").run();
}

async function updateOverdue(db) {
  const result = await db.prepare(`
    UPDATE records
       SET status = '已逾期', updated_at = ?1
     WHERE status = '待處理'
       AND date(date, '+' || CAST(ROUND(freq * 30) AS INTEGER) || ' days') < date('now', '+8 hours')
  `).bind(Date.now()).run();
  if ((result.meta?.changes || 0) > 0) await bumpVersion(db);
}

async function readAll(db) {
  await updateOverdue(db);
  const [recordResult, customerResult, versionResult] = await Promise.all([
    db.prepare("SELECT id, date, customer, item, freq, status, remarks FROM records ORDER BY date DESC, updated_at DESC").all(),
    db.prepare("SELECT name, status FROM customers ORDER BY name").all(),
    db.prepare("SELECT value FROM meta WHERE key = 'version'").first(),
  ]);
  const customers = Object.fromEntries(customerResult.results.map((row) => [row.name, row.status]));
  return { records: recordResult.results, customers, version: Number(versionResult?.value || 0), serverTime: Date.now() };
}

async function upsertRecord(db, input) {
  const record = cleanRecord(input);
  const now = Date.now();
  await db.batch([
    db.prepare(`INSERT INTO records (id, date, customer, item, freq, status, remarks, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      ON CONFLICT(id) DO UPDATE SET date=excluded.date, customer=excluded.customer,
      item=excluded.item, freq=excluded.freq, status=excluded.status,
      remarks=excluded.remarks, updated_at=excluded.updated_at`)
      .bind(record.id, record.date, record.customer, record.item, record.freq, record.status, record.remarks, now),
    db.prepare(`INSERT INTO customers (name, status, updated_at) VALUES (?1, '正常營業', ?2)
      ON CONFLICT(name) DO NOTHING`).bind(record.customer, now),
  ]);
  await bumpVersion(db);
}

async function replaceAll(db, records, customers) {
  if (!Array.isArray(records) || records.length > 20000 || !customers || typeof customers !== "object") {
    throw new Error("匯入資料格式不正確");
  }
  const cleaned = records.map(cleanRecord);
  const now = Date.now();
  await db.batch([
    db.prepare("DELETE FROM records"),
    db.prepare("DELETE FROM customers"),
  ]);

  const statements = [];
  for (const record of cleaned) {
    statements.push(db.prepare(`INSERT INTO records (id, date, customer, item, freq, status, remarks, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`)
      .bind(record.id, record.date, record.customer, record.item, record.freq, record.status, record.remarks, now));
  }
  const knownCustomers = new Set(cleaned.map((record) => record.customer));
  for (const [nameValue, statusValue] of Object.entries(customers)) {
    const name = String(nameValue).trim();
    if (!name || name.length > 300) continue;
    const status = statusValue === "已歇業" ? "已歇業" : "正常營業";
    statements.push(db.prepare("INSERT OR REPLACE INTO customers (name, status, updated_at) VALUES (?1, ?2, ?3)").bind(name, status, now));
    knownCustomers.delete(name);
  }
  for (const name of knownCustomers) {
    statements.push(db.prepare("INSERT OR IGNORE INTO customers (name, status, updated_at) VALUES (?1, '正常營業', ?2)").bind(name, now));
  }
  for (let i = 0; i < statements.length; i += 75) await db.batch(statements.slice(i, i + 75));
  await bumpVersion(db);
}

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.DB) return reply({ error: "Cloudflare D1 尚未綁定為 DB" }, 503);

  try {
    await ensureSchema(env.DB);
    if (request.method === "GET") return reply(await readAll(env.DB));
    if (request.method !== "POST") return reply({ error: "不支援的操作" }, 405);

    const body = await request.json();
    switch (body.action) {
      case "bootstrap": {
        const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM records").first();
        if (Number(count?.count || 0) === 0) await replaceAll(env.DB, body.records || [], body.customers || {});
        break;
      }
      case "upsertRecord":
        await upsertRecord(env.DB, body.record);
        break;
      case "deleteRecord":
        await env.DB.prepare("DELETE FROM records WHERE id = ?1").bind(String(body.id || "")).run();
        await bumpVersion(env.DB);
        break;
      case "setCustomer": {
        const name = String(body.name || "").trim();
        if (!name || name.length > 300) throw new Error("客戶名稱不正確");
        const status = body.status === "已歇業" ? "已歇業" : "正常營業";
        await env.DB.prepare(`INSERT INTO customers (name, status, updated_at) VALUES (?1, ?2, ?3)
          ON CONFLICT(name) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at`)
          .bind(name, status, Date.now()).run();
        await bumpVersion(env.DB);
        break;
      }
      case "replaceAll":
        await replaceAll(env.DB, body.records, body.customers);
        break;
      case "clearAll":
        await env.DB.batch([env.DB.prepare("DELETE FROM records"), env.DB.prepare("DELETE FROM customers")]);
        await bumpVersion(env.DB);
        break;
      default:
        return reply({ error: "未知的操作" }, 400);
    }
    return reply(await readAll(env.DB));
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : "伺服器發生錯誤" }, 400);
  }
}
