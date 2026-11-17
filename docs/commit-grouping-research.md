# Commit grouping research and engine review

Date: 2026-11-17

## Scope and method

Three parallel reviewers inspected public GitHub commit history and contributor guidance across more than 50 popular repositories. The review focused on subject wording, scope conventions, emoji use, and examples of related work being kept together or separated. History pages and guidance are useful for naming patterns, but generally do not expose enough diff context to infer a reliable universal file-count limit. The findings below are qualitative patterns, not a statistical ranking of every commit in each repository.

The sampled repositories were: VS Code, React, Next.js, Vite, Svelte, Vue, TypeScript, ESLint, Prettier, Node.js, Neovim, Deno, CPython, Homebrew, Ghostty, Home Assistant, Ollama, Ruff, FastAPI, Laravel, Ansible, PyTorch, LLVM, Bitcoin Core, etcd, Supabase, Godot, Element, Zed, Obsidian, Blender, Nextcloud, Signal Desktop, Telegram Desktop, FreeCAD, LocalSend, Tauri, Prism Launcher, GIMP, Flutter, Appwrite, n8n, Jitsi Meet, freeCodeCamp, PDF.js, Penpot, Mattermost, Appsmith, KeePassXC, Audacity, Krita, Bitwarden, Standard Notes, Tailwind CSS, Django, Rails, Terraform, Kubernetes, Rust Clippy, Angular, Docker CLI, and Redis.

Representative primary sources: [VS Code history](https://github.com/microsoft/vscode/commits/main), [React history](https://github.com/facebook/react/commits), [Django history](https://github.com/django/django/commits), [Kubernetes history](https://github.com/kubernetes/kubernetes/commits), [Docker CLI contribution guidance](https://github.com/docker/cli/blob/master/CONTRIBUTING.md), [Penpot history](https://github.com/penpot/penpot/commits/develop), [Audacity history](https://github.com/audacity/audacity/commits/master), [FastAPI history](https://github.com/fastapi/fastapi/commits/master), and [Conventional Commit guidance in shadcn/ui](https://github.com/shadcn-ui/ui/blob/main/CONTRIBUTING.md).

## Learnings

1. **Commit around one coherent change.** Keep implementation, tests, and wiring together when they deliver one behavior. Split independent fixes, features, refactors, releases, and dependency updates even when they touch neighboring files.
2. **Use the repository's own voice.** `type(scope): subject`, area-prefixed subjects, issue-first subjects, and natural action-led subjects all appear in maintained projects. No single syntax is universal. Staged's own history currently has only two commits, so its style signal is too small to justify a rigid format.
3. **Name the behavior or intent.** Subjects such as “update files” and labels derived only from filenames give little review value. Prefer a concrete verb and changed behavior; mention scope when it disambiguates.
4. **Treat emoji as an opt-in style.** Most sampled projects do not lead every subject with an emoji. Some repositories, including Penpot and FastAPI, use project-specific emoji conventions. Learn and follow a repo's convention; otherwise, avoid forcing decorative emoji into a Conventional Commit subject.
5. **Do not use a universal file-count threshold.** A small feature can span several files, while unrelated changes can share one file. Grouping evidence should come from intent, imports/wiring, coherent same-file hunks, learned co-change patterns, and explicit user corrections.
6. **Keep confidence honest.** A chain of weak semantic similarities should not be presented as a high-confidence commit. Broad cross-file groups should remain reviewable, and low confidence should prompt review instead of being inflated to meet a target.
7. **Filter history noise.** Merge commits, bots, generated release entries, and dependency automation can overwhelm style learning. Prefer authored, non-merge examples and treat automation as a distinct commit category.

## Current staged comparison

The worktree changed during this review. The final plan snapshot contains 28 changed paths, with 6,030 additions and 796 removals. At the start, the previous engine produced 14 suggestions and marked 3 groups for review. In that earlier 39-path snapshot, “App server” combined 12 paths spanning the app server, Apple Intelligence bridge, grouping engine, and writer; “Settings” combined 16 paths across settings, dashboard, brand assets, and styles. Those cross-feature bundles were too broad to present as confident commits. Because the worktree changed during the run, treat the before/after counts as two snapshots rather than a controlled benchmark.

After the grouping update, the final 28-path snapshot produces 22 suggestions and marks 2 cross-file groups for review. A first attempt yielded 53 suggestions because it split hunk nodes without preserving same-file cohesion; the corrected pass now keeps hunks from one file together while requiring stronger evidence to connect separate files. The remaining review groups are the app-server/Apple bridge (0.86) and commit-view/engine integration (0.85). These scores are evidence scores, not measured probabilities of correctness.

The independent grouping review would treat these as likely change themes, then split by actual diff intent where needed: grouping/index and machine-readable plan support; Apple Intelligence/app server integration; settings and settings UI wiring; commit review and emoji picker UI; branding/PWA assets; in-app updating; release tooling; dashboard/today/glance; motion/sound helpers; documentation. Because several files contain multiple unrelated hunks, a final human commit plan should inspect the hunks before merging the 23 suggestions into these broader themes.

## Engine changes made

- Added a minimum join evidence threshold of 0.83 when splitting weakly connected cross-file groups after clustering. Strong links such as imports, same-file chunks, learned pairs, and repeated co-change links can remain together.
- Preserved same-file hunks during the split pass after an initial run showed that splitting hunk nodes alone created 53 suggestions from 39 paths.
- Added focused message categories for ignore-rule changes, release tooling, and terminal helpers. These now use `chore` with `🙈`, `🔖`, and `🔧` respectively, instead of being labeled as generic features.
- Exposed the join threshold in the machine-readable plan metadata so coding tools can inspect the engine setting alongside each group, subject, emoji, evidence, and confidence.

## Limits and next measurement

The GitHub sample is suitable for qualitative style and workflow patterns, not claims about exact commit size or a benchmark score. This plan has not been checked against a human-approved grouping for the current worktree, so it cannot establish a measured accuracy or “90%” success rate. The next useful learning signal is explicit accept, merge, split, rename, and emoji correction feedback persisted per repository; confidence calibration should then compare predictions against those outcomes.
