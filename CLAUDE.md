# tokens-gone — agent notes

## Releasing

Releases are tag-driven. Push a `v*` tag and `.github/workflows/release.yml`
does the rest:

```bash
git tag v0.2.0
git push origin v0.2.0
```

The tag is the source of truth for the version. The workflow:

1. Parses the version from `${GITHUB_REF#refs/tags/v}`.
2. Writes it into `package.json` (so `package.json` on `main` doesn't need
   to be bumped before tagging).
3. Builds — `bun run build` runs `vite build` and then bundles the server
   into `dist/cli.js` with the version baked in (`tokens-gone --version`).
4. Publishes with `npm publish --provenance --access public`.

Auth is npm trusted publishing via GitHub OIDC — no `NPM_TOKEN` secret.
The npm package is configured on npmjs.com with this repo + workflow
`release.yml` as a trusted publisher. If publish fails with an auth error,
check that Trusted Publisher config first.

The version write happens **before** build because the build inlines
`package.json`'s version via esbuild `--define`. Reorder at your peril.

### First-time / emergency manual publish

If OIDC trusted publishing is down or unavailable (e.g. setting it up for
the first time and you need to bootstrap):

```bash
bun run build
npm publish --access public --otp=<6-digit code>
```

This requires `npm whoami` to be a maintainer of `tokens-gone`. Do not
pass `--provenance` here — provenance requires the CI OIDC context.
