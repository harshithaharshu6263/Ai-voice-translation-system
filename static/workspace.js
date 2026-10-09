(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const csrf = document.querySelector('meta[name="csrf-token"]').content;
  let config = { languages: {}, tts_languages: {}, email_configured: false };
  let current = null, view = 'translate', historyItems = [], historyGeneration = 0;
  let recognition = null, recordingTimer = null;
  let working = false, conversationWorking = false, audioUrl = null, speechGeneration = 0;
  const spokenLanguages = {
    'en-IN': 'English (India)', 'kn-IN': 'Kannada', 'hi-IN': 'Hindi', 'ta-IN': 'Tamil',
    'te-IN': 'Telugu', 'ml-IN': 'Malayalam', 'mr-IN': 'Marathi', 'bn-IN': 'Bengali',
    'gu-IN': 'Gujarati', 'pa-IN': 'Punjabi', 'ur-PK': 'Urdu', 'en-US': 'English (US)',
    'es-ES': 'Spanish', 'fr-FR': 'French', 'de-DE': 'German', 'it-IT': 'Italian',
    'pt-BR': 'Portuguese', 'ja-JP': 'Japanese', 'ko-KR': 'Korean', 'zh-CN': 'Chinese',
    'ar-SA': 'Arabic', 'ru-RU': 'Russian', 'ne-NP': 'Nepali', 'id-ID': 'Indonesian',
  };
  const locales = { en: 'en-IN', kn: 'kn-IN', hi: 'hi-IN', ta: 'ta-IN', te: 'te-IN', ml: 'ml-IN', mr: 'mr-IN', bn: 'bn-IN', gu: 'gu-IN', pa: 'pa-IN', ur: 'ur-PK', iw: 'he-IL', 'zh-CN': 'zh-CN', 'zh-TW': 'zh-TW', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', ja: 'ja-JP', ko: 'ko-KR', ar: 'ar-SA', pt: 'pt-BR' };
  const locale = code => locales[code] || code;
  const translateCode = value => value.startsWith('zh') ? 'zh-CN' : value.split('-')[0];
  const languageName = code => Object.entries(config.languages).find(([, value]) => value === code)?.[0].replace(/^./, c => c.toUpperCase()) || code || 'Unknown';
  const sourceName = record => languageName(record.source === 'auto' ? record.detected : record.source);
  const notify = (message, error = false) => { $('status').textContent = message; $('status').hidden = false; $('status').classList.toggle('error', error); };
  const handleError = error => notify(error.message || 'Something went wrong. Please try again.', true);
  async function api(path, options = {}) {
    const headers = { 'X-CSRF-Token': csrf, ...options.headers };
    if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const response = await fetch(path, { ...options, headers });
    let data;
    try { data = await response.json(); } catch { throw new Error('The server is unavailable. Please try again.'); }
    if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
    return data;
  }
  const json = data => JSON.stringify(data);
  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text != null) element.textContent = text;
    if (className) element.className = className;
    return element;
  }
  function button(text, action, className) {
    const element = node('button', text, className);
    element.type = 'button';
    element.addEventListener('click', async () => {
      element.disabled = true;
      try { await action(); } catch (error) { handleError(error); }
      finally { element.disabled = false; }
    });
    return element;
  }
  function fillLanguages(id, selected, entries, auto = false) {
    const select = $(id);
    select.replaceChildren();
    if (auto) select.add(new Option('Detect automatically', 'auto'));
    for (const [name, code] of entries) select.add(new Option(name.replace(/^./, c => c.toUpperCase()), code));
    select.value = selected;
  }
  function stopAudio() {
    speechGeneration++;
    window.speechSynthesis?.cancel();
    $('audioPlayer').pause();
  }
  function resetAudio() {
    stopAudio();
    $('audioPlayer').hidden = true;
    $('audioPlayer').removeAttribute('src');
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = null;
  }
  function invalidateResult() {
    current = null;
    resetAudio();
    $('resultTools').hidden = $('exportSection').hidden = true;
    $('translatedText').textContent = 'Your translation will appear here.';
    $('translatedText').classList.add('placeholder');
    $('resultLanguage').textContent = languageName($('targetLanguage').value);
    $('detectedLanguage').textContent = $('sourceLanguage').value === 'auto' ? 'Automatic detection' : languageName($('sourceLanguage').value);
  }
  function updateCount() { $('characterCount').textContent = `${$('originalText').value.length} / 5000`; }
  function showResult(record) {
    current = record;
    resetAudio();
    $('originalText').value = record.original;
    $('sourceLanguage').value = record.source;
    $('targetLanguage').value = record.target;
    updateCount();
    $('translatedText').textContent = record.translated;
    $('translatedText').classList.remove('placeholder');
    $('translatedText').lang = record.target;
    $('resultLanguage').textContent = languageName(record.target);
    $('detectedLanguage').textContent = record.source === 'auto' ? `Detected: ${sourceName(record)} (estimate)` : sourceName(record);
    $('resultTools').hidden = $('exportSection').hidden = false;
    updateFavorite();
    $('exportAudio').disabled = !config.tts_languages[record.target];
    $('exportAudio').title = config.tts_languages[record.target] ? 'Download translated audio' : 'MP3 generation is unavailable for this language';
    $('audioHint').textContent = config.tts_languages[record.target] ? 'Listen in the translated language, then download or share.' : 'Use a matching installed browser voice; MP3 generation is unavailable for this language.';
  }
  function updateFavorite() {
    $('favoriteButton').textContent = current?.favorite ? '★ Saved phrase' : '☆ Save phrase';
    $('favoriteButton').setAttribute('aria-pressed', String(Boolean(current?.favorite)));
  }
  async function setFavorite(record) {
    const next = !record.favorite;
    await api(`/api/history/${record.id}`, { method: 'PATCH', body: json({ favorite: next }) });
    record.favorite = Number(next);
    if (current?.id === record.id) { current.favorite = record.favorite; updateFavorite(); }
    notify(next ? 'Added to your phrasebook.' : 'Removed from your phrasebook.');
  }
  function setWorking(busy) {
    working = busy;
    for (const id of ['translateButton', 'transcribeButton', 'recordButton', 'clearText', 'sourceLanguage', 'targetLanguage', 'swapLanguages', 'audioFile']) $(id).disabled = busy;
    $('originalText').readOnly = busy;
    $('translateButton').textContent = busy ? 'Working…' : 'Translate text →';
  }
  async function translate() {
    if (working || recognition) return;
    const text = $('originalText').value.trim();
    if (!text) return notify('Type or record some text first.', true);
    setWorking(true);
    try {
      const record = await api('/translate', { method: 'POST', body: json({ text, source: $('sourceLanguage').value, target: $('targetLanguage').value }) });
      showResult(record);
      notify('Translation saved to your history.');
    } catch (error) { handleError(error); }
    finally { setWorking(false); }
  }
  function switchView(next) {
    if (recognition || working || conversationWorking) { notify('Finish the current recording or request first.', true); return; }
    stopAudio();
    view = next;
    for (const id of ['translateView', 'conversationView', 'historyView', 'profileView']) $(id).hidden = true;
    $(`${['history', 'favorites'].includes(next) ? 'history' : next}View`).hidden = false;
    document.querySelectorAll('.nav-button').forEach(element => {
      const active = element.dataset.view === next;
      element.classList.toggle('active', active);
      if (active) element.setAttribute('aria-current', 'page'); else element.removeAttribute('aria-current');
    });
    $('status').hidden = true;
    if (['history', 'favorites'].includes(next)) {
      $('historyTitle').textContent = next === 'favorites' ? 'Your personal phrasebook' : 'Translation history';
      $('historyEyebrow').textContent = next === 'favorites' ? 'KEEP THE WORDS THAT MATTER' : 'YOUR WORDS, SAVED';
      $('historyDescription').textContent = next === 'favorites' ? 'Your favorite phrases, ready to use again.' : 'Find, replay, export, or delete your previous translations.';
      $('historySearch').value = '';
      loadHistory().catch(handleError);
    }
  }
  async function loadHistory(more = false) {
    const generation = ++historyGeneration;
    const params = new URLSearchParams({ q: $('historySearch').value, favorites: view === 'favorites' ? '1' : '0' });
    if (more && historyItems.length) params.set('before', historyItems.at(-1).id);
    $('loadMoreHistory').disabled = true;
    if (!more) $('historyList').replaceChildren(node('p', 'Loading your translations…', 'empty-state'));
    try {
      const data = await api(`/api/history?${params}`);
      if (generation !== historyGeneration) return;
      historyItems = more ? historyItems.concat(data.items) : data.items;
      renderHistory();
      $('loadMoreHistory').hidden = !data.has_more;
    } finally { if (generation === historyGeneration) $('loadMoreHistory').disabled = false; }
  }
  function renderHistory() {
    $('historyList').replaceChildren();
    if (!historyItems.length) {
      $('historyList').append(node('p', view === 'favorites' ? 'No saved phrases yet. Use ☆ Save phrase on any translation.' : 'No translations found. Translate something to start your history.', 'empty-state'));
      return;
    }
    for (const record of historyItems) {
      const item = node('article', null, 'card history-item');
      const heading = node('div', null, 'card-heading');
      heading.append(node('h2', `${sourceName(record)} → ${languageName(record.target)}`));
      const time = node('time', new Date(record.created_at).toLocaleString());
      time.dateTime = record.created_at;
      heading.append(time);
      if (record.mode === 'conversation') heading.append(node('span', `Person ${record.speaker} · Conversation`, 'pill'));
      const texts = node('div', null, 'texts');
      for (const [title, value, lang] of [['Original', record.original, record.detected || record.source], ['Translation', record.translated, record.target]]) {
        const column = node('div');
        column.append(node('label', title));
        const content = node('p', value); content.dir = 'auto'; content.lang = lang;
        column.append(content); texts.append(column);
      }
      const actions = node('div', null, 'button-row');
      actions.append(button('Open', () => { switchView('translate'); showResult(record); $('originalText').focus(); }));
      actions.append(button('▶ Replay', () => speak(record)));
      actions.append(button(record.favorite ? '★ Saved' : '☆ Save phrase', async () => { await setFavorite(record); if (view === 'favorites' && !record.favorite) historyItems = historyItems.filter(r => r.id !== record.id); renderHistory(); }));
      actions.append(button('↓ Word', () => download(record, 'docx')));
      actions.append(button('Print / PDF', () => printRecord(record)));
      actions.append(button('Delete', async () => {
        if (!window.confirm('Delete this translation from your history and phrasebook?')) return;
        await api(`/api/history/${record.id}`, { method: 'DELETE' });
        historyItems = historyItems.filter(r => r.id !== record.id);
        if (current?.id === record.id) invalidateResult();
        renderHistory(); notify('Translation deleted.');
      }, 'delete-button'));
      item.append(heading, texts, actions); $('historyList').append(item);
    }
  }
  async function download(record, format) {
    const response = await fetch(`/api/export/${record.id}/${format}`);
    if (!response.ok) throw new Error((await response.json()).error || 'Download failed.');
    saveBlob(await response.blob(), `translation-${record.id}.${format}`);
  }
  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob), link = node('a');
    link.href = url; link.download = filename;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  function printRecord(record) {
    $('printMeta').textContent = `${sourceName(record)} → ${languageName(record.target)} · ${new Date(record.created_at).toLocaleString()}`;
    $('printOriginal').textContent = record.original; $('printOriginal').lang = record.detected || record.source;
    $('printTranslation').textContent = record.translated; $('printTranslation').lang = record.target;
    window.print();
  }
  async function generatedAudio(record) {
    const data = await api('/tts-generate', { method: 'POST', body: json({ text: record.translated, lang: record.target }) });
    const bytes = Uint8Array.from(atob(data.audio_base64), c => c.charCodeAt(0));
    return new Blob([bytes], { type: 'audio/mpeg' });
  }
  async function speak(record) {
    stopAudio();
    const generation = speechGeneration;
    const voices = window.speechSynthesis?.getVoices() || [];
    const lang = locale(record.target);
    const voice = voices.find(v => v.lang.toLowerCase() === lang.toLowerCase()) || voices.find(v => v.lang.split('-')[0] === lang.split('-')[0]);
    if (voice) {
      const utterance = new SpeechSynthesisUtterance(record.translated);
      utterance.voice = voice; utterance.lang = lang; utterance.rate = Number($('playbackRate').value);
      utterance.onerror = event => { if (!['interrupted', 'canceled'].includes(event.error)) notify('Browser playback failed. Try downloading the MP3.', true); };
      window.speechSynthesis.speak(utterance);
      return;
    }
    if (!config.tts_languages[record.target]) throw new Error('No matching voice is installed for this language. Install a system voice to use playback.');
    notify('Preparing translated audio…');
    const blob = await generatedAudio(record);
    if (generation !== speechGeneration) return;
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = URL.createObjectURL(blob);
    $('audioPlayer').src = audioUrl;
    $('audioPlayer').playbackRate = Number($('playbackRate').value);
    $('audioPlayer').hidden = view !== 'translate';
    await $('audioPlayer').play();
    notify('Playing your translation.');
  }
  function recordingUI(context, active) {
    const id = context.kind === 'translate' ? 'recordButton' : context.speaker === 'A' ? 'personARecord' : 'personBRecord';
    $(id).classList.toggle('recording', active);
    $(id).setAttribute('aria-pressed', String(active));
    $(id).textContent = active ? '■ Stop recording' : context.kind === 'translate' ? '● Record' : `● Person ${context.speaker} speaks`;
    $('recordButton').disabled = active && context.kind !== 'translate';
    $('personARecord').disabled = active && !(context.kind === 'conversation' && context.speaker === 'A');
    $('personBRecord').disabled = active && !(context.kind === 'conversation' && context.speaker === 'B');
    for (const control of ['spokenLanguage', 'sourceLanguage', 'targetLanguage', 'swapLanguages', 'clearText', 'translateButton', 'transcribeButton', 'personALanguage', 'personBLanguage', 'sendConversation', 'clearConversation']) $(control).disabled = active;
    $('originalText').readOnly = active;
    $('conversationText').readOnly = active;
    $(context.kind === 'translate' ? 'recordStatus' : 'conversationStatus').textContent = active ? '● Listening… Speak clearly, then stop when you are done.' : 'Recording finished. Review your words below.';
  }
  function startRecording(kind = 'translate', speaker = null) {
    if (recognition) { recognition.stop(); return; }
    if (working || conversationWorking) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return notify('Live recording is unavailable in this browser. Use Chrome or Edge, or upload an audio recording.', true);
    stopAudio();
    const context = { kind, speaker, language: kind === 'translate' ? $('spokenLanguage').value : $(speaker === 'A' ? 'personALanguage' : 'personBLanguage').value,
      base: kind === 'translate' ? $('originalText').value.trim() : '', final: '', failed: false };
    if (kind === 'conversation') {
      context.source = translateCode(context.language);
      context.target = translateCode($(speaker === 'A' ? 'personBLanguage' : 'personALanguage').value);
    } else invalidateResult();
    const recognizer = new SR();
    recognition = recognizer;
    recognizer.lang = context.language; recognizer.continuous = true; recognizer.interimResults = true;
    recognizer.onresult = event => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) context.final += `${event.results[i][0].transcript} `;
        else interim += event.results[i][0].transcript;
      }
      const text = [context.base, context.final.trim(), interim].filter(Boolean).join(' ').slice(0, 5000);
      if (kind === 'translate') { $('originalText').value = text; updateCount(); }
      else { $('conversationText').value = text; $('conversationSpeaker').value = speaker; }
    };
    recognizer.onerror = event => {
      context.failed = true;
      const errors = { 'not-allowed': 'Microphone permission was denied. Allow it in your browser settings.', 'audio-capture': 'No microphone was found.', network: 'Speech recognition could not connect. Check your internet connection.', 'no-speech': 'No speech detected. Try speaking again.' };
      notify(errors[event.error] || 'Recording stopped. Try again or upload a recording.', true);
    };
    recognizer.onend = async () => {
      clearTimeout(recordingTimer);
      recognition = null;
      recordingUI(context, false);
      const text = [context.base, context.final.trim()].filter(Boolean).join(' ').slice(0, 5000);
      if (kind === 'translate') { $('originalText').value = text; updateCount(); }
      else if (context.final.trim() && !context.failed) {
        $('conversationText').value = context.final.trim().slice(0, 5000);
        await translateTurn(speaker, context.source, context.target);
      }
    };
    try {
      recordingUI(context, true); recognizer.start();
      recordingTimer = setTimeout(() => recognizer.stop(), 120000);
    } catch (error) { recognition = null; recordingUI(context, false); handleError(error); }
  }
  async function transcribe() {
    if (working || recognition) return;
    const file = $('audioFile').files[0];
    if (!file) return notify('Choose an audio recording first.', true);
    if (file.size > 25 * 1024 * 1024) return notify('Choose a file under 25 MB.', true);
    const form = new FormData(); form.append('audio', file); form.append('language', $('spokenLanguage').value);
    setWorking(true); notify('Transcribing your recording…');
    try {
      const data = await api('/api/transcribe', { method: 'POST', body: form });
      invalidateResult(); $('originalText').value = data.text; updateCount();
      notify('Transcription ready. Review or edit it, then translate.');
    } catch (error) { handleError(error); } finally { setWorking(false); }
  }
  async function translateTurn(speaker, source, target) {
    if (conversationWorking || recognition) return;
    const text = $('conversationText').value.trim();
    if (!text) return notify('Speak or type a message first.', true);
    source ||= translateCode($(speaker === 'A' ? 'personALanguage' : 'personBLanguage').value);
    target ||= translateCode($(speaker === 'A' ? 'personBLanguage' : 'personALanguage').value);
    conversationWorking = true;
    for (const id of ['personARecord', 'personBRecord', 'sendConversation', 'clearConversation', 'personALanguage', 'personBLanguage', 'conversationSpeaker']) $(id).disabled = true;
    $('conversationText').readOnly = true;
    $('conversationStatus').textContent = `Translating Person ${speaker}'s turn…`;
    try {
      const record = await api('/translate', { method: 'POST', body: json({ text, source, target, mode: 'conversation', speaker }) });
      if ($('conversationTurns').querySelector('.empty-state')) $('conversationTurns').replaceChildren();
      const turn = node('article', null, `card turn ${speaker === 'B' ? 'speaker-b' : ''}`);
      turn.append(node('p', `Person ${speaker} · ${sourceName(record)} → ${languageName(record.target)}`, 'small muted'));
      const original = node('p', record.original, 'original'); original.dir = 'auto'; original.lang = record.source;
      const translated = node('p', record.translated, 'translated'); translated.dir = 'auto'; translated.lang = record.target;
      const tools = node('div', null, 'button-row');
      tools.append(button('▶ Replay', () => speak(record)), button('☆ Save phrase', async () => { await setFavorite(record); }), button('■ Stop audio', stopAudio));
      turn.append(original, translated, tools); $('conversationTurns').append(turn);
      $('conversationText').value = '';
      $('conversationSpeaker').value = speaker === 'A' ? 'B' : 'A';
      $('conversationStatus').textContent = `Saved. Person ${speaker === 'A' ? 'B' : 'A'} can speak next.`;
      turn.scrollIntoView({ block: 'nearest' });
      if ($('autoSpeak').checked) await speak(record);
    } catch (error) { handleError(error); $('conversationStatus').textContent = 'Your message is still here. Try translating again.'; }
    finally {
      conversationWorking = false;
      for (const id of ['personARecord', 'personBRecord', 'sendConversation', 'clearConversation', 'personALanguage', 'personBLanguage', 'conversationSpeaker']) $(id).disabled = false;
      $('conversationText').readOnly = false;
    }
  }
  function bind(id, handler) { $(id).addEventListener('click', async () => { try { await handler(); } catch (error) { handleError(error); } }); }
  document.querySelectorAll('.nav-button').forEach(element => element.addEventListener('click', () => switchView(element.dataset.view)));
  $('originalText').addEventListener('input', () => { updateCount(); invalidateResult(); });
  for (const id of ['sourceLanguage', 'targetLanguage']) $(id).addEventListener('change', invalidateResult);
  bind('swapLanguages', () => {
    const source = $('sourceLanguage').value === 'auto' ? current?.detected : $('sourceLanguage').value;
    if (!source || !Object.values(config.languages).includes(source)) return notify('Translate once to detect the source language, or choose it yourself.', true);
    const target = $('targetLanguage').value, text = current?.translated || $('originalText').value;
    $('sourceLanguage').value = target; $('targetLanguage').value = source; $('originalText').value = text;
    updateCount(); invalidateResult();
  });
  bind('clearText', () => { $('originalText').value = ''; updateCount(); invalidateResult(); $('originalText').focus(); });
  bind('translateButton', translate); bind('recordButton', () => startRecording()); bind('transcribeButton', transcribe);
  bind('playButton', () => current && speak(current)); bind('stopAudio', stopAudio);
  bind('copyButton', async () => { if (!current) return; await navigator.clipboard.writeText(current.translated); notify('Translation copied.'); });
  bind('favoriteButton', async () => { if (current) await setFavorite(current); });
  bind('exportTxt', () => current && download(current, 'txt'));
  bind('exportDocx', () => current && download(current, 'docx'));
  bind('exportPdf', () => current && printRecord(current));
  bind('exportAudio', async () => {
    if (!current) return;
    const record = current; $('exportAudio').disabled = true;
    try { saveBlob(await generatedAudio(record), `translation-${record.id}.mp3`); notify('MP3 downloaded.'); }
    finally { $('exportAudio').disabled = !current || !config.tts_languages[current.target]; }
  });
  bind('openEmail', () => {
    if (!current) return;
    $('emailConfiguration').textContent = config.email_configured ? 'Both original and translated text will be included.' : 'Email needs SMTP settings in .env before it can send.';
    $('sendEmail').disabled = !config.email_configured;
    $('emailAttachment').querySelector('option[value="audio"]').disabled = !config.tts_languages[current.target];
    $('emailAttachment').value = 'none'; $('emailStatus').textContent = '';
    $('emailFileField').hidden = true; $('emailAttachmentFile').value = '';
    $('emailDialog').showModal();
  });
  bind('closeEmail', () => $('emailDialog').close());
  $('emailAttachment').addEventListener('change', () => {
    const kind = $('emailAttachment').value;
    $('emailFileField').hidden = !['pdf', 'recording'].includes(kind);
    $('emailAttachmentFile').accept = kind === 'pdf' ? '.pdf' : '.mp3,.wav,.m4a,.webm,.ogg,.flac,.aac';
    $('emailAttachmentFile').value = '';
  });
  $('emailForm').addEventListener('submit', async event => {
    event.preventDefault(); if (!current) return;
    const kind = $('emailAttachment').value;
    let body = json({ id: current.id, email: $('recipientEmail').value, attachment: kind });
    if (['pdf', 'recording'].includes(kind)) {
      const file = $('emailAttachmentFile').files[0];
      if (!file || file.size > 25 * 1024 * 1024) { $('emailStatus').textContent = 'Choose an attachment under 25 MB.'; return; }
      body = new FormData(); body.append('id', current.id); body.append('email', $('recipientEmail').value);
      body.append('attachment', kind); body.append('attachment_file', file);
    }
    $('sendEmail').disabled = true; $('emailStatus').textContent = 'Sending…';
    try { await api('/api/email', { method: 'POST', body }); $('emailDialog').close(); notify('Email sent.'); }
    catch (error) { $('emailStatus').textContent = error.message; }
    finally { $('sendEmail').disabled = !config.email_configured; }
  });
  bind('personARecord', () => startRecording('conversation', 'A'));
  bind('personBRecord', () => startRecording('conversation', 'B'));
  bind('sendConversation', () => translateTurn($('conversationSpeaker').value));
  bind('clearConversation', () => { stopAudio(); $('conversationTurns').replaceChildren(node('p', 'Your conversation starts here. Turns are also saved in History.', 'empty-state')); notify('Conversation view cleared. Saved turns remain in your history.'); });
  $('searchForm').addEventListener('submit', event => { event.preventDefault(); loadHistory().catch(handleError); });
  bind('loadMoreHistory', () => loadHistory(true));
  $('profileForm').addEventListener('submit', async event => {
    event.preventDefault(); const submit = event.target.querySelector('button'); submit.disabled = true;
    try {
      const profile = await api('/api/profile', { method: 'PATCH', body: json({ name: $('profileName').value, current_password: $('currentPassword').value, new_password: $('newPassword').value }) });
      $('userGreeting').textContent = profile.name; $('currentPassword').value = $('newPassword').value = ''; notify('Your profile has been updated.');
    } catch (error) { handleError(error); } finally { submit.disabled = false; }
  });
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !$('emailDialog').open) {
      event.preventDefault(); if (view === 'translate') translate(); else if (view === 'conversation') translateTurn($('conversationSpeaker').value);
    }
    if (event.key === 'Escape') { if (recognition) recognition.stop(); stopAudio(); }
  });
  window.addEventListener('pagehide', () => { recognition?.abort(); stopAudio(); if (audioUrl) URL.revokeObjectURL(audioUrl); });
  async function initialize() {
    try {
      config = await api('/api/config');
      const entries = Object.entries(config.languages).sort(([a], [b]) => a.localeCompare(b));
      fillLanguages('sourceLanguage', 'auto', entries, true);
      fillLanguages('targetLanguage', 'kn', entries);
      const spoken = Object.entries(spokenLanguages).map(([code, name]) => [name, code]);
      fillLanguages('spokenLanguage', 'en-IN', spoken);
      fillLanguages('personALanguage', 'en-IN', spoken);
      fillLanguages('personBLanguage', 'kn-IN', spoken);
      invalidateResult();
    } catch (error) { handleError(error); $('translateButton').disabled = true; }
  }
  initialize();
})();
