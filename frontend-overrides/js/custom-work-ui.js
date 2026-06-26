(function () {
  'use strict';

  if (window.localStorage.getItem('kikoeru-disable-custom-work-ui') === '1') {
    return;
  }

  var state = {
    currentWorkId: null,
    requestKey: 0,
    cache: Object.create(null),
    pending: Object.create(null),
    scheduled: false,
    subtitleCuesByHash: Object.create(null),
    subtitleHashByAudioHash: Object.create(null),
    pendingSubtitleByAudioHash: Object.create(null),
    subtitleProbeDoneByAudioHash: Object.create(null),
    seekControlsInstalled: false,
    searchRequestInterceptorInstalled: false,
    reviewPanelOpenByWorkId: Object.create(null)
  };

  var subtitleExtPattern = /\.(lrc|srt|ass|vtt)$/i;
  var subtitleLineBreakToken = '\uE000';
  var languageNames = [
    '日本语',
    '日本語',
    '日语',
    '日文',
    '中文',
    '繁體中文',
    '繁体中文',
    '简体中文',
    '简體中文'
  ];

  var languageLabelMap = {
    '日本語': '日本語',
    '日本语': '日本語',
    '簡体中文': '简体中文',
    '简体中文': '简体中文',
    '简體中文': '简体中文',
    '繁體中文': '繁體中文',
    '繁体中文': '繁體中文',
    '中文': '中文',
    '韓国語': '韓国語',
    '韩语': '韓国語',
    '英語': '英語',
    '英语': '英語'
  };

  function getWorkIdFromPath() {
    var match = window.location.pathname.match(/^\/work\/(\d+)/);
    return match ? match[1] : null;
  }

  function getToken() {
    var token = window.localStorage.getItem('jwt-token') || '';
    return token.replace(/^"|"$/g, '');
  }

  function fetchJson(url, options) {
    var token = getToken();
    var headers = token ? { Authorization: 'Bearer ' + token } : {};
    options = options || {};
    options.headers = Object.assign({}, options.headers || {}, headers);
    return window.fetch(url, options).then(function (response) {
      if (!response.ok) {
        throw new Error(response.status + ' ' + response.statusText);
      }
      return response.json();
    });
  }

  function getRootVue() {
    var app = document.querySelector('#q-app');
    return app && app.__vue__;
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

  function normalizeCueTime(timeText) {
    var normalized = String(timeText || '').trim().replace(',', '.');
    if (/^\d{2}:\d{2}\.\d{3}$/.test(normalized)) {
      return '00:' + normalized;
    }
    return normalized;
  }

  function parseCueTimeToMs(timeText) {
    var normalized = normalizeCueTime(timeText);
    var match = normalized.match(/^(\d{2}):(\d{2}):(\d{2})\.(\d{1,3})$/);
    if (!match) return null;

    return (Number(match[1]) * 3600000) +
      (Number(match[2]) * 60000) +
      (Number(match[3]) * 1000) +
      Number(match[4].padEnd(3, '0'));
  }

  function parseSubtitleText(text) {
    var content = String(text || '').replace(/^\uFEFF/, '').replace(/\r/g, '');
    if (!/WEBVTT|-->/i.test(content)) {
      return {
        lrc: text,
        cues: []
      };
    }

    var lines = content.split('\n');
    var output = [];
    var cues = [];

    for (var index = 0; index < lines.length; index += 1) {
      var line = lines[index].trim();
      if (!line || /^WEBVTT/i.test(line) || /^NOTE($|\s)/i.test(line) || /^\d+$/.test(line)) {
        continue;
      }

      if (line.indexOf('-->') === -1) {
        continue;
      }

      var start = normalizeCueTime(line.split('-->')[0].trim().split(/\s+/)[0]);
      var startMs = parseCueTimeToMs(start);
      var textLines = [];
      index += 1;

      while (index < lines.length && lines[index].trim()) {
        textLines.push(lines[index].trim().replace(/<[^>]+>/g, ''));
        index += 1;
      }

      var cueText = textLines.join('\n').trim();
      var lrcText = textLines.join(subtitleLineBreakToken).trim();
      if (cueText) {
        output.push('[' + start + ']' + lrcText);
        if (startMs !== null) {
          cues.push({
            startMs: startMs,
            text: cueText
          });
        }
      }
    }

    return {
      lrc: output.length ? output.join('\n') : text,
      cues: cues
    };
  }

  function webVttOrSrtToLrc(text) {
    return parseSubtitleText(text).lrc;
  }

  function normalizeLyricLineBreaks(text) {
    return String(text || '')
      .replace(new RegExp(subtitleLineBreakToken, 'g'), '\n')
      .replace(/\u2028/g, '\n');
  }

  function installLyricLineBreakBridge() {
    var vm = getRootVue();
    var store = vm && vm.$store;
    if (!store || store.__kikoeruLyricLineBreakBridgeInstalled || typeof store.commit !== 'function') {
      return;
    }

    var originalCommit = store.commit;
    store.commit = function (type, payload, options) {
      if (type === 'AudioPlayer/SET_CURRENT_LYRIC' && typeof payload === 'string') {
        payload = normalizeLyricLineBreaks(payload);
      }
      return originalCommit.call(this, type, payload, options);
    };
    store.__kikoeruLyricLineBreakBridgeInstalled = true;
  }

  function installSubtitleResponseInterceptor() {
    var vm = getRootVue();
    var axios = vm && vm.$axios;
    if (!axios || !axios.interceptors || axios.__kikoeruSubtitleBridgeInstalled) {
      return;
    }

    axios.__kikoeruSubtitleBridgeInstalled = true;
    axios.interceptors.response.use(function (response) {
      var url = response && response.config && response.config.url;
      var checkMatch = url && url.match(/\/api\/media\/check-lrc\/([^?]+)/);
      if (checkMatch && response.data && response.data.result && response.data.hash) {
        state.subtitleHashByAudioHash[decodeURIComponent(checkMatch[1])] = response.data.hash;
      }

      if (url && url.indexOf('/api/media/stream/') !== -1 && typeof response.data === 'string') {
        var streamMatch = url.match(/\/api\/media\/stream\/([^?]+)/);
        var parsed = parseSubtitleText(response.data);
        if (streamMatch && parsed.cues.length) {
          state.subtitleCuesByHash[decodeURIComponent(streamMatch[1])] = parsed.cues;
        }
        response.data = parsed.lrc;
        refreshSmartSeekIcons();
      }
      return response;
    });
  }

  function installSearchRequestInterceptor() {
    var vm = getRootVue();
    var axios = vm && vm.$axios;
    if (!axios || !axios.interceptors || axios.__kikoeruSearchBridgeInstalled) {
      return;
    }

    axios.__kikoeruSearchBridgeInstalled = true;
    axios.interceptors.request.use(function (config) {
      var url = config && config.url || '';
      var match = url.match(/^\/api\/search\/([^?]+)/);
      if (!match) return config;

      config.url = '/api/search';
      config.params = Object.assign({}, config.params, {
        keyword: decodeURIComponent(match[1])
      });
      return config;
    });
  }

  function getAudioStoreState() {
    var vm = getRootVue();
    var store = vm && vm.$store;
    var audioState = store && store.state && store.state.AudioPlayer;
    if (!store || !audioState) return null;

    return {
      store: store,
      state: audioState,
      currentFile: store.getters && store.getters['AudioPlayer/currentPlayingFile'] || audioState.queue[audioState.queueIndex] || null
    };
  }

  function getCurrentSubtitleCues() {
    var audio = getAudioStoreState();
    var hash = audio && audio.currentFile && audio.currentFile.hash;
    var subtitleHash = hash && state.subtitleHashByAudioHash[hash];
    return subtitleHash && state.subtitleCuesByHash[subtitleHash] || [];
  }

  function preloadCurrentSubtitleCues() {
    var vm = getRootVue();
    var axios = vm && vm.$axios;
    var audio = getAudioStoreState();
    var hash = audio && audio.currentFile && audio.currentFile.hash;
    if (!axios || !hash || state.pendingSubtitleByAudioHash[hash]) return;

    var knownSubtitleHash = state.subtitleHashByAudioHash[hash];
    if (knownSubtitleHash && state.subtitleCuesByHash[knownSubtitleHash]) return;
    if (state.subtitleProbeDoneByAudioHash[hash]) return;

    var token = getToken();
    var tokenQuery = token ? '?token=' + encodeURIComponent(token) : '';
    state.pendingSubtitleByAudioHash[hash] = true;

    axios.get('/api/media/check-lrc/' + hash + tokenQuery).then(function (response) {
      if (!response.data || !response.data.result || !response.data.hash) return null;
      state.subtitleHashByAudioHash[hash] = response.data.hash;
      if (state.subtitleCuesByHash[response.data.hash]) return null;
      return axios.get('/api/media/stream/' + response.data.hash + tokenQuery);
    }).catch(function () {
      // Keep original seek behavior when subtitle probing fails.
    }).finally(function () {
      delete state.pendingSubtitleByAudioHash[hash];
      state.subtitleProbeDoneByAudioHash[hash] = true;
      refreshSmartSeekIcons();
    });
  }

  function hasCurrentSubtitleCues() {
    return getCurrentSubtitleCues().length > 0;
  }

  function findCurrentCueIndex(cues, currentMs) {
    var index = -1;
    for (var i = 0; i < cues.length; i += 1) {
      if (cues[i].startMs <= currentMs + 80) {
        index = i;
      } else {
        break;
      }
    }
    return index;
  }

  function findSubtitleSeekTarget(cues, currentMs, direction) {
    if (!cues.length) return null;

    if (direction < 0) {
      var currentIndex = findCurrentCueIndex(cues, currentMs);
      if (currentIndex < 0) return cues[0];

      return cues[Math.max(0, currentIndex - 1)];
    }

    for (var i = 0; i < cues.length; i += 1) {
      if (cues[i].startMs > currentMs + 300) {
        return cues[i];
      }
    }
    return cues[cues.length - 1];
  }

  function getAudioElement() {
    return document.querySelector('.plyr audio') || document.querySelector('audio');
  }

  function seekAudioToCue(cue) {
    var audio = getAudioElement();
    var audioState = getAudioStoreState();
    if (!cue || !audioState) return false;

    var seconds = Math.max(0, cue.startMs / 1000);
    if (audio) {
      audio.currentTime = seconds;
      audio.dispatchEvent(new Event('timeupdate'));
      audio.dispatchEvent(new Event('seeked'));
    }

    audioState.store.commit('AudioPlayer/SET_CURRENT_TIME', seconds);
    audioState.store.commit('AudioPlayer/SET_CURRENT_LYRIC', cue.text);
    return true;
  }

  function jumpBySubtitle(direction) {
    var audioState = getAudioStoreState();
    if (!audioState || !audioState.currentFile || !audioState.currentFile.hash) return false;

    var cues = getCurrentSubtitleCues();
    if (!cues.length) return false;

    var audio = getAudioElement();
    var currentMs = ((audio && Number.isFinite(audio.currentTime) ? audio.currentTime : audioState.state.currentTime) || 0) * 1000;
    var targetCue = findSubtitleSeekTarget(cues, currentMs, direction);
    return seekAudioToCue(targetCue);
  }

  function getSeekDirectionFromButton(button) {
    if (!button) return 0;
    if (button.classList.contains('kikoeru-subtitle-seek-prev')) return -1;
    if (button.classList.contains('kikoeru-subtitle-seek-next')) return 1;

    var text = (button.textContent || '').replace(/\s+/g, '');
    if (/^(replay_(5|10|30)|keyboard_arrow_left)$/.test(text)) return -1;
    if (/^(forward_(5|10|30)|keyboard_arrow_right)$/.test(text)) return 1;
    return 0;
  }

  function rememberIconText(icon) {
    if (!icon.dataset.kikoeruOriginalIcon) {
      icon.dataset.kikoeruOriginalIcon = (icon.textContent || '').trim();
    }
  }

  function restoreIconText(icon) {
    if (icon.dataset.kikoeruOriginalIcon) {
      icon.textContent = icon.dataset.kikoeruOriginalIcon;
      delete icon.dataset.kikoeruOriginalIcon;
    }
  }

  function refreshSmartSeekIcons() {
    var active = hasCurrentSubtitleCues();
    document.querySelectorAll('.q-btn .material-icons, .q-btn .q-icon').forEach(function (icon) {
      var original = icon.dataset.kikoeruOriginalIcon || (icon.textContent || '').trim();
      var button = icon.closest('.q-btn');
      if (!button) return;

      if (/^replay_(5|10|30)$/.test(original)) {
        if (active) {
          rememberIconText(icon);
          icon.textContent = 'keyboard_arrow_left';
          button.classList.add('kikoeru-subtitle-seek-button', 'kikoeru-subtitle-seek-prev');
          button.setAttribute('title', '上一句字幕');
          button.setAttribute('aria-label', '上一句字幕');
        } else {
          restoreIconText(icon);
          button.classList.remove('kikoeru-subtitle-seek-button', 'kikoeru-subtitle-seek-prev');
          button.removeAttribute('title');
          button.removeAttribute('aria-label');
        }
      }

      if (/^forward_(5|10|30)$/.test(original)) {
        if (active) {
          rememberIconText(icon);
          icon.textContent = 'keyboard_arrow_right';
          button.classList.add('kikoeru-subtitle-seek-button', 'kikoeru-subtitle-seek-next');
          button.setAttribute('title', '下一句字幕');
          button.setAttribute('aria-label', '下一句字幕');
        } else {
          restoreIconText(icon);
          button.classList.remove('kikoeru-subtitle-seek-button', 'kikoeru-subtitle-seek-next');
          button.removeAttribute('title');
          button.removeAttribute('aria-label');
        }
      }
    });
  }

  function registerSubtitleCuesForCurrent(cues) {
    var audioState = getAudioStoreState();
    var hash = audioState && audioState.currentFile && audioState.currentFile.hash;
    if (!hash || !cues || !cues.length) return false;

    var subtitleHash = hash + '#preview';
    state.subtitleHashByAudioHash[hash] = subtitleHash;
    state.subtitleCuesByHash[subtitleHash] = cues
      .filter(function (cue) {
        return cue && Number.isFinite(cue.startMs) && cue.text;
      })
      .map(function (cue) {
        return {
          startMs: Math.max(0, cue.startMs),
          text: String(cue.text)
        };
      })
      .sort(function (a, b) { return a.startMs - b.startMs; });
    state.subtitleProbeDoneByAudioHash[hash] = true;
    refreshSmartSeekIcons();
    return state.subtitleCuesByHash[subtitleHash].length > 0;
  }

  function installSmartSeekControls() {
    if (state.seekControlsInstalled) return;
    state.seekControlsInstalled = true;
    window.KikoeruSubtitleSeek = {
      hasCues: hasCurrentSubtitleCues,
      jump: jumpBySubtitle,
      registerForCurrent: registerSubtitleCuesForCurrent,
      refresh: refreshSmartSeekIcons
    };

    document.addEventListener('click', function (event) {
      var button = event.target && event.target.closest && event.target.closest('.q-btn');
      var direction = getSeekDirectionFromButton(button);
      if (!direction) return;

      if (jumpBySubtitle(direction)) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        refreshSmartSeekIcons();
      }
    }, true);
  }

  function flattenTree(items, output) {
    (items || []).forEach(function (item) {
      if (item && item.type === 'folder') {
        flattenTree(item.children, output);
      } else if (item) {
        output.push(item);
      }
    });
    return output;
  }

  function countTreeFolders(items) {
    var count = 0;
    (items || []).forEach(function (item) {
      if (item && item.type === 'folder') {
        count += 1 + countTreeFolders(item.children);
      }
    });
    return count;
  }

  function createFileBridge(tree, flatFiles) {
    var bridge = document.createElement('div');
    var audioCount = flatFiles.filter(function (file) { return file.type === 'audio'; }).length;
    var subtitleCount = flatFiles.filter(function (file) { return file.type === 'text' && subtitleExtPattern.test(file.title || ''); }).length;
    var localizedTitleCount = flatFiles.filter(function (file) {
      return file.originalTitle && file.originalTitle !== file.title;
    }).length;
    var folderCount = countTreeFolders(tree);

    bridge.className = 'kikoeru-file-bridge';
    bridge.innerHTML = '<div class="kikoeru-file-bridge-main">'
      + '<span class="material-icons" aria-hidden="true">folder</span>'
      + '<span class="kikoeru-file-bridge-title">文件列表</span>'
      + '</div>'
      + '<div class="kikoeru-file-bridge-stats">'
      + '<span>全部文件 ' + flatFiles.length + '</span>'
      + '<span>音频 ' + audioCount + '</span>'
      + (subtitleCount ? '<span>字幕 ' + subtitleCount + '</span>' : '')
      + (localizedTitleCount ? '<span>标题已译 ' + localizedTitleCount + '</span>' : '')
      + (folderCount ? '<span>文件夹 ' + folderCount + '</span>' : '')
      + '</div>';

    return bridge;
  }

  function insertFileBridge(dom, tree, flatFiles) {
    if (!dom.workTree) return;

    removeOldFileBridge(dom);
    var breadcrumbs = dom.workTree.querySelector('.q-breadcrumbs');
    var bridge = createFileBridge(tree, flatFiles);
    if (breadcrumbs && breadcrumbs.parentNode === dom.workTree) {
      dom.workTree.insertBefore(bridge, breadcrumbs.nextSibling);
    } else {
      dom.workTree.insertBefore(bridge, dom.workTree.firstChild);
    }
  }

  function findWorkDom(workId) {
    var coverLink = document.querySelector('.q-page-container a[href="/work/' + workId + '"]');
    if (!coverLink || !coverLink.querySelector('.q-img')) return null;

    var detailsRoot = coverLink.parentElement;
    var infoPanel = coverLink.nextElementSibling;
    var pageRoot = detailsRoot && detailsRoot.parentElement;
    var workTree = detailsRoot && detailsRoot.nextElementSibling;

    if (!detailsRoot || !infoPanel || !pageRoot) return null;

    return {
      pageRoot: pageRoot,
      detailsRoot: detailsRoot,
      coverLink: coverLink,
      infoPanel: infoPanel,
      workTree: workTree
    };
  }

  function ensureClasses(dom) {
    dom.pageRoot.classList.add('kikoeru-work-page');
    dom.detailsRoot.classList.add('kikoeru-work-details');
    dom.coverLink.classList.add('kikoeru-cover-link');
    dom.infoPanel.classList.add('kikoeru-info-panel');
    if (dom.workTree) {
      dom.workTree.classList.add('kikoeru-work-tree');
    }
  }

  function hasSubtitle(metadata, flatFiles) {
    if (metadata && metadata.lyric_status) {
      return true;
    }
    return flatFiles.some(function (file) {
      return file.type === 'text' && subtitleExtPattern.test(file.title || '');
    });
  }

  function getSubtitleFiles(flatFiles) {
    return flatFiles.filter(function (file) {
      return file.type === 'text' && subtitleExtPattern.test(file.title || '');
    });
  }

  function formatWorkNo(id) {
    var numeric = Number(id);
    if (!Number.isFinite(numeric)) return '';
    var width = numeric >= 1000000 ? 8 : 6;
    return 'RJ' + String(numeric).padStart(width, '0');
  }

  function getCurrentDlLanguageLabel(metadata) {
    var currentWorkNo = formatWorkNo(metadata && metadata.id).toUpperCase();
    var dlsiteLanguages = metadata && metadata.dlsite_languages || [];
    var sameWorkLanguages = dlsiteLanguages.filter(function (item) {
      return item && item.source === 'same_work';
    });
    var currentEditionLanguage = dlsiteLanguages.find(function (item) {
      return String(item && item.workno || '').toUpperCase() === currentWorkNo;
    });

    if (sameWorkLanguages.length > 1) {
      return 'DL\u591a\u8bed';
    }
    if (sameWorkLanguages.some(function (item) { return normalizeDlsiteLanguageCode(item && item.lang) === 'CHI_HANS'; })) {
      return 'DL\u7b80\u4e2d';
    }
    if (sameWorkLanguages.some(function (item) { return normalizeDlsiteLanguageCode(item && item.lang) === 'CHI_HANT'; })) {
      return 'DL\u7e41\u4e2d';
    }
    if (normalizeDlsiteLanguageCode(currentEditionLanguage && currentEditionLanguage.lang) === 'CHI_HANS') {
      return 'DL\u7b80\u4e2d';
    }
    if (normalizeDlsiteLanguageCode(currentEditionLanguage && currentEditionLanguage.lang) === 'CHI_HANT') {
      return 'DL\u7e41\u4e2d';
    }

    var editions = metadata && metadata.dl_count_items || [];
    var edition = editions.find(function (item) {
      return String(item && item.workno || '').toUpperCase() === currentWorkNo;
    });

    if (!edition) return '';
    if (String(edition.lang || '').toUpperCase() === 'CHI_HANS') return 'DL简中';
    if (String(edition.lang || '').toUpperCase() === 'CHI_HANT') return 'DL繁中';
    return '';
  }

  function getDlLanguageLabelFromTitle(metadata) {
    var text = [metadata && metadata.title, metadata && metadata.dir].filter(Boolean).join(' ');
    if (/(繁体中文版|繁體中文版|繁体中文|繁體中文|繁中|繁体字字幕版|繁體字字幕版)/.test(text)) {
      return 'DL繁中';
    }
    if (/(简体中文版|簡体中文版|简体中文|簡体中文|简中|简体字字幕版|簡体字字幕版)/.test(text)) {
      return 'DL简中';
    }
    return '';
  }

  function inferTranslatorGroupLabel(subtitleFiles) {
    var text = subtitleFiles.map(function (file) {
      return [file.title, file.subtitle].filter(Boolean).join(' ');
    }).join('\n');
    var patterns = [
      /\[([^\[\]]{2,24}(?:字幕组|字幕組|汉化组|漢化組|翻译组|翻譯組|同好会|同好會))\]/,
      /【([^】]{2,24}(?:字幕组|字幕組|汉化组|漢化組|翻译组|翻譯組|同好会|同好會))】/,
      /([^\\/\[\]【】]{2,24}(?:字幕组|字幕組|汉化组|漢化組|翻译组|翻譯組|同好会|同好會))/
    ];

    for (var i = 0; i < patterns.length; i += 1) {
      var match = text.match(patterns[i]);
      if (match && match[1]) {
        return match[1].trim();
      }
    }
    return '汉化组';
  }

  function getLocalSubtitleMeta(metadata) {
    return metadata && metadata.localSubtitleMeta || null;
  }

  function getLocalSubtitleBadges(metadata) {
    var localMeta = getLocalSubtitleMeta(metadata);
    return localMeta && Array.isArray(localMeta.badges) ? localMeta.badges.filter(function (badge) {
      return badge && badge.label;
    }) : [];
  }

  function getLocalWorkDisplayTitle(metadata) {
    var localMeta = getLocalSubtitleMeta(metadata);
    return localMeta && localMeta.workTitle ? String(localMeta.workTitle).trim() : '';
  }

  function getOriginalWorkTitle(metadata, fallbackTitle) {
    var originalTitle = metadata && metadata.originalTitle ? String(metadata.originalTitle).trim() : '';
    if (originalTitle) return originalTitle;
    return String(fallbackTitle || '').trim();
  }

  function applyLocalWorkTitle(dom, metadata) {
    var displayTitle = getLocalWorkDisplayTitle(metadata);
    if (!displayTitle || !dom || !dom.infoPanel) return;

    var titleNode = dom.infoPanel.querySelector('.text-h6');
    if (!titleNode) return;
    var originalTitle = getOriginalWorkTitle(metadata, titleNode.textContent);
    if (!titleNode.dataset.kikoeruOriginalTitle) {
      titleNode.dataset.kikoeruOriginalTitle = originalTitle;
      titleNode.title = titleNode.dataset.kikoeruOriginalTitle;
    } else if (originalTitle && titleNode.dataset.kikoeruOriginalTitle === displayTitle) {
      titleNode.dataset.kikoeruOriginalTitle = originalTitle;
      titleNode.title = originalTitle;
    }
    titleNode.textContent = displayTitle;

    if (titleNode.dataset.kikoeruOriginalTitle && titleNode.dataset.kikoeruOriginalTitle !== displayTitle) {
      var originalNode = dom.infoPanel.querySelector('.kikoeru-local-original-title');
      if (!originalNode) {
        originalNode = document.createElement('div');
        originalNode.className = 'kikoeru-local-original-title';
        titleNode.insertAdjacentElement('afterend', originalNode);
      }
      originalNode.textContent = titleNode.dataset.kikoeruOriginalTitle;
    }
  }

  function getSubtitleStatusLabel(metadata, flatFiles) {
    var localBadges = getLocalSubtitleBadges(metadata);
    if (localBadges.length) {
      return localBadges[0].label;
    }

    var subtitleFiles = getSubtitleFiles(flatFiles);
    var hasLocalSubtitle = subtitleFiles.length > 0;
    var hasAiSubtitle = Boolean(metadata && metadata.lyric_status && metadata.lyric_status.indexOf('ai') !== -1);

    if (hasLocalSubtitle) {
      var dlLanguageLabel = getCurrentDlLanguageLabel(metadata) || getDlLanguageLabelFromTitle(metadata);
      if (dlLanguageLabel) return dlLanguageLabel;
      return inferTranslatorGroupLabel(subtitleFiles);
    }

    if (hasAiSubtitle) return 'AI字幕';
    return '无字幕';
  }

  function getLanguages(metadata) {
    var tags = metadata && metadata.tags ? metadata.tags : [];
    var found = [];
    tags.forEach(function (tag) {
      var name = tag && tag.name;
      if (!name) return;
      if (languageNames.indexOf(name) !== -1 && found.indexOf(name) === -1) {
        found.push(name);
      }
    });
    return found;
  }

  function normalizeLanguageLabel(label) {
    return languageLabelMap[label] || label;
  }

  function normalizeDlLanguageLabel(item) {
    var lang = String(item && item.lang || '').toUpperCase();
    var label = item && item.label;
    if (lang === 'JPN') return '日本語';
    if (lang === 'CHI_HANS') return '简体中文';
    if (lang === 'CHI_HANT') return '繁體中文';
    if (lang === 'ENG') return '英語';
    if (lang === 'KO_KR') return '韓国語';
    if (lang === 'THA') return 'タイ語';
    return normalizeLanguageLabel(label || lang);
  }

  function addUniqueName(list, name) {
    if (name && list.indexOf(name) === -1) {
      list.push(name);
    }
  }

  function looksLikeTranslatedEdition(metadata, supplemental) {
    var text = [
      metadata && metadata.title,
      metadata && metadata.dir,
      supplemental && supplemental.title
    ].filter(Boolean).join(' ');
    return /(\u4e2d\u6587|\u7b80\u4f53|\u7c21\u9ad4|\u7b80\u4e2d|\u7e41\u4f53|\u7e41\u9ad4|\u7e41\u4e2d|\u6c49\u5316|\u6f22\u5316|\u82f1\u8a9e|\u82f1\u8bed|English|\u97d3\u56fd\u8a9e|\u97d3\u570b\u8a9e|\u97e9\u8bed|\u97d3\u8a9e|\u30bf\u30a4\u8a9e|\u6cf0\u8bed)/i.test(text);
  }

  function normalizeDlsiteLanguageCode(value) {
    return String(value || '').trim().toUpperCase().replace(/-/g, '_');
  }

  function getDlsiteLanguageDisplayName(item) {
    var lang = normalizeDlsiteLanguageCode(item && item.lang || item);
    if (lang === 'JPN') return '\u65e5\u8bed';
    if (lang === 'CHI') return '\u4e2d\u6587';
    if (lang === 'CHI_HANS') return '\u7b80\u4f53\u4e2d\u6587';
    if (lang === 'CHI_HANT') return '\u7e41\u9ad4\u4e2d\u6587';
    if (lang === 'ENG') return '\u82f1\u8bed';
    if (lang === 'KO_KR') return '\u97e9\u8bed';
    if (lang === 'THA') return '\u6cf0\u8bed';
    return normalizeLanguageLabel(item && item.label || item && item.lang || item);
  }

  function getDlsiteLanguageLabels(metadata, supplemental) {
    var items = [];
    var seenCodes = Object.create(null);
    var labels = [];

    (metadata && metadata.dlsite_languages || []).forEach(function (item) {
      items.push(item);
    });

    if (!items.length) {
      (metadata && metadata.dl_count_items || []).forEach(function (item) {
        items.push(item);
      });
      (supplemental && supplemental.language_editions || []).forEach(function (item) {
        items.push(item);
      });
    }

    items.forEach(function (item) {
      var lang = normalizeDlsiteLanguageCode(item && item.lang);
      if (!lang) return;
      seenCodes[lang] = true;
    });

    if ((seenCodes.CHI_HANS || seenCodes.CHI_HANT) && seenCodes.CHI) {
      delete seenCodes.CHI;
    }

    Object.keys(seenCodes).sort(function (left, right) {
      var order = {
        CHI_HANS: 1,
        CHI_HANT: 2,
        JPN: 3,
        ENG: 4,
        KO_KR: 5,
        THA: 6
      };
      return (order[left] || 99) - (order[right] || 99) || left.localeCompare(right);
    }).forEach(function (lang) {
      addUniqueName(labels, getDlsiteLanguageDisplayName(lang));
    });

    if (labels.length > 1) {
      labels.unshift('DL\u591a\u8bed');
    }

    return labels;
  }

  function getLanguageLabels(metadata, supplemental) {
    var dlsiteLabels = getDlsiteLanguageLabels(metadata, supplemental);
    if (dlsiteLabels.length) return dlsiteLabels;

    var found = [];
    var hasMultipleEditions = (supplemental && supplemental.language_editions || []).length > 1;

    if (hasMultipleEditions) {
      addUniqueName(found, '多语种');
    }

    getLanguages(metadata).forEach(function (name) {
      addUniqueName(found, normalizeLanguageLabel(name));
    });

    (metadata && metadata.dl_count_items || []).forEach(function (edition) {
      addUniqueName(found, normalizeDlLanguageLabel(edition));
    });

    (supplemental && supplemental.other_language_editions_in_db || []).forEach(function (edition) {
      addUniqueName(found, normalizeLanguageLabel(edition && edition.lang));
    });

    var title = (metadata && metadata.title || supplemental && supplemental.title || '');
    if (/日本語|日本语|日语|日文/.test(title)) addUniqueName(found, '日本語');
    if (/簡体中文|简体中文|简體中文/.test(title)) addUniqueName(found, '简体中文');
    if (/繁體中文|繁体中文/.test(title)) addUniqueName(found, '繁體中文');

    if (!found.length && !looksLikeTranslatedEdition(metadata, supplemental)) {
      addUniqueName(found, '\u65e5\u6587\u7248');
    }

    return found;
  }

  function mergeTags(metadata, supplemental) {
    var output = [];
    var seen = Object.create(null);
    var addTag = function (tag, source) {
      var name = tag && tag.name;
      if (!name) return;
      var key = String(tag.id || name).toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      output.push({
        id: tag.id,
        name: name,
        source: source,
        voteStatus: typeof tag.voteStatus === 'number' ? tag.voteStatus : null,
        upvote: Number(tag.upvote || 0),
        downvote: Number(tag.downvote || 0)
      });
    };

    (metadata && metadata.tags || []).forEach(function (tag) {
      addTag(tag, 'local');
    });
    (supplemental && supplemental.tags || []).forEach(function (tag) {
      addTag(tag, 'asmrone');
    });

    return output;
  }

  function removeOldEnhancements(infoPanel) {
    infoPanel.classList.remove('kikoeru-enhancing');
    infoPanel.classList.remove('kikoeru-review-mode');
    infoPanel.querySelectorAll('.kikoeru-status-row, .kikoeru-action-row, .kikoeru-tag-row, .kikoeru-review-shell, .kikoeru-review-voice-row, .kikoeru-review-voice-actions, .kikoeru-meta-chip, .kikoeru-duration-meta').forEach(function (node) {
      node.remove();
    });
    infoPanel.querySelectorAll('.kikoeru-original-tags-hidden').forEach(function (node) {
      node.classList.remove('kikoeru-original-tags-hidden');
    });
    infoPanel.querySelectorAll('.kikoeru-original-voice-hidden').forEach(function (node) {
      node.classList.remove('kikoeru-original-voice-hidden');
    });
  }

  function removeOriginalUserActionButtons(infoPanel) {
    var labels = ['标记进度', '写评论'];
    Array.prototype.slice.call(infoPanel.querySelectorAll('.q-btn, .q-btn-dropdown')).forEach(function (node) {
      var compactText = (node.textContent || '').replace(/\s+/g, '');
      var shouldRemove = labels.some(function (label) {
        return compactText.indexOf(label) !== -1;
      });
      if (!shouldRemove) return;

      var parent = node.parentNode;
      node.remove();
      while (parent && parent !== infoPanel && parent.children.length === 0 && !(parent.textContent || '').trim()) {
        var nextParent = parent.parentNode;
        parent.remove();
        parent = nextParent;
      }
    });
  }

  function removeOldFileBridge(dom) {
    if (!dom.workTree) return;
    dom.workTree.querySelectorAll('.kikoeru-file-bridge').forEach(function (node) {
      node.remove();
    });
  }

  function createMetaChip(text, extraClass, title) {
    var chip = document.createElement('span');
    chip.className = 'kikoeru-meta-chip' + (extraClass ? ' ' + extraClass : '');
    chip.textContent = text;
    if (title) {
      chip.title = title;
    }
    return chip;
  }

  function insertAfter(parent, node, referenceNode) {
    if (!parent || !node || !referenceNode) return false;
    parent.insertBefore(node, referenceNode.nextSibling);
    return true;
  }

  function getRatingRow(infoPanel) {
    return infoPanel && infoPanel.querySelector('.row.items-center.q-gutter-xs');
  }

  function moveVoiceRowBelowCircle(infoPanel, voiceRow) {
    if (!infoPanel || !voiceRow) return;

    voiceRow.classList.add('kikoeru-voice-row');
    var circleText = infoPanel.querySelector('.text-subtitle1');
    var circleRow = circleText && circleText.closest('.q-px-sm.q-py-none') || circleText;
    if (circleRow && circleRow.parentNode === infoPanel) {
      insertAfter(infoPanel, voiceRow, circleRow);
      return;
    }

    var titleText = infoPanel.querySelector('.text-h6');
    var titleRow = titleText && titleText.closest('.q-px-sm.q-py-none') || titleText;
    if (titleRow && titleRow.parentNode === infoPanel) {
      insertAfter(infoPanel, voiceRow, titleRow);
    }
  }

  function moveRatingRowAboveActions(infoPanel, actionRow) {
    var ratingRow = getRatingRow(infoPanel);
    if (!ratingRow || !actionRow || actionRow.parentNode !== infoPanel) return;

    ratingRow.classList.add('kikoeru-rating-row');
    infoPanel.insertBefore(ratingRow, actionRow);
  }

  function getFallbackRankDate(metadata) {
    var dates = (metadata && metadata.rank || []).filter(function (item) {
      return item && item.term === 'day' && /\d{4}-\d{2}-\d{2}/.test(item.rank_date || '');
    }).map(function (item) {
      return item.rank_date;
    }).sort();
    return dates[0] || '';
  }

  function getReleaseDateInfo(metadata, supplemental) {
    var release = metadata && metadata.release || supplemental && supplemental.release || '';
    var match = String(release || '').match(/\d{4}-\d{2}-\d{2}/);
    if (match) {
      return {
        text: match[0],
        title: '\u53d1\u552e\u65e5: ' + match[0]
      };
    }

    var fallback = getFallbackRankDate(metadata);
    return fallback
      ? {
        text: fallback,
        title: '\u63a8\u5b9a\u53d1\u552e\u65e5: ' + fallback
      }
      : null;
  }

  function addCoverReleaseBadge(dom, metadata, supplemental) {
    var releaseInfo = getReleaseDateInfo(metadata, supplemental);
    var coverImage = dom.coverLink && dom.coverLink.querySelector('.q-img');
    if (!coverImage) return;

    var badges = Array.prototype.slice.call(coverImage.querySelectorAll('.kikoeru-release-badge, .absolute-bottom-right'));
    var badge = badges.filter(function (node) {
      return node.classList.contains('kikoeru-release-badge');
    })[0] || badges[0] || null;
    if (!releaseInfo) {
      badges.forEach(function (node) {
        node.remove();
      });
      return;
    }

    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'absolute-bottom-right kikoeru-release-badge';
      coverImage.appendChild(badge);
    } else {
      badge.classList.add('kikoeru-release-badge');
      badge.classList.add('absolute-bottom-right');
      badges.forEach(function (node) {
        if (node !== badge) node.remove();
      });
    }

    badge.textContent = releaseInfo.text;
    badge.title = releaseInfo.title;
  }

  function formatDuration(seconds) {
    var total = Math.round(Number(seconds || 0));
    if (!total) return '';

    var hours = Math.floor(total / 3600);
    var minutes = Math.floor((total % 3600) / 60);
    var secs = total % 60;
    var pad = function (value) {
      return value < 10 ? '0' + value : String(value);
    };

    return hours ? hours + ':' + pad(minutes) + ':' + pad(secs) : minutes + ':' + pad(secs);
  }

  function getDurationText(metadata, supplemental) {
    return formatDuration(
      supplemental && supplemental.duration
      || metadata && metadata.duration
      || metadata && metadata.work_duration
    );
  }

  function addDurationMeta(infoPanel, metadata, supplemental) {
    var durationText = getDurationText(metadata, supplemental);
    if (!durationText) return;

    var ratingRow = getRatingRow(infoPanel);
    if (!ratingRow) return;

    var duration = document.createElement('span');
    duration.className = 'kikoeru-duration-meta';
    duration.innerHTML = '<span class="material-icons" aria-hidden="true">schedule</span><span>' + durationText + '</span>';

    var dlsiteLink = ratingRow.querySelector('a[href*="dlsite.com"]');
    var insertBefore = dlsiteLink;
    while (insertBefore && insertBefore.parentNode !== ratingRow) {
      insertBefore = insertBefore.parentNode;
    }

    if (insertBefore) {
      ratingRow.insertBefore(duration, insertBefore);
    } else {
      ratingRow.appendChild(duration);
    }
  }

  function isCountText(text) {
    return /^\([\d,]+\)$/.test(String(text || '').trim());
  }

  function syncOriginalRatingMeta(infoPanel, metadata) {
    var ratingRow = getRatingRow(infoPanel);
    if (!ratingRow) return;

    var countNodes = Array.prototype.slice.call(ratingRow.querySelectorAll('.text-grey')).filter(function (node) {
      return isCountText(node.textContent);
    });

    if (countNodes[0] && metadata && metadata.rate_count) {
      countNodes[0].textContent = '(' + formatCount(metadata.rate_count) + ')';
    }

    Array.prototype.slice.call(ratingRow.querySelectorAll('.col-auto.q-px-sm')).forEach(function (node) {
      var compactText = (node.textContent || '').replace(/\s+/g, '');
      var icon = node.querySelector('.material-icons');
      var iconName = icon && icon.textContent ? icon.textContent.trim() : '';
      if ((iconName === 'chat' || compactText.indexOf('chat') === 0) && /\([\d,]+\)/.test(compactText)) {
        node.remove();
      }
    });
  }

  function formatCount(value) {
    var number = Number(value || 0);
    if (!Number.isFinite(number)) return String(value || 0);
    return number.toLocaleString();
  }

  function getSalesItems(metadata) {
    return (metadata && metadata.dl_count_items || []).filter(function (item) {
      return item && (item.workno || item.label) && item.dl_count !== undefined && item.dl_count !== null;
    });
  }

  function hideSalesTooltip() {
    var tooltip = document.querySelector('.kikoeru-sales-tooltip');
    if (tooltip) tooltip.remove();
  }

  function positionSalesTooltip(anchor, tooltip) {
    var rect = anchor.getBoundingClientRect();
    var left = rect.left + window.scrollX;
    var top = rect.bottom + window.scrollY + 8;
    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';

    var tooltipRect = tooltip.getBoundingClientRect();
    var maxLeft = window.scrollX + document.documentElement.clientWidth - tooltipRect.width - 12;
    if (left > maxLeft) {
      tooltip.style.left = Math.max(window.scrollX + 12, maxLeft) + 'px';
    }
  }

  function showSalesTooltip(anchor, metadata) {
    var items = getSalesItems(metadata);
    if (!items.length) return;

    hideSalesTooltip();

    var tooltip = document.createElement('div');
    tooltip.className = 'kikoeru-sales-tooltip';
    tooltip.innerHTML = '<div class="kikoeru-sales-tooltip-head">'
      + '<span>\u8bed\u8a00</span><span>\u552e\u51fa\u6570</span>'
      + '</div>'
      + items.map(function (item) {
        return '<div class="kikoeru-sales-tooltip-row">'
          + '<span>' + escapeHtml(item.label || item.lang || item.workno) + '</span>'
          + '<span>' + formatCount(item.dl_count) + '</span>'
          + '</div>';
      }).join('');

    document.body.appendChild(tooltip);
    positionSalesTooltip(anchor, tooltip);
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, function (char) {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      }[char];
    });
  }

  function buildSalesSummary(metadata) {
    var total = Number(metadata && metadata.dl_count || 0);
    if (!total && !getSalesItems(metadata).length) return null;

    var summary = document.createElement('span');
    summary.className = 'kikoeru-sales-summary';
    summary.innerHTML = '<span>\u603b\u552e\u51fa\u6570: </span><strong>' + formatCount(total) + '</strong><span class="material-icons">\u0065\u0078\u0070\u0061\u006e\u0064\u005f\u006d\u006f\u0072\u0065</span>';
    summary.addEventListener('mouseenter', function () { showSalesTooltip(summary, metadata); });
    summary.addEventListener('mouseleave', hideSalesTooltip);
    return summary;
  }

  function enhanceSalesSummary(priceRow, metadata) {
    var existing = priceRow.querySelector('.kikoeru-sales-summary');
    var summary = buildSalesSummary(metadata);
    if (!summary) return;

    if (existing) {
      existing.replaceWith(summary);
      return;
    }

    var regexp = new RegExp('(\\u603b\\u552e\\u51fa\\u6570|\\u552e\\u51fa\\u6570|\\u9500\\u91cf|\\u92b7\\u91cf|\\u8ca9\\u58f2\\u6570)\\s*[:\\uff1a]\\s*[\\d,]*');
    var walker = document.createTreeWalker(priceRow, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        return regexp.test(node.nodeValue || '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    var textNode = walker.nextNode();
    if (textNode) {
      var parts = String(textNode.nodeValue).split(regexp);
      var fragment = document.createDocumentFragment();
      if (parts[0]) fragment.appendChild(document.createTextNode(parts[0]));
      fragment.appendChild(summary);
      if (parts[1]) fragment.appendChild(document.createTextNode(parts[1]));
      textNode.parentNode.replaceChild(fragment, textNode);
    } else {
      priceRow.appendChild(summary);
    }
  }

  function removeStaleSalesText(priceRow) {
    if (!priceRow.querySelector('.kikoeru-sales-summary')) return;

    var regexp = new RegExp('^(\\u603b\\u552e\\u51fa\\u6570|\\u552e\\u51fa\\u6570|\\u9500\\u91cf|\\u92b7\\u91cf|\\u8ca9\\u58f2\\u6570)\\s*[:\\uff1a]?\\s*$');
    Array.prototype.slice.call(priceRow.childNodes).forEach(function (node) {
      if (node.nodeType === Node.TEXT_NODE && regexp.test(node.textContent.trim())) {
        node.remove();
      }
    });
  }

  function createTagChip(tag) {
    var chip = document.createElement('a');
    var classes = ['kikoeru-tag-chip'];
    var confirmed = tag.source === 'local' || tag.voteStatus === 1;
    classes.push(confirmed ? 'is-confirmed' : 'is-supplemental');
    if (!confirmed && tag.upvote > tag.downvote) {
      classes.push('has-positive-votes');
    }
    chip.className = classes.join(' ');
    chip.textContent = tag.name;
    chip.title = confirmed ? '\u70b9\u51fb\u6309 DLsite \u6807\u7b7e\u7b5b\u9009' : '\u70b9\u51fb\u641c\u7d22 asmr.one \u8865\u5145\u6807\u7b7e';
    chip.href = confirmed && tag.id
      ? '/works?tagId=' + encodeURIComponent(tag.id)
      : '/works?keyword=' + encodeURIComponent(tag.name);
    chip.addEventListener('click', function (event) {
      var vm = getRootVue();
      if (!vm || !vm.$router) return;

      event.preventDefault();
      vm.$router.push(chip.getAttribute('href'));
    });
    return chip;
  }

  function createTagSection(title, className, tags) {
    var section = document.createElement('div');
    var label = document.createElement('span');
    var chips = document.createElement('div');

    section.className = 'kikoeru-tag-section ' + className;
    label.className = 'kikoeru-tag-source-label';
    label.textContent = title;
    chips.className = 'kikoeru-tag-chip-list';

    tags.forEach(function (tag) {
      chips.appendChild(createTagChip(tag));
    });

    section.appendChild(label);
    section.appendChild(chips);
    return section;
  }

  function createReviewMetaPill(label, value) {
    var pill = document.createElement('span');
    pill.className = 'kikoeru-review-meta-pill';
    pill.textContent = value ? label + value : label;
    return pill;
  }

  function getReviewCount(reviews, metadata) {
    var cachedCount = Number(reviews && reviews.count || 0);
    var effectiveCount = Number(reviews && reviews.effectiveReviewCount || 0);
    var metadataCount = Number(metadata && metadata.review_count || 0);
    cachedCount = Number.isFinite(cachedCount) ? cachedCount : 0;
    effectiveCount = Number.isFinite(effectiveCount) ? effectiveCount : 0;
    metadataCount = Number.isFinite(metadataCount) ? metadataCount : 0;
    if (reviews && reviews.shortCacheConfirmed && cachedCount > 0) return cachedCount;
    if (effectiveCount > 0) return effectiveCount;
    return Math.max(cachedCount, metadataCount);
  }

  function getReviewItems(reviews) {
    return reviews && Array.isArray(reviews.items) ? reviews.items : [];
  }

  function getReviewItemCount(reviews) {
    return getReviewItems(reviews).length;
  }

  function getReviewCacheLimit(reviews) {
    var limit = Number(reviews && reviews.cacheLimit || 0);
    return Number.isFinite(limit) && limit > 0 ? limit : 10;
  }

  function isTranslatedReview(item) {
    return item && item.translation && item.translation.status === 'translated' && item.translation.body;
  }

  function getReviewDisplayText(item, showOriginal) {
    if (!showOriginal && isTranslatedReview(item)) {
      return {
        title: item.translation.title || item.title || '',
        body: item.translation.body || item.body || '',
        mode: 'translation'
      };
    }
    return {
      title: item.title || '',
      body: item.body || '',
      mode: 'original'
    };
  }

  function getReviewLanguageLabel(language) {
    if (language === 'ja') return '日文';
    if (language === 'zh-cn') return '简体中文';
    if (language === 'zh-tw') return '繁体中文';
    if (language === 'ko') return '韩文';
    if (language === 'en') return '英文';
    return language || '未知语言';
  }

  function createReviewBadge(text, className) {
    var badge = document.createElement('span');
    badge.className = 'kikoeru-review-badge ' + (className || '');
    badge.textContent = text;
    return badge;
  }

  function createReviewStars(rating) {
    var stars = document.createElement('span');
    var value = Math.max(0, Math.min(5, Number(rating || 0)));

    stars.className = 'kikoeru-review-stars';
    stars.setAttribute('aria-label', value + '星');
    stars.textContent = '★★★★★';
    stars.style.setProperty('--kikoeru-review-rating', String(value / 5 * 100) + '%');
    return stars;
  }

  function createReviewItem(item) {
    var card = document.createElement('article');
    var head = document.createElement('div');
    var ratingLine = document.createElement('div');
    var metaLine = document.createElement('div');
    var title = document.createElement('div');
    var body = document.createElement('div');
    var tools = document.createElement('div');
    var metadata = item.metadata || {};
    var expanded = false;
    var showOriginal = false;
    var translated = isTranslatedReview(item);
    var expand = null;
    var expandMeasureToken = 0;

    card.className = 'kikoeru-review-card';
    head.className = 'kikoeru-review-card-head';
    ratingLine.className = 'kikoeru-review-rating-line';
    metaLine.className = 'kikoeru-review-meta-line';
    title.className = 'kikoeru-review-card-title';
    body.className = 'kikoeru-review-card-body';
    tools.className = 'kikoeru-review-card-tools';

    if (metadata.recommend) {
      ratingLine.appendChild(createReviewBadge('推荐鉴赏家!', 'is-recommended'));
    }
    if (item.rating) {
      ratingLine.appendChild(createReviewStars(item.rating));
    }

    if (item.postedAt) metaLine.appendChild(createReviewBadge(item.postedAt.slice(0, 10), 'is-date'));
    if (item.author) metaLine.appendChild(createReviewBadge(item.author, 'is-author'));
    if (metadata.reviewer_rank) metaLine.appendChild(createReviewBadge('人气鉴赏家 ' + metadata.reviewer_rank, 'is-rank'));

    if (ratingLine.childNodes.length) head.appendChild(ratingLine);
    head.appendChild(metaLine);

    var preserveReviewControlPosition = function (anchor, update) {
      var scrollParent = card.closest && card.closest('.kikoeru-review-list');
      var beforeTop = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect().top : 0;
      var schedule = window.requestAnimationFrame
        ? window.requestAnimationFrame.bind(window)
        : function (callback) { window.setTimeout(callback, 0); };

      update();

      if (!scrollParent || !anchor || !anchor.getBoundingClientRect) return;
      schedule(function () {
        if (!document.documentElement.contains(anchor)) return;
        var afterTop = anchor.getBoundingClientRect().top;
        scrollParent.scrollTop += afterTop - beforeTop;
      });
    };

    var syncExpandButton = function () {
      if (!expand) return;
      var token = ++expandMeasureToken;
      var schedule = window.requestAnimationFrame
        ? window.requestAnimationFrame.bind(window)
        : function (callback) { window.setTimeout(callback, 0); };

      schedule(function () {
        if (token !== expandMeasureToken || !expand) return;

        var canExpand = body.textContent.length > 260;
        if (document.documentElement.contains(body)) {
          card.classList.add('is-collapsed');
          canExpand = body.scrollHeight > body.clientHeight + 1;
        }

        card.classList.toggle('is-collapsed', canExpand && !expanded);
        expand.hidden = !canExpand;
        expand.setAttribute('aria-hidden', canExpand ? 'false' : 'true');
      });
    };

    var renderText = function () {
      var display = getReviewDisplayText(item, showOriginal);
      title.textContent = display.title || '无标题赏析';
      body.textContent = display.body;
      card.classList.toggle('is-original', display.mode === 'original');
      var canExpand = display.body.length > 260;
      card.classList.toggle('is-collapsed', !expanded && canExpand);
      if (expand) {
        expand.hidden = !canExpand;
        expand.setAttribute('aria-hidden', canExpand ? 'false' : 'true');
        syncExpandButton();
      }
    };

    renderText();

    if (translated) {
      var toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'kikoeru-review-tool';
      toggle.textContent = '显示原文';
      toggle.addEventListener('click', function () {
        preserveReviewControlPosition(toggle, function () {
          showOriginal = !showOriginal;
        toggle.textContent = showOriginal ? '显示译文' : '显示原文';
          renderText();
        });
      });
      tools.appendChild(toggle);
    } else if (item.language && item.language !== 'zh' && item.language !== 'zh-cn') {
      var pending = document.createElement('span');
      pending.className = 'kikoeru-review-tool is-disabled';
      pending.textContent = '赏析未翻译';
      tools.appendChild(pending);
    }

    if ((item.body || '').length > 260 || (item.translation && item.translation.body || '').length > 260) {
      expand = document.createElement('button');
      expand.type = 'button';
      expand.className = 'kikoeru-review-tool';
      expand.textContent = '展开';
      expand.addEventListener('click', function () {
        preserveReviewControlPosition(body, function () {
          expanded = !expanded;
        expand.textContent = expanded ? '收起' : '展开';
          renderText();
        });
      });
      tools.appendChild(expand);
      renderText();
    }

    card.appendChild(head);
    card.appendChild(title);
    card.appendChild(body);
    if (tools.childNodes.length) card.appendChild(tools);
    return card;
  }

  function createReviewPanel(workId, dom, metadata, tree, supplemental, reviews, onClose) {
    var panel = document.createElement('section');
    var header = document.createElement('div');
    var title = document.createElement('div');
    var tools = document.createElement('div');
    var list = document.createElement('div');
    var count = getReviewCount(reviews, metadata);
    var itemCount = getReviewItemCount(reviews);
    var status = reviews && reviews.status || 'idle';

    panel.className = 'kikoeru-review-panel';
    header.className = 'kikoeru-review-panel-head';
    title.className = 'kikoeru-review-panel-title';
    tools.className = 'kikoeru-review-panel-tools';
    list.className = 'kikoeru-review-list';
    title.textContent = '\u8d4f\u6790\u9884\u89c8';
    if (count && itemCount) {
      title.textContent += '\uff08\u6700\u4f73 ' + itemCount + '/' + count + '\uff09';
    } else if (count) {
      title.textContent += '\uff08\u5171 ' + count + '\u6761\uff09';
    }

    var refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'kikoeru-review-mini-button is-secondary';
    refresh.textContent = status === 'error' ? '重试抓取' : '刷新原文';
    refresh.addEventListener('click', function () {
      refresh.disabled = true;
      refresh.textContent = '抓取中';
      fetchJson('/api/work/' + workId + '/reviews/refresh', { method: 'POST' }).then(function (nextReviews) {
        if (state.cache[workId]) state.cache[workId].reviews = nextReviews;
        insertEnhancements(workId, dom, metadata, tree, supplemental, nextReviews);
      }).catch(function () {
        notify('获取赏析失败', 'negative');
        refresh.disabled = false;
        refresh.textContent = '重试抓取';
      });
    });

    tools.appendChild(refresh);
    if (typeof onClose === 'function') {
      var close = document.createElement('button');
      close.type = 'button';
      close.className = 'kikoeru-review-mini-button is-close';
      close.textContent = '\u6536\u8d77';
      close.addEventListener('click', onClose);
      tools.appendChild(close);
    }
    header.appendChild(title);
    header.appendChild(tools);
    panel.appendChild(header);

    if (status === 'loading') {
      var loading = document.createElement('div');
      loading.className = 'kikoeru-review-empty';
      loading.textContent = '赏析加载中...';
      panel.appendChild(loading);
      return panel;
    }

    if (status === 'error') {
      var error = document.createElement('div');
      error.className = 'kikoeru-review-empty';
      error.textContent = reviews && reviews.error || '获取赏析失败';
      panel.appendChild(error);
      return panel;
    }

    if (!itemCount) {
      var empty = document.createElement('div');
      empty.className = 'kikoeru-review-empty';
      empty.textContent = '暂无赏析';
      if (count) {
        empty.textContent = '\u6682\u65e0\u53ef\u5c55\u793a\u8d4f\u6790\u6b63\u6587';
      }
      panel.appendChild(empty);
      return panel;
    }

    if (status === 'stale') {
      var stale = document.createElement('div');
      stale.className = 'kikoeru-review-stale';
      stale.textContent = '本地缓存可能已过期，可刷新原文；已有 AI 译文不会被自动覆盖。';
      panel.appendChild(stale);
    }

    getReviewItems(reviews).forEach(function (item) {
      list.appendChild(createReviewItem(item));
    });
    panel.appendChild(list);
    return panel;
  }

  function createReviewCompactMeta(metadata, supplemental, tags, languages, subtitleStatusLabel, reviews) {
    var meta = document.createElement('aside');
    var primary = document.createElement('div');
    var tagPreview = document.createElement('div');
    var voicePreview = document.createElement('div');
    var count = getReviewCount(reviews, metadata);

    meta.className = 'kikoeru-review-compact-meta';
    primary.className = 'kikoeru-review-compact-primary';
    tagPreview.className = 'kikoeru-review-compact-tags';
    voicePreview.className = 'kikoeru-review-compact-voices';

    primary.appendChild(createReviewMetaPill('评分 ', metadata.rate_average_2dp || '0'));
    primary.appendChild(createReviewMetaPill('价格 ', metadata.price ? metadata.price + ' JPY' : '未知'));
    primary.appendChild(createReviewMetaPill('销量 ', metadata.dl_count ? String(metadata.dl_count) : '未知'));
    primary.appendChild(createReviewMetaPill('', subtitleStatusLabel));
    primary.appendChild(createReviewMetaPill('\u8d4f\u6790 ', String(count)));
    if (reviews && reviews.count && count > reviews.count) {
      primary.appendChild(createReviewMetaPill('\u5df2\u7f13\u5b58\u6700\u4f73 ', String(reviews.count) + '/' + String(Math.min(count, getReviewCacheLimit(reviews)))));
    }
    languages.slice(0, 3).forEach(function (name) {
      primary.appendChild(createReviewMetaPill('', name));
    });

    tags.slice(0, 8).forEach(function (tag) {
      var chip = createTagChip(tag);
      chip.classList.add('is-compact');
      tagPreview.appendChild(chip);
    });
    if (tags.length > 8) {
      tagPreview.appendChild(createReviewMetaPill('更多标签 ', String(tags.length - 8)));
    }

    (metadata.vas || supplemental && supplemental.vas || []).slice(0, 4).forEach(function (va) {
      voicePreview.appendChild(createReviewMetaPill('', va.name));
    });

    meta.appendChild(primary);
    if (tagPreview.childNodes.length) meta.appendChild(tagPreview);
    if (voicePreview.childNodes.length) meta.appendChild(voicePreview);
    return meta;
  }

  function createReviewShell(workId, dom, metadata, tree, supplemental, tags, languages, subtitleStatusLabel, reviews, onClose) {
    var shell = document.createElement('div');
    shell.className = 'kikoeru-review-shell';
    shell.appendChild(createReviewPanel(workId, dom, metadata, tree, supplemental, reviews, onClose));
    return shell;
  }

  function createActionButton(icon, label, className, onClick) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'kikoeru-action-button ' + className;
    button.innerHTML = '<span class="material-icons" aria-hidden="true">' + icon + '</span><span>' + label + '</span>';
    button.addEventListener('click', onClick);
    return button;
  }

  function createReviewVoiceRow(infoPanel, voiceRow, reviewToggleButton) {
    if (!infoPanel || !voiceRow || !reviewToggleButton) return null;

    var row = document.createElement('div');
    var voices = document.createElement('div');
    var actions = document.createElement('div');
    row.className = 'kikoeru-review-voice-row';
    voices.className = 'kikoeru-review-voice-list';
    actions.className = 'kikoeru-review-voice-actions';

    Array.prototype.slice.call(voiceRow.children).forEach(function (child) {
      if (child.classList && child.classList.contains('kikoeru-review-voice-actions')) return;
      voices.appendChild(child.cloneNode(true));
    });

    reviewToggleButton.classList.add('in-voice-row');
    actions.appendChild(reviewToggleButton);
    row.appendChild(voices);
    row.appendChild(actions);
    voiceRow.classList.add('kikoeru-original-voice-hidden');
    moveVoiceRowBelowCircle(infoPanel, row);
    return row;
  }

  function insertEnhancements(workId, dom, metadata, tree, supplemental, reviews) {
    var flatFiles = flattenTree(tree, []);
    var subtitleAvailable = hasSubtitle(metadata, flatFiles);
    var subtitleStatusLabel = getSubtitleStatusLabel(metadata, flatFiles);
    var localSubtitleBadges = getLocalSubtitleBadges(metadata);
    var languages = getLanguageLabels(metadata, supplemental);
    languages = languages.filter(function (name) {
      return name !== subtitleStatusLabel;
    });
    var tags = mergeTags(metadata, supplemental);
    var reviewCount = getReviewCount(reviews, metadata);
    var reviewOpen = Boolean(state.reviewPanelOpenByWorkId[workId]);
    var originalTagRow = dom.infoPanel.querySelector('.q-px-none.q-py-sm:not(.q-pt-sm)') || dom.infoPanel.querySelector('.q-px-none.q-py-sm');

    removeOldEnhancements(dom.infoPanel);
    removeOldFileBridge(dom);
    removeOriginalUserActionButtons(dom.infoPanel);
    var voiceRow = dom.infoPanel.querySelector('.q-px-none.q-pt-sm.q-py-sm');
    moveVoiceRowBelowCircle(dom.infoPanel, voiceRow);

    applyLocalWorkTitle(dom, metadata);
    syncOriginalRatingMeta(dom.infoPanel, metadata);
    addCoverReleaseBadge(dom, metadata, supplemental);
    addDurationMeta(dom.infoPanel, metadata, supplemental);
    var priceRow = dom.infoPanel.querySelector('.q-pt-sm.q-pb-none');
    if (priceRow) {
      enhanceSalesSummary(priceRow, metadata);
      removeStaleSalesText(priceRow);
      if (!reviewOpen) {
        var primaryBadge = localSubtitleBadges[0] || null;
        var subtitleChipTitle = primaryBadge && primaryBadge.description || '';
        priceRow.appendChild(createMetaChip(
          subtitleStatusLabel,
          'is-subtitle is-subtitle-' + (subtitleStatusLabel === '无字幕' ? 'none' : 'available') + (primaryBadge ? ' is-local-subtitle-meta' : ''),
          subtitleChipTitle
        ));
        localSubtitleBadges.slice(1).forEach(function (badge) {
          priceRow.appendChild(createMetaChip(badge.label, 'is-local-subtitle-meta', badge.description || ''));
        });
        languages.forEach(function (name) {
          priceRow.appendChild(createMetaChip(name));
        });
      }
    }

    var actionRow = document.createElement('div');
    actionRow.className = 'kikoeru-action-row';

    var reviewToggleButton = createActionButton('rate_review', (reviewOpen ? '收起赏析(' : '显示赏析(') + reviewCount + ')', 'primary review-toggle', function () {
      state.reviewPanelOpenByWorkId[workId] = !reviewOpen;
      insertEnhancements(workId, dom, metadata, tree, supplemental, reviews);
    });
    actionRow.appendChild(reviewToggleButton);
    if (!reviewOpen) {
      var reviewToggleLabel = reviewToggleButton.querySelector('span:last-child');
      if (reviewToggleLabel) reviewToggleLabel.textContent = '\u8d4f\u6790\u8bc4\u8bba(' + reviewCount + ')';
      if (!createReviewVoiceRow(dom.infoPanel, voiceRow, reviewToggleButton)) {
        actionRow.appendChild(reviewToggleButton);
      }
    }

    if (!reviewOpen) {
      var downloadButton = createActionButton('file_download', '下载', 'secondary', function () {
        notify('暂未实现，等待音声库功能实装', 'info');
      });
      actionRow.appendChild(downloadButton);
    }

    var tagRow = document.createElement('div');
    tagRow.className = 'kikoeru-tag-row';
    var confirmedTags = tags.filter(function (tag) {
      return tag.source === 'local' || tag.voteStatus === 1;
    });
    var supplementalTags = tags.filter(function (tag) {
      return tag.source !== 'local' && tag.voteStatus !== 1;
    });
    if (confirmedTags.length) {
      tagRow.appendChild(createTagSection('DLsite', 'is-confirmed-source', confirmedTags));
    }
    if (supplementalTags.length) {
      tagRow.appendChild(createTagSection('asmr.one', 'is-supplemental-source', supplementalTags));
    }

    var reviewShell = null;
    if (reviewOpen) {
      dom.infoPanel.classList.add('kikoeru-review-mode');
      reviewShell = createReviewShell(workId, dom, metadata, tree, supplemental, tags, languages, subtitleStatusLabel, reviews, function () {
        state.reviewPanelOpenByWorkId[workId] = false;
        insertEnhancements(workId, dom, metadata, tree, supplemental, reviews);
      });
    }

    if (originalTagRow) {
      originalTagRow.classList.add('kikoeru-original-tags-hidden');
      dom.infoPanel.insertBefore(actionRow, originalTagRow);
      if (reviewShell) {
        dom.infoPanel.insertBefore(reviewShell, originalTagRow);
      }
      dom.infoPanel.insertBefore(tagRow, originalTagRow);
    } else {
      dom.infoPanel.appendChild(actionRow);
      if (reviewShell) {
        dom.infoPanel.appendChild(reviewShell);
      }
      dom.infoPanel.appendChild(tagRow);
    }

    moveRatingRowAboveActions(dom.infoPanel, actionRow);

    insertFileBridge(dom, tree, flatFiles);
  }

  function findVueComponentByName(vm, name) {
    if (!vm) return null;
    if (vm.$options && vm.$options.name === name) return vm;

    var children = vm.$children || [];
    for (var index = 0; index < children.length; index += 1) {
      var found = findVueComponentByName(children[index], name);
      if (found) return found;
    }

    return null;
  }

  function findScannerButtonRow() {
    var rows = Array.prototype.slice.call(document.querySelectorAll('.row.q-ma-sm'));
    return rows.find(function (row) {
      var text = (row.textContent || '').replace(/\s+/g, '');
      return text.indexOf('扫描本地音声库') !== -1
        && text.indexOf('刷新音声库信息') !== -1
        && text.indexOf('终止扫描进程') !== -1;
    });
  }

  function updateReviewRefreshButton(button, scannerVm) {
    var connected = scannerVm && (scannerVm.loggedIn || scannerVm.$socket && scannerVm.$socket.connected);
    var disabled = !scannerVm || scannerVm.state === 'running' || !connected;
    button.disabled = disabled;
    button.classList.toggle('is-disabled', disabled);
  }

  function installScannerReviewRefreshControl() {
    if (!/^\/admin\/scanner\/?$/.test(window.location.pathname)) return;

    var row = findScannerButtonRow();
    if (!row) return;

    var scannerVm = findVueComponentByName(getRootVue(), 'Scanner');
    var existingButton = row.querySelector('.kikoeru-scanner-review-button');
    if (existingButton) {
      updateReviewRefreshButton(existingButton, scannerVm);
      return;
    }

    var wrapper = document.createElement('div');
    var button = document.createElement('button');
    var icon = document.createElement('span');
    var label = document.createElement('span');

    wrapper.className = 'col-xs-12 col-sm-4 row q-pa-sm kikoeru-scanner-review-control';
    button.type = 'button';
    button.className = 'col kikoeru-scanner-review-button';
    icon.className = 'material-icons';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = 'rate_review';
    label.textContent = '\u66f4\u65b0\u6700\u4f73\u8d4f\u6790\u6b63\u6587';

    button.appendChild(icon);
    button.appendChild(label);
    button.addEventListener('click', function () {
      var currentVm = findVueComponentByName(getRootVue(), 'Scanner');
      updateReviewRefreshButton(button, currentVm);
      if (button.disabled || !currentVm || !currentVm.$socket) return;

      currentVm.tasks = [];
      currentVm.failedTasks = [];
      currentVm.mainLogs = [];
      currentVm.results = [];
      currentVm.state = 'running';
      currentVm.$socket.emit('PERFORM_REVIEW_REFRESH');
      updateReviewRefreshButton(button, currentVm);
    });

    wrapper.appendChild(button);
    row.appendChild(wrapper);
    updateReviewRefreshButton(button, scannerVm);
  }

  function enhanceCurrentPage() {
    installLyricLineBreakBridge();
    installSearchRequestInterceptor();
    installSubtitleResponseInterceptor();
    installSmartSeekControls();
    installScannerReviewRefreshControl();
    preloadCurrentSubtitleCues();
    refreshSmartSeekIcons();

    var workId = getWorkIdFromPath();
    if (!workId) return;

    var dom = findWorkDom(workId);
    if (!dom) return;

    ensureClasses(dom);
    removeOriginalUserActionButtons(dom.infoPanel);
    if (!dom.infoPanel.querySelector('.kikoeru-action-row')) {
      dom.infoPanel.classList.add('kikoeru-enhancing');
    }

    if (state.currentWorkId !== workId) {
      state.currentWorkId = workId;
      state.requestKey += 1;
    }

    if (dom.infoPanel.querySelector('.kikoeru-action-row')) {
      var existingCached = state.cache[workId];
      if (existingCached) {
        applyLocalWorkTitle(dom, existingCached.metadata);
        syncOriginalRatingMeta(dom.infoPanel, existingCached.metadata);
        addCoverReleaseBadge(dom, existingCached.metadata, existingCached.supplemental);
      }
      return;
    }

    var cached = state.cache[workId];
    if (cached) {
      insertEnhancements(workId, dom, cached.metadata, cached.tree, cached.supplemental, cached.reviews);
      return;
    }

    if (state.pending[workId]) {
      return;
    }

    var requestKey = state.requestKey;
    state.pending[workId] = Promise.all([
      fetchJson('/api/work/' + workId),
      fetchJson('/api/tracks/' + workId),
      fetchJson('/api/work/' + workId + '/subtitle-meta').catch(function () {
        return null;
      })
    ]).then(function (result) {
      if (requestKey !== state.requestKey) return;
      result[0].localSubtitleMeta = result[2];
      state.cache[workId] = {
        metadata: result[0],
        tree: result[1],
        reviews: { count: 0, status: 'loading', items: [] },
        supplemental: null
      };
      var latestDom = findWorkDom(workId);
      if (latestDom) {
        ensureClasses(latestDom);
        insertEnhancements(workId, latestDom, result[0], result[1], null, state.cache[workId].reviews);
      }

      var reviewRequest = fetchJson('/api/work/' + workId + '/reviews').catch(function () {
        return { count: 0, status: 'error', items: [], error: '获取赏析失败' };
      }).then(function (reviews) {
        if (requestKey !== state.requestKey || !state.cache[workId]) return;
        state.cache[workId].reviews = reviews;
        latestDom = findWorkDom(workId);
        if (latestDom) {
          ensureClasses(latestDom);
          insertEnhancements(workId, latestDom, result[0], result[1], state.cache[workId].supplemental, reviews);
        }
      });

      var supplementalRequest = fetchJson('/api/work/' + workId + '/asmrone').then(function (supplemental) {
        if (requestKey !== state.requestKey) return;
        state.cache[workId].supplemental = supplemental;
        latestDom = findWorkDom(workId);
        if (latestDom) {
          ensureClasses(latestDom);
          insertEnhancements(workId, latestDom, result[0], result[1], supplemental, state.cache[workId].reviews);
        }
      }).catch(function () {});

      return Promise.all([reviewRequest, supplementalRequest]);
    }).catch(function () {
      // The original page already handles API errors. Keep this enhancement quiet.
      var failedDom = findWorkDom(workId);
      if (failedDom) {
        failedDom.infoPanel.classList.remove('kikoeru-enhancing');
      }
    }).finally(function () {
      delete state.pending[workId];
    });
  }

  function boot() {
    var lastUrl = '';
    var scheduleEnhance = function () {
      if (state.scheduled) return;
      state.scheduled = true;
      window.requestAnimationFrame(function () {
        state.scheduled = false;
        enhanceCurrentPage();
      });
    };

    var observer = new MutationObserver(function () {
      scheduleEnhance();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    setInterval(function () {
      var url = window.location.pathname + window.location.search;
      if (url !== lastUrl) {
        lastUrl = url;
        scheduleEnhance();
      }
      installSubtitleResponseInterceptor();
      installLyricLineBreakBridge();
      preloadCurrentSubtitleCues();
      refreshSmartSeekIcons();
    }, 700);

    scheduleEnhance();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}());
