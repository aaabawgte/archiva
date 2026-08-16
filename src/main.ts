import "./style.css";

type Role = "viewer" | "admin";
type NamedItem = { id: string; name: string };
type Photo = {
  id: string;
  originalName: string;
  takenAt: string | null;
  description: string;
  isPrivate: boolean;
  createdAt: string;
  location: NamedItem | null;
  people?: NamedItem[];
  imageUrl: string;
};

const API_URL = window.ARCHIVA_CONFIG?.API_URL?.replace(/\/+$/u, "") ?? "http://localhost:8787";
const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("Nedostaje korijenski element aplikacije.");
const app: HTMLDivElement = root;

let token = sessionStorage.getItem("archiva_token");
let role = sessionStorage.getItem("archiva_role") as Role | null;
let locations: NamedItem[] = [];
let people: NamedItem[] = [];
let photos: Photo[] = [];
const imageUrls = new Map<string, string>();

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (options.body && typeof options.body === "string") headers.set("Content-Type", "application/json");
  const response = await fetch(`${API_URL}${path}`, { ...options, headers });
  if (response.status === 401 && path !== "/login") {
    logout();
    throw new Error("Sesija je istekla.");
  }
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    const message = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
      ? payload.error
      : "Zahtjev nije uspio.";
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);
}

function logout(): void {
  token = null;
  role = null;
  sessionStorage.removeItem("archiva_token");
  sessionStorage.removeItem("archiva_role");
  for (const url of imageUrls.values()) URL.revokeObjectURL(url);
  imageUrls.clear();
  renderLogin();
}

function renderLogin(message = ""): void {
  app.innerHTML = `
    <main class="login">
      <form class="login-form" id="login-form">
        <img class="mark" src="./icon.svg" alt="" />
        <h1>Arhiva</h1>
        <div class="password-wrap">
          <input id="password" type="password" autocomplete="current-password" placeholder="Lozinka" aria-label="Lozinka" required autofocus />
          <button type="submit" aria-label="Otvori arhivu">→</button>
        </div>
        <p class="error" id="login-error">${escapeHtml(message)}</p>
      </form>
    </main>`;
  const form = document.querySelector<HTMLFormElement>("#login-form");
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = document.querySelector<HTMLInputElement>("#password");
    const error = document.querySelector<HTMLParagraphElement>("#login-error");
    if (!input || !error) return;
    error.textContent = "";
    try {
      const result = await api<{ token: string; role: Role }>("/login", { method: "POST", body: JSON.stringify({ password: input.value }) });
      token = result.token;
      role = result.role;
      sessionStorage.setItem("archiva_token", token);
      sessionStorage.setItem("archiva_role", role);
      await loadArchive();
    } catch (caught) {
      error.textContent = caught instanceof Error ? caught.message : "Prijava nije uspjela.";
      input.select();
    }
  });
}

async function loadArchive(): Promise<void> {
  try {
    const requests: [Promise<{ items: NamedItem[] }>, Promise<{ photos: Photo[] }>, Promise<{ items: NamedItem[] }> | null] = [
      api("/locations"), api("/photos"), role === "admin" ? api("/people") : null,
    ];
    const [locationResult, photoResult, peopleResult] = await Promise.all(requests);
    locations = locationResult.items;
    photos = photoResult.photos;
    people = peopleResult?.items ?? [];
    renderArchive();
    await loadVisibleImages();
  } catch (caught) {
    if (token) renderLogin(caught instanceof Error ? caught.message : "Arhivu nije moguće učitati.");
  }
}

