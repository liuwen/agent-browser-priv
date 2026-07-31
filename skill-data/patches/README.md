# Skillbread agent-browser overlay

`skillbread-agent-browser.patch` contains the private customization applied to the latest official `skill-data/core/` skill after it is copied to `/Users/liuwen/work/foundation/skillbread/skills/agent-browser/`.

The patch deliberately contains only the Skillbread identity change, the pnpm installation preference, and the private Patchright provider and upgrade guidance. Official command and reference content remains in the clean Skillbread vendor snapshot so future upstream changes are easy to distinguish.

## Refresh procedure

1. Fetch `upstream/main` in this repository.
2. Copy `upstream/main:skill-data/core/` to Skillbread's `skills/agent-browser/`.
3. In Skillbread, run `just vendor-snapshot agent-browser` before applying local changes.
4. From the Skillbread root, apply this patch with `git apply /Users/liuwen/work/agent-browser-priv/skill-data/patches/skillbread-agent-browser.patch`.
5. Resolve upstream drift, update `skills.json`, then run `just validate`, `just doctor`, and `just install`.
6. Regenerate the patch by diffing the clean vendor snapshot against the customized `skills/agent-browser/` tree.

Do not copy the old direct-backend guidance from the private fork. The supported customization is the external provider selected with `--provider patchright`.
