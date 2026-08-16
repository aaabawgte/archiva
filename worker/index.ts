type Role = "viewer" | "admin";

type Session = {
  role: Role;
  exp: number;
  epoch: number;
};

type PhotoInput = {
  originalName: string;
  mediaType: string;
  takenAt: string | null;
  description: string;
  locationId: string | null;
  personIds: string[];
  isPrivate: boolean;
};

const encoder = new TextEncoder();
const MAX_JSON_BYTES = 64 * 1024;
const MAX_ORIGINAL_BYTES = 25 * 1024 * 1024;
const MAX_THUMB_BYTES = 3 * 1024 * 1024;
const SESSION_SECONDS = 12 * 60 * 60;
const LOGIN_WINDOW_SECONDS = 15 * 60;
const MAX_LOGIN_FAILURES = 8;

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function corsHeaders(env: Env, request: Request): Headers {
  const headers = new Headers({
    Vary: "Origin",
    "Cache-Control": "no-store",
  });
  if (request.headers.get("Origin") === env.ALLOWED_ORIGIN) {
    headers.set("Access-Control-Allow-Origin", env.ALLOWED_ORIGIN);
    headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    headers.set("Access-Control-Max-Age", "86400");
  }
  return headers;
}

function json(env: Env, request: Request, data: unknown, status = 200): Response {
  const headers = corsHeaders(env, request);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return Response.json(data, { status, headers });
}

function assertAllowedOrigin(request: Request, env: Env): void {
  const origin = request.headers.get("Origin");
  if (origin && origin !== env.ALLOWED_ORIGIN) {
    throw new ApiError(403, "Nedopušten izvor zahtjeva.");
  }
}

async function readJson(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get("Content-Length") ?? "0");
  if (contentLength > MAX_JSON_BYTES) throw new ApiError(413, "Zahtjev je prevelik.");
  if (!request.headers.get("Content-Type")?.includes("application/json")) {
    throw new ApiError(415, "Očekivan je JSON.");
  }
  try {
    return await request.json();
  } catch {
    throw new ApiError(400, "Neispravan JSON.");
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmac(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

async function secureEqual(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  return crypto.subtle.timingSafeEqual(leftHash, rightHash);
}

async function createToken(env: Env, session: Session): Promise<string> {
  const payload = base64Url(encoder.encode(JSON.stringify(session)));
  return `${payload}.${base64Url(await hmac(env.SESSION_SECRET, payload))}`;
}

async function currentEpoch(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'auth_epoch'").first<{ value: string }>();
  return Number(row?.value ?? "1");
}

async function requireSession(request: Request, env: Env, role?: Role): Promise<Session> {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) throw new ApiError(401, "Potrebna je prijava.");
  const token = authorization.slice(7);
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) throw new ApiError(401, "Neispravna sesija.");

  const expected = await hmac(env.SESSION_SECRET, payload);
  let actual: Uint8Array;
  try {
    actual = fromBase64Url(signature);
  } catch {
    throw new ApiError(401, "Neispravna sesija.");
  }
  if (actual.byteLength !== expected.byteLength || !crypto.subtle.timingSafeEqual(actual, expected)) {
    throw new ApiError(401, "Neispravna sesija.");
  }

  let session: Session;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
    if (!isRecord(parsed) || (parsed.role !== "viewer" && parsed.role !== "admin")) throw new Error();
    if (typeof parsed.exp !== "number" || typeof parsed.epoch !== "number") throw new Error();
    session = { role: parsed.role, exp: parsed.exp, epoch: parsed.epoch };
  } catch {
    throw new ApiError(401, "Neispravna sesija.");
  }

  if (session.exp < Math.floor(Date.now() / 1000) || session.epoch !== (await currentEpoch(env))) {
    throw new ApiError(401, "Sesija je istekla.");
  }
  if (role === "admin" && session.role !== "admin") throw new ApiError(403, "Potrebna je administratorska prijava.");
  return session;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanText(value: unknown, label: string, max: number, required = false): string {
  if (typeof value !== "string") throw new ApiError(400, `${label} nije ispravan.`);
  const cleaned = value.trim();
  if ((required && !cleaned) || cleaned.length > max) throw new ApiError(400, `${label} nije ispravan.`);
  return cleaned;
}

function optionalId(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/iu.test(value)) throw new ApiError(400, "Neispravan identifikator.");
  return value;
}

