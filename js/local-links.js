(() => {
  if (!['127.0.0.1', 'localhost'].includes(window.location.hostname)) return;
  document.querySelectorAll('a[href*="yifeiliu-1997.github.io/lyf-profile"]').forEach((link) => {
    const target = new URL(link.href);
    const route = target.pathname.replace(/^\/lyf-profile(?=\/|$)/, '') || '/';
    link.href = `http://${window.location.hostname}:8765${route}${target.search}${target.hash}`;
  });
})();
