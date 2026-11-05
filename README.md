# ERAS — Emergency Resource Allocation System

DBMS Level 3 mini project (UE24CS351A) · Yadunandana Reddy M (PES2UG24CS605) · Vismay Chandra Dev (PES2UG24CS597)

In an emergency, coordinators get more requests than they have stock for. ERAS is built for **allocation under scarcity**. It records emergencies, the places they hit and how bad things are getting there, the requests coming from those places, and stock by batch at every resource center. It ranks every open request item with an explainable priority score, suggests batches first-expiry-first-out from the nearest open center, and allocates them so that two coordinators racing for the last units can't oversell. Every stock change lands in a ledger written by database triggers, so even a manual `UPDATE` from a console is audited.

## Features

Added in Part 2.

## Screenshots

Added in Part 2.

## Stack

- **Next.js 16** (App Router, TypeScript). Route Handlers in `src/app/api` are the only code that touches a database.
- **MySQL 8**, the system of record: raw parameterised SQL through `mysql2`, with functions, views, stored procedures and triggers.
- **MongoDB**: field reports (their shape depends on the emergency type) and the append-only activity log.
- **Auth**: `bcryptjs` password hashes and a signed JWT (`jose`) in an httpOnly cookie; every handler checks the role.
- **UI**: Tailwind CSS, shadcn/ui and TanStack Table.

## Prerequisites

- Node.js 24
- MySQL 8.0.17 or later (8.4 LTS recommended), with the `mysql` command-line client on your `PATH`: setup runs the SQL files through it
- MongoDB 8 or 9, running locally

## Setup

### 1. Install

```bash
git clone https://github.com/Spinicle/emergency-resource-allocation.git
cd emergency-resource-allocation
npm install
```

### 2. Configure

Copy `.env.example` to `.env.local` and fill it in:

```bash
cp .env.example .env.local
```

| Key | Value |
|---|---|
| `MYSQL_HOST`, `MYSQL_PORT` | `127.0.0.1` and `3306` (use `127.0.0.1`, not `localhost`) |
| `MYSQL_DATABASE` | `emergency_resource_allocation` |
| `MYSQL_USER`, `MYSQL_PASSWORD` | The app's own least-privilege account. Choose any password: `db:reset` creates the user |
| `MYSQL_ADMIN_USER`, `MYSQL_ADMIN_PASSWORD` | An admin account such as `root`, used only by the scripts |
| `MONGODB_URI`, `MONGODB_DB` | `mongodb://127.0.0.1:27017` and `eras` |
| `JWT_SECRET` | 64 hex characters, from the command below |

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Build the databases

Start MySQL and MongoDB, then run:

```bash
npm run db:reset
```

This recreates the MySQL database from `db/mysql/01_schema.sql` to `08_test_support.sql` (schema, functions, views, procedures, triggers and seed data), creates the app's MySQL user, rebuilds the MongoDB database and prints the row counts. Run it again whenever you want the seed back.

### 4. Run

```bash
npm run dev
```

Open http://localhost:3000 and sign in. Every seeded account uses the password `Eras@2026`:

| Email | Role |
|---|---|
| `admin@eras.test` | Admin |
| `coord@eras.test` | Coordinator |
| `field1@eras.test`, `field2@eras.test` | Field officer |
| `field3@eras.test` | Field officer, deactivated (sign-in is refused) |
| `cm.central@eras.test` | Center manager, Bengaluru Central Warehouse |
| `cm.kodagu@eras.test` | Center manager, Madikeri Relief Depot |

## npm scripts

| Script | What it does |
|---|---|
| `npm run dev` | Starts the development server on http://localhost:3000 |
| `npm run build` | Builds the app for production |
| `npm run start` | Serves the production build |
| `npm run lint` | Runs ESLint |
| `npm run typecheck` | Generates Next.js route types, then type-checks with `tsc` |
| `npm run db:reset` | Rebuilds both databases from scratch with the seed data |
| `npm run db:test` | Runs the SQL tests in `db/mysql/tests` as the app's MySQL user |
| `npm run db:race` | Races concurrent allocations and cancels to prove nothing deadlocks or oversells |
| `npm run db:enums` | Checks that `src/lib/enums.ts` matches the database's allowed-value constraints |
| `npm run mongo:test` | Checks the MongoDB validators, the activity log and the cross-database write |
| `npm run api:test` | Checks the HTTP API against a running app |

## Tests

| Command | What it checks |
|---|---|
| `npm run db:test` | Functions, views, procedures and triggers on rolled-back fixtures (`t_p1_*.sql`), and the seed itself (`t_seed.sql`). Safe on a seeded database |
| `npm run db:race` | Allocations, cancels and splits racing over three connections: no deadlock, no oversold batch, and stock, ledger and item totals agree |
| `npm run mongo:test` | The MongoDB validators, the activity log backfill, and the cross-database write with its compensation |
| `npm run api:test` | Logins and session tokens, every API route signed out and as each role, center scope, validation and reads. Writes nothing |

`api:test` needs the app running (`npm run dev` in another terminal). Pass its options after a single `--`:

```bash
npm run api:test -- --base http://localhost:3001
npm run api:test -- --writes
```

`--base` points it at another server (the default is http://localhost:3000). `--writes` also allocates, receives, adjusts, dispatches and delivers, so it only runs on a freshly reset database and changes it: run `npm run db:reset` afterwards.

**When to reset.** The seed-scenario checks in `db:test` and `api:test` print `SKIP` once the app has been used; run `npm run db:reset` first to see them run. Reset after `api:test -- --writes`, and shortly before a demo: the seed's waits, deadlines and expiry dates count from the reset.

## Repo layout

```text
db/mysql/        schema, functions, views, procedures, triggers and seed (01-08, run in order by db:reset)
db/mysql/tests/  SQL tests run by db:test
db/mongo/        MongoDB collections: validators, indexes, the activity log backfill, field reports
scripts/         db:reset, the test runners and their shared helpers
src/proxy.ts     the sign-in check in front of every page and API call
src/app/api/     Route Handlers, the only code that touches a database
src/app/(app)/   the signed-in pages
src/lib/         server helpers (MySQL, MongoDB, auth, errors), shared types and validators
```