function parsePhotoInput(value: unknown): PhotoInput {
  if (!isRecord(value)) throw new ApiError(400, "Neispravni podaci fotografije.");
  const mediaType = cleanText(value.mediaType, "Vrsta datoteke", 100, true).toLowerCase();
  if (!mediaType.startsWith("image/")) throw new ApiError(400, "Datoteka mora biti fotografija.");
  const rawPeople = value.personIds ?? [];
  if (!Array.isArray(rawPeople) || rawPeople.length > 50) throw new ApiError(400, "Neispravan popis osoba.");
  const personIds = [...new Set(rawPeople.map(optionalId))].filter((id): id is string => id !== null);
  const takenAt = value.takenAt === null || value.takenAt === "" ? null : cleanText(value.takenAt, "Datum", 10);
  if (takenAt && !/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/u.test(takenAt)) throw new ApiError(400, "Neispravan datum.");
  return {
    originalName: cleanText(value.originalName, "Naziv datoteke", 255, true),
    mediaType,
    takenAt,
    description: cleanText(value.description ?? "", "Opis", 2000),
    locationId: optionalId(value.locationId),
    personIds,
    isPrivate: value.isPrivate === true,
  };
}

async function login(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (!isRecord(body) || typeof body.password !== "string" || body.password.length > 256) {
    throw new ApiError(400, "Upiši lozinku.");
  }

  const now = Math.floor(Date.now() / 1000);
  const ip = request.headers.get("CF-Connecting-IP") ?? "local";
  const fingerprint = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(ip))));
  const attempt = await env.DB.prepare(
    "SELECT failures, window_started FROM login_attempts WHERE fingerprint = ?",
  ).bind(fingerprint).first<{ failures: number; window_started: number }>();
  if (attempt && now - attempt.window_started < LOGIN_WINDOW_SECONDS && attempt.failures >= MAX_LOGIN_FAILURES) {
    throw new ApiError(429, "Previše pokušaja. Pokušaj ponovno kasnije.");
  }

  const [isAdmin, isViewer] = await Promise.all([
    secureEqual(body.password, env.ADMIN_PASSWORD),
    secureEqual(body.password, env.VIEWER_PASSWORD),
  ]);
  const role: Role | null = isAdmin ? "admin" : isViewer ? "viewer" : null;
  if (!role) {
    const expiredWindow = !attempt || now - attempt.window_started >= LOGIN_WINDOW_SECONDS;
    const windowStarted = expiredWindow ? now : attempt.window_started;
    const failures = expiredWindow ? 1 : attempt.failures + 1;
    await env.DB.prepare(
      "INSERT INTO login_attempts (fingerprint, failures, window_started) VALUES (?, ?, ?) ON CONFLICT(fingerprint) DO UPDATE SET failures = excluded.failures, window_started = excluded.window_started",
    ).bind(fingerprint, failures, windowStarted).run();
    throw new ApiError(401, "Pogrešna lozinka.");
  }

  await env.DB.prepare("DELETE FROM login_attempts WHERE fingerprint = ?").bind(fingerprint).run();
  const session: Session = { role, exp: now + SESSION_SECONDS, epoch: await currentEpoch(env) };
  return json(env, request, { token: await createToken(env, session), role, expiresAt: session.exp });
}

async function listPhotos(request: Request, env: Env, session: Session): Promise<Response> {
  const url = new URL(request.url);
  const locationId = optionalId(url.searchParams.get("location"));
  const personId = optionalId(url.searchParams.get("person"));
  if (personId && session.role !== "admin") throw new ApiError(403, "Filtar osoba dostupan je samo administratoru.");

  const conditions = ["p.ready = 1"];
  const bindings: string[] = [];
  if (session.role !== "admin") conditions.push("p.is_private = 0");
  if (locationId) {
    conditions.push("p.location_id = ?");
    bindings.push(locationId);
  }
  if (personId) {
    conditions.push("EXISTS (SELECT 1 FROM photo_people x WHERE x.photo_id = p.id AND x.person_id = ?)");
    bindings.push(personId);
  }

  const result = await env.DB.prepare(`
    SELECT p.id, p.original_name, p.taken_at, p.description, p.is_private, p.created_at,
           l.id AS location_id, l.name AS location_name
    FROM photos p LEFT JOIN locations l ON l.id = p.location_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY COALESCE(p.taken_at, p.created_at) DESC, p.created_at DESC
    LIMIT 500
  `).bind(...bindings).all<Record<string, string | number | null>>();

  const photos = result.results.map((row) => ({
    id: String(row.id),
    originalName: String(row.original_name),
    takenAt: row.taken_at,
    description: String(row.description),
    isPrivate: Boolean(row.is_private),
    createdAt: String(row.created_at),
    location: row.location_id ? { id: String(row.location_id), name: String(row.location_name) } : null,
    imageUrl: `/photos/${row.id}/image`,
  }));

  if (session.role !== "admin" || photos.length === 0) return json(env, request, { photos });
  const placeholders = photos.map(() => "?").join(",");
  const people = await env.DB.prepare(`
    SELECT pp.photo_id, pe.id, pe.name FROM photo_people pp
    JOIN people pe ON pe.id = pp.person_id
    WHERE pp.photo_id IN (${placeholders}) ORDER BY pe.name COLLATE NOCASE
  `).bind(...photos.map((photo) => photo.id)).all<{ photo_id: string; id: string; name: string }>();
  const byPhoto = new Map<string, Array<{ id: string; name: string }>>();
  for (const person of people.results) {
    const list = byPhoto.get(person.photo_id) ?? [];
    list.push({ id: person.id, name: person.name });
    byPhoto.set(person.photo_id, list);
  }
  return json(env, request, { photos: photos.map((photo) => ({ ...photo, people: byPhoto.get(photo.id) ?? [] })) });
}

