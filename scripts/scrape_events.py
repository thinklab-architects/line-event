#!/usr/bin/env python3
"""Scrape the KAA activity list and save it as data/events.json."""

from __future__ import annotations

import json
import urllib.parse
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any

import requests
from bs4 import BeautifulSoup

LIST_URL = 'https://www.kaa.org.tw/news_list.php?t1=1'
BASE_URL = 'https://www.kaa.org.tw/'
HEADERS = {'User-Agent': 'Mozilla/5.0 (Event scraper)'}
MEETING_KEYWORDS = ['會議', '理事', '委員', '會員', '議']
OUTING_KEYWORDS = ['出遊', '旅遊', '旅行', '參訪', '觀摩', '遊', '遊程']


def fetch_text(url: str) -> str:
  response = requests.get(url, headers=HEADERS, timeout=30)
  response.raise_for_status()
  try:
    return response.content.decode('utf-8')
  except UnicodeDecodeError:
    return response.content.decode('big5', errors='ignore')


def fetch_list_html() -> str:
  return fetch_text(LIST_URL)


def detect_category(title: str | None) -> str:
  if not title:
    return 'other'

  if any(keyword in title for keyword in MEETING_KEYWORDS):
    return 'meeting'

  if any(keyword in title for keyword in OUTING_KEYWORDS):
    return 'outing'

  return 'other'


@lru_cache(maxsize=128)
def fetch_detail_fields(detail_url: str) -> dict[str, str | None]:
  html = fetch_text(detail_url)
  soup = BeautifulSoup(html, 'html.parser')
  fields: dict[str, str | None] = {}

  for row in soup.select('table tr'):
    header = row.find('th')
    if not header:
      continue

    label = header.get_text(strip=True)
    if not label:
      continue

    normalized = label.replace('：', '').replace(':', '').strip()
    if not normalized:
      continue

    value_parts = [
      td.get_text('\n', strip=True).replace('\r', '')
      for td in row.find_all('td')
      if td.get_text(strip=True)
    ]
    fields[normalized] = '\n'.join(value_parts).strip() if value_parts else None

  return fields


def parse_events(html: str) -> list[dict[str, Any]]:
  soup = BeautifulSoup(html, 'html.parser')
  table = soup.select_one('.mtable table')
  if table is None:
    raise RuntimeError('Unable to locate the event table in the HTML payload.')

  events: list[dict[str, Any]] = []

  for row in table.select('tr'):
    cells = row.find_all('td')
    if not cells:
      continue

    title_text = cells[0].get_text(strip=True)
    if not title_text:
      continue

    title_link = cells[0].find('a')
    detail_url = urllib.parse.urljoin(BASE_URL, title_link['href']) if title_link and title_link.get('href') else None
    location = cells[1].get_text(separator=' ', strip=True) or None
    dates = [value.strip() for value in cells[2].stripped_strings if value.strip()]
    time_info = [value.strip() for value in cells[3].stripped_strings if value.strip()]

    note_link = cells[4].find('a') if len(cells) > 4 else None
    note_label = note_link.get_text(strip=True) if note_link else None
    note_url = urllib.parse.urljoin(BASE_URL, note_link['href']) if note_link and note_link.get('href') else None

    register_link = cells[5].find('a') if len(cells) > 5 else None
    register_label = register_link.get_text(strip=True) if register_link else None
    register_url = urllib.parse.urljoin(BASE_URL, register_link['href']) if register_link and register_link.get('href') else None

    extras: list[dict[str, str | None]] = []
    if len(cells) > 6:
      for cell in cells[6:]:
        link = cell.find('a')
        if link and link.get('href'):
          extras.append(
            {
              'label': link.get_text(strip=True) or None,
              'url': urllib.parse.urljoin(BASE_URL, link['href']),
            }
          )

    detail_fields: dict[str, str | None] = {}
    if detail_url:
      try:
        detail_fields = fetch_detail_fields(detail_url)
      except requests.RequestException as error:
        print(f'Unable to load detail page {detail_url}: {error}')

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
        'registerUrl': register_url,
        'extras': extras,
        'category': detect_category(title_text),
        'remarks': detail_fields.get('備註') if detail_fields else None,
      }
    )

  return events


def write_payload(events: list[dict[str, Any]]) -> Path:
  payload = {
    'sourceUrl': LIST_URL,
    'scrapedAt': datetime.now(timezone.utc).isoformat(),
    'events': events,
  }

  output_path = Path(__file__).resolve().parents[1] / 'data' / 'events.json'
  output_path.parent.mkdir(exist_ok=True, parents=True)
  output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
  return output_path


def main() -> None:
  html = fetch_list_html()
  events = parse_events(html)
  output_path = write_payload(events)
  print(f'Saved {len(events)} events to {output_path}')


if __name__ == '__main__':
  main()
