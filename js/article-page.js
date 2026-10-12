(() => {
  const title = document.querySelector('#article-title');
  const date = document.querySelector('#article-date');
  const content = document.querySelector('#article-content');
  const error = document.querySelector('#article-error');
  const slug = new URLSearchParams(window.location.search).get('slug');

  async function loadArticle() {
    if (!slug || slug.includes('/') || slug.includes('\\')) throw new Error('Invalid article path');
    const response = await fetch(`./posts/${encodeURIComponent(slug)}/article.json`, { cache: 'no-cache' });
    if (!response.ok) throw new Error('Article not found');
    const article = await response.json();
    title.textContent = article.title || '未命名文章';
    document.title = `${title.textContent} · 刘一非技术博客`;
    date.dateTime = article.date || '';
    date.textContent = String(article.date || '').replaceAll('-', '.');
    const html = window.marked.parse(article.body || '', { gfm: true, breaks: true, async: false });
    content.innerHTML = window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
    content.querySelectorAll('a[href^="http"]').forEach((link) => {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    });
  }

  loadArticle().catch(() => {
    title.textContent = '文章无法读取';
    error.hidden = false;
    content.hidden = true;
  });
})();
