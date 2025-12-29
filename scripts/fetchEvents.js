#!/usr/bin/env node
/**
 * Scrape KAA events (first five list pages) and write to data/events.json.
 * Ported from the Python scraper to JavaScript, following the line-code pattern.
 */

import fsPromises from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'cheerio';

const BASE_URL = 'https://www.kaa.org.tw';
const LIST_URL = `${BASE_URL}/news_list.php?t1=1`;
const PAGE_COUNT = 5;
const DETAIL_CONCURRENCY = Math.max(1, Number(process.env.DETAIL_CONCURRENCY) || 4);
const DETAIL_DELAY_MS = Math.max(0, Number(process.env.DETAIL_DELAY_MS) || 0);

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  Referer: 'https://www.kaa.org.tw/',
};

const CATEGORY_KEYWORDS = {
  meeting: ['會議', '理事', '理監事', '委員', '會員', '座談', '大會', '議'],
  outing: ['出遊', '旅遊', '旅行', '參訪', '觀摩', '遊程', '團遊'],
  movie: ['電影', '影展', '影唱', '電影活動', '改版播放'],
  workshop: ['講習', '課程', '研習', '培訓', '講座', '講堂', '工作坊', '訓練'],
};
const CATEGORY_PRIORITY = ['movie', 'workshop', 'meeting', 'outing'];
const OUTING_MARKERS = ['遊'];
const DOWNLOAD_FIELD_NAMES = ['檔案下載', '相關檔案', '相關文件'];
const REGISTER_FIELD_NAMES = ['報名'];
const REMARK_FIELD_NAMES = ['備註', '備考', '注意事項'];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cleanText(value) {
  return value?.replace(/\r/g, '').trim() ?? '';
}

function decodeBody(arrayBuffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(arrayBuffer);
  } catch {
    try {
      return new TextDecoder('big5').decode(arrayBuffer);
    } catch {
      return Buffer.from(arrayBuffer).toString();
    }
  }
}

async function fetchPage(url) {
  const response = await fetch(url, { headers: DEFAULT_HEADERS });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  const buffer = await response.arrayBuffer();
  return decodeBody(buffer);
}

function buildListUrl(pageNumber = 1) {
  if (pageNumber <= 1) return LIST_URL;
  const url = new URL(LIST_URL);
  url.searchParams.set('b', String(pageNumber));
  return url.toString();
}

function detectCategory(title) {
  if (!title) return 'other';
  const normalized = title.trim();

  for (const category of CATEGORY_PRIORITY) {
    const keywords = CATEGORY_KEYWORDS[category] || [];
    if (keywords.some((word) => normalized.includes(word))) {
      return category;
    }
  }

  if (OUTING_MARKERS.some((marker) => normalized.includes(marker))) {
    return 'outing';
  }

  return 'other';
}

function normalizeLabel(label) {
  return cleanText(label).replace(/[:：]/g, '');
}

function absoluteUrl(value) {
  if (!value) return null;
  try {
    return new URL(value, LIST_URL).toString();
  } catch {
    return null;
  }
}

function parseEvents(html) {
  const $ = load(html);
  const table = $('.mtable table').first();
  if (!table.length) return [];

  const events = [];
  table
    .find('tr')
    .slice(1)
    .each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length < 5) return;

      const titleCell = $(cells[0]);
      const titleLink = titleCell.find('a').first();
      const title = cleanText(titleCell.text());
      const detailUrl = absoluteUrl(titleLink.attr('href'));

      const location = cleanText($(cells[1]).text()) || null;
      const dateCell = $(cells[2]);
      dateCell.find('br').replaceWith('\n');
      const dates = cleanText(dateCell.text())
        .split(/\s+/)
        .map((value) => value.trim())
        .filter(Boolean);
      const timeInfo = cleanText($(cells[3]).text())
        .split(/\s+/)
        .map((value) => value.trim())
        .filter(Boolean);

      const noteLink = $(cells[4]).find('a').first();
      const note = noteLink.length ? cleanText(noteLink.text()) : null;
      const noteUrl = noteLink.length ? absoluteUrl(noteLink.attr('href')) : null;

      let register = null;
      let registerUrl = null;
      for (let i = 5; i < cells.length; i += 1) {
        const link = $(cells[i]).find('a').first();
        const href = link.attr('href');
        if (href && href.includes('news_apply')) {
          registerUrl = absoluteUrl(href);
          register = cleanText(link.text()) || '線上報名';
          break;
        }
      }

      events.push({
        title,
        detailUrl,
        location,
        dates,
        timeInfo,
        note,
        noteUrl,
        register,
        registerUrl,
        extras: [],
        category: detectCategory(title),
      });
    });

  return events;
}

