import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8766);
const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp']
]);
const imageTypes = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp']
]);
const allowedOrigins = new Set([
  'http://127.0.0.1:8766',
  'http://localhost:8766',
  'https://yifeiliu-1997.github.io'
]);
let publishQueue = Promise.resolve();

function sendJson(response, status, value) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(value));
}

async function readRequestBody(request, limit = 36 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('请求内容过大。'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('请求内容不是有效的 JSON。'), { status: 400 });
  }
}

function runGit(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'http.version=HTTP/1.1', ...args], { cwd: siteRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-8000); });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-8000); });
    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(stderr.trim() || stdout.trim() || `git ${args[0]} failed`), { code }));
    });
  });
}

async function syncBlogChanges(message) {
  const paths = ['content.json', 'posts'];
  await runGit(['add', '-A', '--', ...paths]);
  const status = await runGit(['status', '--porcelain', '--', ...paths]);
  if (status.stdout.trim()) await runGit(['commit', '--only', '-m', message, '--', ...paths]);
  try {
    await runGit(['pull', '--rebase', 'origin', 'gh-pages']);
  } catch (error) {
    try { await runGit(['rebase', '--abort']); } catch {}
    throw error;
  }
  await runGit(['push', 'origin', 'gh-pages']);
}

async function pendingBlogChanges() {
  const workingTree = await runGit(['status', '--porcelain', '--', 'content.json', 'posts']);
  const ahead = await runGit(['rev-list', '--count', 'origin/gh-pages..HEAD']);
  return Boolean(workingTree.stdout.trim() || Number(ahead.stdout.trim()) > 0);
}

function queueMutation(operation) {
  const current = publishQueue.then(operation);
  publishQueue = current.catch(() => {});
  return current;
}

function makeSlug(title, date) {
  const normalized = title.normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return `${date}-${normalized || 'article'}`;
}

