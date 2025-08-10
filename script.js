'use strict';

class WorldTimeApp {
  constructor() {
    this.API_BASE = 'http://worldtimeapi.org/api';
    this.dbPromise = this.initDB();
    this.elements = {
      cardsContainer: document.getElementById('time-cards'),
      searchInput: document.getElementById('search'),
      addInput: document.getElementById('add-input'),
      suggestions: document.getElementById('suggestions'),
      addButton: document.getElementById('add-button'),
      themeToggle: document.getElementById('theme-toggle'),
      refreshButton: document.getElementById('refresh'),
      loading: document.getElementById('loading'),
      toast: document.getElementById('toast')
    };
    this.state = {
      timezones: [],
      timezoneData: [],
      fuse: null,
      selectedZones: [],
      zoneData: {},
      theme: 'dark',
      lastFetchTimestamp: 0,
      locale: navigator.language || 'en-US',
      updateInterval: null,
      draggedCard: null,
      isOffline: !navigator.onLine
    };
    this.bindEvents();
    this.init();
  }

  async initDB() {
    try {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('WorldTimeDB', 3);
        request.onupgradeneeded = e => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('data')) {
            db.createObjectStore('data', { keyPath: 'key' });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return db;
    } catch (err) {
      console.warn('IndexedDB unavailable, falling back to localStorage');
      return {
        fallback: true,
        transaction: () => ({ objectStore: () => ({
          get: key => Promise.resolve({ value: JSON.parse(localStorage.getItem(key)) }),
          put: ({key, value}) => { localStorage.setItem(key, JSON.stringify(value)); return Promise.resolve(); }
        }) })
      };
    }
  }

  async getData(key) {
    const db = await this.dbPromise;
    if (db.fallback) {
      const tx = db.transaction();
      const store = tx.objectStore();
      return await store.get(key);
    }
    const tx = db.transaction('data', 'readonly');
    const store = tx.objectStore('data');
    const request = store.get(key);
    return new Promise(resolve => {
      request.onsuccess = () => resolve(request.result ? request.result.value : null);
    });
  }

  async putData(key, value) {
    const db = await this.dbPromise;
    if (db.fallback) {
      const tx = db.transaction();
      const store = tx.objectStore();
      await store.put({key, value});
      return;
    }
    const tx = db.transaction('data', 'readwrite');
    const store = tx.objectStore('data');
    store.put({ key, value });
    await new Promise(resolve => tx.oncomplete = resolve);
  }

  getCityFromTimezone(tz) {
    return tz.split('/').pop().replace(/_/g, ' ');
  }

  showToast(message, type = 'info') {
    this.elements.toast.textContent = message;
    this.elements.toast.className = `toast ${type}`;
    this.elements.toast.style.display = 'block';
    setTimeout(() => {
      this.elements.toast.style.display = 'none';
    }, 3000);
  }

  async fetchTimezones() {
    try {
      const res = await fetch(`${this.API_BASE}/timezone`);
      this.state.timezones = await res.json();
      this.state.timezoneData = this.state.timezones.map(tz => ({ tz, city: this.getCityFromTimezone(tz) }));
      this.state.fuse = new Fuse(this.state.timezoneData, { keys: ['city'], threshold: 0.3 });
      await this.putData('timezones', this.state.timezones);
      await this.putData('timezoneData', this.state.timezoneData);
    } catch (err) {
      this.showToast('Failed to fetch timezones. Using cached data if available.', 'error');
      console.error(err);
    }
  }

  async fetchZoneData(tz) {
    try {
      const res = await fetch(`${this.API_BASE}/timezone/${tz}`);
      if (!res.ok) throw new Error('API error');
      const data = await res.json();
      const offset = (data.raw_offset + data.dst_offset) / 3600;
      this.state.zoneData[tz] = {
        offset,
        city: this.getCityFromTimezone(tz),
        dst_from: data.dst_from,
        dst_until: data.dst_until
      };
      await this.putData('zoneData', this.state.zoneData);
      return true;
    } catch (err) {
      this.showToast(`Failed to fetch data for ${tz}. Check connection.`, 'error');
      console.error(err);
      return false;
    }
  }

  renderCards() {
    this.elements.cardsContainer.innerHTML = '';
    this.state.selectedZones.forEach(tz => {
      const card = document.createElement('div');
      card.classList.add('time-card');
      card.tabIndex = 0;
      card.draggable = true;
      card.dataset.timezone = tz;
      card.innerHTML = `
        <h2><i class="fas fa-clock"></i> ${this.state.zoneData[tz]?.city || tz}</h2>
        <p class="time">Loading...</p>
        <p class="date">Loading...</p>
        <p class="offset">UTC ${this.state.zoneData[tz]?.offset.toFixed(2) || '...'}</p>
        <button class="delete-btn" aria-label="Delete ${tz}"><i class="fas fa-trash"></i></button>
      `;
      this.elements.cardsContainer.appendChild(card);

      card.querySelector('.delete-btn').addEventListener('click', () => this.removeZone(tz));
      card.addEventListener('pointerdown', this.handlePointerDown.bind(this, card));
      card.addEventListener('pointermove', this.handlePointerMove.bind(this, card));
      card.addEventListener('pointerup', this.handlePointerUp.bind(this, card));
    });
    this.updateTimes();
  }

