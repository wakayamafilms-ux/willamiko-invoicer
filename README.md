# Willamiko Accounter

## Account setup

The app uses administrator-created username/password accounts and PostgreSQL-backed,
per-user data. There is no public registration route.

1. Create a PostgreSQL database (a Render Postgres database works in production).
2. Copy `server/.env.example` to `server/.env` and set `DATABASE_URL`, a long random
   `SESSION_SECRET`, `ADMIN_USERNAME`, and an `ADMIN_PASSWORD` of at least 12 characters.
3. Run `npm install` in both the project root and `server/`.
4. Start the API with `npm run dev` from `server/`, then start the web app with
   `npm run dev` from the project root.
5. Sign in with the configured administrator account. Open **Accounts** in the sidebar
   to create or disable user accounts.

On the first login to an empty account, existing data from the old browser-only version
is migrated into that account and removed from shared browser storage.

## Frontend

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.
