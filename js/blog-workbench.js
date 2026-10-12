(() => {
  const databaseName = 'lyf-blog-local-drafts';
  const storeName = 'drafts';
  const editor = document.querySelector('#markdown-source');
  const titleField = document.querySelector('#draft-title');
  const dateField = document.querySelector('#draft-date');
  const dialog = document.querySelector('#writer-dialog');
  const writerMain = document.querySelector('#writer-main');
  const imageField = document.querySelector('#image-input');
  const imageList = document.querySelector('#image-list');
  const writerStatus = document.querySelector('#writer-status');
  const writerNotice = document.querySelector('#writer-notice');
  const publishButton = document.querySelector('#publish-article');
  const connectPublisherButton = document.querySelector('#connect-publisher');
  const publisherStatus = document.querySelector('#publisher-status');
  const retryPublishButton = document.querySelector('#retry-publish');
  const preview = document.querySelector('#markdown-preview');
  const objectUrls = new Map();
  let databasePromise;
  let articles = [];
  let drafts = [];
  let activeDraftId = '';
  let activeImages = [];
  let dirty = false;
  let publishAvailable = false;
  let publisherBase = '';
  const localPublisherPage = ['127.0.0.1', 'localhost'].includes(window.location.hostname) && window.location.port === '8766';

  function localDate() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function makeId() {
    return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('当前浏览器不支持本地草稿存储。'));
        return;
      }
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('无法打开本地草稿存储。'));
    });
    return databasePromise;
  }

  async function readDrafts() {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const request = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error || new Error('读取草稿失败。'));
    });
  }

  async function writeDraft(draft) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite');
      transaction.objectStore(storeName).put(draft);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('保存草稿失败。'));
      transaction.onabort = () => reject(transaction.error || new Error('保存草稿失败。'));
    });
  }

  async function removeDraft(id) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite');
      transaction.objectStore(storeName).delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('删除草稿失败。'));
    });
  }

  function formatDate(value) {
    return value ? value.replaceAll('-', '.') : '';
  }

  function createTag(label) {
    const tag = document.createElement('span');
    tag.textContent = label;
    return tag;
  }

  function renderArticle(entry) {
    const wrapper = document.createElement('div');
    wrapper.className = 'article-entry';
    const row = document.createElement('a');
    row.className = 'article-row';
    row.href = `./${entry.path}`;

    const date = document.createElement('time');
    date.className = 'article-date';
    date.dateTime = String(entry.date || '').slice(0, 10);
    date.textContent = formatDate(date.dateTime);

    const copy = document.createElement('div');
    copy.className = 'article-copy';
    const heading = document.createElement('h3');
    heading.textContent = entry.title || '未命名文章';
    const tags = document.createElement('div');
    tags.className = 'article-tags';
    (entry.tags || []).forEach((item) => tags.append(createTag(item.name)));
    copy.append(heading, tags);
    row.append(date, copy);
    wrapper.append(row);
    const slug = articleSlug(entry);
    if (publishAvailable && slug) {
      const remove = document.createElement('button');
      remove.className = 'article-delete';
      remove.type = 'button';
      remove.dataset.deleteArticle = slug;
      remove.textContent = '删除';
      remove.setAttribute('aria-label', `删除文章：${entry.title || '未命名文章'}`);
      wrapper.append(remove);
    }
    return wrapper;
  }

  function articleSlug(entry) {
    if (!String(entry.path || '').startsWith('article.html?slug=')) return '';
    try {
      const slug = new URL(entry.path, window.location.href).searchParams.get('slug') || '';
      return /^[\p{L}\p{N}-]{1,100}$/u.test(slug) ? slug : '';
    } catch {
      return '';
    }
  }

  function renderArticles() {
    const query = document.querySelector('#article-search').value.trim().toLocaleLowerCase();
    const filtered = articles.filter((article) => {
      const tags = (article.tags || []).map((tag) => tag.name).join(' ');
      return `${article.title} ${tags}`.toLocaleLowerCase().includes(query);
    });
    const list = document.querySelector('#article-list');
    list.replaceChildren(...filtered.map(renderArticle));
    document.querySelector('#empty-results').hidden = filtered.length !== 0;
  }

  function renderTopics() {
    const counts = new Map();
    articles.forEach((article) => (article.tags || []).forEach((tag) => {
      counts.set(tag.name, (counts.get(tag.name) || 0) + 1);
    }));
    const topics = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const list = document.querySelector('#topic-list');
    list.replaceChildren(...topics.map(([name]) => {
      const link = document.createElement('a');
      link.href = '#notes';
      link.textContent = name;
      link.addEventListener('click', () => {
        document.querySelector('#article-search').value = name;
        renderArticles();
      });
      return link;
    }));
  }

  function renderDrafts() {
    const section = document.querySelector('#draft-section');
    const list = document.querySelector('#draft-list');
    const sorted = [...drafts].sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
    section.hidden = sorted.length === 0;
    document.querySelector('#draft-count').textContent = `${sorted.length} 篇`;
    list.replaceChildren(...sorted.map((draft) => {
      const row = document.createElement('div');
      row.className = 'draft-row';
      const open = document.createElement('button');
      open.className = 'draft-open';
      open.type = 'button';
      open.dataset.openDraft = draft.id;
      const heading = document.createElement('strong');
      heading.textContent = draft.title || '未命名草稿';
      const date = document.createElement('time');
      date.textContent = formatDate(draft.date);
      open.append(heading, date);
      const remove = document.createElement('button');
      remove.className = 'draft-delete';
      remove.type = 'button';
      remove.dataset.deleteDraft = draft.id;
      remove.textContent = '×';
      remove.title = '删除草稿';
      remove.setAttribute('aria-label', `删除草稿：${draft.title || '未命名草稿'}`);
      row.append(open, remove);
      return row;
    }));
  }

  async function loadArticles() {
    const response = await fetch('./content.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error('文章列表暂时无法读取。');
    const data = await response.json();
    articles = data.filter((entry) => !String(entry.path).startsWith('notes/'));
    articles.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    document.querySelector('#article-count').textContent = `${articles.length} 篇文章`;
    document.querySelector('#original-count').textContent = String(articles.length);
    document.querySelector('#latest-date').textContent = formatDate(String(articles[0]?.date || '').slice(0, 10)) || '--';
    renderArticles();
    renderTopics();
  }

  function updatePublisherStatus(message, pending = false) {
    publisherStatus.textContent = message;
    retryPublishButton.hidden = !pending;
  }

  function setPublisherConnected(connected) {
    publishAvailable = connected;
    publishButton.hidden = !connected;
    if (!localPublisherPage) {
      connectPublisherButton.hidden = false;
      connectPublisherButton.disabled = connected;
      connectPublisherButton.textContent = connected ? '本机已连接' : '连接本机发布器';
    }
    renderArticles();
  }

  async function checkLocalPublisher() {
    if (!localPublisherPage) {
      connectPublisherButton.hidden = false;
      document.querySelector('#writer-notice').textContent = 'GitHub Pages 是静态站点。连接本机发布器后，保存和删除会提交并推送到 GitHub。';
      updatePublisherStatus('连接本机发布器后，可从页面新增或删除文章并推送到 GitHub。');
      return;
    }
    publisherBase = window.location.origin;
    try {
      const response = await fetch(`${publisherBase}/api/status`, { cache: 'no-store' });
      if (!response.ok) return;
      const status = await response.json();
      setPublisherConnected(status.writeEnabled === true && status.pushEnabled === true);
      writerNotice.textContent = publishAvailable
        ? '本机已连接。保存或删除文章后会提交并推送到 GitHub。'
        : '草稿保存在当前浏览器，也可以导出 Markdown 和图片。';
      updatePublisherStatus(status.pending
        ? '检测到本机有尚未同步的博客更改。'
        : publishAvailable ? '本机发布器已连接；文章变更会提交并推送到 GitHub。' : '本机发布器当前不可用。', status.pending === true);
    } catch {
      setPublisherConnected(false);
      updatePublisherStatus('本机发布器连接失败。');
    }
  }

  async function connectPublisher() {
    publisherBase = 'http://127.0.0.1:8766';
    connectPublisherButton.disabled = true;
    connectPublisherButton.textContent = '正在连接…';
    writerNotice.textContent = '正在连接本机发布器…';
    try {
      const response = await fetch(`${publisherBase}/api/status`, { cache: 'no-store' });
      if (!response.ok) throw new Error('本机发布器未响应。');
      const status = await response.json();
      if (status.writeEnabled !== true || status.pushEnabled !== true) throw new Error('本机发布器不支持 Git 发布。');
      setPublisherConnected(true);
      writerNotice.textContent = '已连接本机；保存或删除后会通过 Git 提交并推送。';
      updatePublisherStatus(status.pending ? '检测到本机有尚未同步的博客更改。' : '本机发布器已连接；文章变更会提交并推送到 GitHub。', status.pending === true);
    } catch {
      publisherBase = '';
      setPublisherConnected(false);
      connectPublisherButton.disabled = false;
      connectPublisherButton.textContent = '连接本机发布器';
      writerNotice.textContent = '连接失败。请先在本机启动博客发布器，再重试。';
      updatePublisherStatus('本机发布器连接失败。请确认发布服务正在运行。');
    }
  }

  function markDirty() {
    dirty = true;
    writerStatus.textContent = '有未保存的修改';
    renderPreview();
  }

  function getObjectUrl(image) {
    if (!objectUrls.has(image.id)) objectUrls.set(image.id, URL.createObjectURL(image.blob));
    return objectUrls.get(image.id);
  }

  function releaseObjectUrls() {
    objectUrls.forEach((url) => URL.revokeObjectURL(url));
    objectUrls.clear();
  }

  function renderPreview() {
    document.querySelector('#preview-title').textContent = titleField.value.trim() || '文章标题';
    document.querySelector('#preview-date').textContent = formatDate(dateField.value);
    const text = editor.value.trim();
    if (!text) {
      preview.innerHTML = '<p class="preview-placeholder">输入内容后在这里预览。</p>';
      return;
    }
    if (!window.marked?.parse || !window.DOMPurify?.sanitize) {
      preview.textContent = text;
      return;
    }
    const html = window.marked.parse(text, { gfm: true, breaks: true, async: false });
    preview.innerHTML = window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
    preview.querySelectorAll('img[src]').forEach((image) => {
      const match = image.getAttribute('src').match(/^draft-assets\/([\w-]+)$/);
      if (!match) return;
      const attached = activeImages.find((item) => item.id === match[1]);
      if (attached) image.src = getObjectUrl(attached);
      else image.remove();
    });
    preview.querySelectorAll('a[href^="http"]').forEach((link) => {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    });
  }

  function renderImageList() {
    imageList.replaceChildren(...activeImages.map((image) => {
      const chip = document.createElement('span');
      chip.className = 'image-chip';
      const name = document.createElement('span');
      name.textContent = image.name;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.dataset.removeImage = image.id;
      remove.textContent = '×';
      remove.title = `移除图片 ${image.name}`;
      remove.setAttribute('aria-label', `移除图片 ${image.name}`);
      chip.append(name, remove);
      return chip;
    }));
  }

  function resetWriter(draft) {
    releaseObjectUrls();
    activeDraftId = draft?.id || makeId();
    activeImages = (draft?.images || []).map((image) => ({ ...image }));
    titleField.setCustomValidity('');
    titleField.value = draft?.title || '';
    dateField.value = draft?.date || localDate();
    editor.value = draft?.body || '';
    dirty = false;
    writerStatus.textContent = draft ? '本地草稿已载入' : '草稿尚未保存';
    document.querySelector('#delete-draft').hidden = !draft;
    writerMain.classList.remove('preview-mode');
    document.querySelector('#show-editor').classList.add('is-active');
    document.querySelector('#show-editor').setAttribute('aria-pressed', 'true');
    document.querySelector('#show-preview').classList.remove('is-active');
    document.querySelector('#show-preview').setAttribute('aria-pressed', 'false');
    renderImageList();
    renderPreview();
  }

  function openWriter(draft) {
    resetWriter(draft);
    if (!dialog.open) dialog.showModal();
    titleField.focus();
  }

  function closeWriter() {
    const hasContent = titleField.value.trim() || editor.value.trim() || activeImages.length;
    if (dirty && hasContent && !window.confirm('有未保存的修改，仍要关闭吗？')) return;
    dialog.close();
  }

  async function saveCurrentDraft() {
    const title = titleField.value.trim();
    if (!title) {
      titleField.setCustomValidity('请填写文章标题。');
      titleField.reportValidity();
      titleField.addEventListener('input', () => titleField.setCustomValidity(''), { once: true });
      return;
    }
    if (!dateField.value) {
      dateField.reportValidity();
      return;
    }
    try {
      const draft = {
        id: activeDraftId,
        title,
        date: dateField.value,
        body: editor.value,
        images: activeImages,
        updated: new Date().toISOString()
      };
      await writeDraft(draft);
      drafts = [draft, ...drafts.filter((item) => item.id !== draft.id)];
      dirty = false;
      writerStatus.textContent = '已保存到本地草稿';
      document.querySelector('#delete-draft').hidden = false;
      renderDrafts();
    } catch (error) {
      writerStatus.textContent = error.message || '保存失败，请检查浏览器存储空间。';
    }
  }

  function insertText(before, after = '', placeholder = '') {
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const selected = editor.value.slice(start, end) || placeholder;
    editor.setRangeText(`${before}${selected}${after}`, start, end, 'select');
    editor.focus();
    editor.setSelectionRange(start + before.length, start + before.length + selected.length);
    markDirty();
  }

  function insertLinePrefix(prefix) {
    const start = editor.selectionStart;
    const lineStart = editor.value.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
    editor.setRangeText(prefix, lineStart, lineStart, 'end');
    editor.focus();
    markDirty();
  }

  function uniqueFileName(name, used) {
    const clean = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '') || 'image';
    const dot = clean.lastIndexOf('.');
    const stem = dot > 0 ? clean.slice(0, dot) : clean;
    const extension = dot > 0 ? clean.slice(dot) : '';
    let candidate = clean;
    let suffix = 2;
    while (used.has(candidate.toLowerCase())) candidate = `${stem}-${suffix++}${extension}`;
    used.add(candidate.toLowerCase());
    return candidate;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function slugForExport() {
    return `technical-note-${dateField.value}-${activeDraftId.slice(0, 6)}`;
  }

  function exportCurrentDraft() {
    const title = titleField.value.trim();
    if (!title) {
      titleField.setCustomValidity('请填写文章标题。');
      titleField.reportValidity();
      titleField.addEventListener('input', () => titleField.setCustomValidity(''), { once: true });
      return;
    }
    if (!dateField.value) {
      dateField.reportValidity();
      return;
    }
    const usedNames = new Set();
    const replacements = new Map();
    activeImages.forEach((image) => replacements.set(image.id, uniqueFileName(image.name, usedNames)));
    const body = editor.value.replace(/\]\(draft-assets\/([\w-]+)\)/g, (match, id) => {
      const name = replacements.get(id);
      return name ? `](images/${name})` : match;
    });
    const markdown = `---\ntitle: ${JSON.stringify(title)}\ndate: ${dateField.value}\n---\n\n${body}\n`;
    downloadBlob(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }), `${slugForExport()}.md`);
    activeImages.forEach((image, index) => {
      window.setTimeout(() => downloadBlob(image.blob, replacements.get(image.id)), 250 * (index + 1));
    });
    writerStatus.textContent = activeImages.length
      ? `已导出 Markdown 和 ${activeImages.length} 张图片；图片路径为 images/。`
      : '已导出 Markdown 文件。';
  }

  function blobAsDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('读取图片失败。'));
      reader.readAsDataURL(blob);
    });
  }

  async function publishCurrentArticle() {
    const title = titleField.value.trim();
    if (!title) {
      titleField.setCustomValidity('请填写文章标题。');
      titleField.reportValidity();
      titleField.addEventListener('input', () => titleField.setCustomValidity(''), { once: true });
      return;
    }
    if (!dateField.value) {
      dateField.reportValidity();
      return;
    }
    if (!publishAvailable) {
      writerStatus.textContent = '本地发布服务不可用，请从本地预览地址打开博客。';
      return;
    }

    publishButton.disabled = true;
    writerStatus.textContent = '正在写入博客目录…';
    try {
      const images = await Promise.all(activeImages.map(async (image) => ({
        id: image.id,
        name: image.name,
        type: image.type,
        dataUrl: await blobAsDataUrl(image.blob)
      })));
      const response = await fetch(`${publisherBase}/api/articles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, date: dateField.value, body: editor.value, images })
      });
      const result = await response.json();
      if (!response.ok && response.status !== 202) throw new Error(result.error || '保存文章失败。');

      articles = [result.article, ...articles].sort((a, b) => String(b.date).localeCompare(String(a.date)));
      document.querySelector('#article-count').textContent = `${articles.length} 篇文章`;
      document.querySelector('#original-count').textContent = String(articles.length);
      document.querySelector('#latest-date').textContent = formatDate(String(articles[0]?.date || '').slice(0, 10));
      renderArticles();
      renderTopics();
      try {
        await removeDraft(activeDraftId);
        drafts = drafts.filter((draft) => draft.id !== activeDraftId);
        renderDrafts();
      } catch {
        // Keep the published article even if browser draft cleanup fails.
      }
      dirty = false;
      dialog.close();
      resetWriter(null);
      if (result.published) {
        writerStatus.textContent = '文章已提交并推送到 GitHub。';
        updatePublisherStatus('文章已提交并推送到 GitHub Pages。');
      } else {
        writerStatus.textContent = result.error || '文章已保存在本机，尚未推送。';
        updatePublisherStatus(result.error || '文章已保存在本机，尚未推送。', true);
      }
    } catch (error) {
      writerStatus.textContent = error.message || '保存文章失败，请稍后重试。';
    } finally {
      publishButton.disabled = false;
    }
  }

  async function deleteDraft(id) {
    const draft = drafts.find((item) => item.id === id);
    if (!draft || !window.confirm(`删除草稿“${draft.title || '未命名草稿'}”？`)) return;
    try {
      await removeDraft(id);
      drafts = drafts.filter((item) => item.id !== id);
      renderDrafts();
      if (activeDraftId === id) {
        dirty = false;
        dialog.close();
      }
    } catch (error) {
      writerStatus.textContent = error.message || '删除草稿失败。';
    }
  }

  async function deletePublishedArticle(slug, button) {
    const article = articles.find((entry) => articleSlug(entry) === slug);
    if (!article || !window.confirm(`删除文章“${article.title || '未命名文章'}”？这会从博客移除文章并推送到 GitHub。`)) return;
    button.disabled = true;
    updatePublisherStatus(`正在删除“${article.title}”…`);
    try {
      const response = await fetch(`${publisherBase}/api/articles/${encodeURIComponent(slug)}`, { method: 'DELETE' });
      const result = await response.json();
      if (!response.ok && response.status !== 202) throw new Error(result.error || '删除文章失败。');
      articles = articles.filter((entry) => articleSlug(entry) !== slug);
      document.querySelector('#article-count').textContent = `${articles.length} 篇文章`;
      document.querySelector('#original-count').textContent = String(articles.length);
      document.querySelector('#latest-date').textContent = formatDate(String(articles[0]?.date || '').slice(0, 10)) || '--';
      renderArticles();
      renderTopics();
      if (result.published) updatePublisherStatus('文章已删除并推送到 GitHub Pages。');
      else updatePublisherStatus(result.error || '文章已从本机移除，尚未推送。', true);
    } catch (error) {
      button.disabled = false;
      updatePublisherStatus(error.message || '删除文章失败。');
    }
  }

  async function retryPublish() {
    retryPublishButton.disabled = true;
    updatePublisherStatus('正在同步 GitHub…', true);
    try {
      const response = await fetch(`${publisherBase}/api/publish`, { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Git 推送失败。');
      updatePublisherStatus('本机博客内容已同步到 GitHub Pages。');
    } catch (error) {
      updatePublisherStatus(error.message || 'Git 推送失败。', true);
    } finally {
      retryPublishButton.disabled = false;
    }
  }

  document.querySelector('#open-writer').addEventListener('click', () => openWriter(null));
  document.querySelectorAll('.close-writer').forEach((button) => button.addEventListener('click', closeWriter));
  dialog.addEventListener('close', releaseObjectUrls);
  dialog.addEventListener('cancel', (event) => {
    const hasContent = titleField.value.trim() || editor.value.trim() || activeImages.length;
    if (dirty && hasContent && !window.confirm('有未保存的修改，仍要关闭吗？')) event.preventDefault();
  });
  titleField.addEventListener('input', markDirty);
  dateField.addEventListener('input', markDirty);
  editor.addEventListener('input', markDirty);
  document.querySelector('#save-draft').addEventListener('click', saveCurrentDraft);
  connectPublisherButton.addEventListener('click', connectPublisher);
  retryPublishButton.addEventListener('click', retryPublish);
  publishButton.addEventListener('click', publishCurrentArticle);
  document.querySelector('#export-draft').addEventListener('click', exportCurrentDraft);
  document.querySelector('#delete-draft').addEventListener('click', () => deleteDraft(activeDraftId));
  document.querySelector('#article-search').addEventListener('input', renderArticles);
  document.querySelector('#article-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-delete-article]');
    if (!button) return;
    event.preventDefault();
    deletePublishedArticle(button.dataset.deleteArticle, button);
  });

  document.querySelector('.format-tools').addEventListener('click', (event) => {
    const button = event.target.closest('[data-format]');
    if (!button) return;
    switch (button.dataset.format) {
      case 'heading': insertLinePrefix('## '); break;
      case 'bold': insertText('**', '**', '重点内容'); break;
      case 'code': insertText('`', '`', 'code'); break;
      case 'list': insertLinePrefix('- '); break;
      case 'link': insertText('[', '](https://)', '链接文字'); break;
    }
  });

  document.querySelector('#add-image').addEventListener('click', () => imageField.click());
  imageField.addEventListener('change', () => {
    const files = [...imageField.files].filter((file) => file.type.startsWith('image/'));
    files.forEach((file) => {
      const id = makeId();
      const image = { id, name: file.name, type: file.type, blob: file };
      activeImages.push(image);
      const alt = file.name.replace(/\.[^.]+$/, '').replace(/[\]\r\n]/g, ' ');
      const insertion = `![${alt}](draft-assets/${id})`;
      const start = editor.selectionStart;
      editor.setRangeText(`${start > 0 && editor.value[start - 1] !== '\n' ? '\n\n' : ''}${insertion}\n`, start, editor.selectionEnd, 'end');
    });
    imageField.value = '';
    if (files.length) {
      dirty = true;
      writerStatus.textContent = '有未保存的修改';
      renderImageList();
      renderPreview();
    }
  });

  imageList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove-image]');
    if (!button) return;
    const id = button.dataset.removeImage;
    activeImages = activeImages.filter((image) => image.id !== id);
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    editor.value = editor.value.replace(new RegExp(`!\\[[^\\]]*\\]\\(draft-assets/${escapedId}\\)\\s*`, 'g'), '');
    if (objectUrls.has(id)) {
      URL.revokeObjectURL(objectUrls.get(id));
      objectUrls.delete(id);
    }
    markDirty();
    renderImageList();
  });

  document.querySelector('#show-editor').addEventListener('click', () => {
    writerMain.classList.remove('preview-mode');
    document.querySelector('#show-editor').classList.add('is-active');
    document.querySelector('#show-editor').setAttribute('aria-pressed', 'true');
    document.querySelector('#show-preview').classList.remove('is-active');
    document.querySelector('#show-preview').setAttribute('aria-pressed', 'false');
  });
  document.querySelector('#show-preview').addEventListener('click', () => {
    writerMain.classList.add('preview-mode');
    document.querySelector('#show-preview').classList.add('is-active');
    document.querySelector('#show-preview').setAttribute('aria-pressed', 'true');
    document.querySelector('#show-editor').classList.remove('is-active');
    document.querySelector('#show-editor').setAttribute('aria-pressed', 'false');
  });

  document.querySelector('#draft-list').addEventListener('click', async (event) => {
    const openButton = event.target.closest('[data-open-draft]');
    const deleteButton = event.target.closest('[data-delete-draft]');
    if (openButton) openWriter(drafts.find((draft) => draft.id === openButton.dataset.openDraft));
    if (deleteButton) await deleteDraft(deleteButton.dataset.deleteDraft);
  });

  async function initialize() {
    await checkLocalPublisher();
    try {
      await loadArticles();
    } catch (error) {
      document.querySelector('#article-count').textContent = '文章列表暂不可用';
      document.querySelector('#article-list').textContent = error.message;
    }
    try {
      drafts = await readDrafts();
      renderDrafts();
    } catch {
      document.querySelector('#writer-status').textContent = '本地草稿存储不可用，仍可编辑并导出。';
    }
  }

  initialize();
})();
