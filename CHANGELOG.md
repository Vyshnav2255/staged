# Changelog

All notable changes to staged.

## v1.2.0 · 26 Nov 2026

staged v1.2.0 is out 🦚 A big little update: tidier commits, a cosier home, and everything feels a bit bouncier.

### New
- **Sorts your messy changes like a tidy friend.** Big, mixed piles now split into much better commits, with names that actually say what changed.
- **A cosy new Home.** One line tells you how things stand ("Everything is saved", or what's waiting on you). Below it: your activity in staged greens, and the commits that are ready to go, folded per repo.
- **Puts heavy images on a diet.** Open Media and a tiny scale weighs your heavy images and videos. One click shrinks them (PNG to WebP, videos to H.264), the dot display counts down, and the links in your code get updated for you.
- **Tells you when it's safe to push.** A little pill on each suggestion, so you never guess.
- **The drag card follows you around.** Drag a file to another commit and a clear card sticks to your cursor until you drop it.
- **Running dots** in the sidebar show which repos have a dev server on. Home now lives in the repo list too, and there's a compact sidebar in Settings.
- **An Overview** for each repo, with Codebase and Repo weight side by side.
- **Stop anything.** Dev servers you started outside staged can be stopped from the Run deck now.

### Better
- **Everything feels a bit bouncier.** staged has its own springs now, tuned so menus pop, panels glide, and closing is always quicker than opening.
- Crisp hairline edges, a calmer stone palette and smaller leaf-green toggles.
- One quiet progress bar for the whole app, and pages cross-fade instead of jumping.
- Wheel scrolling stays inside the panel you're in.

### Fewer buttons, less thinking
- Gone: the "Try them" section, Copy notes, and Rename in the commit menus.
- The push check no longer trips over imports mentioned in comments.

## v1.1.0 · 21 Nov 2026

### New
- Added coffee, About and License to the README
- Added an About page
- Added the staged License

### Fixes
- Fixed badges and section links in the README view
- Made Run work on Windows and Linux without zsh

### Other
- Updated Buy Me a Coffee username in FUNDING.yml
- Made the README clone the latest release
- Updated README for 1.0

## v1.0.0 · 21 Nov 2026

### New
- Added Run, a cassette deck for each project's commands
- Added rename last commit and the file move button
- Updated ai
- Removed “you are here” and “commit, coloured by type”
- Updated release tooling
- Updated compare url and receipt spec in receipt
- Added GitHub release
- Added tiny Markdown view for notes and changelogs
- Added project settings
- Stripped Markdown from commit messages
- Removed “Your repos” and “last 12 weeks”
- Removed “Lines this week”
- Added “Sound”
- Added receipt image that turns a receipt or statement spec
- Updated commit: what a change says about itself, read without any model
- Added receipts and weekly statements

### Design
- Docked side panels inside the app

### Maintenance
- Removed categorise, tree weight and image report from insights
- Removed count up
- Removed the AI engine picker and its panel
- Added “Branches and stashes” and “Copy the command to delete it”
- Removed slide into place, push launch and push button done from fx
- Reworked branch card

### Other
- Released 1.0.0
- Cleaned up unused code and engine naming
- Updated documentation

## v0.1.0 · 18 Nov 2026

### New
- Updated engine
- Added a close sheet button
- Added ai
- Added a shared highlight that glides between repository rows
- Turned Today into Home
- Updated stats and page panel
- Added low-profile scrollbar treatment across 12 files
- Added release tooling
- Added in-app update flow
- Added settings view
- Updated commit routes in commit
- Added the gitmoji picker
- Added local indexes for feature grouping
- Added little moments, kept smooth
- Updated package
- Added commit grouping research
- Added glance rail
- Added staged's web server
- First version of staged

### Design
- Changed border from 1px line to .5px line-strong in 24 places
- Changed font-weight from 600 to 500 in 4 places
- Added keyboard shortcuts to palette
- Updated icons
- Updated app icons

### Maintenance
- Added terminal helpers
- Updated ignore rules
- Updated sidebar

### Other
- Updated documentation