function optionList(items: NamedItem[], selected = "", placeholder = "Sve"): string {
  return `<option value="">${escapeHtml(placeholder)}</option>${items.map((item) => `<option value="${item.id}" ${item.id === selected ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}`;
}

function renderArchive(): void {
  app.innerHTML = `
    <main class="shell">
      <header class="topbar">
        <span class="brand">Arhiva</span>
        <span class="role">${role === "admin" ? "Administriranje" : "Pregled"}</span>
        <div class="menu-wrap">
          <button class="ghost" id="menu-toggle" aria-label="Izbornik" aria-expanded="false">•••</button>
          <div class="menu" id="menu" hidden>
            ${role === "admin" ? '<button id="change-passwords">Promijeni lozinke</button><button id="revoke">Odjavi sve uređaje</button>' : ""}
            <button id="logout">Odjava</button>
          </div>
        </div>
      </header>
      <section class="filters" aria-label="Filtri">
        <select id="location-filter" aria-label="Filtriraj po lokaciji">${optionList(locations, "", "Sve lokacije")}</select>
        ${role === "admin" ? `<select id="person-filter" aria-label="Filtriraj po osobi">${optionList(people, "", "Sve osobe")}</select>` : ""}
        <span class="count" id="count"></span>
      </section>
      <section class="gallery" id="gallery"></section>
    </main>
    ${role === "admin" ? '<button class="fab" id="add-photo" aria-label="Dodaj fotografiju">+</button>' : ""}
    <dialog id="upload-dialog"></dialog>
    <dialog id="password-dialog"></dialog>
    <dialog id="viewer-dialog"></dialog>`;

  document.querySelector("#location-filter")?.addEventListener("change", filterPhotos);
  document.querySelector("#person-filter")?.addEventListener("change", filterPhotos);
  document.querySelector("#add-photo")?.addEventListener("click", openUpload);
  document.querySelector("#logout")?.addEventListener("click", logout);
  document.querySelector("#revoke")?.addEventListener("click", revokeAll);
  document.querySelector("#change-passwords")?.addEventListener("click", openPasswordDialog);
  const menu = document.querySelector<HTMLElement>("#menu");
  const toggle = document.querySelector<HTMLButtonElement>("#menu-toggle");
  toggle?.addEventListener("click", () => {
    if (!menu) return;
    menu.hidden = !menu.hidden;
    toggle.setAttribute("aria-expanded", String(!menu.hidden));
  });
  filterPhotos();
}

function selectedValue(id: string): string {
  return document.querySelector<HTMLSelectElement>(`#${id}`)?.value ?? "";
}

function filterPhotos(): void {
  const locationId = selectedValue("location-filter");
  const personId = selectedValue("person-filter");
  const filtered = photos.filter((photo) =>
    (!locationId || photo.location?.id === locationId) && (!personId || photo.people?.some((person) => person.id === personId)),
  );
  const gallery = document.querySelector<HTMLElement>("#gallery");
  const count = document.querySelector<HTMLElement>("#count");
  if (!gallery || !count) return;
  count.textContent = `${filtered.length} ${filtered.length === 1 ? "fotografija" : "fotografija"}`;
  gallery.innerHTML = filtered.length ? filtered.map((photo) => `
    <button class="photo-card" data-photo-id="${photo.id}" aria-label="Otvori ${escapeHtml(photo.originalName)}">
      <img data-image-id="${photo.id}" alt="${escapeHtml(photo.description || photo.originalName)}" />
      <span class="photo-meta">
        <span class="photo-title">${escapeHtml(photo.location?.name ?? "Nepoznata lokacija")}</span>
        <span class="photo-subtitle">${escapeHtml(photo.takenAt ?? "Nepoznat datum")}</span>
      </span>
    </button>`).join("") : '<p class="empty">Još nema fotografija.</p>';
  for (const card of document.querySelectorAll<HTMLButtonElement>(".photo-card")) {
    card.addEventListener("click", () => openViewer(card.dataset.photoId ?? ""));
  }
  void loadVisibleImages();
}

async function imageBlobUrl(photo: Photo): Promise<string> {
  const cached = imageUrls.get(photo.id);
  if (cached) return cached;
  const response = await fetch(`${API_URL}${photo.imageUrl}`, { headers: { Authorization: `Bearer ${token ?? ""}` } });
  if (!response.ok) throw new Error("Fotografiju nije moguće učitati.");
  const url = URL.createObjectURL(await response.blob());
  imageUrls.set(photo.id, url);
  return url;
}

async function loadVisibleImages(): Promise<void> {
  await Promise.all([...document.querySelectorAll<HTMLImageElement>("img[data-image-id]")].map(async (image) => {
    const photo = photos.find((item) => item.id === image.dataset.imageId);
    if (!photo || image.src) return;
    try { image.src = await imageBlobUrl(photo); } catch { image.alt = "Fotografija nije dostupna"; }
  }));
}

function openViewer(id: string): void {
  const photo = photos.find((item) => item.id === id);
  const dialog = document.querySelector<HTMLDialogElement>("#viewer-dialog");
  const src = imageUrls.get(id);
  if (!photo || !dialog || !src) return;
  const peopleText = role === "admin" && photo.people?.length ? photo.people.map((person) => person.name).join(", ") : "";
  dialog.innerHTML = `<article class="viewer">
    <img src="${src}" alt="${escapeHtml(photo.description || photo.originalName)}" />
    <div class="viewer-info">
      <div class="viewer-text">
        <h2>${escapeHtml(photo.location?.name ?? "Nepoznata lokacija")}</h2>
        <p>${escapeHtml(photo.takenAt ?? "Nepoznat datum")}${photo.isPrivate ? " · Privatno" : ""}</p>
        ${photo.description ? `<p>${escapeHtml(photo.description)}</p>` : ""}
        ${peopleText ? `<p>${escapeHtml(peopleText)}</p>` : ""}
      </div>
      ${role === "admin" ? '<button class="danger" id="delete-photo">Obriši</button>' : ""}
      <button class="close" id="close-viewer" aria-label="Zatvori">×</button>
    </div>
  </article>`;
  dialog.querySelector("#close-viewer")?.addEventListener("click", () => dialog.close());
  dialog.querySelector("#delete-photo")?.addEventListener("click", () => void deletePhoto(photo));
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); }, { once: true });
  dialog.showModal();
}

