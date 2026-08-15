# Syvon public docs (Mintlify)

The **public** documentation site, hosted by Mintlify at `docs.syvon.ai`.
This is a standalone repo on purpose: the monorepo's `main` receives dozens of
auto-commits a day ("go", "yoyoyo"), and Mintlify deploys on push — sharing a
repo would mean constant no-op production deploys. The monorepo's internal
`docs/` folder (ports, bucket names, deploy notes) must never be pointed at a
public host.

Source of truth for API content: `packages/sdk/docs/API.md` in the **beta-v2
monorepo** and the SDK's shipped `.d.ts` types. When the SDK changes, update
those first, then regenerate here (see OpenAPI below).

## Preview locally

```bash
npx mintlify dev
```

(Or install the Mintlify CLI once: `npm i -g mintlify`.)

## Deploying

- Connect this repo to Mintlify; deploys happen on push to the default branch.
- DNS: `docs.syvon.ai` CNAME to Mintlify, per their dashboard.
- `syvon.ai/docs` should 301 to `docs.syvon.ai` (a portal/vercel.json
  redirect, not a page).

## Structure

- `docs.json` — Mintlify config: theme, brand colors (#FD5E40 family), nav.
- `introduction / quickstart / authentication / errors` — onboarding.
- `platform-model / scope` — the tenancy model and what is NOT exposed.
- `sdk/*` — the `@syvon/sdk` reference, split from `API.md`.
- `guides/*` — task-focused guides (chat stream, media files).
- `openapi.json` — generated API spec (see below).

Mintlify serves `/llms.txt` and `/llms-full.txt` automatically from this
content; that is the agent-readable surface, no extra work needed.

## TODO (deliberately not done yet)

- Confirm social handles in `footerSocials` before going live.
- Wire Mintlify to this repo + DNS (above).

## OpenAPI

`openapi.json` is **generated, never hand-edited**:

```bash
node scripts/generate-openapi.mjs
```

Schemas are derived from the monorepo's `packages/sdk/src/types.ts` via the
TypeScript compiler API, so they cannot drift from the SDK. The script finds
the monorepo at `../beta-v2` by default; override with `--sdk-types=<path>`
or `SYVON_SDK_TYPES`. Only the route table inside the script is
hand-maintained (method, path, tag, auth, response wiring).

The `API Reference` nav group in `docs.json` imports the spec by section
(`Auth`, `Portal`, `Brain`). Regenerate after any SDK type change and commit
the output — this repo never needs the monorepo to build.
