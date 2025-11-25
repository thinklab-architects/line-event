#!/usr/bin/env python3
"""Scrape the KAA activity list (first five pages) and save it as data/events.json.

The scraper now mirrors the faster approach used in thinklab-architects/line-code:
- reuse HTTP session headers
- fetch detail pages concurrently
- reuse existing detail data when available
"""

from __future__ import annotations

import json
import os
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable

import requests
from bs4 import BeautifulSoup

BASE_URL = 'https://www.kaa.org.tw'
LIST_URL = f'{BASE_URL}/news_list.php?t1=1'
HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Referer': 'https://www.kaa.org.tw/',
}
PAGE_COUNT = 5
DETAIL_CONCURRENCY = max(1, int(os.getenv('DETAIL_CONCURRENCY', '4') or 4))
DETAIL_DELAY = max(0.0, float(os.getenv('DETAIL_DELAY', '0') or 0))

CATEGORY_KEYWORDS = {
  'meeting': ['\u6703\u8b70', '\u7406\u4e8b', '\u7406\u76e3\u4e8b', '\u59d4\u54e1', '\u6703\u54e1', '\u5ea7\u8ac7', '\u5927\u6703', '\u8b70'],
  'outing': ['\u51fa\u904a', '\u65c5\u904a', '\u65c5\u884c', '\u53c3\u8a2a', '\u89c0\u6469', '\u904a\u7a0b', '\u5718\u904a'],
  'movie': ['\u96fb\u5f71', '\u5f71\u5c55', '\u5f71\u5531', '\u96fb\u5f71\u6d3b\u52d5', '\u6539\u7248\u64ad\u653e'],
  'workshop': ['\u8b1b\u7fd2', '\u8ab2\u7a0b', '\u7814\u7fd2', '\u57f9\u8a13', '\u8b1b\u5ea7', '\u8b1b\u5802', '\u5de5\u4f5c\u574a', '\u8a13\u7df4'],
}
CATEGORY_PRIORITY = ('movie', 'workshop', 'meeting', 'outing')
OUTING_MARKERS = ['\u904a']
DOWNLOAD_FIELD_NAMES = ('\u6a94\u6848\u4e0b\u8f09', '\u76f8\u95dc\u6a94\u6848', '\u76f8\u95dc\u6587\u4ef6')
REGISTER_FIELD_NAMES = ('\u5831\u540d',)
REMARK_FIELD_NAMES = ('\u5099\u8a3b', '\u5099\u8003', '\u6ce8\u610f\u4e8b\u9805')

session = requests.Session()
session.headers.update(HEADERS)


def clean_text(value: str | None) -> str:
  if not value:
    return ''
  return value.replace('\r', '').strip()


def fetch_text(url: str) -> str:
  response = session.get(url, timeout=30)
  response.raise_for_status()
  try:
    return response.content.decode('utf-8')
  except UnicodeDecodeError:
    return response.content.decode('big5', errors='ignore')


def fetch_list_html(page: int = 1) -> str:
  if page <= 1:
    return fetch_text(LIST_URL)
  return fetch_text(f'{LIST_URL}&b={page}')


def detect_category(title: str | None) -> str:
  if not title:
    return 'other'

  normalized = title.strip()

  for category in CATEGORY_PRIORITY:
    keywords = CATEGORY_KEYWORDS.get(category, [])
    if any(keyword in normalized for keyword in keywords):
      return category

  if any(marker in normalized for marker in OUTING_MARKERS):
    return 'outing'

  return 'other'


def extract_remarks(fields: dict[str, str | None]) -> str | None:
  for key, value in fields.items():
    if value and any(label in key for label in REMARK_FIELD_NAMES):
      return value
  return None


@lru_cache(maxsize=256)
def fetch_detail(
  detail_url: str,
) -> tuple[dict[str, str | None], list[dict[str, str]], dict[str, str | None]]:
  html = fetch_text(detail_url)
  soup = BeautifulSoup(html, 'html.parser')
  rows = soup.select('.addtable table tr') or soup.find_all('tr')
  fields: dict[str, str | None] = {}
  downloads: list[dict[str, str]] = []
  register_info: dict[str, str | None] = {}

  for row in rows:
    header = row.find('th')
    if not header:
      continue
    label = clean_text(header.get_text())
    if not label:
      continue
    normalized = label.replace('\uff1a', '').replace(':', '').strip()
    if not normalized:
      continue

    cell_texts = [
      clean_text(td.get_text('\n', strip=True))
      for td in row.find_all('td')
      if clean_text(td.get_text(strip=True))
    ]
    fields[normalized] = '\n'.join(cell_texts).strip() if cell_texts else None

    if any(name in normalized for name in DOWNLOAD_FIELD_NAMES):
      for link in row.select('a[href]'):
        url = urllib.parse.urljoin(BASE_URL, link['href'])
        label_text = clean_text(link.get_text()) or '檔案下載'
        downloads.append({'label': label_text, 'url': url})

    if any(name in normalized for name in REGISTER_FIELD_NAMES):
      link = row.find('a', href=True)
      if link:
        register_info = {
          'label': clean_text(link.get_text()) or fields.get(normalized) or '報名資訊',
          'url': urllib.parse.urljoin(BASE_URL, link['href']),
        }
      elif fields.get(normalized):
        register_info = {'label': fields[normalized], 'url': None}

  return fields, downloads, register_info