async function listNamed(request: Request, env: Env, table: "locations" | "people"): Promise<Response> {
  const result = await env.DB.prepare(`SELECT id, name FROM ${table} ORDER BY name COLLATE NOCASE`).all<{ id: string; name: string }>();
  return json(env, request, { items: result.results });
}

async function createNamed(request: Request, env: Env, table: "locations" | "people"): Promise<Response> {
  const body = await readJson(request);
  if (!isRecord(body)) throw new ApiError(400, "Neispravni podaci.");
  const name = cleanText(body.name, "Naziv", 100, true);
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(`INSERT INTO ${table} (id, name) VALUES (?, ?)`).bind(id, name).run();
  } catch {
    throw new ApiError(409, "Taj naziv već postoji.");
  }
  return json(env, request, { item: { id, name } }, 201);
}

async function createPhoto(request: Request, env: Env): Promise<Response> {
  const input = parsePhotoInput(await readJson(request));
  if (input.locationId) {
    const location = await env.DB.prepare("SELECT id FROM locations WHERE id = ?").bind(input.locationId).first();
    if (!location) throw new ApiError(400, "Odabrana lokacija ne postoji.");
  }
  if (input.personIds.length) {
    const placeholders = input.personIds.map(() => "?").join(",");
    const people = await env.DB.prepare(`SELECT COUNT(*) AS count FROM people WHERE id IN (${placeholders})`)
      .bind(...input.personIds).first<{ count: number }>();
    if (people?.count !== input.personIds.length) throw new ApiError(400, "Jedna od odabranih osoba ne postoji.");
  }

  const id = crypto.randomUUID();
  const safeExtension = input.originalName.toLowerCase().match(/\.(jpe?g|png|webp|gif|avif|heic)$/u)?.[1] ?? "image";
  const objectKey = `originals/${id}.${safeExtension}`;
  const thumbKey = `thumbs/${id}.jpg`;
  const statements = [env.DB.prepare(`
    INSERT INTO photos (id, object_key, thumb_key, original_name, media_type, taken_at, description, location_id, is_private)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(id, objectKey, thumbKey, input.originalName, input.mediaType, input.takenAt, input.description, input.locationId, input.isPrivate ? 1 : 0)];
  for (const personId of input.personIds) {
    statements.push(env.DB.prepare("INSERT INTO photo_people (photo_id, person_id) VALUES (?, ?)").bind(id, personId));
  }
  await env.DB.batch(statements);
  return json(env, request, {
    photo: { id },
    upload: { original: `/photos/${id}/original`, thumbnail: `/photos/${id}/thumbnail` },
  }, 201);
}

async function uploadPhotoPart(request: Request, env: Env, id: string, kind: "original" | "thumbnail"): Promise<Response> {
  const length = Number(request.headers.get("Content-Length") ?? "0");
  const limit = kind === "original" ? MAX_ORIGINAL_BYTES : MAX_THUMB_BYTES;
  if (!Number.isFinite(length) || length <= 0 || length > limit) throw new ApiError(413, "Fotografija je prevelika ili prazna.");
  const mediaType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!mediaType?.startsWith("image/")) throw new ApiError(415, "Datoteka mora biti fotografija.");
  if (!request.body) throw new ApiError(400, "Nedostaje sadržaj fotografije.");

  const photo = await env.DB.prepare("SELECT object_key, thumb_key, media_type FROM photos WHERE id = ?")
    .bind(id).first<{ object_key: string; thumb_key: string; media_type: string; original_uploaded?: number }>();
  if (!photo) throw new ApiError(404, "Fotografija ne postoji.");
  if (kind === "thumbnail") {
    const state = await env.DB.prepare("SELECT original_uploaded FROM photos WHERE id = ?").bind(id).first<{ original_uploaded: number }>();
    if (!state?.original_uploaded) throw new ApiError(409, "Prvo prenesi original.");
  }
  const key = kind === "original" ? photo.object_key : photo.thumb_key;
  await env.PHOTOS.put(key, request.body, { httpMetadata: { contentType: kind === "original" ? photo.media_type : "image/jpeg" } });
  if (kind === "original") {
    await env.DB.prepare("UPDATE photos SET original_uploaded = 1 WHERE id = ?").bind(id).run();
  } else {
    await env.DB.prepare("UPDATE photos SET ready = 1 WHERE id = ?").bind(id).run();
  }
  return json(env, request, { ok: true });
}

async function servePhoto(request: Request, env: Env, id: string, original: boolean): Promise<Response> {
  const session = await requireSession(request, env, original ? "admin" : undefined);
  const photo = await env.DB.prepare("SELECT object_key, thumb_key, is_private, ready FROM photos WHERE id = ?")
    .bind(id).first<{ object_key: string; thumb_key: string; is_private: number; ready: number }>();
  if (!photo || !photo.ready || (session.role !== "admin" && photo.is_private)) throw new ApiError(404, "Fotografija ne postoji.");
  const object = await env.PHOTOS.get(original ? photo.object_key : photo.thumb_key);
  if (!object?.body) throw new ApiError(404, "Datoteka ne postoji.");
  const headers = corsHeaders(env, request);
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("Cache-Control", "private, max-age=300");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(object.body, { headers });
}

async function deletePhoto(request: Request, env: Env, id: string): Promise<Response> {
  const photo = await env.DB.prepare("SELECT object_key, thumb_key FROM photos WHERE id = ?")
    .bind(id).first<{ object_key: string; thumb_key: string }>();
  if (!photo) throw new ApiError(404, "Fotografija ne postoji.");
  await Promise.all([env.PHOTOS.delete(photo.object_key), env.PHOTOS.delete(photo.thumb_key)]);
  await env.DB.prepare("DELETE FROM photos WHERE id = ?").bind(id).run();
  return json(env, request, { ok: true });
}

async function revokeSessions(request: Request, env: Env): Promise<Response> {
  await env.DB.prepare("UPDATE settings SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'auth_epoch'").run();
  return json(env, request, { ok: true });
}

async function route(request: Request, env: Env): Promise<Response> {
  assertAllowedOrigin(request, env);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(env, request) });
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/u, "") || "/";

  if (request.method === "GET" && path === "/health") return json(env, request, { ok: true });
  if (request.method === "POST" && path === "/login") return login(request, env);

  const session = await requireSession(request, env);
  if (request.method === "GET" && path === "/session") return json(env, request, { role: session.role, expiresAt: session.exp });
  if (request.method === "GET" && path === "/photos") return listPhotos(request, env, session);
  if (request.method === "GET" && path === "/locations") return listNamed(request, env, "locations");
  if (request.method === "GET" && path === "/people") {
    if (session.role !== "admin") throw new ApiError(403, "Potrebna je administratorska prijava.");
    return listNamed(request, env, "people");
  }

  const match = path.match(/^\/photos\/([0-9a-f-]{36})\/(original|thumbnail|image)$/iu);
  if (match?.[1] && match[2] === "image" && request.method === "GET") return servePhoto(request, env, match[1], false);

  if (session.role !== "admin") throw new ApiError(403, "Potrebna je administratorska prijava.");
  if (request.method === "POST" && path === "/locations") return createNamed(request, env, "locations");
  if (request.method === "POST" && path === "/people") return createNamed(request, env, "people");
  if (request.method === "POST" && path === "/photos") return createPhoto(request, env);
  if (request.method === "POST" && path === "/sessions/revoke") return revokeSessions(request, env);

  if (match?.[1] && match[2] === "original" && request.method === "PUT") return uploadPhotoPart(request, env, match[1], "original");
  if (match?.[1] && match[2] === "thumbnail" && request.method === "PUT") return uploadPhotoPart(request, env, match[1], "thumbnail");
  if (match?.[1] && match[2] === "original" && request.method === "GET") return servePhoto(request, env, match[1], true);
  const deleteMatch = path.match(/^\/photos\/([0-9a-f-]{36})$/iu);
  if (deleteMatch?.[1] && request.method === "DELETE") return deletePhoto(request, env, deleteMatch[1]);
  throw new ApiError(404, "Ruta ne postoji.");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof ApiError) return json(env, request, { error: error.message }, error.status);
      console.error(JSON.stringify({ event: "unhandled_error", message: error instanceof Error ? error.message : "unknown" }));
      return json(env, request, { error: "Dogodila se neočekivana pogreška." }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