  updateTimes() {
    const now = new Date();
    document.querySelectorAll('.time-card').forEach(card => {
      const tz = card.dataset.timezone;
      const data = this.state.zoneData[tz];
      if (data) {
        const localTime = new Date(now.getTime() + data.offset * 3600 * 1000);
        const timeStr = localTime.toLocaleTimeString(this.state.locale, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
        const dateStr = localTime.toLocaleDateString(this.state.locale, { weekday: 'short', month: 'short', day: 'numeric' });
        card.querySelector('.time').textContent = timeStr;
        card.querySelector('.date').textContent = dateStr;
      } else {
        card.querySelector('.time').textContent = 'Error';
        card.querySelector('.date').textContent = '';
      }
    });
  }

  async addZone(tz) {
    if (!tz || this.state.selectedZones.includes(tz)) {
      this.showToast('Invalid or duplicate timezone', 'error');
      return;
    }
    this.elements.loading.style.display = 'block';
    const success = await this.fetchZoneData(tz);
    this.elements.loading.style.display = 'none';
    if (success) {
      this.state.selectedZones.push(tz);
      await this.saveSelected();
      this.renderCards();
      this.showToast(`Added ${this.state.zoneData[tz].city}`, 'success');
    }
  }

  async removeZone(tz) {
    this.state.selectedZones = this.state.selectedZones.filter(z => z !== tz);
    delete this.state.zoneData[tz];
    await this.saveSelected();
    this.renderCards();
    this.showToast('Removed', 'success');
  }

  async saveSelected() {
    await this.putData('selectedZones', this.state.selectedZones);
    await this.putData('zoneData', this.state.zoneData);
  }

  handleSearch() {
    const query = this.elements.searchInput.value.toLowerCase();
    document.querySelectorAll('.time-card').forEach(card => {
      const city = this.state.zoneData[card.dataset.timezone]?.city.toLowerCase() || '';
      card.style.display = city.includes(query) ? '' : 'none';
    });
  }

  toggleTheme() {
    this.state.theme = this.state.theme === 'dark' ? 'light' : 'dark';
    document.body.dataset.theme = this.state.theme;
    this.elements.themeToggle.innerHTML = `<i class="fas fa-${this.state.theme === 'dark' ? 'moon' : 'sun'}"></i>`;
    localStorage.setItem('theme', this.state.theme);
  }

  handleDragStart(card) {
    this.state.draggedCard = card;
    card.classList.add('dragging');
  }

  handleDragOver(e) {
    e.preventDefault();
  }

  async handleDrop(card) {
    const cards = Array.from(this.elements.cardsContainer.children);
    const draggedIndex = cards.indexOf(this.state.draggedCard);
    const targetIndex = cards.indexOf(card);
    if (draggedIndex !== targetIndex) {
      const [moved] = this.state.selectedZones.splice(draggedIndex, 1);
      this.state.selectedZones.splice(targetIndex, 0, moved);
      await this.saveSelected();
      this.renderCards();
    }
    this.state.draggedCard.classList.remove('dragging');
    this.state.draggedCard = null;
  }

  handlePointerDown(card, e) {
    if (e.pointerType === 'mouse') {
      this.handleDragStart(card);
      card.addEventListener('dragover', this.handleDragOver);
      card.addEventListener('drop', this.handleDrop.bind(this, card));
    } else {
      this.startX = e.clientX;
      card.style.transition = 'none';
    }
  }

  handlePointerMove(card, e) {
    if (this.startX) {
      const diffX = e.clientX - this.startX;
      if (Math.abs(diffX) > 20) {
        card.style.transform = `translateX(${diffX}px)`;
        card.classList.add('swiping');
      }
    }
  }

  handlePointerUp(card, e) {
    if (this.startX) {
      const diffX = e.clientX - this.startX;
      card.style.transition = var(--transition);
      card.style.transform = '';
      card.classList.remove('swiping');
      if (diffX < -100) {
        this.removeZone(card.dataset.timezone);
      }
      this.startX = null;
    } else if (e.pointerType === 'mouse') {
      card.removeEventListener('dragover', this.handleDragOver);
      card.removeEventListener('drop', this.handleDrop.bind(this, card));
    }
  }

  handleSuggestions() {
    const query = this.elements.addInput.value.trim();
    this.elements.suggestions.innerHTML = '';
    this.elements.suggestions.classList.remove('visible');
    if (query && this.state.fuse) {
      const results = this.state.fuse.search(query).slice(0, 10);
      if (results.length > 0) {
        results.forEach(res => {
          const div = document.createElement('div');
          div.classList.add('suggestion');
          div.textContent = res.item.city;
          div.dataset.tz = res.item.tz;
          div.tabIndex = 0;
          div.addEventListener('click', () => this.handleSuggestionClick(div));
          div.addEventListener('keydown', e => {
            if (e.key === 'Enter') this.handleSuggestionClick(div);
          });
          this.elements.suggestions.appendChild(div);
        });
        this.elements.suggestions.classList.add('visible');
      }
    }
  }

  handleSuggestionClick(suggestion) {
    const tz = suggestion.dataset.tz;
    this.elements.addInput.value = '';
    this.elements.suggestions.innerHTML = '';
    this.elements.suggestions.classList.remove('visible');
    this.addZone(tz);
  }

  async refetchIfNeeded(force = false) {
    const now = Date.now();
    const today = new Date().toISOString().split('T')[0];
    let needsRefetch = force || now - this.state.lastFetchTimestamp > 86400000;
    if (!needsRefetch) {
      for (const tz in this.state.zoneData) {
        const { dst_from, dst_until } = this.state.zoneData[tz];
        if ((dst_from && dst_from.startsWith(today)) || (dst_until && dst_until.startsWith(today))) {
          needsRefetch = true;
          break;
        }
      }
    }
    if (needsRefetch) {
      this.elements.loading.style.display = 'block';
      await Promise.all(this.state.selectedZones.map(tz => this.fetchZoneData(tz)));
      this.state.lastFetchTimestamp = now;
      await this.putData('lastFetchTimestamp', this.state.lastFetchTimestamp);
      this.elements.loading.style.display = 'none';
      this.showToast('Data refreshed', 'success');
      this.renderCards();
    }
  }

  handleOfflineChange() {
    this.state.isOffline = !navigator.onLine;
    this.showToast(this.state.isOffline ? 'Offline - Using cached data' : 'Back online', this.state.isOffline ? 'offline' : 'success');
    if (!this.state.isOffline) this.refetchIfNeeded();
  }

  bindEvents() {
    let searchTimeout;
    this.elements.searchInput.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => this.handleSearch(), 300);
    });
    this.elements.addInput.addEventListener('input', () => this.handleSuggestions());
    this.elements.addButton.addEventListener('click', () => {
      const query = this.elements.addInput.value.trim();
      if (query && this.state.fuse) {
        const result = this.state.fuse.search(query)[0];
        if (result) this.addZone(result.item.tz);
      }
    });
    this.elements.addInput.addEventListener('keypress', e => {
      if (e.key === 'Enter') this.elements.addButton.click();
    });
    this.elements.themeToggle.addEventListener('click', () => this.toggleTheme());
    this.elements.refreshButton.addEventListener('click', () => this.refetchIfNeeded(true));
    window.addEventListener('online', () => this.handleOfflineChange());
    window.addEventListener('offline', () => this.handleOfflineChange());
    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault();
      // Optionally show a button to prompt install
    });
  }

  async init() {
    // Theme
    const savedTheme = localStorage.getItem('theme');
    if (!savedTheme) {
      this.state.theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    } else {
      this.state.theme = savedTheme;
    }
    document.body.dataset.theme = this.state.theme;
    this.elements.themeToggle.innerHTML = `<i class="fas fa-${this.state.theme === 'dark' ? 'moon' : 'sun'}"></i>`;

    // Load data
    this.state.timezones = await this.getData('timezones') || [];
    this.state.timezoneData = await this.getData('timezoneData') || [];
    if (this.state.timezones.length === 0) {
      this.elements.loading.style.display = 'block';
      await this.fetchTimezones();
      this.elements.loading.style.display = 'none';
    }
    this.state.fuse = new Fuse(this.state.timezoneData, { keys: ['city'], threshold: 0.3 });

    this.state.selectedZones = await this.getData('selectedZones') || ['America/New_York', 'Europe/London', 'Asia/Tokyo'];
    this.state.zoneData = await this.getData('zoneData') || {};
    this.state.lastFetchTimestamp = await this.getData('lastFetchTimestamp') || 0;

    this.elements.loading.style.display = 'block';
    const missingZones = this.state.selectedZones.filter(tz => !this.state.zoneData[tz]);
    if (missingZones.length > 0) {
      await Promise.all(missingZones.map(tz => this.fetchZoneData(tz)));
    }
    await this.refetchIfNeeded();
    this.elements.loading.style.display = 'none';

    this.renderCards();
    this.state.updateInterval = setInterval(() => this.updateTimes(), 1000);

    // PWA
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/serviceworker.js').catch(err => console.error('Service Worker failed:', err));
    }

    // Clean up on unload
    window.addEventListener('beforeunload', () => {
      if (this.state.updateInterval) clearInterval(this.state.updateInterval);
    });

    if (this.state.isOffline) this.showToast('Offline - Using cached data', 'offline');
  }
}

new WorldTimeApp();