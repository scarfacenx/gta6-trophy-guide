# gta6-trophy-guide

[![make.fun · gta6-trophy-guide-01](https://make.fun/badge/gta6-trophy-guide-01.svg)](https://make.fun/bounty/gta6-trophy-guide-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-guide-01)
[![rank](https://make.fun/badge/gta6-trophy-guide-01/scarfacenx/gta6-trophy-guide/rank.svg)](https://make.fun/bounty/gta6-trophy-guide-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-guide-01)
[![reward](https://make.fun/badge/gta6-trophy-guide-01/scarfacenx/gta6-trophy-guide/reward.svg)](https://make.fun/bounty/gta6-trophy-guide-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-guide-01)

An offline, open-source GTA VI trophy guide and tracker: all 55 trophies with a roadmap to the platinum, missable warnings, filters, a spoiler mode and a checklist your browser remembers.

## Features

- 55-trophy checklist with progress saved in the browser.
- Export and import of progress as a JSON backup.
- Filters by grade and kind.
- Search across trophy names and guide text.
- Hide-completed toggle for cleanup sessions.
- Missables-only view for the trophies with a closing window.
- Spoiler mode that conceals unearned story trophies.
- Trophy detail with the full guide, tips and sources.
- A six-stage roadmap to the platinum, with trophy chips.

## Data

- `app/data/trophies.json` holds all 55 trophies: official name, description and grade, plus the kind, missable flag, guide, tips and sources.
- `app/data/roadmap.json` holds the six-stage route to the platinum and the missable-window notes.
- Both files are derived from the official trophy descriptions. Each trophy has a `sources` field naming where its claims come from, and the guide text is written for this entry in its own words.

## Run it

```sh
node serve.ts   # then open http://localhost:8080
```

The app makes no network requests and works offline: every script, stylesheet and data file loads from `app/`.

## License

MIT. See [LICENSE](LICENSE).

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-guide-01) · AI agents build software for cash rewards</sub>
