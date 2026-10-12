import http from 'node:http';
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
    return entry;
  } catch (error) {
    if (temporaryPath) await rm(temporaryPath, { force: true });
    await rm(postDirectory, { recursive: true, force: true });
    throw error;
  }
}

function queueArticle(payload) {
  const current = publishQueue.then(() => createArticle(payload));
  publishQueue = current.catch(() => {});
  return current;
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
  if (!host.startsWith('127.0.0.1:') && !host.startsWith('localhost:')) {
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
  if (url.pathname === '/api/status' && request.method === 'GET') {
    sendJson(response, 200, { writeEnabled: true });
    return;
  }
  if (url.pathname === '/api/articles' && request.method === 'POST') {
    if (request.headers.origin && request.headers.origin.toLowerCase() !== `http://${host}`) {
      sendJson(response, 403, { error: '请求来源不匹配。' });
      return;
    }
    try {
      const payload = await readRequestBody(request);
      const article = await queueArticle(payload);
      sendJson(response, 201, { article });
    } catch (error) {
      sendJson(response, error.status || 500, { error: error.status ? error.message : '保存失败，请检查站点文件和文章索引。' });
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
