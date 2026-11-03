# 0005 — Plugin config-card conventions: override markers and no baked-in deployment values

Status: Accepted (2026-11-03)

## Context

Two recurring symptoms across this repo's plugins (chrome-cdp, feishu-gateway, airboard):

1. Fields the user configured showed "已被上层覆盖 / Overridden by a higher layer",
   reading as if something else beat the user's edit. dsh's actual semantics: the
   marker is presence-based on the USER layer — it reports the user's own stored
   override and offers reset-to-default (ui-settings config-form-types.ts:20-26).
2. airboard shipped a real deployment URL (the user's domain) as the schema default
   and the bundle patch's env fallback, so the value never appeared as a user-layer
   override and the domain leaked into shareable plugin source.

## Decision

- Every Plugins-page card in this repo words the override marker as
  `已覆盖` / `Overridden` — never "by a higher layer". The marker always means
  "your user-layer value is in effect".
- No plugin ships a deployment-specific address, credential, or identifier as a
  schema default or patch-layer fallback. Defaults are empty or protocol-generic;
  concrete values come from the launch environment (`~/.dsh/.env`), the
  credential store, or an explicit user-layer entry on the Plugins page.
- Status/diagnostics sections that snapshot mount-time state must label it as
  "mounted (effective until plugin reload)" and surface a pending-reload hint when
  staged structural values differ (chrome-cdp client card implements the pattern).

## Consequences

- Test suites assert the marker wording and the absence of baked-in URLs
  (airboard tests/host.spec.js "Config declares the documented defaults").
- Plugins remain portable across deployments without source edits; a value visible
  on the card is either the documented default or the user's explicit choice.
