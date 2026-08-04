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

## Database setup

Start XAMPP and MariaDB, then run the versioned database migrations before
creating the first administrator:

```powershell
cd server
npm run db:migrate
npm run admin:create
```

Running migrations again is safe: migrations that were already applied are
skipped. The administrator command collects the username and password
interactively, hides password input, and never stores credentials in project
files or prints them. This stage creates nullable image-path columns only; it
does not upload image files.

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
