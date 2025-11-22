const EVENTS_URL = './data/events.json';
const UPCOMING_SOON_DAYS = 7;
const BADGE_TEXT = {
  'coming-soon': '即將開始',
  upcoming: '仍可規劃',
  past: '已結束',
  'no-date': '待公告',
};

const CATEGORY_KEYWORDS = {
  meeting: ['\u6703\u8b70', '\u7406\u4e8b', '\u59d4\u54e1', '\u6703\u54e1', '\u8b70'],
  outing: ['\u51fa\u904a', '\u65c5\u904a', '\u65c5\u884c', '\u53c3\u8a2a', '\u89c0\u6469', '\u904a', '\u904a\u7a0b', '\u96fb\u5f71', '\u5f71\u5c55'],
};

const DEFAULT_STATUS_VALUES = ['coming-soon', 'upcoming'];

const state = {
  events: [],
  filtered: [],
  filters: {
    search: '',
    sort: 'start-asc',
    category: 'all',
    statuses: new Set(DEFAULT_STATUS_VALUES),
  },
};

const elements = {
  status: document.getElementById('status'),
  list: document.getElementById('documentList'),
  searchInput: document.getElementById('search'),
  sortSelect: document.getElementById('sortSelect'),
  categorySelect: document.getElementById('categorySelect'),
  clearFilters: document.getElementById('clearFilters'),
  updatedAt: document.getElementById('updatedAt'),
};

const statusCheckboxes = Array.from(
  document.querySelectorAll('input[name="statusFilter"]'),
);

function syncStatusCheckboxes() {
  statusCheckboxes.forEach((checkbox) => {
    checkbox.checked = state.filters.statuses.has(checkbox.value);
  });
}

function resetStatusFilters() {
  state.filters.statuses = new Set(DEFAULT_STATUS_VALUES);
  syncStatusCheckboxes();
}

statusCheckboxes.forEach((checkbox) => {
  checkbox.addEventListener('change', () => {
    const { value, checked } = checkbox;

    if (checked) {
      state.filters.statuses.add(value);
    } else {
      state.filters.statuses.delete(value);
      if (state.filters.statuses.size === 0) {
        state.filters.statuses.add(value);
        checkbox.checked = true;
        return;
      }
    }

    render();
  });
});

syncStatusCheckboxes();

if (elements.searchInput) {
  elements.searchInput.addEventListener('input', (event) => {
    state.filters.search = event.target.value.trim();
    render();
  });

  elements.searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && elements.searchInput.value) {
      elements.searchInput.value = '';
      state.filters.search = '';
      render();
    }
  });
}

if (elements.sortSelect) {
  elements.sortSelect.addEventListener('change', (event) => {
    state.filters.sort = event.target.value;
    render();
  });
}

if (elements.categorySelect) {
  elements.categorySelect.addEventListener('change', (event) => {
    state.filters.category = event.target.value;
    render();
  });
}

if (elements.clearFilters) {
  elements.clearFilters.addEventListener('click', () => {
    const hasSearch = Boolean(state.filters.search);
    const hasSort = state.filters.sort !== 'start-asc';
    const hasCategory = state.filters.category !== 'all';
    const hasStatusChange =
      state.filters.statuses.size !== DEFAULT_STATUS_VALUES.length ||
      DEFAULT_STATUS_VALUES.some((value) => !state.filters.statuses.has(value));

    if (!hasSearch && !hasSort && !hasStatusChange && !hasCategory) {
      return;
    }

    state.filters.search = '';
    state.filters.sort = 'start-asc';
    state.filters.category = 'all';
    resetStatusFilters();

    if (elements.searchInput) {
      elements.searchInput.value = '';
    }
    if (elements.sortSelect) {
      elements.sortSelect.value = 'start-asc';
    }
    if (elements.categorySelect) {
      elements.categorySelect.value = 'all';
    }

    render();
  });
}

