(function () {
  'use strict';

  if (window.localStorage.getItem('kikoeru-disable-custom-player-ui') === '1') {
    return;
  }

  var subtitleState = {
    dialog: null,
    items: [],
    offset: 0,
    timer: null,
    currentText: ''
  };

  var subtitleExtPattern = /\.(lrc|srt|vtt|ass)$/i;
  var audioExtPattern = /\.(mp3|wav|flac|m4a|mp4|ogg|aac)$/i;
  var subtitleLineBreakToken = '\uE000';
  var lastLyricsBarText = '';
  var pipSubtitleState = {
    win: null,
    textNode: null,
    emptyNode: null
  };

  function normalizeSubtitleLineBreaks(text) {
    return String(text || '')
      .replace(new RegExp(subtitleLineBreakToken, 'g'), '\n')
      .replace(/\u2028/g, '\n');
  }

  function normalizeDisplaySubtitleText(text) {
    return normalizeSubtitleLineBreaks(text).replace(/^[\t\r\n ]+|[\t\r\n ]+$/g, '');
  }

  function getRootVue() {
    var app = document.querySelector('#q-app');
    return app && app.__vue__;
  }

  function getStore() {
    var vm = getRootVue();
    return vm && vm.$store;
  }

  function getPlayerState() {
    var store = getStore();
    return store && store.state && store.state.AudioPlayer;
  }

  function getAudioElement() {
    return document.querySelector('.plyr audio') || document.querySelector('audio');
  }

  function getCurrentFile() {
    var store = getStore();
    if (!store) return null;
    if (store.getters && store.getters['AudioPlayer/currentPlayingFile']) {
      return store.getters['AudioPlayer/currentPlayingFile'];
    }
    var state = getPlayerState();
    return state && state.queue ? state.queue[state.queueIndex] : null;
  }

  function notify(message, color) {
    var vm = getRootVue();
    if (vm && vm.$q && vm.$q.notify) {
      vm.$q.notify({
        message: message,
        color: color || 'primary',
        textColor: 'white',
        timeout: 2200
      });
      return;
    }
    window.alert(message);
  }

  function iconButton(icon, title, className, onClick) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'kikoeru-asmr-btn' + (className ? ' ' + className : '');
    button.title = title;
    button.setAttribute('aria-label', title);
    button.innerHTML = '<span class="material-icons" aria-hidden="true">' + icon + '</span>';
    button.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      onClick();
      button.blur();
    });
    return button;
  }

  function setIcon(button, icon) {
    var node = button && button.querySelector('.material-icons');
    if (node && node.textContent !== icon) {
      node.textContent = icon;
    }
  }

  function setRangeFill(input, value) {
    if (!input) return;
    var min = Number(input.min || 0);
    var max = Number(input.max || 100);
    var current = Number(value !== undefined ? value : input.value);
    var percent = max > min ? ((current - min) / (max - min)) * 100 : 0;
    input.style.setProperty('--kikoeru-range-value', Math.max(0, Math.min(100, percent)).toFixed(2) + '%');
  }

  function playModeIcon(mode) {
    var name = mode && mode.name;
    if (name === 'all repeat') return 'repeat';
    if (name === 'repeat once') return 'repeat_one';
    if (name === 'shuffle') return 'shuffle';
    return 'playlist_play';
  }

  function ensureHandle(card) {
    if (card.querySelector('.kikoeru-player-handle')) return;
    var store = getStore();
    if (!store) return;

    var handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'kikoeru-player-handle';
    handle.title = '收起播放器';
    handle.setAttribute('aria-label', '收起播放器');
    handle.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      if (store._mutations && store._mutations['AudioPlayer/PLAYER_HIDE']) {
        store.commit('AudioPlayer/PLAYER_HIDE');
      } else {
        store.commit('AudioPlayer/TOGGLE_HIDE');
      }
      handle.blur();
    });
    card.insertBefore(handle, card.firstChild);
  }

  function buildControls(card) {
    if (card.querySelector('.kikoeru-asmr-controls')) return;

    var store = getStore();
    if (!store) return;

    var titleItem = card.querySelector(':scope > .q-item.text-center');
    if (!titleItem) return;

    var controls = document.createElement('div');
    controls.className = 'kikoeru-asmr-controls';
    controls.appendChild(iconButton('skip_previous', '上一首', '', function () {
      store.commit('AudioPlayer/PREVIOUS_TRACK');
    }));
    controls.appendChild(iconButton('replay_5', '后退 5 秒', 'is-seek-prev', function () {
      if (window.KikoeruSubtitleSeek && window.KikoeruSubtitleSeek.jump(-1)) return;
      store.commit('AudioPlayer/SET_REWIND_SEEK_MODE', true);
    }));
    controls.appendChild(iconButton('play_arrow', '播放/暂停', 'is-play', function () {
      store.commit('AudioPlayer/TOGGLE_PLAYING');
    }));
    controls.appendChild(iconButton('forward_30', '前进 30 秒', 'is-seek-next', function () {
      if (window.KikoeruSubtitleSeek && window.KikoeruSubtitleSeek.jump(1)) return;
      store.commit('AudioPlayer/SET_FORWARD_SEEK_MODE', true);
    }));
    controls.appendChild(iconButton('skip_next', '下一首', '', function () {
      store.commit('AudioPlayer/NEXT_TRACK');
    }));

    var volume = document.createElement('div');
    volume.className = 'kikoeru-asmr-volume';
    volume.innerHTML = '<span class="material-icons" aria-hidden="true">volume_down</span><input type="range" min="0" max="1" step="0.01"><span class="material-icons" aria-hidden="true">volume_up</span>';
    var volumeInput = volume.querySelector('input');
    volumeInput.addEventListener('input', function () {
      setRangeFill(volumeInput);
      store.commit('AudioPlayer/SET_VOLUME', Number(volumeInput.value));
    });

    var tools = document.createElement('div');
    tools.className = 'kikoeru-asmr-tools';
    tools.appendChild(iconButton('queue_music', '当前播放列表', '', function () {
      clickOriginalButton(card, 0);
    }));
    tools.appendChild(iconButton('playlist_play', '播放模式', 'is-mode', function () {
      store.commit('AudioPlayer/CHANGE_PLAY_MODE');
    }));
    tools.appendChild(iconButton('picture_in_picture_alt', '画中画字幕', 'is-pip-subtitle', function () {
      togglePipSubtitle();
    }));
    tools.appendChild(iconButton('subtitles', '字幕预览', 'is-subtitle', function () {
      showSubtitlePreview();
    }));
    tools.appendChild(iconButton('more_horiz', '更多', '', function () {
      clickTopMoreMenu(card);
    }));

    titleItem.insertAdjacentElement('afterend', controls);
    controls.insertAdjacentElement('afterend', volume);
    volume.insertAdjacentElement('afterend', tools);
  }

  function clickOriginalButton(card, index) {
    var row = card.querySelector(':scope > .row.justify-around');
    var buttons = row ? row.querySelectorAll('.q-btn') : [];
    if (buttons[index]) {
      buttons[index].click();
    }
  }

  function clickTopMoreMenu(card) {
    var buttons = card.querySelectorAll('.albumart > .absolute-top-right, .albumart .absolute-top-right');
    if (buttons[0]) {
      buttons[0].click();
      return;
    }
    notify('更多菜单暂不可用', 'info');
  }

  function updateControls(card) {
    var state = getPlayerState();
    if (!state) return;

    var playButton = card.querySelector('.kikoeru-asmr-controls .is-play');
    setIcon(playButton, state.playing ? 'pause' : 'play_arrow');
    if (playButton) {
      playButton.classList.toggle('is-playing', !!state.playing);
    }

    var modeButton = card.querySelector('.kikoeru-asmr-tools .is-mode');
    setIcon(modeButton, playModeIcon(state.playMode));
    if (modeButton) {
      modeButton.classList.toggle('is-active', !!state.playMode && state.playMode.name !== 'order');
      modeButton.title = '播放模式：' + ((state.playMode && state.playMode.name) || 'order');
    }

    var subtitleButton = card.querySelector('.kikoeru-asmr-tools .is-subtitle');
    if (subtitleButton) {
      subtitleButton.classList.toggle('is-active', !!subtitleState.dialog);
    }

    var pipSubtitleButton = card.querySelector('.kikoeru-asmr-tools .is-pip-subtitle');
    if (pipSubtitleButton) {
      pipSubtitleButton.classList.toggle('is-active', isPipSubtitleOpen());
    }

    updateSeekButtons(card);

    var input = card.querySelector('.kikoeru-asmr-volume input');
    if (input && document.activeElement !== input) {
      input.value = typeof state.volume === 'number' ? state.volume : 0;
      setRangeFill(input);
    }

    enhanceMarqueeLabels(card);
  }

  function updateSeekButtons(card) {
    var subtitleSeek = window.KikoeruSubtitleSeek && window.KikoeruSubtitleSeek.hasCues && window.KikoeruSubtitleSeek.hasCues();
    var prevButton = card.querySelector('.kikoeru-asmr-controls .is-seek-prev');
    var nextButton = card.querySelector('.kikoeru-asmr-controls .is-seek-next');

    setIcon(prevButton, subtitleSeek ? 'keyboard_arrow_left' : 'replay_5');
    setIcon(nextButton, subtitleSeek ? 'keyboard_arrow_right' : 'forward_30');
    if (prevButton) {
      prevButton.title = subtitleSeek ? '上一句字幕' : '后退 5 秒';
      prevButton.setAttribute('aria-label', prevButton.title);
      prevButton.classList.toggle('is-subtitle-seek', !!subtitleSeek);
    }
    if (nextButton) {
      nextButton.title = subtitleSeek ? '下一句字幕' : '前进 30 秒';
      nextButton.setAttribute('aria-label', nextButton.title);
      nextButton.classList.toggle('is-subtitle-seek', !!subtitleSeek);
    }
  }

  function stripAudioExtension(name) {
    return String(name || '').replace(audioExtPattern, '');
  }

  function setMarqueeText(label, text, className, scrollable) {
    var nextText = String(text || '').trim();
    var marquee = label.querySelector(':scope > .kikoeru-marquee');
    if (!marquee) {
      label.textContent = '';
      marquee = document.createElement('span');
      marquee.className = 'kikoeru-marquee';
      var inner = document.createElement('span');
      inner.className = 'kikoeru-marquee-inner';
      marquee.appendChild(inner);
      label.appendChild(marquee);
    }

    marquee.classList.toggle('is-track-title', className === 'is-track-title');
    marquee.classList.toggle('is-work-title', className === 'is-work-title');

    var innerNode = marquee.querySelector('.kikoeru-marquee-inner');
    if (!innerNode) return;
    if (innerNode.textContent !== nextText) {
      innerNode.textContent = nextText;
    }
    var overflowing = innerNode.scrollWidth > marquee.clientWidth + 4;
    marquee.classList.toggle('is-overflowing', !!scrollable && overflowing);
    if (scrollable && overflowing) {
      var distance = Math.max(0, innerNode.scrollWidth - marquee.clientWidth);
      var duration = Math.max(10, Math.min(30, 8 + distance / 28));
      marquee.style.setProperty('--kikoeru-marquee-distance', distance.toFixed(0) + 'px');
      marquee.style.setProperty('--kikoeru-marquee-duration', duration.toFixed(1) + 's');
    }
  }

  function enhanceMarqueeLabels(card) {
    var current = getCurrentFile() || {};
    var labels = card.querySelectorAll(':scope > .q-item.text-center .q-item__label');
    if (labels[0]) setMarqueeText(labels[0], stripAudioExtension(current.title || ''), 'is-track-title', false);
    if (labels[1]) setMarqueeText(labels[1], current.workTitle || '', 'is-work-title', true);
  }

  function setLyricsBarText(text) {
    var nextText = normalizeDisplaySubtitleText(text);
    lastLyricsBarText = nextText;

    var bar = document.querySelector('#lyricsBar');
    if (bar && bar.getAttribute('data-lyric-text') !== nextText) {
      bar.setAttribute('data-lyric-text', nextText);
    }
    updatePipSubtitleText(nextText);
  }

  function syncLyricsBarText() {
    var bar = document.querySelector('#lyricsBar');
    var lyric = document.querySelector('#lyric');
    if (!bar && !lyric) return;

    setLyricsBarText(lyric ? lyric.textContent : lastLyricsBarText);
  }

  function installLyricsBarStoreBridge() {
    var store = getStore();
    if (!store || store.__kikoeruLyricsBarBridgeInstalled || typeof store.commit !== 'function') return;

    var originalCommit = store.commit;
    store.commit = function (type, payload, options) {
      if (type === 'AudioPlayer/SET_CURRENT_LYRIC') {
        setLyricsBarText(payload);
      }

      var result = originalCommit.call(this, type, payload, options);
      if (type === 'AudioPlayer/SET_CURRENT_LYRIC') {
        window.requestAnimationFrame(syncLyricsBarText);
      }
      return result;
    };
    store.__kikoeruLyricsBarBridgeInstalled = true;

    var state = getPlayerState();
    if (state && state.currentLyric) {
      setLyricsBarText(state.currentLyric);
    }
  }

  function isPipSubtitleOpen() {
    return !!(pipSubtitleState.win && !pipSubtitleState.win.closed);
  }

  function updatePipSubtitleText(text) {
    if (!isPipSubtitleOpen() || !pipSubtitleState.textNode) return;

    var nextText = normalizeDisplaySubtitleText(text || lastLyricsBarText);
    pipSubtitleState.textNode.textContent = nextText;
    if (pipSubtitleState.emptyNode) {
      pipSubtitleState.emptyNode.hidden = !!nextText;
    }
    if (pipSubtitleState.applySize) {
      pipSubtitleState.applySize();
    }
  }

  function closePipSubtitle() {
    if (isPipSubtitleOpen()) {
      pipSubtitleState.win.close();
    }
    pipSubtitleState.win = null;
    pipSubtitleState.textNode = null;
    pipSubtitleState.emptyNode = null;
    pipSubtitleState.applySize = null;
  }

  function setupPipSubtitleWindow(pipWindow) {
    pipSubtitleState.win = pipWindow;

    var doc = pipWindow.document;
    doc.title = 'Kikoeru subtitles';
    doc.body.innerHTML = [
      '<main class="kikoeru-pip-subtitle-root">',
      '<div class="kikoeru-pip-subtitle-text" aria-live="polite"></div>',
      '<div class="kikoeru-pip-subtitle-empty">等待字幕...</div>',
      '</main>'
    ].join('');

    var style = doc.createElement('style');
    style.textContent = [
      'html,body{width:100%;height:100%;margin:0;overflow:hidden;}',
      'body{box-sizing:border-box;display:flex;align-items:center;justify-content:center;padding:10px;background:rgba(248,246,245,.58);font-family:Roboto,-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;}',
      '.kikoeru-pip-subtitle-root{box-sizing:border-box;display:flex;align-items:center;justify-content:center;width:100%;height:100%;padding:4px 14px;text-align:center;}',
      '.kikoeru-pip-subtitle-text{width:100%;color:#9c27b0;font-size:var(--kikoeru-pip-font-size,36px);font-weight:800;line-height:1.16;white-space:pre-line;overflow-wrap:anywhere;text-shadow:0 1px 2px rgba(255,255,255,.72);}',
      '.kikoeru-pip-subtitle-empty{color:rgba(80,80,80,.55);font-size:clamp(15px,5vw,24px);font-weight:600;}',
      '.kikoeru-pip-subtitle-empty[hidden]{display:none!important;}'
    ].join('');
    doc.head.appendChild(style);

    pipSubtitleState.textNode = doc.querySelector('.kikoeru-pip-subtitle-text');
    pipSubtitleState.emptyNode = doc.querySelector('.kikoeru-pip-subtitle-empty');
    installPipSubtitleAutoSizing(pipWindow);
    updatePipSubtitleText(lastLyricsBarText);

    pipWindow.addEventListener('pagehide', function () {
      pipSubtitleState.win = null;
      pipSubtitleState.textNode = null;
      pipSubtitleState.emptyNode = null;
      pipSubtitleState.applySize = null;
      window.requestAnimationFrame(enhancePlayer);
    }, { once: true });
  }

  function installPipSubtitleAutoSizing(pipWindow) {
    var doc = pipWindow.document;
    var root = doc.querySelector('.kikoeru-pip-subtitle-root');
    if (!root) return;

    var applySize = function () {
      var rect = root.getBoundingClientRect();
      var width = Math.max(1, rect.width);
      var height = Math.max(1, rect.height);
      var text = normalizeDisplaySubtitleText(lastLyricsBarText);
      var lineCount = Math.max(1, text.split('\n').length);
      var longestLine = text.split('\n').reduce(function (max, line) {
        return Math.max(max, Array.from(line || '').length || 1);
      }, 1);
      var widthSize = width / Math.max(9, Math.min(24, longestLine * 0.62));
      var heightSize = height / (lineCount * 1.32);
      var fontSize = Math.max(18, Math.min(76, Math.floor(Math.min(widthSize, heightSize))));
      root.style.setProperty('--kikoeru-pip-font-size', fontSize + 'px');
    };

    applySize();
    if (pipWindow.ResizeObserver) {
      var observer = new pipWindow.ResizeObserver(applySize);
      observer.observe(root);
      pipWindow.addEventListener('pagehide', function () {
        observer.disconnect();
      }, { once: true });
    } else {
      pipWindow.addEventListener('resize', applySize);
      pipWindow.addEventListener('pagehide', function () {
        pipWindow.removeEventListener('resize', applySize);
      }, { once: true });
    }

    pipSubtitleState.applySize = applySize;
  }

  function togglePipSubtitle() {
    if (isPipSubtitleOpen()) {
      closePipSubtitle();
      enhancePlayer();
      return;
    }

    if (!window.documentPictureInPicture || !window.documentPictureInPicture.requestWindow) {
      notify('当前浏览器不支持独立画中画字幕', 'warning');
      return;
    }

    window.documentPictureInPicture.requestWindow({
      width: 720,
      height: 180
    }).then(function (pipWindow) {
      setupPipSubtitleWindow(pipWindow);
      enhancePlayer();
    }).catch(function (error) {
      if (error && error.name === 'NotAllowedError') {
        notify('请直接点击画中画字幕按钮来打开', 'warning');
        return;
      }
      notify('画中画字幕打开失败', 'negative');
    });
  }

  function enhancePlayer() {
    installLyricsBarStoreBridge();
    syncLyricsBarText();

    var card = document.querySelector('.audio-player');
    if (!card) return;
    card.classList.add('kikoeru-asmr-player');
    ensureHandle(card);
    buildControls(card);
    updateControls(card);
  }

  function getToken() {
    var token = window.localStorage.getItem('jwt-token') || '';
    return token.replace(/^"|"$/g, '');
  }

  function fetchText(url) {
    var token = getToken();
    var headers = token ? { Authorization: 'Bearer ' + token } : {};
    return window.fetch(url, { headers: headers }).then(function (response) {
      if (!response.ok) throw new Error(response.status + ' ' + response.statusText);
      return response.text();
    });
  }

  function fetchJson(url) {
    var token = getToken();
    var headers = token ? { Authorization: 'Bearer ' + token } : {};
    return window.fetch(url, { headers: headers }).then(function (response) {
      if (!response.ok) throw new Error(response.status + ' ' + response.statusText);
      return response.json();
    });
  }

  function flattenTree(items, folder, output) {
    (items || []).forEach(function (item) {
      if (!item) return;
      if (item.type === 'folder') {
        flattenTree(item.children, folder.concat(item.title), output);
      } else {
        output.push({
          item: item,
          folder: folder.join('/'),
          title: item.title || '',
          originalTitle: item.originalTitle || item.title || '',
          hash: item.hash || '',
          mediaStreamUrl: item.mediaStreamUrl || ''
        });
      }
    });
    return output;
  }

  function stripExt(name) {
    return String(name || '').replace(/\.[^.]+$/, '').toLowerCase();
  }

  function scoreSubtitle(current, candidate) {
    if (!subtitleExtPattern.test(candidate.title)) return -1;
    var score = 0;
    if (candidate.folder === current.folder) score += 20;
    var originalAudioTitle = current.originalTitle || current.title;
    var audioStem = stripExt(originalAudioTitle);
    var subStem = stripExt(candidate.title);
    if (subStem === audioStem) score += 30;
    if (subStem === String(originalAudioTitle).toLowerCase()) score += 24;
    if (subStem.indexOf(audioStem) !== -1 || audioStem.indexOf(subStem) !== -1) score += 8;
    return score;
  }

  function findSubtitleCandidates(tree, currentFile) {
    var flat = flattenTree(tree, [], []);
    var current = flat.find(function (entry) {
      return entry.hash === currentFile.hash;
    }) || {
      folder: '',
      title: currentFile.title || '',
      originalTitle: currentFile.originalTitle || currentFile.title || ''
    };

    return flat
      .filter(function (entry) {
        return entry.item.type === 'text' && subtitleExtPattern.test(entry.title);
      })
      .map(function (entry) {
        entry.score = scoreSubtitle(current, entry);
        return entry;
      })
      .filter(function (entry) {
        return entry.score >= 0;
      })
      .sort(function (a, b) {
        return b.score - a.score || a.title.localeCompare(b.title);
      });
  }

  function parseTime(value) {
    var match = String(value || '').trim().match(/(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:[.,]\d+)?)/);
    if (!match) return 0;
    var hours = Number(match[1] || 0);
    var minutes = Number(match[2] || 0);
    var seconds = Number(String(match[3]).replace(',', '.'));
    return hours * 3600 + minutes * 60 + seconds;
  }

  function formatTime(seconds) {
    var value = Math.max(0, seconds || 0);
    var minutes = Math.floor(value / 60);
    var rest = (value - minutes * 60).toFixed(2).padStart(5, '0');
    return '[' + String(minutes).padStart(2, '0') + ':' + rest + ']';
  }

  function parseLrc(text) {
    var rows = [];
    String(text || '').split(/\r?\n/).forEach(function (line) {
      var matches = line.match(/\[\d{1,3}:\d{1,2}(?:[.,]\d+)?\]/g);
      if (!matches) return;
      var body = normalizeSubtitleLineBreaks(line.replace(/\[\d{1,3}:\d{1,2}(?:[.,]\d+)?\]/g, '').trim());
      matches.forEach(function (time) {
        rows.push({ start: parseTime(time.slice(1, -1)), text: body });
      });
    });
    return rows.sort(function (a, b) { return a.start - b.start; });
  }

  function parseCueSubtitle(text) {
    var rows = [];
    var blocks = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n\r?\n/);
    blocks.forEach(function (block) {
      var lines = block.split(/\r?\n/).filter(Boolean);
      var timeIndex = lines.findIndex(function (line) {
        return line.indexOf('-->') !== -1;
      });
      if (timeIndex === -1) return;
      var range = lines[timeIndex].split('-->');
      var body = lines.slice(timeIndex + 1).join('\n').replace(/<[^>]+>/g, '').trim();
      if (!body) return;
      rows.push({
        start: parseTime(range[0]),
        end: parseTime(range[1]),
        text: body
      });
    });
    return rows.sort(function (a, b) { return a.start - b.start; });
  }

  function parseAss(text) {
    var rows = [];
    String(text || '').split(/\r?\n/).forEach(function (line) {
      if (!/^Dialogue:/i.test(line)) return;
      var parts = line.replace(/^Dialogue:\s*/i, '').split(',');
      if (parts.length < 10) return;
      rows.push({
        start: parseTime(parts[1]),
        end: parseTime(parts[2]),
        text: parts.slice(9).join(',').replace(/\{[^}]*\}/g, '').replace(/\\N/g, '\n').trim()
      });
    });
    return rows.sort(function (a, b) { return a.start - b.start; });
  }

  function parseSubtitle(text, title) {
    var lower = String(title || '').toLowerCase();
    var rows = lower.endsWith('.lrc') ? parseLrc(text)
      : lower.endsWith('.ass') ? parseAss(text)
      : parseCueSubtitle(text);

    if (!rows.length) {
      rows = String(text || '').split(/\r?\n/).filter(Boolean).map(function (line, index) {
        return { start: index, text: line };
      });
    }

    rows.forEach(function (row, index) {
      if (typeof row.end !== 'number') {
        row.end = rows[index + 1] ? rows[index + 1].start : row.start + 5;
      }
    });
    return rows;
  }

  function syncCurrentSubtitleText(text) {
    var store = getStore();
    if (!store || !store._mutations || !store._mutations['AudioPlayer/SET_CURRENT_LYRIC']) return;
    var nextText = normalizeSubtitleLineBreaks(text);
    if (subtitleState.currentText === nextText) return;
    subtitleState.currentText = nextText;
    store.commit('AudioPlayer/SET_CURRENT_LYRIC', nextText);
  }

  function registerPreviewSubtitleCues() {
    var bridge = window.KikoeruSubtitleSeek;
    if (!bridge || !bridge.registerForCurrent || !subtitleState.items.length) return;
    bridge.registerForCurrent(subtitleState.items.map(function (item) {
      return {
        startMs: Math.max(0, item.start * 1000),
        text: item.text
      };
    }));
    if (bridge.refresh) bridge.refresh();
  }

  function showSubtitlePreview() {
    var current = getCurrentFile();
    if (!current || !current.hash) {
      notify('当前没有正在播放的音频', 'warning');
      return;
    }

    var workId = String(current.hash).split('/')[0];
    fetchJson('/api/tracks/' + workId)
      .then(function (tree) {
        var candidates = findSubtitleCandidates(tree, current);
        if (!candidates.length) {
          notify('没有找到可预览的字幕文件', 'warning');
          return;
        }
        openSubtitleDialog(candidates);
      })
      .catch(function (error) {
        notify('读取字幕列表失败：' + (error.message || error), 'negative');
      });
  }

  function openSubtitleDialog(candidates) {
    closeSubtitleDialog();

    var dialog = document.createElement('div');
    dialog.className = 'kikoeru-subtitle-dialog';
    dialog.innerHTML = [
      '<div class="kikoeru-subtitle-panel" role="dialog" aria-modal="true">',
      '<div class="kikoeru-subtitle-header">',
      '<select class="kikoeru-subtitle-select"></select>',
      '<button type="button" class="kikoeru-subtitle-close" aria-label="关闭"><span class="material-icons">close</span></button>',
      '</div>',
      '<div class="kikoeru-subtitle-list"><div class="kikoeru-subtitle-empty">正在加载字幕...</div></div>',
      '<div class="kikoeru-subtitle-footer">',
      '<button type="button" class="kikoeru-subtitle-offset" data-delta="-0.3">-0.3s</button>',
      '<div class="kikoeru-subtitle-offset-value">0.0s</div>',
      '<button type="button" class="kikoeru-subtitle-offset" data-delta="0.3">+0.3s</button>',
      '</div>',
      '</div>'
    ].join('');

    var select = dialog.querySelector('.kikoeru-subtitle-select');
    candidates.forEach(function (entry, index) {
      var option = document.createElement('option');
      option.value = String(index);
      option.textContent = entry.title;
      select.appendChild(option);
    });

    dialog.addEventListener('click', function (event) {
      if (event.target === dialog) closeSubtitleDialog();
    });
    dialog.querySelector('.kikoeru-subtitle-close').addEventListener('click', closeSubtitleDialog);
    select.addEventListener('change', function () {
      loadSubtitleCandidate(candidates[Number(select.value)], dialog);
    });
    dialog.querySelectorAll('.kikoeru-subtitle-offset').forEach(function (button) {
      button.addEventListener('click', function () {
        subtitleState.offset = Math.round((subtitleState.offset + Number(button.dataset.delta)) * 10) / 10;
        updateSubtitleOffset(dialog);
        updateSubtitleHighlight(dialog);
      });
    });

    document.body.appendChild(dialog);
    subtitleState.dialog = dialog;
    subtitleState.offset = 0;
    loadSubtitleCandidate(candidates[0], dialog);
    subtitleState.timer = window.setInterval(function () {
      updateSubtitleHighlight(dialog);
    }, 400);
  }

  function loadSubtitleCandidate(candidate, dialog) {
    var list = dialog.querySelector('.kikoeru-subtitle-list');
    list.innerHTML = '<div class="kikoeru-subtitle-empty">正在加载字幕...</div>';
    fetchText(candidate.mediaStreamUrl)
      .then(function (text) {
        subtitleState.items = parseSubtitle(text, candidate.title);
        subtitleState.currentText = '';
        registerPreviewSubtitleCues();
        renderSubtitleRows(dialog);
      })
      .catch(function (error) {
        list.innerHTML = '<div class="kikoeru-subtitle-empty">字幕读取失败：' + escapeHtml(error.message || error) + '</div>';
      });
  }

  function renderSubtitleRows(dialog) {
    var list = dialog.querySelector('.kikoeru-subtitle-list');
    if (!subtitleState.items.length) {
      list.innerHTML = '<div class="kikoeru-subtitle-empty">这个字幕文件没有可显示的内容</div>';
      return;
    }
    list.innerHTML = '';
    subtitleState.items.forEach(function (item) {
      var row = document.createElement('div');
      row.className = 'kikoeru-subtitle-row';
      row.dataset.start = String(item.start);
      row.dataset.end = String(item.end);
      row.setAttribute('role', 'button');
      row.setAttribute('tabindex', '0');
      row.setAttribute('aria-label', '跳转到 ' + formatTime(item.start));
      row.innerHTML = '<div class="kikoeru-subtitle-time">' + formatTime(item.start) + '</div><div class="kikoeru-subtitle-text">' + escapeHtml(item.text) + '</div>';
      row.addEventListener('click', function () {
        seekToSubtitleItem(item, row, dialog);
      });
      row.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        seekToSubtitleItem(item, row, dialog);
      });
      list.appendChild(row);
    });
    updateSubtitleHighlight(dialog);
  }

  function seekToSubtitleItem(item, row, dialog) {
    var store = getStore();
    var state = getPlayerState();
    var audio = getAudioElement();
    if (!item || !store || !state) return;

    var seconds = Math.max(0, item.start - subtitleState.offset);
    if (audio) {
      audio.currentTime = seconds;
      audio.dispatchEvent(new Event('timeupdate'));
      audio.dispatchEvent(new Event('seeked'));
      if (audio.paused && audio.play) {
        var playResult = audio.play();
        if (playResult && playResult.catch) playResult.catch(function () {});
      }
    }

    if (store._mutations && store._mutations['AudioPlayer/SET_CURRENT_TIME']) {
      store.commit('AudioPlayer/SET_CURRENT_TIME', seconds);
    }
    syncCurrentSubtitleText(item.text);
    if (!state.playing && store._mutations && store._mutations['AudioPlayer/PLAY']) {
      store.commit('AudioPlayer/PLAY');
    }

    if (row) {
      Array.prototype.forEach.call(dialog.querySelectorAll('.kikoeru-subtitle-row'), function (node) {
        delete node.dataset.seen;
        node.classList.remove('is-current');
      });
      row.classList.add('is-current');
      row.dataset.seen = '1';
    }
  }

  function updateSubtitleOffset(dialog) {
    var value = dialog.querySelector('.kikoeru-subtitle-offset-value');
    if (value) {
      value.textContent = subtitleState.offset.toFixed(1) + 's';
    }
  }

  function updateSubtitleHighlight(dialog) {
    var state = getPlayerState();
    if (!state || !dialog || !document.body.contains(dialog)) return;
    var time = state.currentTime + subtitleState.offset;
    var rows = Array.prototype.slice.call(dialog.querySelectorAll('.kikoeru-subtitle-row'));
    var active = null;
    var activeIndex = -1;
    rows.forEach(function (row, index) {
      var start = Number(row.dataset.start);
      if (time >= start) activeIndex = index;
    });
    rows.forEach(function (row, index) {
      var current = index === activeIndex;
      row.classList.toggle('is-current', current);
      if (current) active = row;
    });
    if (activeIndex >= 0 && subtitleState.items[activeIndex]) {
      syncCurrentSubtitleText(subtitleState.items[activeIndex].text);
    }
    if (active && !active.dataset.seen) {
      rows.forEach(function (row) { delete row.dataset.seen; });
      active.dataset.seen = '1';
      active.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  function closeSubtitleDialog() {
    if (subtitleState.timer) {
      window.clearInterval(subtitleState.timer);
      subtitleState.timer = null;
    }
    if (subtitleState.dialog && subtitleState.dialog.parentNode) {
      subtitleState.dialog.parentNode.removeChild(subtitleState.dialog);
    }
    subtitleState.dialog = null;
    subtitleState.items = [];
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function boot() {
    var scheduled = false;
    var schedule = function () {
      if (scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(function () {
        scheduled = false;
        enhancePlayer();
      });
    };

    var observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    window.setInterval(schedule, 500);
    schedule();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}());
