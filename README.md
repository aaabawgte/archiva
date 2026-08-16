# Archiva

Archiva je minimalistička privatna PWA zbirka fotografija. Statički frontend objavljuje se na GitHub Pages, a Cloudflare Worker pruža autentikaciju i API. Fotografije su privatne u R2, a metapodaci u D1.

## Što prva verzija podržava

- zajedničku `viewer` lozinku za pregled i filtriranje po lokaciji
- zasebnu `admin` lozinku za upload, privatne fotografije, osobe i brisanje
- lokacije i osobe koje se jednom kreiraju pa ponovno odabiru
- godinu, mjesec ili puni datum te opis fotografije
- thumbnail bez EXIF podataka, izrađen u pregledniku
- originale dostupne samo administratorskom API-ju
- 12-satne sesije, ograničavanje pokušaja prijave i odjavu svih uređaja
- PWA shell koji radi offline; privatne fotografije i API odgovori ne spremaju se u service-worker cache

## Lokalni razvoj

Potrebni su Node.js 22+ i Cloudflare račun.

```sh
npm install
npx wrangler d1 migrations apply archiva --local
npm run dev:api
```

U drugom terminalu:

```sh
npm run dev
```

Za lokalne tajne napravi `.dev.vars` (datoteka je ignorirana u Gitu):

```dotenv
VIEWER_PASSWORD="zajednicka-duga-lozinka"
ADMIN_PASSWORD="druga-jos-duza-lozinka"
SESSION_SECRET="nasumicna-vrijednost-od-barem-32-bajta"
```

Frontend je na `http://localhost:5173`, a Worker na `http://localhost:8787`.

## Postavljanje Cloudflarea

Prijavi Wrangler:

```sh
npx wrangler login
```

Kreiraj resurse:

```sh
npx wrangler d1 create archiva
npx wrangler r2 bucket create archiva-photos
```

ID koji vrati D1 upiši u `database_id` unutar `wrangler.jsonc`. U `ALLOWED_ORIGIN` upiši točan GitHub Pages origin, bez putanje i završne kose crte, primjerice:

```json
"ALLOWED_ORIGIN": "https://korisnik.github.io"
```

Lozinke i potpisni ključ dodaj interaktivno; nemoj ih zapisivati u repozitorij:

```sh
npx wrangler secret put VIEWER_PASSWORD
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET
```

Za `SESSION_SECRET` upotrijebi dugu nasumičnu vrijednost. Zatim primijeni migraciju i objavi Worker:

```sh
npx wrangler d1 migrations apply archiva --remote
npm run deploy:api
```

Wrangler će ispisati produkcijsku adresu poput `https://archiva-api.<subdomain>.workers.dev`.

## GitHub Pages

U GitHub repozitoriju:

1. Otvori **Settings → Pages** i kao source odaberi **GitHub Actions**.
2. U **Settings → Secrets and variables → Actions → Variables** dodaj `ARCHIVA_API_URL` s punom `workers.dev` adresom, bez završne kose crte.
3. Pushaj `main`; workflow `.github/workflows/pages.yml` izgradit će i objaviti `dist`.
4. Nakon što dobiješ Pages adresu, provjeri da se njezin origin točno podudara s `ALLOWED_ORIGIN` u `wrangler.jsonc` pa ponovno objavi Worker ako si ga mijenjao.

## Provjere

```sh
npm run typecheck
npm run build
npx wrangler deploy --dry-run
```

## Sigurnosne napomene

- GitHub Pages kod je javan čak i kada je repozitorij privatan; lozinke zato postoje samo kao Worker secrets.
- R2 bucket ne smije dobiti javni development URL ili custom domain.
- Viewer API namjerno ne vraća osobe, privatne fotografije ni originale.
- Token živi u `sessionStorage`, pa zatvaranje taba završava lokalnu prijavu.
- Brisanje fotografije trajno briše R2 original i thumbnail.
- Napravi periodične D1 izvoze i zasebnu kopiju R2 fotografija.
