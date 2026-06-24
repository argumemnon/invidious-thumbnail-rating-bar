// ==UserScript==
// @name         Thumbnail Rating Bar for Invidious
// @namespace    https://example.com/invidious-rating-bar
// @version      1.0.0
// @description  Adds a like/dislike rating bar to the bottom of every video thumbnail on Invidious, using the Return YouTube Dislike API.
// @author       you
// @match        https://your.instance.here/*
// @grant        GM_xmlhttpRequest
// @connect      returnyoutubedislikeapi.com
// @run-at       document-idle
// ==/UserScript==
//
// SETUP: change the @match line above to your Invidious instance, e.g.
//   @match        https://yewtu.be/*
// You can add multiple @match lines if you use more than one instance.

(function () {
  'use strict';

  // ---------- Settings ----------
  const BAR_HEIGHT = 4;               // bar thickness in px
  const LIKE_COLOR = '#2ba640';       // green (like portion)
  const DISLIKE_COLOR = '#cc0000';    // red (dislike portion)
  const CACHE_TTL = 10 * 60 * 1000;   // cache ratings for 10 minutes
  const MAX_CONCURRENT = 6;           // simultaneous API requests (lower = less rate limiting)
  const EXPONENTIAL = true;          // true = exaggerate differences near 100% (like the original extension)

  // ---------- Persistent cache (localStorage) ----------
  const CACHE_PREFIX = 'ryd:';

  function getCached(id) {
    try {
      const raw = localStorage.getItem(CACHE_PREFIX + id);
      if (!raw) return undefined;
      const { r, t } = JSON.parse(raw);
      if (Date.now() - t < CACHE_TTL) return r; // r may be null (= no data)
    } catch (e) { /* ignore */ }
    return undefined;
  }

  function setCached(id, ratio) {
    try {
      localStorage.setItem(CACHE_PREFIX + id, JSON.stringify({ r: ratio, t: Date.now() }));
    } catch (e) { /* storage full / disabled — fine */ }
  }

  // ---------- Concurrency-limited request queue ----------
  let active = 0;
  const queue = [];

  function pump() {
    while (active < MAX_CONCURRENT && queue.length) {
      const task = queue.shift();
      active++;
      task().finally(() => { active--; pump(); });
    }
  }

  function enqueue(taskFactory) {
    return new Promise((resolve) => {
      queue.push(() => taskFactory().then(resolve, () => resolve(null)));
      pump();
    });
  }

  // ---------- Fetch a rating (0..1) for a video id, or null ----------
  function fetchRating(id) {
    const cached = getCached(id);
    if (cached !== undefined) return Promise.resolve(cached);

    return enqueue(() => new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: 'https://returnyoutubedislikeapi.com/votes?videoId=' + encodeURIComponent(id),
        onload: (res) => {
          let ratio = null;
          try {
            const data = JSON.parse(res.responseText);
            const likes = data.likes || 0;
            const dislikes = data.dislikes || 0;
            const total = likes + dislikes;
            if (total > 0) ratio = likes / total;
          } catch (e) { /* leave ratio null */ }
          setCached(id, ratio);
          resolve(ratio);
        },
        onerror: () => { resolve(null); },
        ontimeout: () => { resolve(null); },
      });
    }));
  }

  // ---------- Width of the green (like) portion ----------
  function likeWidthPercent(ratio) {
    if (EXPONENTIAL) {
      // Each 10% below 100% halves the green bar (matches the original extension's option).
      return Math.min(100, Math.pow(2, (ratio - 1) * 10) * 100);
    }
    return ratio * 100;
  }

  // ---------- Draw the bar over a thumbnail image ----------
  function addBar(img, ratio) {
    if (ratio === null) return;
    const container = img.closest('div.thumbnail') || img.parentElement;
    if (!container || container.querySelector('.ryd-bar')) return;

    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }

    const bar = document.createElement('div');
    bar.className = 'ryd-bar';
    bar.style.cssText =
      'position:absolute;left:0;right:0;bottom:0;height:' + BAR_HEIGHT + 'px;' +
      'background:' + DISLIKE_COLOR + ';z-index:5;pointer-events:none;';

    const green = document.createElement('div');
    green.style.cssText =
      'position:absolute;left:0;top:0;bottom:0;background:' + LIKE_COLOR + ';' +
      'width:' + likeWidthPercent(ratio).toFixed(2) + '%;';

    bar.appendChild(green);
    bar.title = (ratio * 100).toFixed(1) + '% liked';
    container.appendChild(bar);
  }

  // ---------- Extract an 11-char video id from a watch link ----------
  function videoId(href) {
    const m = href && href.match(/[?&]v=([\w-]{11})/);
    return m ? m[1] : null;
  }

  // ---------- Find and process all thumbnails ----------
  function process() {
    // Any link to a watch page that wraps an image is treated as a thumbnail.
    const anchors = document.querySelectorAll('a[href*="watch?v="]');
    anchors.forEach((a) => {
      const img = a.querySelector('img');
      if (!img || img.dataset.rydDone) return;
      const id = videoId(a.getAttribute('href') || '');
      if (!id) return;
      img.dataset.rydDone = '1';
      fetchRating(id).then((ratio) => addBar(img, ratio));
    });
  }

  // Run now, then watch for lazily-added thumbnails.
  process();
  const observer = new MutationObserver(() => process());
  observer.observe(document.body, { childList: true, subtree: true });
})();
