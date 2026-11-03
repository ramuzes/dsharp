# DSH "Custom plugin markets" — index format, hosting, and install path (research report)

Date: 2026-11-03. Research subject: the Custom plugin indexes / Discover feature of the DeepSeek
Harness (dsh) checkout at `/home/ramuz/deepseek-harness/` (read-only; commit `ab3bb7455` state of
the market packages at HEAD of the working tree). Purpose: dsharp wants to publish one index URL so
users can Discover-install every plugin of this repository. Every claim cites dsh source
(repo-relative paths, function names, line numbers as of this checkout). The parser CODE is treated
as the single source of truth; where the design Agent Note diverges from the code, the code wins
and the divergence is flagged (§5.4).

The repo already keeps dated research under `docs/research/`; this file follows that convention.

---

## 0. Executive summary for dsharp

- One static JSON file at an **http(s) URL** (no redirects, no fragment), fetched **by the dsh host**
  (Node `fetch`), parsed with a strict hand-written validator: `parseMarketIndex()` in
  `packages/util/plugin-market-index/src/index.ts`.
- Minimum viable index: `{"format":1,"title":{"en":"…"},"plugins":[{"name":"<npm name>","versions":[{"version":"1.2.3","publishTimestamp":1788000000,"source":{"type":"npm"}}]}]}`
  (`engines` is optional in the shipped validator; absent = "any DSH version").
- Each version resolves to an install spec **built by dsh**, not the index: npm → `name@version`
  (plus optional `registry`), git → `git+https://…​.git#<40-hex-sha>[&path:/<dir>]`.
- Compatibility gating: `engines.dsh` range evaluated against the running dsh version
  (`semver.satisfies` with `includePrerelease: true`); incompatibility *hides the default version /
  disables Install* but never invalidates the index; install re-checks the real package manifest and
  hard-refuses unless an exact-version exemption exists. No platform/arch, checksum, or signature
  mechanism exists anywhere in this path.
- There is **no built-in default market**; `indexes` defaults to `[]` and only the user adds sources.
- Publishing implication: host the file on any static server that returns the body with 200 (any
  content type is accepted — the body is parsed as UTF-8 JSON regardless), never 3xx
  (`redirect: 'error'`), ≤ 128 MiB, answered within 15 s. Updates are seen on the next browse after
  a 10-minute in-memory TTL (or immediately via the Discover Refresh button). `apps/plugin-market-generator`
  is dsh's own reference generator we can reuse or mirror.

---

## 1. Where the feature lives (components and wiring)