def parse_events(html: str) -> list[dict[str, Any]]:
  soup = BeautifulSoup(html, 'html.parser')
  table = soup.select_one('.mtable table')
  if table is None:
    return []

  events: list[dict[str, Any]] = []

  for row in table.select('tr'):
    cells = row.find_all('td')
    if not cells or not cells[0].get_text(strip=True):
      continue

    title_link = cells[0].find('a')
    title_text = clean_text(cells[0].get_text())
    detail_url = (
      urllib.parse.urljoin(BASE_URL, title_link['href'])
      if title_link and title_link.get('href')
      else None
    )
    location = clean_text(cells[1].get_text(' ', strip=True)) or None
    dates = [clean_text(value) for value in cells[2].stripped_strings if clean_text(value)]
    time_info = [clean_text(value) for value in cells[3].stripped_strings if clean_text(value)]

    note_link = cells[4].find('a') if len(cells) > 4 else None
    note_label = clean_text(note_link.get_text()) if note_link else None
    note_url = (
      urllib.parse.urljoin(BASE_URL, note_link['href'])
      if note_link and note_link.get('href')
      else None
    )

    register_link = None
    register_label = None
    for cell in cells[5:]:
      link = cell.find('a')
      if link and 'news_apply' in link.get('href', ''):
        register_link = urllib.parse.urljoin(BASE_URL, link['href'])
        register_label = clean_text(link.get_text()) or '線上報名'
        break

    events.append(
      {
        'title': title_text,
        'detailUrl': detail_url,
        'location': location,
        'dates': dates,
        'timeInfo': time_info,
        'note': note_label,
        'noteUrl': note_url,
        'register': register_label,
        'registerUrl': register_link,
        'extras': [],
        'category': detect_category(title_text),
      },
    )

  return events


def load_existing_map() -> dict[str, dict[str, Any]]:
  data_path = Path(__file__).resolve().parents[1] / 'data' / 'events.json'
  if not data_path.exists():
    return {}

  try:
    payload = json.loads(data_path.read_text(encoding='utf-8'))
  except (json.JSONDecodeError, OSError):
    return {}

  mapping: dict[str, dict[str, Any]] = {}
  for item in payload.get('events') or []:
    key = item.get('detailUrl') or item.get('title')
    if key:
      mapping[key] = item
  return mapping


def should_fetch_detail(existing_event: dict[str, Any] | None) -> bool:
  if not existing_event:
    return True

  has_downloads = bool(existing_event.get('downloads'))
  has_remarks = bool(existing_event.get('remarks'))
  has_register = bool(existing_event.get('registerUrl') or existing_event.get('register'))
  return not (has_downloads and has_remarks and has_register)


def enrich_with_details(events: list[dict[str, Any]], existing_map: dict[str, dict[str, Any]]):
  targets: list[tuple[int, str]] = []

  for index, event in enumerate(events):
    key = event.get('detailUrl') or event.get('title')
    existing = existing_map.get(key or '')

    # Merge list data onto existing detail cache (list data wins for basic fields)
    merged = {**(existing or {}), **event}
    events[index] = merged

    if event.get('detailUrl') and should_fetch_detail(existing):
      targets.append((index, event['detailUrl']))

  if not targets:
    return events

  with ThreadPoolExecutor(max_workers=DETAIL_CONCURRENCY) as executor:
    future_to_index = {executor.submit(fetch_detail, url): index for index, url in targets}
    for future in as_completed(future_to_index):
      index = future_to_index[future]
      event = events[index]
      try:
        fields, downloads, register_info = future.result()
      except Exception as error:  # noqa: BLE001
        print(f'Unable to load detail page {event.get("detailUrl")}: {error}')
        continue

      remarks = extract_remarks(fields)
      if remarks:
        event['remarks'] = remarks

      if register_info.get('label'):
        event['register'] = register_info['label']
      if register_info.get('url'):
        event['registerUrl'] = register_info['url']

      valid_downloads = [item for item in downloads if item.get('url')]
      if valid_downloads:
        event['downloads'] = valid_downloads

      if DETAIL_DELAY:
        time.sleep(DETAIL_DELAY)

  return events


def collect_events(page_count: int = PAGE_COUNT) -> list[dict[str, Any]]:
  seen = set()
  aggregated: list[dict[str, Any]] = []

  for page in range(1, page_count + 1):
    html = fetch_list_html(page)
    for event in parse_events(html):
      key = event.get('detailUrl') or event['title']
      if key in seen:
        continue
      seen.add(key)
      aggregated.append(event)

  existing_map = load_existing_map()
  enriched = enrich_with_details(aggregated, existing_map)
  return enriched


def write_payload(events: Iterable[dict[str, Any]]) -> Path:
  payload = {
    'sourceUrl': LIST_URL,
    'scrapedAt': datetime.now(timezone.utc).isoformat(),
    'events': list(events),
  }

  output_path = Path(__file__).resolve().parents[1] / 'data' / 'events.json'
  output_path.parent.mkdir(exist_ok=True, parents=True)
  output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
  return output_path


def main() -> None:
  events = collect_events(PAGE_COUNT)
  output_path = write_payload(events)
  print(f'Saved {len(events)} events to {output_path}')


if __name__ == '__main__':
  main()
