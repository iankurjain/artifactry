/**
 * Thin helpers over D1 prepared statements.
 * Every query in this app is parameterised — no string interpolation of
 * user input, which is what keeps tenant scoping enforceable (PRD §64).
 */

export type Params = unknown[]

function prepared(db: D1Database, sql: string, params: Params) {
  return params.length ? db.prepare(sql).bind(...params) : db.prepare(sql)
}

export async function first<T>(db: D1Database, sql: string, params: Params = []): Promise<T | null> {
  return (await prepared(db, sql, params).first<T>()) ?? null
}

export async function all<T>(db: D1Database, sql: string, params: Params = []): Promise<T[]> {
  const result = await prepared(db, sql, params).all<T>()
  return result.results ?? []
}

export async function run(db: D1Database, sql: string, params: Params = []) {
  return prepared(db, sql, params).run()
}

export async function count(db: D1Database, sql: string, params: Params = []): Promise<number> {
  const row = await first<{ n: number }>(db, sql, params)
  return row?.n ?? 0
}

/**
 * D1 has no interactive transactions across statements, so multi-step writes
 * are expressed as a prepared batch. D1 executes a batch atomically.
 */
export async function batch(db: D1Database, statements: D1PreparedStatement[]) {
  return db.batch(statements)
}

/** Build a prepared statement without executing it (for batch use). */
export function ps(db: D1Database, sql: string, params: Params = []) {
  return prepared(db, sql, params)
}

/** D1 rejects `undefined`; normalise optional values to null. */
export function nz<T>(value: T | undefined | null): T | null {
  return value === undefined ? null : (value as T | null)
}

export function nowIso(): string {
  return new Date().toISOString()
}

/** YYYY-MM-DD in UTC — the rollup key for analytics (PRD §104). */
export function metricDate(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10)
}

export function addDays(date: Date, days: number): Date {
  const copy = new Date(date.getTime())
  copy.setUTCDate(copy.getUTCDate() + days)
  return copy
}

export async function kvGet(db: D1Database, key: string): Promise<string | null> {
  const row = await first<{ value: string }>(db, 'SELECT value FROM app_kv WHERE key = ?', [key])
  return row?.value ?? null
}

export async function kvPut(db: D1Database, key: string, value: string): Promise<void> {
  await run(
    db,
    `INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, nowIso()]
  )
}