function parseDetail(html) {
  const $ = load(html);
  const rows = $('.addtable table tr').toArray();
  const fields = {};
  const downloads = [];
  let registerInfo = {};

  rows.forEach((row) => {
    const header = $(row).find('th').first();
    const label = normalizeLabel(header.text());
    if (!label) return;

    const values = $(row)
      .find('td')
      .toArray()
      .map((td) => cleanText($(td).text()))
      .filter(Boolean);
    fields[label] = values.join('\n') || null;

    if (DOWNLOAD_FIELD_NAMES.some((name) => label.includes(name))) {
      $(row)
        .find('a[href]')
        .each((_, link) => {
          const url = absoluteUrl($(link).attr('href'));
          if (!url) return;
          const labelText = cleanText($(link).text()) || '檔案下載';
          downloads.push({ label: labelText, url });
        });
    }

    if (REGISTER_FIELD_NAMES.some((name) => label.includes(name))) {
      const link = $(row).find('a[href]').first();
      if (link.length) {
        registerInfo = {
          label: cleanText(link.text()) || fields[label] || '報名資訊',
          url: absoluteUrl(link.attr('href')),
        };
      } else if (fields[label]) {
        registerInfo = { label: fields[label], url: null };
      }
    }
  });

  return { fields, downloads, registerInfo };
}

function extractRemarks(fields) {
  return Object.entries(fields).find(([key, value]) => value && REMARK_FIELD_NAMES.some((label) => key.includes(label)))?.[1] || null;
}

async function fetchDetailSafe(detailUrl) {
  const html = await fetchPage(detailUrl);
  return parseDetail(html);
}

function shouldFetchDetail(existing) {
  if (!existing) return true;
  const hasDownloads = Array.isArray(existing.downloads) && existing.downloads.length > 0;
  const hasRemarks = Boolean(existing.remarks);
  const hasRegister = Boolean(existing.registerUrl || existing.register);
  return !(hasDownloads && hasRemarks && hasRegister);
}

function loadExistingMap() {
  const dataPath = path.resolve(__dirname, '../data/events.json');
  try {
    const raw = fs.readFileSync(dataPath, 'utf8');
    const payload = JSON.parse(raw);
    const map = new Map();
    (payload.events || []).forEach((event) => {
      const key = event.detailUrl || event.title;
      if (key) map.set(key, event);
    });
    return map;
  } catch {
    return new Map();
  }
}

async function enrichWithDetails(events, existingMap) {
  const merged = events.map((evt) => {
    const key = evt.detailUrl || evt.title;
    const cached = key ? existingMap.get(key) : null;
    return cached ? { ...cached, ...evt } : evt;
  });

  const targets = merged
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.detailUrl && shouldFetchDetail(existingMap.get(event.detailUrl || event.title)));

  if (!targets.length) return merged;

  let next = 0;
  const worker = async () => {
    while (true) {
      const current = next;
      next += 1;
      if (current >= targets.length) break;

      const { event, index } = targets[current];
      try {
        const { fields, downloads, registerInfo } = await fetchDetailSafe(event.detailUrl);
        const remarks = extractRemarks(fields);
        if (remarks) merged[index].remarks = remarks;

        if (registerInfo.label) merged[index].register = registerInfo.label;
        if (registerInfo.url) merged[index].registerUrl = registerInfo.url;

        const validDownloads = (downloads || []).filter((d) => d.url);
        if (validDownloads.length) merged[index].downloads = validDownloads;
      } catch (error) {
        console.warn(`Unable to load detail page ${event.detailUrl}: ${error.message}`);
      }

      if (DETAIL_DELAY_MS) {
        await sleep(DETAIL_DELAY_MS);
      }
    }
  };

  const workers = Array.from(
    { length: Math.min(DETAIL_CONCURRENCY, targets.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return merged;
}

async function collectEvents() {
  const seen = new Set();
  const aggregated = [];

  for (let page = 1; page <= PAGE_COUNT; page += 1) {
    const html = await fetchPage(buildListUrl(page));
    const events = parseEvents(html);
    events.forEach((event) => {
      const key = event.detailUrl || event.title;
      if (key && !seen.has(key)) {
        seen.add(key);
        aggregated.push(event);
      }
    });
  }

  const existingMap = loadExistingMap();
  return enrichWithDetails(aggregated, existingMap);
}

async function writePayload(events) {
  const payload = {
    sourceUrl: LIST_URL,
    scrapedAt: new Date().toISOString(),
    events,
  };

  const outPath = path.resolve(__dirname, '../data/events.json');
  await fsPromises.mkdir(path.dirname(outPath), { recursive: true });
  await fsPromises.writeFile(outPath, JSON.stringify(payload, null, 2), 'utf8');
  return outPath;
}

export async function main() {
  try {
    const events = await collectEvents();
    const outPath = await writePayload(events);
    console.log(`Saved ${events.length} events to ${outPath}`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

if (process.argv[1] && process.argv[1].endsWith('fetchEvents.js')) {
  main();
}