async function deletePhoto(photo: Photo): Promise<void> {
  if (!confirm(`Obrisati „${photo.originalName}”? Ova radnja je trajna.`)) return;
  try {
    await api(`/photos/${photo.id}`, { method: "DELETE" });
    const objectUrl = imageUrls.get(photo.id);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    imageUrls.delete(photo.id);
    document.querySelector<HTMLDialogElement>("#viewer-dialog")?.close();
    await loadArchive();
  } catch (caught) { alert(caught instanceof Error ? caught.message : "Brisanje nije uspjelo."); }
}

function openUpload(): void {
  const dialog = document.querySelector<HTMLDialogElement>("#upload-dialog");
  if (!dialog) return;
  dialog.innerHTML = `<form class="dialog-panel" id="upload-form">
    <div class="dialog-head"><h2>Nova fotografija</h2><button type="button" class="close" id="close-upload" aria-label="Zatvori">×</button></div>
    <div class="field"><label for="photo-file">Fotografija</label><input id="photo-file" type="file" accept="image/*" required /></div>
    <div class="field field-row"><div><label for="upload-location">Lokacija</label><select id="upload-location">${optionList(locations, "", "Nepoznata lokacija")}</select></div><button type="button" class="mini" id="new-location">+ nova</button></div>
    <div class="field field-row"><div><label for="upload-people">Osobe</label><select id="upload-people" multiple size="4">${people.map((person) => `<option value="${person.id}">${escapeHtml(person.name)}</option>`).join("")}</select></div><button type="button" class="mini" id="new-person">+ nova</button></div>
    <div class="field"><label for="taken-at">Datum (godina, mjesec ili dan)</label><input id="taken-at" type="text" inputmode="numeric" placeholder="1998 ili 1998-07 ili 1998-07-14" pattern="\\d{4}(-\\d{2}(-\\d{2})?)?" /></div>
    <div class="field"><label for="description">Opis ili priča</label><textarea id="description" maxlength="2000"></textarea></div>
    <label class="check"><input id="private-photo" type="checkbox" /> Samo za administratora</label>
    <button class="primary" id="upload-submit" type="submit">Spremi fotografiju</button>
    <div class="progress" aria-hidden="true"><span id="upload-progress"></span></div>
    <p class="error" id="upload-error"></p>
  </form>`;
  dialog.querySelector("#close-upload")?.addEventListener("click", () => dialog.close());
  dialog.querySelector("#new-location")?.addEventListener("click", () => void createNamedItem("locations"));
  dialog.querySelector("#new-person")?.addEventListener("click", () => void createNamedItem("people"));
  dialog.querySelector("#upload-form")?.addEventListener("submit", (event) => void uploadPhoto(event));
  dialog.showModal();
}

async function createNamedItem(type: "locations" | "people"): Promise<void> {
  const label = type === "locations" ? "Naziv lokacije" : "Ime osobe";
  const name = prompt(label)?.trim();
  if (!name) return;
  try {
    const result = await api<{ item: NamedItem }>(`/${type}`, { method: "POST", body: JSON.stringify({ name }) });
    const collection = type === "locations" ? locations : people;
    collection.push(result.item);
    collection.sort((a, b) => a.name.localeCompare(b.name, "hr"));
    const select = document.querySelector<HTMLSelectElement>(type === "locations" ? "#upload-location" : "#upload-people");
    if (select) {
      select.insertAdjacentHTML("beforeend", `<option value="${result.item.id}" selected>${escapeHtml(result.item.name)}</option>`);
    }
  } catch (caught) { alert(caught instanceof Error ? caught.message : "Spremanje nije uspjelo."); }
}

async function makeThumbnail(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const maxSide = 1200;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Thumbnail nije moguće izraditi.");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Thumbnail nije moguće izraditi.")), "image/jpeg", 0.82));
}

async function putFile(path: string, body: Blob, contentType: string): Promise<void> {
  const response = await fetch(`${API_URL}${path}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token ?? ""}`, "Content-Type": contentType },
    body,
  });
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    throw new Error(payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : "Prijenos nije uspio.");
  }
}

