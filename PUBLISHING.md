# Blog Publishing

GitHub Pages is static hosting, so it cannot commit files to this repository on its own. The editor uses a small local service and the Git credentials already configured on this computer; it does not put a GitHub token in the page.

1. In this repository, run `node server.mjs` and leave the process running.
2. Open the published blog and choose **写技术博客**.
3. Choose **连接本机发布器**. The browser may ask permission to connect to this computer.
4. Save a new article to create its Markdown and image files, commit them, and push `gh-pages`.
5. After connecting, use **删除** next to an editor-managed article to remove it and push the change.

If a push fails, the local changes remain in the repository. Choose **重试 Git 推送** after restoring GitHub connectivity.
