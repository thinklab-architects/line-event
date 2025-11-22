#!/usr/bin/env python3
"""Scrape the KAA activity list (first five pages) and save it as data/events.json."""

from __future__ import annotations

import json
import urllib.parse
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any

import requests
from bs4 import BeautifulSoup

BASE_URL = 'https://www.kaa.org.tw'
LIST_URL = f'{BASE_URL}/news_list.php?t1=1'
HEADERS = {'User-Agent': 'Mozilla/5.0 (Event scraper)'}
PAGE_COUNT = 5
CATEGORY_KEYWORDS = {
  'meeting': ['會議', '理事', '理監事', '委員', '會員', '座談', '大會', '議'],
  'outing': ['出遊', '旅遊', '旅行', '參訪', '觀摩', '遊程', '團遊'],
  'movie': ['電影', '影展', '影視', '電影欣賞', '影片', '放映'],
  'workshop': ['講習', '課程', '研習', '培訓', '講座', '講堂', '工作坊', '訓練'],
  'other': ['其他'],
}
CATEGORY_PRIORITY = ('movie', 'workshop', 'meeting', 'outing')
OUTING_MARKERS = ['遊']
DOWNLOAD_FIELD_NAMES = ('檔案下載', '相關檔案', '相關文件')
REGISTER_FIELD_NAMES = ('報名',)
REMARK_FIELD_NAMES = ('備註', '備考', '注意事項')


def fetch_text(url: str) -> str:
  response = requests.get(url, headers=HEADERS, timeout=30)
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
  
  # Check priority categories first
  for category in CATEGORY_PRIORITY:
    keywords = CATEGORY_KEYWORDS.get(category, [])
    if any(keyword in normalized for keyword in keywords):
      return category

  # Fallback checks
  if any(marker in normalized for marker in OUTING_MARKERS):
    return 'outing'

  return 'other'
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
    label = header.get_text(strip=True)
    if not label:
      continue
    normalized = label.replace('：', '').replace(':', '').strip()
    if not normalized:
      continue

    cell_texts = [
      td.get_text('\n', strip=True).replace('\r', '')
      for td in row.find_all('td')
      if td.get_text(strip=True)
    ]
    fields[normalized] = '\n'.join(cell_texts).strip() if cell_texts else None

    if any(name in normalized for name in DOWNLOAD_FIELD_NAMES):
      for link in row.select('a[href]'):
        url = urllib.parse.urljoin(BASE_URL, link['href'])
        label_text = link.get_text(strip=True) or '檔案下載'
        downloads.append({'label': label_text, 'url': url})

    if any(name in normalized for name in REGISTER_FIELD_NAMES):
      link = row.find('a', href=True)
      if link:
        register_info = {
          'label': link.get_text(strip=True) or fields[normalized] or '線上報名',
          'url': urllib.parse.urljoin(BASE_URL, link['href']),
        }
      elif fields[normalized]:
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
    title_text = cells[0].get_text(strip=True)
    detail_url = (
      urllib.parse.urljoin(BASE_URL, title_link['href'])
      if title_link and title_link.get('href')
      else None
    )
    location = cells[1].get_text(' ', strip=True) or None
    dates = [value.strip() for value in cells[2].stripped_strings if value.strip()]
    time_info = [value.strip() for value in cells[3].stripped_strings if value.strip()]

    note_link = cells[4].find('a') if len(cells) > 4 else None
    note_label = note_link.get_text(strip=True) if note_link else None
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
        register_label = link.get_text(strip=True) or '線上報名'
        break

    detail_fields: dict[str, str | None] = {}
    downloads: list[dict[str, str]] = []
    detail_register: dict[str, str | None] = {}
    if detail_url:
      try:
        detail_fields, downloads, detail_register = fetch_detail(detail_url)
      except requests.RequestException as error:
        print(f'Unable to load detail page {detail_url}: {error}')

    if detail_register.get('url') and not register_link:
      register_link = detail_register['url']
      register_label = detail_register.get('label')
    elif detail_register.get('label') and not register_label:
      register_label = detail_register['label']

    remarks = None
    for key, value in detail_fields.items():
      if value and any(label in key for label in REMARK_FIELD_NAMES):
        remarks = value
        break

    valid_downloads = [item for item in downloads if item.get('url')]

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
        'remarks': remarks,
        'downloads': valid_downloads,
      },
    )

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

  return aggregated


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
  events = collect_events(PAGE_COUNT)
  output_path = write_payload(events)
  print(f'Saved {len(events)} events to {output_path}')


if __name__ == '__main__':
  main()
