# Branch protection setup — `main`

This guide locks down the `main` branch so nothing can be merged while CI is
broken. It is a one-time setup done in the GitHub web UI by a repo admin.

> Repo: **`ros190392-source/cbw-kz`** · Protected branch: **`main`**

---

## 1. Why this matters for CBW KZ

CBW KZ is a **trusted** crypto media system. Its editorial quality lives in code:

- the **scoring layer** decides what is worth publishing (KZ relevance, exchange/
  bonus priority, hype/noise rejection),
- the **scoring regression tests** pin that behaviour,
- the **manual approval / draft-only** safety logic must never silently break.

CI already runs `typecheck` + the scoring tests on every push and PR. But CI
only *reports* failures — by itself it does not *stop* a bad merge. Branch
protection makes the green CI check **mandatory**: a change that breaks type
safety, mis-ranks Kazakhstan/bonus news, lets meme-coin hype through, or breaks
the approval flow simply **cannot reach `main`**. Quality is enforced by the
platform, not by anyone remembering to check.

---

## 2. Where to configure it (exact UI path)

```
GitHub repo → Settings → Branches → Branch protection rules → Add rule
```

(On newer GitHub UIs this may read **Settings → Rules → Rulesets**, but the
classic **Branch protection rules → Add branch protection rule** still works and
is what this guide uses.)

---

## 3. Branch name pattern

In **Branch name pattern**, enter exactly:

```
main
```

---

## 4. Required settings (turn these ON)

| Setting | Why |
|---|---|
| ✅ **Require a pull request before merging** | No direct pushes to `main`; every change is reviewed via PR |
| ✅ **Require status checks to pass before merging** | The merge button stays disabled until CI is green |
| ✅ → select check: **`Typecheck & scoring tests`** | This is the CI job that runs `npm run typecheck` + `npm run test` (workflow **CI**, defined in `.github/workflows/ci.yml`) |
| ✅ **Require branches to be up to date before merging** | Forces the PR to re-run CI against the latest `main` before merge |
| ✅ **Do not allow bypassing the above settings** | Applies the rules to admins too — no silent overrides |

> The status check name comes from the **job name** in the workflow. Our job is
> `Typecheck & scoring tests`, so that is the exact name to search for and tick
> in the status-checks box.

Click **Create** (or **Save changes**) at the bottom.

---

## 5. Optional (recommended) settings

| Setting | Why |
|---|---|
| ☑️ **Require conversation resolution before merging** | All PR review comments must be resolved first |
| ☑️ **Require linear history** | Keeps `main` a clean, bisectable line (squash/rebase merges only) |

These are nice-to-have hygiene settings; the four required ones above are what
actually protect editorial quality.

---

## 6. How to verify protection works

1. Create a throwaway branch and deliberately break a test, e.g. change an
   expectation in `tests/scoring-layer.test.ts`:
   ```bash
   git checkout -b test/protection-check
   # edit a test so it fails, then:
   git commit -am "ci: intentional failing test (do not merge)"
   git push -u origin test/protection-check
   ```
2. Open a Pull Request into `main`.
3. On the PR you should see the **`Typecheck & scoring tests`** check run and
   go **red**, and the **Merge** button should be **blocked** with
   *"Required statuses must pass before merging."*
4. Delete the branch / close the PR. Protection confirmed.

A passing change (green check) will instead show the Merge button enabled —
that is the normal, healthy state.

---

## 7. If the CI check name does not appear in the list yet

GitHub only offers a status check in the dropdown **after it has run at least
once**. If `Typecheck & scoring tests` isn't selectable:

1. **Wait for the first CI run to finish.** After the initial push, open the
   **Actions** tab and let the **CI** workflow complete once on `main`.
2. **Trigger a run** if needed — push a tiny change, e.g.:
   ```bash
   # add a blank line to README, then:
   git commit -am "docs: trigger CI" && git push
   ```
3. **Refresh the branch protection page.** Re-open
   *Settings → Branches → (your rule) → Edit*; the
   **`Typecheck & scoring tests`** check should now be searchable. Tick it and
   save.

Until then you can still create the rule with the other settings and add the
status check immediately after the first run.