function parseDate(value) {
  if (!value) return null;

  const normalized = value.trim().replace(/\//g, '-');
  const isoCandidate =
    normalized.length === 10 ? `${normalized}T00:00:00+08:00` : normalized;

  const parsed = new Date(isoCandidate);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

const taipeiDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Taipei',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function getTaipeiToday() {
  const formatted = taipeiDateFormatter.format(Date.now());
  return parseDate(formatted);
}

function formatDateForDisplay(date) {
  if (!date) return '';
  return taipeiDateFormatter.format(date);
}

function detectCategoryFromTitle(title) {
  if (!title) return 'other';

  if (CATEGORY_KEYWORDS.meeting.some((keyword) => title.includes(keyword))) {
    return 'meeting';
  }

  if (CATEGORY_KEYWORDS.outing.some((keyword) => title.includes(keyword))) {
    return 'outing';
  }

  return 'other';
}

function enrichEvent(event) {
  const parsedDates = (event.dates || [])
    .map((date) => parseDate(date))
    .filter(Boolean)
    .sort((a, b) => a.getTime() - b.getTime());

  const today = getTaipeiToday();
  const upcomingDate = parsedDates.find((date) => date >= today);
  const referenceDate = upcomingDate || parsedDates[parsedDates.length - 1] || null;

  let statusCategory = 'no-date';
  let daysUntilStart = null;

  if (referenceDate) {
    const diffDays = Math.floor(
      (referenceDate.getTime() - today.getTime()) / (24 * 60 * 60 * 1000),
    );
    daysUntilStart = diffDays;

    if (diffDays < 0) {
      statusCategory = 'past';
    } else if (diffDays <= UPCOMING_SOON_DAYS) {
      statusCategory = 'coming-soon';
    } else {
      statusCategory = 'upcoming';
    }
  }

  return {
    ...event,
    category: event.category ?? detectCategoryFromTitle(event.title ?? ''),
    parsedDates,
    startDate: parsedDates[0] || null,
    endDate: parsedDates[parsedDates.length - 1] || null,
    referenceDate,
    statusCategory,
    daysUntilStart,
  };
}

function formatStatusNote(event) {
  if (event.statusCategory === 'no-date') {
    return '尚未公布日期';
  }

  if (event.statusCategory === 'past') {
    const days = Math.abs(event.daysUntilStart ?? 0);
    return days === 0 ? '已於今日結束' : `已結束 ${days} 天`;
  }

  if (event.daysUntilStart == null) {
    return '日期更新中';
  }

  if (event.daysUntilStart === 0) {
    return '活動今日開始';
  }

  return `距離開始 ${event.daysUntilStart} 天`;
}

function applyFilters() {
  const query = state.filters.search.toLowerCase();
  let results = state.events;

  if (query) {
    results = results.filter((event) => {
      const text = [
        event.title ?? '',
        event.location ?? '',
        ...(event.dates || []),
        ...(event.timeInfo || []),
      ]
        .join(' ')
        .toLowerCase();

      return text.includes(query);
    });
  }

  if (state.filters.statuses.size) {
    results = results.filter((event) =>
      state.filters.statuses.has(event.statusCategory ?? 'no-date'),
    );
  }

  if (state.filters.category !== 'all') {
    results = results.filter(
      (event) => (event.category ?? 'other') === state.filters.category,
    );
  }

  const sorted = [...results];

  const compareStart = (a, b) => {
    const aDate = a.referenceDate || a.startDate;
    const bDate = b.referenceDate || b.startDate;

    if (!aDate && !bDate) return 0;
    if (!aDate) return 1;
    if (!bDate) return -1;
    return aDate.getTime() - bDate.getTime();
  };

  switch (state.filters.sort) {
    case 'start-desc':
      sorted.sort((a, b) => compareStart(b, a));
      break;
    case 'title-asc':
      sorted.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'zh-Hant'));
      break;
    case 'start-asc':
    default:
      sorted.sort(compareStart);
      break;
  }

  return sorted;
}

function updateStatus(filtered, total) {
  elements.status.classList.remove('status--error');

  if (total === 0) {
    elements.status.textContent = '目前尚無活動資料，請稍後再試。';
    return;
  }

  if (filtered === 0) {
    elements.status.textContent = '找不到符合篩選條件的活動。';
    return;
  }

  elements.status.textContent = `顯示 ${filtered} / ${total} 場活動`;
}

function setListVisibility(hasResults) {
  elements.list.hidden = !hasResults;
}

function createDateBlock(event) {
  const wrapper = document.createElement('div');
  wrapper.className = 'deadline-wrapper';

  const dateList = document.createElement('div');
  dateList.className = 'date-list';
  const hasDates = Boolean(event.dates?.length);

  const shouldShowRange =
    hasDates &&
    event.startDate &&
    event.endDate &&
    event.startDate.getTime() !== event.endDate.getTime() &&
    event.dates.length > 1;

  if (shouldShowRange) {
    dateList.classList.add('date-list--range');

    const startSpan = document.createElement('span');
    startSpan.className = 'date-pill';
    startSpan.textContent = `${formatDateForDisplay(event.startDate)}~`;

    const endSpan = document.createElement('span');
    endSpan.className = 'date-pill';
    endSpan.textContent = formatDateForDisplay(event.endDate);

    dateList.append(startSpan, endSpan);
  } else if (hasDates) {
    event.dates.forEach((date) => {
      const pill = document.createElement('span');
      pill.className = 'date-pill';
      pill.textContent = date;
      dateList.appendChild(pill);
    });
  } else {
    const empty = document.createElement('span');
    empty.className = 'attachment-empty';
    empty.textContent = '未提供日期';
    dateList.appendChild(empty);
  }

  wrapper.appendChild(dateList);

  if (event.timeInfo?.length) {
    const time = document.createElement('div');
    time.className = 'time-info';
    time.textContent = event.timeInfo.join(' ／ ');
    wrapper.appendChild(time);
  }

  const note = document.createElement('span');
  note.className = 'deadline-note';
  note.textContent = formatStatusNote(event);
  wrapper.appendChild(note);

  return wrapper;
}