| Piece | Location | Notes |
|---|---|---|
| Index format validator (authoritative) | `packages/util/plugin-market-index/src/index.ts` — `parseMarketIndex()` (L299-316), `marketInstallTarget()` (L325-330) | Zero-dependency hand-written validator ("Plugin market index format 1": header comment L1-5). Types in `src/types.ts`. |
| Host-side service | `packages/boot/plugin-market/src/index.ts` — `class PluginMarket extends TypertRemoteService` (L108) | Fetches, validates, caches indexes; annotates entries. Service name `pluginMarket` (L35-40, L135). |
| URL validation | `packages/boot/plugin-market/src/index-url.ts` — `normalizeIndexUrl()` (L11-26) | Shared by `setIndexes` and per-use check of configured sources. |
| Body decode/JSON/validate + worker | `packages/boot/plugin-market/src/parse.ts` — `parseIndexBody()` (L21-43); `parse-thread.ts` — `parseIndexInWorker()` (L36-58); `worker.ts` | Parsing runs in a fresh Worker Thread so a large index cannot block the host event loop (parse-thread.ts L1). |
| Search/filter/sort | `packages/boot/plugin-market/src/search.ts` — `class MarketSearch` (L58) | MiniSearch fuzzy index over name/title/keywords/description/author/taxonomy. |
| Agent tool | `packages/boot/plugin-market/src/tools.ts` — `plugin_market` tool (L70-141) | Read-only: `list_indexes` / `list_plugins` / `list_versions`; returns each version's `install.target`/`registry` "to pass to plugin_manager install_bundle" (description L73). |
| Web UI (Discover tab) | `packages/client/ui-plugin-market/src/client/index.ts` — `apply()` (L38-58) registers slot `plugins.tab` id `discover`; UI copy in `src/client/locales.ts` (the quoted UI text `sourcesDescription` is L112: "A plugin index is published as the URL of one index file. Discover browses the indexes listed here.") | Pure presentation: "The Host `pluginMarket` service fetches and validates indexes; this package only presents them" (`packages/client/ui-plugin-market/README.md`, Summary). |
| Composition (optional bundle) | `packages/experimental/plugin-market-bundle/` — `package.json` (`@deepseek-ai/dsh-experimental-plugin-market-bundle`, "Experimental custom plugin indexes…"); `cordis.patch.yml` inserts rows `plugin-market` (service, disabled without a profile) and `ui-plugin-market` (client) | Listed in `OPTIONAL_BUNDLES` (`packages/util/official-bundles/src/bundles.ts` L55-71). UI name "Custom plugin indexes" (`locale/en.json` L3). |
| Remote wiring / events | `packages/api/remotes/src/remote-events.ts` L53 (`plugin-market/changed`); client remote imports in `packages/api/remotes/src/client/index.ts` L19-50 | The browser talks to the service only through the `pluginMarket` Remote namespace; liveshare marks its methods owner-only (`packages/experimental/liveshare/src/endpoint-classification.ts` L156-159). |
| Reference index generator | `apps/plugin-market-generator/` (`@deepseek-ai/dsh-plugin-market-generator`, "Reference generator of plugin market index files from a list of npm packages and Git repositories") | Standalone Node CLI (`src/bin.ts`), not part of the host. |
| Design notes | `.agents/notes/implemented/feature/2026-10-02-plugin-market-index-format.md` (format) and `2026-10-02-plugin-market-discover.md` (reader) | Advisory; see divergence §5.4. |
| Agent-facing tool catalog copy | `packages/extensions/tool-cordis/src/api-catalog.ts` L2336-2360, L5143-5145 | Documents `setIndexes`/`search`/`readEntryDetail` throws and the `plugin-market/changed` event. |

Connection flow: Web Discover → `remote.pluginMarket` (`listIndexes`/`setIndexes`/`search`/`readEntryDetail`)
→ host `PluginMarket` fetches + parses → annotates with `pluginManager.listBundles()` + `listVersionExemptions()`
(`annotator()`, boot/plugin-market/src/index.ts L375-379) → UI installs via the shared Plugins install
dialog (`install(spec, registry?)` owner prop; Discover note L23) → `pluginManager.installBundle` (`packages/boot/plugin-manager/src/index.ts` L872).

---

## 2. How a user adds a market URL

- **Config field**: `indexes: Volatile<string[]>` — `PluginMarket.Config` interface (boot/plugin-market/src/index.ts L43-45) and schema `static Config = z.object({ indexes: z.array(z.string().pattern(/^https?:\/\/\S+$/u)).default([]).volatile(), … })` (L111-124). Default **`[]` — no built-in official market**; "No index source is configured by default, so the Host sends no index request until a user adds one" (`packages/boot/plugin-market/README.md`, Use-this-package). "No official market exists, so DSH cannot ship a default source; the sources are user data" (Discover note L9).
- **Write path**: the Remote method `setIndexes(urls)` (L200-215) validates each not-yet-configured URL with `normalizeIndexUrl`, refuses duplicates (canonical-URL comparison, `reason: 'duplicate'`), then persists via `settings.update(this.entryId, { indexes })` where `entryId` is the loader row id `plugin-market` (`packages/experimental/plugin-market-bundle/cordis.patch.yml`; test `packages/boot/plugin-market/tests/market.spec.ts` L280 asserts `update('plugin-market', { indexes: […] })`). Without Settings or a profile entry it throws `plugin-market/settings-unavailable` (L210-213). The list is volatile (live-editable, no remount) and the commit is announced by the `plugin-market/changed` event (L159-168).
- **URL validation** (`normalizeIndexUrl`, index-url.ts L11-26): must parse as an absolute URL (`reason: 'not-absolute'`), scheme must be `http:` or `https:` (`reason: 'scheme'` — **no `file:`**), no username/password and no `#` fragment (`reason: 'credentials-or-fragment'`); the stored string must equal its canonical WHATWG serialization — `sources()` (index.ts L386-397) marks a non-canonical configured URL unusable with "Index URL is not in canonical form; use …". A **query string on the index URL is allowed** (only `#` is rejected). Duplicate configured URLs are listed once (L387-390).
- **Where stored**: the dsh profile (Settings service write to the `plugin-market` loader entry); "Switching the bundle off … the saved index sources stay in the profile" (`packages/experimental/plugin-market-bundle/README.md` L27).
- **UI**: Discover → "Manage index sources…" dialog; strings in `packages/client/ui-plugin-market/src/client/locales.ts` L106-125 (`sourceInvalid`: "Use an http or https address without a user name, password, or # fragment."). The `plugin_market` tool and Discover UI cannot add sources for the agent: "Only the user can add or remove index sources" (tools.ts L73).

