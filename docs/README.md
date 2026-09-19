# 1stSeen documentation

Everything behind [1stseen.win](https://1stseen.win), grouped by what you want to know. Start with
[How 1stSeen is built](architecture.md) for the whole picture.

## How the product works

| Document | What it covers |
| --- | --- |
| [How 1stSeen is built](architecture.md) | The product contract, collection, the forecast engine, the data model, and the commands behind each |
| [Product scope](role-scope.md) | Which early-career technical roles are tracked, and how a role is classified in or out |
| [Forecasting methodology](forecasting-methodology.md) | The statistical model that produces every opening date, window, and confidence score |
| [Backtesting methodology](backtesting-methodology.md) | How forecasts are tested against past openings without seeing the future |
| [Recruiting signals](recruiting-signals.md) | Supporting evidence from career pages and news, and why it never moves a date |
| [Readiness methodology](readiness-methodology.md) | How a prep plan works back from a likely opening date |
| [Watchlists and personalization](watchlists-and-personalization.md) | Following programs, the first-run questions, and how saved picks carry into an account |
| [Guest access](guest-access.md) | What a visitor without an account sees, the guest limits, and the edge cache |
| [Recruiting agent](recruiting-agent.md) | The question-answering service behind Ask, and what it may and may not do |
| [Email digests](email-intelligence-digests.md) | The optional email summary of a watchlist |
| [Google Calendar](google-calendar-integration.md) | Syncing likely dates and prep deadlines to a calendar |
| [Account data](account-data.md) | Exporting everything an account holds, and deleting it |
| [Design system](design-system.md) | Tokens, icons, components, and accessibility rules for the web app |
| [Credits](credits.md) | Artwork, typefaces, and icons the web app ships, with their licenses |

## Running it

| Document | What it covers |
| --- | --- |
| [Local development](local-development.md) | Running the whole product on one machine, with no hosted accounts |
| [Production checklist](PRODUCTION_CHECKLIST.md) | Going from accounts to a live, collecting site, step by step |
| [Deployment](deployment.md) | The three services, their secrets, deploys, and rollbacks |
| [Hosted Supabase setup](hosted-supabase-setup.md) | Standing up the production database |
| [Scheduled collection](github-actions-collection.md) | The GitHub Actions workflows that collect, forecast, back up, and check health |
| [Operations](operations.md) | Alerts, health checks, backups and restores, quotas, and rolling back the web app |
| [Takedown](takedown.md) | Stopping collection for a company, or removing it, when asked |

## Reviews

| Document | What it covers |
| --- | --- |
| [Security review](security-audit.md) | Trust boundaries, fixes made, and the controls that remain |
| [Forecasting audit](forecasting-audit.md) | A review of the model, the leakage paths closed, and its known limits |
| [Collection reliability audit](scraping-reliability-audit.md) | How each kind of source fails, and what collection does when it does |
| [Google sign-in test plan](oauth-manual-test-plan.md) | The manual checks for the Google Calendar and Gmail connections |