function imageFilename(name, type, usedNames) {
  const extension = imageTypes.get(type);
  if (!extension) throw Object.assign(new Error('图片格式仅支持 PNG、JPEG、GIF 和 WebP。'), { status: 400 });
  const baseName = path.posix.basename(String(name || 'image').replaceAll('\\', '/'));
  const stem = path.parse(baseName).name.normalize('NFKC')
    .replace(/[^\p{L}\p{N}-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'image';
  let filename = `${stem}${extension}`;
  let suffix = 2;
  while (usedNames.has(filename.toLocaleLowerCase())) filename = `${stem}-${suffix++}${extension}`;
  usedNames.add(filename.toLocaleLowerCase());
  return filename;
}

async function createArticle(payload) {
  const title = typeof payload.title === 'string' ? payload.title.trim() : '';
  const date = typeof payload.date === 'string' ? payload.date : '';
  const body = typeof payload.body === 'string' ? payload.body : '';
  const images = Array.isArray(payload.images) ? payload.images : [];
  if (!title || title.length > 120) throw Object.assign(new Error('标题不能为空，且不能超过 120 个字符。'), { status: 400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw Object.assign(new Error('请选择有效的发布日期。'), { status: 400 });
  }
  if (body.length > 2_000_000) throw Object.assign(new Error('Markdown 内容不能超过 2 MB。'), { status: 413 });
  if (images.length > 12) throw Object.assign(new Error('单篇文章最多添加 12 张图片。'), { status: 400 });

  const slugBase = makeSlug(title, date);
  let slug = slugBase;
  let suffix = 2;
  while (true) {
    try {
      await access(path.join(siteRoot, 'posts', slug));
      slug = `${slugBase}-${suffix++}`;
    } catch {
      break;
    }
  }

  const postDirectory = path.join(siteRoot, 'posts', slug);
  const imagesDirectory = path.join(postDirectory, 'images');
  const imageReferences = new Map();
  const usedNames = new Set();
  const decodedImages = [];
  let totalImageBytes = 0;

  for (const image of images) {
    if (!image || typeof image.id !== 'string' || !/^[\w-]{1,80}$/.test(image.id)) {
      throw Object.assign(new Error('图片信息无效。'), { status: 400 });
    }
    if (imageReferences.has(image.id) || typeof image.dataUrl !== 'string') {
      throw Object.assign(new Error('图片信息重复或缺失。'), { status: 400 });
    }
    const filename = imageFilename(image.name, image.type, usedNames);
    const prefix = `data:${image.type};base64,`;
    if (!image.dataUrl.startsWith(prefix)) throw Object.assign(new Error('图片数据格式无效。'), { status: 400 });
    const bytes = Buffer.from(image.dataUrl.slice(prefix.length), 'base64');
    if (!bytes.length || bytes.toString('base64') !== image.dataUrl.slice(prefix.length)) {
      throw Object.assign(new Error('图片数据无法解码。'), { status: 400 });
    }
    totalImageBytes += bytes.length;
    if (totalImageBytes > 24 * 1024 * 1024) throw Object.assign(new Error('图片总大小不能超过 24 MB。'), { status: 413 });
    imageReferences.set(image.id, filename);
    decodedImages.push({ filename, bytes });
  }

  if (/draft-assets\/[\w-]+/.test(body.replace(/draft-assets\/([\w-]+)/g, (reference, id) => imageReferences.has(id) ? '' : reference))) {
    throw Object.assign(new Error('正文里存在未添加到图片列表的图片引用。'), { status: 400 });
  }
  const storedBody = body.replace(/draft-assets\/([\w-]+)/g, (reference, id) =>
    imageReferences.has(id) ? `posts/${slug}/images/${imageReferences.get(id)}` : reference);
  const markdownBody = body.replace(/draft-assets\/([\w-]+)/g, (reference, id) =>
    imageReferences.has(id) ? `images/${imageReferences.get(id)}` : reference);
  const markdown = `---\ntitle: ${JSON.stringify(title)}\ndate: ${date}\n---\n\n${markdownBody}\n`;
  const entry = {
    title,
    date: `${date}T00:00:00.000Z`,
    path: `article.html?slug=${encodeURIComponent(slug)}`,
    tags: []
  };

  await mkdir(imagesDirectory, { recursive: true });
  let temporaryPath = '';
  try {
    for (const { filename, bytes } of decodedImages) {
      await writeFile(path.join(imagesDirectory, filename), bytes, { flag: 'wx' });
    }
    await writeFile(path.join(postDirectory, 'article.md'), markdown, { flag: 'wx' });
    await writeFile(path.join(postDirectory, 'article.json'), JSON.stringify({ title, date, body: storedBody }, null, 2) + '\n', { flag: 'wx' });
    const contentPath = path.join(siteRoot, 'content.json');
    const content = JSON.parse(await readFile(contentPath, 'utf8'));
    if (!Array.isArray(content)) throw new Error('文章索引格式无效。');
    const updatedContent = [entry, ...content];
    temporaryPath = `${contentPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `[\n${updatedContent.map((item) => `  ${JSON.stringify(item)}`).join(',\n')}\n]\n`, { flag: 'wx' });
    await rename(temporaryPath, contentPath);
    temporaryPath = '';
    return { entry, slug };
  } catch (error) {
    if (temporaryPath) await rm(temporaryPath, { force: true });
    await rm(postDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function publishArticle(payload) {
  const { entry } = await createArticle(payload);
  try {
    await syncBlogChanges(`Publish blog post: ${entry.title}`);
    return { article: entry, published: true };
  } catch {
    return { article: entry, published: false, error: '文章已写入本机，但 Git 提交或推送失败。可以重试同步。' };
  }
}

async function deleteArticle(slug) {
  if (!/^[\p{L}\p{N}-]{1,100}$/u.test(slug)) throw Object.assign(new Error('文章编号无效。'), { status: 400 });
  const contentPath = path.join(siteRoot, 'content.json');
  const content = JSON.parse(await readFile(contentPath, 'utf8'));
  const expectedPath = `article.html?slug=${encodeURIComponent(slug)}`;
  const entry = content.find((item) => item.path === expectedPath);
  if (!entry) throw Object.assign(new Error('找不到这篇可管理的文章。'), { status: 404 });
  const postDirectory = path.join(siteRoot, 'posts', slug);
  try {
    await access(path.join(postDirectory, 'article.json'));
  } catch {
    throw Object.assign(new Error('这篇文章不属于写作器管理的内容。'), { status: 404 });
  }
  const updatedContent = content.filter((item) => item !== entry);
  const temporaryPath = `${contentPath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `[` + (updatedContent.length ? `\n${updatedContent.map((item) => `  ${JSON.stringify(item)}`).join(',\n')}\n` : '') + `]\n`, { flag: 'wx' });
  await rename(temporaryPath, contentPath);
  await rm(postDirectory, { recursive: true, force: true });
  try {
    await syncBlogChanges(`Delete blog post: ${entry.title}`);
    return { deleted: true, published: true };
  } catch {
    return { deleted: true, published: false, error: '文章已从本机移除，但 Git 提交或推送失败。可以重试同步。' };
  }
}

function setApiCors(request, response) {
  const origin = request.headers.origin;
  if (origin && !allowedOrigins.has(origin)) return false;
  if (origin) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
  }
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Access-Control-Allow-Private-Network', 'true');
  response.setHeader('Access-Control-Max-Age', '600');
  return true;
}

async function serveStatic(requestPath, method, response) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch {
    response.writeHead(400).end('Bad request');
    return;
  }
  if (decodedPath.includes('\0')) {
    response.writeHead(400).end('Bad request');
    return;
  }
  let filePath = path.resolve(siteRoot, `.${decodedPath}`);
  const rootPrefix = `${siteRoot}${path.sep}`.toLocaleLowerCase();
  if (filePath.toLocaleLowerCase() !== siteRoot.toLocaleLowerCase() && !filePath.toLocaleLowerCase().startsWith(rootPrefix)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  if (decodedPath.endsWith('/')) filePath = path.join(filePath, 'index.html');
  let file;
  try {
    file = await readFile(filePath);
  } catch {
    if (response.destroyed) return;
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    return;
  }
  response.writeHead(200, {
    'Cache-Control': 'no-cache',
    ...(method === 'HEAD' ? {} : { 'Content-Length': file.length }),
    'Content-Type': mimeTypes.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(method === 'HEAD' ? undefined : file);
}

const server = http.createServer(async (request, response) => {
  const host = String(request.headers.host || '').toLowerCase();
  if (!['127.0.0.1:8766', 'localhost:8766'].includes(host)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  let url;
  try {
    url = new URL(request.url, `http://${host}`);
  } catch {
    response.writeHead(400).end('Bad request');
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    if (!setApiCors(request, response)) {
      sendJson(response, 403, { error: '请求来源不受允许。' });
      return;
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204).end();
      return;
    }
  }
  if (url.pathname === '/api/status' && request.method === 'GET') {
    try {
      sendJson(response, 200, { writeEnabled: true, pushEnabled: true, pending: await pendingBlogChanges() });
    } catch {
      sendJson(response, 200, { writeEnabled: true, pushEnabled: true, pending: false });
    }
    return;
  }
  if (url.pathname === '/api/articles' && request.method === 'POST') {
    try {
      const payload = await readRequestBody(request);
      const result = await queueMutation(() => publishArticle(payload));
      sendJson(response, result.published ? 201 : 202, result);
    } catch (error) {
      sendJson(response, error.status || 500, { error: error.status ? error.message : '保存失败，请检查站点文件和文章索引。' });
    }
    return;
  }
  const articleMatch = url.pathname.match(/^\/api\/articles\/([^/]+)$/);
  if (articleMatch && request.method === 'DELETE') {
    try {
      const slug = decodeURIComponent(articleMatch[1]);
      const result = await queueMutation(() => deleteArticle(slug));
      sendJson(response, result.published ? 200 : 202, result);
    } catch (error) {
      sendJson(response, error.status || 500, { error: error.status ? error.message : '删除失败，请检查站点文件和文章索引。' });
    }
    return;
  }
  if (url.pathname === '/api/publish' && request.method === 'POST') {
    try {
      await queueMutation(() => syncBlogChanges('Sync technical blog changes'));
      sendJson(response, 200, { published: true });
    } catch {
      sendJson(response, 502, { error: 'Git 推送失败。请检查 GitHub 登录、网络和仓库状态后重试。' });
    }
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end('Method not allowed');
    return;
  }
  await serveStatic(url.pathname, request.method, response);
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Blog preview and local publishing: http://127.0.0.1:${port}/\n`);
});