---

## 3. How the index file is fetched

All fetching is **host-side** (the browser half never fetches the index; ui-plugin-market README:
"The Host `pluginMarket` service fetches and validates indexes; this package only presents them").

`PluginMarket.fetchIndex()` (boot/plugin-market/src/index.ts L424-444):

- **Method/headers**: plain `fetch(url, { signal, redirect: 'error', headers: { accept: 'application/json' } })` (L430). Single GET; **redirects are rejected** (`redirect: 'error'`) — no shorteners, no http→https redirects.
- **Timeout**: `AbortSignal.any([lifetime, AbortSignal.timeout(fetchTimeoutMs)])` (L425), default **15000 ms** (schema L113; range 1..MAX_TIMER_DELAY_MS).
- **Status**: non-2xx (`!response.ok`) → `plugin-market/fetch-failed` "HTTP <status>" (L434-437).
- **Size**: `readBody()` (L447-473) refuses early on `content-length` and streaming on overflow; limit `maxBytes` default **134217728 (128 MiB)** (L114).
- **Caching**: in-memory `Map` keyed by URL, TTL `cacheTtlMs` default **600000 ms (10 min)** (L115; `fetchShared()` L403-422). Concurrent reads share one promise (`pending` map). No ETag / If-None-Match / Last-Modified anywhere (grep over `packages/boot/plugin-market/src` finds none) — **every expiry is a full re-fetch**. `query.refresh: true` bypasses the cache (Discover's Refresh button); `query.fetchedAt` pins pagination to one document even past the TTL (`document()` L363-372; `MarketQuery.fetchedAt` doc, boot/plugin-market/src/types.ts L118-125). Nothing is written to disk for the index itself (only detail-repository partial clones use `detailCacheDir`, default `.plugin-market/repositories` under the profile).
- **Parse pipeline** (`parse.ts` `parseIndexBody` L21-43): strict UTF-8 (`new TextDecoder('utf-8', { fatal: true })`, reason `must be UTF-8`), `JSON.parse` (reason `must be JSON: …`), then `parseMarketIndex(value, url)` (violations → `plugin-market/invalid-index` with JSON `path` + `reason`, index.ts L443). Ran in a fresh Worker Thread per parse (`parse-thread.ts` L36-58).
- **Content type**: NOT checked — any MIME works if the bytes are UTF-8 JSON.
- **Schemes/hosts**: `http://localhost/127.0.0.1` is legal (validator test uses `http://127.0.0.1:8080/index.json`, plugin-market-index.spec.ts L149ff; same-origin http icons allowed for loopback markets). `file://` is impossible (`scheme` refusal).
- **Error surface**: per-URL last error kept in `errors` and shown by `listIndexes()` (L179-190); a failed read does not remove the previous listing from the UI (ui-plugin-market README).
- **Frequency**: fetches happen on browse (`search`/`entry`/`readEntryDetail`), debounced 250 ms after typing in the UI, paged 50/page (ui-plugin-market README). No polling or background refresh. Effectively: an update becomes visible at the next browse after TTL expiry, or on Refresh immediately.

---

## 4. Entry → installable package mapping

`marketInstallTarget(name, version)` (packages/util/plugin-market-index/src/index.ts L318-330) is
"the only place install arguments are built; the Web page and the model tool consume it" (Discover note L21):

```ts
if (from.type === 'npm') return { spec: `${name}@${version.version}`, ...registry }
const repository = from.url.endsWith('.git') ? from.url : `${from.url}.git`
return { spec: `git+${repository}#${from.commit}${from.path === undefined ? '' : `&path:/${from.path}`}` }
```

- **npm**: spec `name@version` (exact version — the client "never installs `name@latest`", format note L186). `source.registry` (optional) → `registry` asked first for that install only, through `registryPlan()` (`packages/boot/plugin-manager/src/registry.ts` L54-76): a requested registry **not** in the configured set is asked **alone** (a private registry never falls back to a public one); one that is in the set is asked first, then the configured fallbacks.
- **git**: spec `git+https://…​.git#<sha>` with pnpm's `&path:/<dir>` for a package directory. `parseInstallSpec()` (`packages/boot/plugin-manager/src/install-spec.ts` L69-92) classifies it `kind: 'git'` via `GIT_URL`/`HOSTED_REPOSITORY_URL`. Tarball URLs and local paths are NOT producible from a market entry (only `npm` and `git` `source.type`s exist, validator `source()` L191-206).
- **Versions/channels**: versions array is sorted descending by `semver.rcompare` at parse time (validator `versions()` L255-266); **no channels in the shipped code** (see §5.4). The **default version** dsh offers is computed in `listingOf()` (boot/plugin-market/src/index.ts L476-495): the first (highest) version that is compatible, preferring a non-prerelease whenever the plugin has any stable version. The `plugin_market` tool tells the model: "A bundle result carries its default version, which is the one to install unless the user asks for another" (tools.ts L73).
- **Multiple indexes / same package**: indexes are browsed **one at a time** — `search(url, …)` takes exactly one configured URL (L363-367 refuses others with `plugin-market/unknown-index`); the UI has an index switcher (`marketMenu` locale). There is **no cross-index merge, dedup, or precedence**; within one index a duplicate `name` or duplicate exact `version` string makes the whole index invalid (validator L261, L309-310). Installation status is matched against profile bundles by package name only (`installationOf()` L497-507).
- **Official catalog vs custom market**: the Official catalog is not an index — it is `ON_DEMAND_BUNDLES` (runtime deps of the dsh installation; `packages/util/official-bundles/src/bundles.ts` L73-78) surfaced by `pluginManager.listBundles()` with an `installTarget` from `officialBundleInstallTarget()` (`packages/boot/plugin-manager/src/official-install-target.ts` L24-58): `name@<dsh version>` for a published install, `link:<workspace dir>` for a source checkout. The `plugin_manager` tool says: "For an Official catalog entry, pass list_bundles installTarget.spec to install_bundle" (plugin-manager/src/tools.ts L91). A market entry that names an already-provided official package shows status `provided` ("Provided by DSH", `installationOf()` L500-501, `availability: 'installation'`) and Discover refuses to install over it (DiscoverSection.tsx L157).

---

## 5. Index file format (authoritative)

Source of truth: `parseMarketIndex()` + helpers in `packages/util/plugin-market-index/src/index.ts`
(validating code quoted inline below), types in `src/types.ts`. Semantics: "Members the format does
not define are ignored and dropped" (doc comment L292) — **unknown fields never fail validation**;
the first violated rule throws `MarketIndexError(path, reason)`.

### 5.1 Top-level fields

| Field | Required | Rule (validator code) |
|---|---|---|
| `format` | **yes** | `if (object.format !== 1) fail('$.format', 'must be 1')` (L303). This is the **index format version**, independent of any package version. |
| `title` | **yes** | `localizedText(object.title, '$.title')` (L313) — a string or an object of language→string that **must contain `en`** (`if (!Object.hasOwn(text, 'en')) fail(path, 'must contain en')`, L73); language keys match `^[a-z]{2,8}(-[a-z0-9]{1,8})*$` (L28); every string has a non-whitespace char (`stringAt`, L56-59). |
| `description` | no | `LocalizedText` (L314). |
| `metadata` | no | `indexMetadata()` (L100-107) with three optional declaration maps, each defaulting `{}`: `categories`/`labels` = id → `{ title: LocalizedText }` (`declaration()`, L91-93); `sortKeys` = id → `{ title: LocalizedText, order: "asc"\|"desc" }` (`sortKeyDeclaration()` L95-98: `if (object.order !== 'asc' && object.order !== 'desc') fail(...)`). Declaration ids must be non-empty (`declarations()` L85). |
| `plugins` | **yes** | `if (!Array.isArray(object.plugins)) fail('$.plugins', 'must be an array')` (L305) — **may be empty** (test: "accepts an index without metadata or plugins"). Array order = the index's default display order. Duplicate plugin `name` in one index is invalid (L309-310). |

### 5.2 Per-plugin fields (`plugin()`, L268-289)

| Field | Required | Rule |
|---|---|---|
| `name` | **yes** | Valid npm package name, ≤214 chars: `PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u` (L29, check L271). Unique within the index. This is the install identity. |
| `title` | no | `LocalizedText` (L272). |
| `description` | no | `LocalizedText` (L273). |
| `icon` | no | `icon()` (L219-238): either a base64 `data:image/svg+xml\|png\|jpeg\|webp` URL with decoded payload ≤ 32 KiB (`MAX_INLINE_ICON_BYTES`, L42), or a URL reference **resolved against the index URL** whose result is `https:` or has the index URL's origin (`resolved.protocol !== 'https:' && (resolved.origin === 'null' || resolved.origin !== indexUrl.origin)` → fail, L236). So `icons/foo.svg` next to the index file works on any static host; http icons work only same-origin (loopback/intranet markets). |
| `author` | no | Non-empty string (L275). |
| `homepage` | no | Absolute http(s) URL; query/fragment **kept** (`homepageUrl()`, L158-165). |
| `repository` | no | `{ url, directory? }` (`repository()`, L184-189): `url` absolute http(s) **web page** without credentials/query/fragment (`httpUrl()`, L143-156); `directory` a relative path of segments matching `^[A-Za-z0-9._@+-]+$`, no `.`/`..` (`packagePath()`, L175-182). "display only, never an install source" (types.ts L35). |
| `metadata` | no | `pluginMetadata()` (L115-141): `category` (one **declared** category id, L117), `keywords` (array of free-form strings, order/duplicates/empties preserved, L118-124), `labels` (array of **distinct declared** label ids, L125-130), `sortKeys` (object of **declared** sort-key id → finite number, L131-139). A reference to an undeclared id fails the whole index (`declaredId()`, L109-113: `references undeclared id`). Absent → `{keywords: [], labels: [], sortKeys: {}}`. |
| `versions` | **yes** | Non-empty array (`versions()` L256: `must be a non-empty array`); exact `version` strings unique within the plugin (L261). Sorted descending SemVer on read (L265). |

### 5.3 Per-version fields (`marketVersion()`, L240-253)

| Field | Required | Rule |
|---|---|---|
| `version` | **yes** | Exact SemVer 2.0.0 string (`SEMVER` regex L32-36; check L243: `must be an exact SemVer version`). Build metadata allowed (test accepts `1.0.0-rc.1+build.5`). This is the **package version**; it must equal the installed manifest's version for install to be honest (generator obligation, unverifiable by readers). |
| `publishTimestamp` | **yes** | Integer Unix **seconds** in `[0, 10^11)` (L244-247: `must be an integer number of Unix seconds in [0, 10^11)`). |
| `source` | **yes** | `source()` (L191-206), one of exactly two forms: <br>• `{ "type": "npm", "registry"?: string }` — `registry` an http(s) URL without credentials/query/fragment (L195); absent = installing client's configured registries.<br>• `{ "type": "git", "url": string, "commit": string, "path"?: string }` — `url` **canonical https URL** equal to its own serialization, ≥2 path segments, no trailing-slash issue, not ending `.tgz`/`.tar.gz` (`gitUrl()`, L167-173); `commit` lowercase 40-hex SHA (`COMMIT`, L37; L200); `path` same rule as repository.directory (L201). Any other `type` → `must be "npm" or "git"` (L204). |
| `engines` | **no** (code) | `optional(object, 'engines', …) ?? {}` (L251). If present: object; `engines.dsh` if present must be a **valid SemVer range and not `workspace:*`** (`engines()`, L208-217: `must not be a workspace: range` / `must be a SemVer range`). Absent engines/dsh = "any DSH version" (types.ts L62-64). ⚠️ the design note says required — see §5.4. |

### 5.4 Divergence: Agent Note vs shipped validator

`.agents/notes/implemented/feature/2026-10-02-plugin-market-index-format.md` documents format 1
with (a) **required** `engines.dsh` per version (L139-140) and (b) a plugin-level **`dist-tags`**
channel map (L127, L169, L186: "The initial channel is `latest`"). The shipped validator
(last changed in commit `ab3bb7455`, 2026-10-14, which also touched the note) has **neither**:
`engines` is optional from the first commit (`3de3a977e0`, confirmed via `git log -S 'engines: optional'`),
and `dist-tags` never existed in `src/` (`git log -S 'dist-tags' -- packages/util/plugin-market-index/src packages/boot/plugin-market/src`
is empty) — it is dropped as an unknown member. Default-version selection is dsh-computed (§4),
not channel-based. Practical guidance: follow the note where it is **stricter** (always emit
`engines.dsh`; you may emit `dist-tags` for forward compatibility — today it is ignored), and treat
the parser as the compatibility floor.

### 5.5 Minimal valid example — REAL fixture

From `packages/boot/plugin-market/tests/built-worker.e2e.ts` (L26-31), the smallest index the
shipped service accepts and searches end-to-end (served over http in the test):

```json
{
  "format": 1,
  "title": "M",
  "plugins": [
    { "name": "p", "versions": [ { "version": "1.0.0", "publishTimestamp": 1, "source": { "type": "npm" } } ] }
  ]
}
```

A richer REAL example (unit-test fixture, `packages/util/plugin-market-index/tests/plugin-market-index.spec.ts`
L20-32 + L35-95; also the generator-style example in the format note L23-92) exercising every
optional field — note how the relative `icon` is resolved against the index URL and versions come
back sorted by descending SemVer:

```json
{
  "format": 1,
  "title": { "en": "Example Market", "zh": "示例市场" },
  "metadata": {
    "categories": { "productivity": { "title": "Productivity" } },
    "labels": { "official": { "title": { "en": "Official", "zh": "官方" } }, "ui": { "title": "UI" } },
    "sortKeys": { "downloads": { "title": "Downloads", "order": "desc" } }
  },
  "plugins": [
    {
      "name": "@scope/dsh-foo",
      "title": { "en": "Foo" },
      "description": "Does foo",
      "icon": "icons/foo.svg",
      "author": "Jane Doe",
      "homepage": "https://github.com/jane/dsh-foo#readme",
      "repository": { "url": "https://github.com/jane/dsh-plugins", "directory": "packages/foo" },
      "metadata": { "category": "productivity", "keywords": ["review"], "labels": ["official", "ui"], "sortKeys": { "downloads": 12 } },
      "versions": [
        { "version": "1.10.0", "publishTimestamp": 2, "source": { "type": "npm" }, "engines": {} },
        { "version": "1.2.3", "publishTimestamp": 1790476800, "source": { "type": "npm", "registry": "https://registry.example/" }, "engines": { "dsh": ">=0.2.0" } },
        { "version": "1.2.3-rc.1", "publishTimestamp": 1, "source": { "type": "npm" } }
      ]
    },
    {
      "name": "dsh-bar",
      "icon": "data:image/png;base64,iVBORw==",
      "versions": [
        { "version": "1.0.0-rc.1+build.5", "publishTimestamp": 0,
          "source": { "type": "git", "url": "https://gitlab.example/group/sub/repo", "commit": "3f9c2e1d8a4b6c0e7f1a2b3c4d5e6f708192a3b4", "path": "packages/bar" } }
      ]
    }
  ]
}
```

Both examples are from real dsh test fixtures (nothing constructed by me). Error behavior on bad
input is pinned by `packages/boot/plugin-market/tests/market.spec.ts` (e.g. `$.format must be 1`,
`$.plugins[0].versions[0].version must be an exact SemVer version`, `$ must be UTF-8`) and
`built-worker.e2e.ts` (invalid index → `plugin-market/invalid-index` with `path: '$.format'`).

---

## 6. Compatibility gating

Two layers, both via `evaluatePluginCompatibility()` in `packages/boot/app-boot/src/plugin-compatibility.ts` (L87-102):

1. **Listing layer (Discover/tool)** — `compatibilityOf()` (boot/plugin-market/src/index.ts L509-516) synthesizes a manifest `{ name, version, engines?: { dsh } }` **from the index only**; no engines → compatible with everything. `unmetRequirements()` (plugin-compatibility.ts L55-74): an own `engines.dsh` decides alone (`semver.satisfies(runtime, range, { includePrerelease: true })`, L51-53); otherwise (real installs only) every `@deepseek-ai/dsh`/`@deepseek-ai/dsh-*` peerDependency must match, with `workspace:^|~|*` meaning the current runtime. An incompatible-but-exempted version is reported `compatible: false, exempted: true`.
2. **Install layer (hard refusal)** — after `pnpm add` succeeds, `installBundle` reads the **real** installed manifest and re-evaluates: `if (compatibility !== undefined && !compatibility.exempted) throw new ManagementFailure('incompatible-version', …)` (plugin-manager/src/index.ts L985-986); a package without `dsh.bundle` → `not-bundle` (L984).

- **Default-version hiding**: `listingOf()` (index.ts L484-492) picks the highest compatible version (preferring stable); if none is compatible, `defaultVersion` is omitted and Discover shows a disabled Install ("no version is compatible with the running DSH"; ui-plugin-market README). Individual incompatible versions are still listed and tagged, and installation of them is refused by the dialog (`installable()` = compatible or exempted, DiscoverSection.tsx L73-74). **Nothing invalidates the index itself over compatibility.**
- **Version exemptions**: profile file `compatibility.json` (`PROFILE_COMPATIBILITY_FILENAME`, app-boot/src/profile-compatibility.ts L8) mapping exact `name@version` → list of exact dsh versions (`readProfileVersionExemptions()` L99-101; validation L62-93). Granted only explicitly with risk acknowledgement (`setProfileVersionExemption()` L113-141: "Incompatible plugins may cause crashes or data loss…"), via `plugin_manager set_version_exemption` or `dsh plugin allow-version`. An exemption can excuse a *valid* range that rejects the runtime; it cannot make a missing/invalid declaration eligible (format note L160).
- **Platform/arch, checksums, signatures**: **none exist** in the format or any reader — no `os`/`cpu`/`sha`/signature fields in the validator, `evaluatePluginCompatibility`, or `installBundle`; the format note's Risks section states "An index is unsigned" (L231) and dsh mitigates by showing the index URL, per-version source facts, and a trust notice at install confirmation (Discover note L23; ui-plugin-market README).

---

## 7. Install path from a market entry (brief)

Discover's Install → confirmation (icon, title, exact version, author, source facts, trust notice) →
shared Plugins install dialog at its check screen with the entry's exact spec and registry
(`install(spec, registry?)` owner prop; ui-plugin-market README; Discover note L23) →
`pluginManager.installBundle(spec, options)` (plugin-manager/src/index.ts L872-1012):

1. Spec/shape checks (L882-889; `already-installed` under HMR → must `remove_bundle` first, tools.ts L18).
2. `parseInstallSpec` classifies (install-spec.ts L69-92); GitHub connection pre-check; optional SSH-transport switch for other git hosts (L902-929).
3. `pnpm add <installSpec> [--save-exact] [--registry …]` per `registryPlan` with registry fallback only inside the configured set (L932-958; registry.ts L54-76). Failed runs surface `pendingBuilds` for the `approvedBuilds` flow (L966).
4. Manifest checks: `manifest.dsh.bundle` must exist (L984); compatibility re-check + exemptions (L985-986); bundle patch loaded (L987); bundle selected and reloaded (L1001-1008). Failures restore `package.json`/`pnpm-lock.yaml`.

**Minimum fields an index entry needs for end-to-end install**: plugin `name` (npm-valid, and the
real package's manifest name for a coherent install) + one version with exact SemVer `version`,
integer-seconds `publishTimestamp`, and `source` (`{"type":"npm"}` or git url+commit[+path]).
`engines` is optional for parsing but the *installed package's own* `engines.dsh`/dsh-peer ranges
and `dsh.bundle` declaration are what install actually enforces (§6) — so publish packages whose
manifests declare `dsh.bundle.patch` and are compatible with the running dsh line.

---

## 8. Publishing guidance implied by the code (for the dsharp index)

- **URL**: one absolute `http(s)` URL, no userinfo, no `#` (query allowed), in canonical serialization; serve **200 directly — any redirect fails** (`redirect: 'error'`). `https:` is strongly implied for public hosting (the Discover note flags http indexes as "altered in transit" risks); `http://127.0.0.1` is fine for local dev. Recommend publishing `https://<host>/dsharp/index.json`-style stable URLs since users paste them once and they persist in the profile.
- **Body**: UTF-8 JSON; **any content type** is accepted (none checked); ≤ 128 MiB (keep it far smaller — the whole file is parsed in a worker per refresh); served within 15 s; `content-length` honesty helps early size refusal. No GZIP requirement (undici handles standard encodings; nothing dsh-specific).
- **Icons**: ship them **beside the index** and reference relatively (`icons/x.svg`) — the validator resolves them against the index URL at read time, so the directory is relocatable; inline `data:` icons allowed up to 32 KiB decoded.
- **Updates**: no ETag/If-Modified-Since — dsh re-fetches the full body whenever the 10-minute TTL expires at the next browse, or when the user hits Refresh. There is no rate limit or polling; expect roughly one fetch per user per Discover visit after TTL. Publish new versions by regenerating the file; add entries only for versions whose packages actually exist (readers can't verify generator obligations — a misleading index is silent breakage; format note "Generator obligations" L162-172).
- **Version policy**: pin npm versions as `name@version` (exact), git versions as commit SHA + optional `path`. Include `engines.dsh` on every version (the note requires it; the code merely permits its absence). `publishTimestamp` = npm publish time / git committer time (seconds).
- **Reuse**: `apps/plugin-market-generator` is the reference generator (input list of npm names + git URLs → `index.json` + `icons/`); its README documents listing rules (only versions whose `package.json` declares `dsh.bundle` with `patch`, not private, etc.) and deterministic caching. dsharp can run it in CI or hand-write the small index — the format above is the full contract.

---

## 9. Open questions / gaps

- **Note-vs-code divergence (engines/dist-tags)**: the format Agent Note (updated after the last parser change) still documents required `engines.dsh` and `dist-tags` channels; the shipped parser has neither. If a future dsh release tightens validation to match the note, indexes relying on absent `engines` or on `dist-tags`-free channel semantics could change behavior. Mitigation: always emit `engines.dsh`; optionally also emit `dist-tags` (ignored today). No in-repo statement resolves which is intended going forward.
- **No official market**: the code confirms no default source; whether DeepSeek will later ship an official index (and whether custom indexes would then be deduped against it) is not answered by the source.
- **Prerelease-default nuance**: when a plugin has *only* prerelease versions, `listingOf()` (index.ts L484-488) will offer the highest prerelease as default — but the exact interplay with a future channel mechanism is undefined in code.
- **`maxBytes` vs. practical limits**: 128 MiB is the hard cap; nothing in the source recommends a practical size or entry count (the UI pages 50 at a time; the tool 25).
- **CDN caching of the index**: dsh sends `accept: application/json` and `redirect: 'error'`; whether a CDN in front of the index may serve `Vary`/compression edge cases is outside the source. No `cache-control` expectations are documented anywhere for the index itself.
- **Detail documents**: `readEntryDetail` reads long descriptions from npm file CDNs (jsdelivr/unpkg/npmmirror — `PUBLIC_REGISTRIES` is npmjs.org/npmmirror only, index.ts L89) or pinned git commits; a private-registry npm version gets detail only from the entry's `repository`. Whether dsharp wants to rely on this for README display is our choice, not answered by dsh.
- **Multiple dsharp indexes**: nothing prevents publishing several index files, but users add URLs one by one and browse one at a time; there is no "index of indexes" mechanism in the source.
