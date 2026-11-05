const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {SourceClient, httpUrl} = require('../manga-sources/client');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1sAAAAASUVORK5CYII=', 'base64');
const json = data => new Response(JSON.stringify({data}), {headers: {'Content-Type': 'application/json'}});

async function temporary(t)
{
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencomic-sources-test-'));
	t.after(() => fs.rm(dir, {recursive: true, force: true}));
	return dir;
}

test('repository URLs accept arbitrary HTTP(S) hosts, rejecting executable schemes and credentials', () => {
	assert.equal(httpUrl('https://example.com/custom/index.json'), 'https://example.com/custom/index.json');
	assert.equal(httpUrl('http://localhost:8000/repo.json'), 'http://localhost:8000/repo.json');
	for(const url of ['file:///tmp/repo', 'javascript:alert(1)', 'https://user:password@example.com', 'https://example.com/#secret', 'not a url']) assert.throws(() => httpUrl(url));
});

test('source IDs keep 64-bit precision and search uses GraphQL variables', async() => {
	let request;
	const client = new SourceClient('http://localhost:9999', {fetchImpl: async(_url, init) => {
		request = JSON.parse(init.body);
		return json({fetchSourceManga: {hasNextPage: false, mangas: []}});
	}});
	await client.browse('9223372036854775807', 'a"} mutation {', 2);
	assert.equal(request.variables.input.source, '9223372036854775807');
	assert.equal(request.variables.input.query, 'a"} mutation {');
	assert.equal(request.variables.input.type, 'SEARCH');
	assert.equal(request.variables.input.page, 2);
	assert.ok(!request.query.includes('a"} mutation {'));
});

test('network, GraphQL and malformed response errors are propagated', async() => {
	for(const response of [new Response('', {status: 503}), new Response(JSON.stringify({errors: [{message: 'Source unavailable'}]})), new Response('{}')])
	{
		const client = new SourceClient('https://example.com', {fetchImpl: async() => response});
		await assert.rejects(client.sources());
	}
});

test('invalid pagination, extension actions and chapter IDs fail before requests', async() => {
	const client = new SourceClient('https://example.com', {fetchImpl: async() => { throw new Error('Unexpected network request'); }});
	await assert.rejects(client.browse('1', '', -1), /Invalid/);
	await assert.rejects(client.browse('1', '', 1, 'DELETE'), /Invalid/);
	await assert.rejects(client.install('pkg', 'execute'), /Invalid/);
	assert.throws(() => client.downloadChapter('../outside', '/tmp'), /Invalid/);
});

test('repository operations preserve the supplied URL', async() => {
	const requests = [];
	const client = new SourceClient('https://engine.example', {fetchImpl: async(_url, init) => { requests.push(JSON.parse(init.body)); return json({}); }});
	await client.addRepository('https://repo.example/nested/custom.json');
	await client.removeRepository('https://repo.example/nested/custom.json');
	assert.equal(requests[0].variables.input.indexUrl, 'https://repo.example/nested/custom.json');
	assert.equal(requests[1].variables.input.indexUrl, 'https://repo.example/nested/custom.json');
});

test('pages are downloaded atomically in reader order and cached for offline re-opening', async t => {
	const root = await temporary(t);
	let requests = 0;
	const progress = [];
	const client = new SourceClient('http://localhost:9999', {fetchImpl: async url => {
		requests++;
		return url.endsWith('/api/graphql') ? json({fetchChapterPages: {pages: ['/page/2', '/page/1']}}) : new Response(png);
	}});
	const folder = await client.downloadChapter(42, root, (done, total) => progress.push([done, total]));
	assert.deepEqual((await fs.readdir(folder)).sort(), ['00001.png', '00002.png', 'complete.json']);
	assert.deepEqual(progress, [[1, 2], [2, 2]]);
	assert.equal(requests, 3);
	assert.equal(await client.downloadChapter(42, root), folder);
	assert.equal(requests, 3);
	await fs.unlink(path.join(folder, '00001.png'));
	await client.downloadChapter(42, root);
	assert.equal(requests, 6, 'missing cached pages trigger a complete retry');
});

test('a failed page leaves no readable partial chapter', async t => {
	const root = await temporary(t);
	const client = new SourceClient('http://localhost:9999', {fetchImpl: async url => url.endsWith('/api/graphql') ? json({fetchChapterPages: {pages: ['/page/1', '/page/2']}}) : url.endsWith('/1') ? new Response(png) : new Response('<html>challenge</html>')});
	await assert.rejects(client.downloadChapter(43, root), /supported image/);
	assert.deepEqual(await fs.readdir(root), []);
});

test('cancelling a download removes staged files', async t => {
	const root = await temporary(t);
	const controller = new AbortController();
	const client = new SourceClient('http://localhost:9999', {fetchImpl: async url => url.endsWith('/api/graphql') ? json({fetchChapterPages: {pages: ['/page/1', '/page/2']}}) : new Response(png)});
	await assert.rejects(client.downloadChapter(44, root, () => controller.abort(), controller.signal), /abort/i);
	assert.deepEqual(await fs.readdir(root), []);
});

test('image proxy rejects external URLs, HTML and oversized images', async() => {
	const client = new SourceClient('https://engine.example', {fetchImpl: async() => new Response(png)});
	await assert.rejects(client.image('https://attacker.example/page'), /external/);
	await assert.rejects(client.image('/page', 1), /limit/);
	const html = new SourceClient('https://engine.example', {fetchImpl: async() => new Response('<html>not a page</html>')});
	await assert.rejects(html.image('/page'), /supported image/);
});

test('duplicate chapter requests share a single download', async t => {
	const root = await temporary(t);
	let requests = 0;
	const client = new SourceClient('http://localhost:9999', {fetchImpl: async url => { requests++; return url.endsWith('/api/graphql') ? json({fetchChapterPages: {pages: ['/page']}}) : new Response(png); }});
	const first = client.downloadChapter(45, root);
	const second = client.downloadChapter(45, root);
	assert.equal(first, second);
	await Promise.all([first, second]);
	assert.equal(requests, 2);
});

test('cache paths remain stable when the bundled engine restarts on a different port', async t => {
	const root = await temporary(t);
	const first = new SourceClient('http://127.0.0.1:12345', {cacheNamespace: 'bundled-suwayomi', fetchImpl: async url => url.endsWith('/api/graphql') ? json({fetchChapterPages: {pages: ['/page']}}) : new Response(png)});
	const folder = await first.downloadChapter(46, root);
	const restarted = new SourceClient('http://127.0.0.1:54321', {cacheNamespace: 'bundled-suwayomi', fetchImpl: async() => { throw new Error('Offline'); }});
	assert.equal(await restarted.downloadChapter(46, root), folder);
});
