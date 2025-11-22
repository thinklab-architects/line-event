# Event

This project recreates the LINE NEWS glassmorphism interface and renders the Kaohsiung Architects Association event feed. scripts/scrape_events.py automatically scrapes the first five pages (
ews_list.php?t1=1&b=1~5) and writes normalized data to data/events.json. The frontend offers search, status filters, category filters (All / Outing / Meeting), remark display, PDF download preview, and dedicated registration buttons.

## Quick start

1. Install dependencies (only needed the first time or when re-scraping): pip install -r requirements.txt.
2. Launch any static server (needs to support Fetch):
   `sh
   python -m http.server 4173
   # or: npx serve .
   `
3. Navigate to http://localhost:4173.

## Refresh event data

`sh
py -3.10 -m pip install -r requirements.txt  # first run
py -3.10 scripts/scrape_events.py
`

The command prints how many records were written. Once completed, the download buttons, remarks, and registration links on the page are all up to date.

## Publish to GitHub Pages

1. Initialize the repo locally:
   `sh
   git init
   git add .
   git commit -m "feat: init line-event web"
   `
2. Create a public repo called line-event on GitHub.
3. Push: git remote add origin git@github.com:<YOUR_ACCOUNT>/line-event.git && git push -u origin main.
4. Enable **Pages** (Branch: main, Folder: /root).

> You can also publish via gh-pages or GitHub Actions if desired.