async function uploadPhoto(event: Event): Promise<void> {
  event.preventDefault();
  const file = document.querySelector<HTMLInputElement>("#photo-file")?.files?.[0];
  const error = document.querySelector<HTMLElement>("#upload-error");
  const submit = document.querySelector<HTMLButtonElement>("#upload-submit");
  const progress = document.querySelector<HTMLElement>("#upload-progress");
  if (!file || !error || !submit || !progress) return;
  if (file.size > 25 * 1024 * 1024) { error.textContent = "Fotografija može imati najviše 25 MB."; return; }
  submit.disabled = true;
  error.textContent = "";
  try {
    const personIds = [...(document.querySelector<HTMLSelectElement>("#upload-people")?.selectedOptions ?? [])].map((option) => option.value);
    const created = await api<{ upload: { original: string; thumbnail: string } }>("/photos", {
      method: "POST",
      body: JSON.stringify({
        originalName: file.name,
        mediaType: file.type || "image/jpeg",
        locationId: selectedValue("upload-location") || null,
        personIds,
        takenAt: document.querySelector<HTMLInputElement>("#taken-at")?.value.trim() || null,
        description: document.querySelector<HTMLTextAreaElement>("#description")?.value.trim() ?? "",
        isPrivate: document.querySelector<HTMLInputElement>("#private-photo")?.checked ?? false,
      }),
    });
    progress.style.width = "20%";
    const thumbnail = await makeThumbnail(file);
    progress.style.width = "40%";
    await putFile(created.upload.original, file, file.type || "image/jpeg");
    progress.style.width = "80%";
    await putFile(created.upload.thumbnail, thumbnail, "image/jpeg");
    progress.style.width = "100%";
    document.querySelector<HTMLDialogElement>("#upload-dialog")?.close();
    await loadArchive();
  } catch (caught) {
    error.textContent = caught instanceof Error ? caught.message : "Spremanje nije uspjelo.";
    submit.disabled = false;
  }
}

async function revokeAll(): Promise<void> {
  if (!confirm("Odjaviti sve uređaje, uključujući ovaj?")) return;
  try { await api("/sessions/revoke", { method: "POST" }); } finally { logout(); }
}

function openPasswordDialog(): void {
  const dialog = document.querySelector<HTMLDialogElement>("#password-dialog");
  if (!dialog) return;
  dialog.innerHTML = `<form class="dialog-panel password-panel" id="password-form">
    <div class="dialog-head"><h2>Promijeni lozinke</h2><button type="button" class="close" id="close-passwords" aria-label="Zatvori">×</button></div>
    <p class="dialog-note">Upiši samo lozinku koju želiš promijeniti. Svi uređaji bit će odjavljeni.</p>
    <div class="field"><label for="current-admin-password">Trenutačna admin lozinka</label><input id="current-admin-password" type="password" autocomplete="current-password" required /></div>
    <div class="field"><label for="new-viewer-password">Nova lozinka za gledatelje</label><input id="new-viewer-password" type="password" autocomplete="new-password" minlength="12" placeholder="Ostavi prazno bez promjene" /></div>
    <div class="field"><label for="new-admin-password">Nova admin lozinka</label><input id="new-admin-password" type="password" autocomplete="new-password" minlength="12" placeholder="Ostavi prazno bez promjene" /></div>
    <button class="primary" id="password-submit" type="submit">Spremi i odjavi sve</button>
    <p class="error" id="password-error"></p>
  </form>`;
  dialog.querySelector("#close-passwords")?.addEventListener("click", () => dialog.close());
  dialog.querySelector("#password-form")?.addEventListener("submit", (event) => void submitPasswordChange(event));
  dialog.showModal();
}

async function submitPasswordChange(event: Event): Promise<void> {
  event.preventDefault();
  const currentPassword = document.querySelector<HTMLInputElement>("#current-admin-password")?.value ?? "";
  const viewerPassword = document.querySelector<HTMLInputElement>("#new-viewer-password")?.value ?? "";
  const adminPassword = document.querySelector<HTMLInputElement>("#new-admin-password")?.value ?? "";
  const error = document.querySelector<HTMLElement>("#password-error");
  const submit = document.querySelector<HTMLButtonElement>("#password-submit");
  if (!error || !submit) return;
  if (!viewerPassword && !adminPassword) { error.textContent = "Upiši barem jednu novu lozinku."; return; }
  submit.disabled = true;
  error.textContent = "";
  try {
    await api("/passwords", { method: "PATCH", body: JSON.stringify({ currentPassword, viewerPassword, adminPassword }) });
    alert("Lozinke su promijenjene. Svi uređaji su odjavljeni.");
    logout();
  } catch (caught) {
    error.textContent = caught instanceof Error ? caught.message : "Promjena lozinki nije uspjela.";
    submit.disabled = false;
  }
}

async function start(): Promise<void> {
  if ("serviceWorker" in navigator) void navigator.serviceWorker.register("./sw.js");
  if (!token || !role) { renderLogin(); return; }
  try {
    const session = await api<{ role: Role }>("/session");
    role = session.role;
    await loadArchive();
  } catch { logout(); }
}

void start();