function createLinkChip(label, url) {
  const chip = document.createElement('a');
  chip.className = 'link-chip';
  chip.href = url;
  chip.target = '_blank';
  chip.rel = 'noopener noreferrer';
  chip.textContent = label;
  return chip;
}

function createLinkGroup(event) {
  const group = document.createElement('div');
  group.className = 'link-group';

  const seen = new Set();
  const pushLink = (label, url) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    group.appendChild(createLinkChip(label, url));
  };

  pushLink('活動頁面', event.detailUrl);

  if (event.registerUrl) {
    pushLink(event.register || '線上報名', event.registerUrl);
  }

  if (event.noteUrl && event.noteUrl !== event.detailUrl) {
    pushLink(event.note || '備註', event.noteUrl);
  }

  (event.extras || []).forEach((item, index) => {
    pushLink(item.label || `連結 ${index + 1}`, item.url);
  });

  if (!group.childElementCount) {
    const empty = document.createElement('span');
    empty.className = 'attachment-empty';
    empty.textContent = '尚無連結';
    return empty;
  }

  return group;
}

function createLocationContent(event) {
  const location = document.createElement('span');
  location.className = 'location-line';
  location.textContent = event.location || '未提供地點';
  return location;
}

function createMetaItem(label, content) {
  const wrapper = document.createElement('div');
  wrapper.className = 'meta-item';

  const dt = document.createElement('dt');
  dt.textContent = label;

  const dd = document.createElement('dd');
  if (typeof content === 'string') {
    dd.textContent = content;
  } else if (content instanceof Node) {
    dd.appendChild(content);
  }

  wrapper.append(dt, dd);
  return wrapper;
}

function createEventCard(event) {
  const card = document.createElement('article');
  card.className = `document-card document-card--${event.statusCategory}`;

  const header = document.createElement('header');
  header.className = 'document-card__header';

  const badge = document.createElement('span');
  badge.className = `badge badge--${event.statusCategory}`;
  badge.textContent = BADGE_TEXT[event.statusCategory] ?? '狀態';
  header.appendChild(badge);

  card.appendChild(header);

  const title = document.createElement('h2');
  title.className = 'document-card__title';
  const titleText = event.title?.trim() || '未命名活動';

  if (event.detailUrl) {
    const link = document.createElement('a');
    link.href = event.detailUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = titleText;
    title.appendChild(link);
  } else {
    title.textContent = titleText;
  }

  const metaList = document.createElement('dl');
  metaList.className = 'document-card__meta';
  const metaItems = [
    createMetaItem('活動日期', createDateBlock(event)),
    createMetaItem('活動地點', createLocationContent(event)),
    createMetaItem('相關連結', createLinkGroup(event)),
  ];

  if (event.remarks) {
    const remarksItem = createMetaItem('備註', event.remarks);
    remarksItem.classList.add('meta-item--remarks');
    metaItems.push(remarksItem);
  }

  metaList.append(...metaItems);

  card.append(title, metaList);
  return card;
}

function renderEvents(events) {
  elements.list.replaceChildren(...events.map((event) => createEventCard(event)));
}

function render() {
  state.filtered = applyFilters();
  updateStatus(state.filtered.length, state.events.length);
  setListVisibility(state.filtered.length > 0);

  if (state.filtered.length) {
    renderEvents(state.filtered);
  }
}

function formatUpdatedAt(iso) {
  if (!iso) return '資料更新時間待同步';

  const formatter = new Intl.DateTimeFormat('zh-TW', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Taipei',
  });

  try {
    return `資料更新時間：${formatter.format(new Date(iso))}`;
  } catch (error) {
    console.warn('Unable to format updated time', error);
    return `資料更新時間：${iso}`;
  }
}

async function loadEvents() {
  try {
    const response = await fetch(EVENTS_URL, { cache: 'no-cache' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    const events = payload.events ?? [];
    state.events = events.map(enrichEvent);
    render();

    if (payload.scrapedAt) {
      elements.updatedAt.textContent = formatUpdatedAt(payload.scrapedAt);
    }
  } catch (error) {
    console.error('Unable to load events', error);
    elements.status.textContent = '載入資料時發生問題，請重新整理後再試。';
    elements.status.classList.add('status--error');
  }
}

loadEvents();
