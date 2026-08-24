# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and Oxlint's TypeScript related rules in your project.

## Backend

Set the local database and client settings in `server/.env` using
`server/.env.example` as a template. Keep the real `.env` file private.

```powershell
cd server
npm run dev
```

For production-style execution, use `npm start`. The database-backed health check
is available at `http://localhost:3000/api/health`.

## Production deployment contract

The frontend deliberately uses root-relative `/api/...` URLs for application
requests and root-relative `/uploads/...` URLs for managed images. A production
deployment must therefore serve the frontend and backend through the same HTTPS
origin at the domain root.

The edge server or reverse proxy must apply these routes before the frontend's
SPA fallback:

- Forward `/api` and every `/api/...` request to the Express backend.
- Forward `/uploads` and every `/uploads/...` request to the Express backend.
- Preserve the original method, complete path (including the `/api` or
  `/uploads` prefix), and query string. Do not rewrite or strip either prefix.
- Send every other frontend route, including known Admin routes, to the built
  `dist/index.html` SPA entry point as appropriate.

HTTPS is required in production because the Admin session cookie is `Secure`.
The cookie is also `HttpOnly` and `SameSite=Lax`; the frontend's credentialed
requests rely on the documented same-origin topology. Vite's configured proxy is
for the local development server only. Publishing the static `dist` directory
without the two production proxy routes is insufficient: authentication, API
calls, and uploaded images will not work.

A cross-origin frontend/backend deployment is not supported by the current
contract. Supporting it would require a coordinated redesign of API base URLs,
image URLs, cookie `SameSite`/`Secure` behavior, and backend CORS policy. Do not
put database credentials, session secrets, API keys, or other private values in
Vite configuration or `VITE_*` variables; frontend environment values are
included in the browser bundle.

## Database setup

Start XAMPP and MariaDB, then run the versioned database migrations before
creating the first administrator:

```powershell
cd server
npm run db:migrate
npm run admin:create
```

Running migrations again is safe: migrations that were already applied are
skipped. Migration `004_require_product_image` stops before changing the schema
if an existing product has no image; assign an image to every existing product
before retrying it. The administrator command collects the username and password
interactively, hides password input, and never stores credentials in project
files or prints them.

## Admin product contract

Product prices are integer **Toman** values from database to UI. The database
stores the integer without Rial/Toman conversion, API responses expose `price`
as a canonical decimal string, and the frontend keeps that string intact so
unsigned `BIGINT` values never lose precision. Zero is valid; negative,
fractional, exponent, signed, leading-zero, and out-of-range values are not.

`isVisible` and `isAvailable` are independent. A hidden product is omitted from
the future public menu. A visible and available product is shown normally, while
a visible but unavailable product remains visible with an «ناموجود» label. The
public Menu API and public Menu UI are not part of this branch.

Every product has exactly one required managed image. Admin creation uses one
atomic `multipart/form-data` request with a JSON text field named `metadata` and
one file field named `image`. Replacing that image is supported; deleting it
independently is rejected because it would break the product invariant. Deleting
the product also schedules cleanup of its managed image.

Run the backend regression tests with `npm test` from `server`. Database
integration tests are destructive and are skipped unless
`RUN_DB_INTEGRATION_TESTS=1`. Each enabled run requires a newly generated UUID in
`TEST_DB_OWNERSHIP_TOKEN` and a dedicated empty database named
`riona_integration_<uuid_with_underscores>`. That database must contain only the
`riona_integration_test_ownership` sentinel table, with one row whose
`singleton_id` is `1` and whose `ownership_token` is the same UUID. Configure the
connection with `TEST_DB_HOST`, `TEST_DB_PORT`, `TEST_DB_USER`, optional
`TEST_DB_PASSWORD`, and `TEST_DB_NAME`.

The sentinel structure is:

```sql
CREATE TABLE riona_integration_test_ownership (
  singleton_id TINYINT NOT NULL PRIMARY KEY,
  ownership_token CHAR(36) NOT NULL
);
```

The test target is compared with the application `DB_HOST`, `DB_PORT`, and
`DB_NAME`, locked for the entire suite, and rejected if the sentinel does not
match or any unrelated table already exists. Never reuse the database or UUID,
and never point these tests at production, staging, or a shared database.
