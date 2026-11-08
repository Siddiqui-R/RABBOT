// Anonymous read-only SQL over HTTP: the endpoint `spacetime sql
// --anonymous` uses. Good for one-off lookups (status, picking a match to
// follow) without opening a WebSocket. Rows come back as SATS-JSON arrays;
// decodeRows turns them into objects keyed by column name, with sum types
// (enums, options) decoded by the schema.

import { FORBIDDEN_TABLES } from "./queries.js";

type AlgType = Record<string, unknown>;

interface Column {
  name: { some?: string } | string;
  algebraic_type: AlgType;
}

interface SqlResult {
  schema: { elements: Column[] };
  rows: unknown[][];
}

export type Row = Record<string, unknown>;

function colName(c: Column, i: number): string {
  if (typeof c.name === "string") return c.name;
  return c.name.some ?? `col${i}`;
}

function decode(v: unknown, t: AlgType): unknown {
  if ("Sum" in t) {
    const variants = (t.Sum as { variants: Column[] }).variants;
    if (!Array.isArray(v) || v.length !== 2) return v;
    const [tag, payload] = v as [number, unknown];
    const variant = variants[tag];
    const name = variant ? colName(variant, tag) : String(tag);
    // option<T> is a sum of some(T) | none
    if (variants.length === 2 && name === "some" && colName(variants[1]!, 1) === "none") {
      return decode(payload, variant!.algebraic_type);
    }
    if (name === "none" && variants.length === 2 && colName(variants[0]!, 0) === "some") return null;
    const inner = variant?.algebraic_type as { Product?: { elements: unknown[] } } | undefined;
    if (inner?.Product && inner.Product.elements.length === 0) return name;
    return { [name]: variant ? decode(payload, variant.algebraic_type) : payload };
  }
  if ("Product" in t) {
    const els = (t.Product as { elements: Column[] }).elements;
    // Timestamps and the like: one special field.
    if (els.length === 1 && Array.isArray(v) && v.length === 1) {
      const n = colName(els[0]!, 0);
      if (n === "__timestamp_micros_since_unix_epoch__") return Number(v[0]) / 1000;
      if (n === "__identity__") return v[0];
    }
    if (Array.isArray(v)) {
      const o: Row = {};
      els.forEach((e, i) => (o[colName(e, i)] = decode(v[i], e.algebraic_type)));
      return o;
    }
  }
  return v;
}

export function decodeRows(res: SqlResult): Row[] {
  const cols = res.schema.elements;
  return res.rows.map((r) => {
    const o: Row = {};
    cols.forEach((c, i) => (o[colName(c, i)] = decode(r[i], c.algebraic_type)));
    return o;
  });
}

export async function sql(host: string, db: string, query: string, timeoutMs = 15_000): Promise<Row[]> {
  const lower = query.toLowerCase();
  for (const t of FORBIDDEN_TABLES) if (lower.includes(t)) throw new Error(`refusing to query ${t}`);
  if (!/^\s*select\b/i.test(query)) throw new Error("read-only: SELECT only");
  const url = `${host.replace(/\/$/, "")}/v1/database/${encodeURIComponent(db)}/sql`;
  const res = await fetch(url, { method: "POST", body: query, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new Error(`SQL ${res.status}: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(text) as SqlResult[];
  return parsed.length ? decodeRows(parsed[0]!) : [];
}

export function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
