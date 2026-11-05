// End-to-end smoke test for the real Electron renderer. Uses a temporary profile.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const {spawn} = require('node:child_process');
const {setTimeout: delay} = require('node:timers/promises');
const sharp = require('sharp');

async function main()
{
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'opencomic-ui-'));
	const fixture = path.join(profile, 'manga-source-engine/local/OpenComic UI test/Chapter 001');
	await fs.mkdir(fixture, {recursive: true});
	for(let i = 1; i <= 3; i++) await sharp({create: {width: 600, height: 900, channels: 3, background: {r: 40 * i, g: 90, b: 120}}}).png().toFile(path.join(fixture, i+'.png'));
	const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
	const binary = process.env.OPENCOMIC_TEST_BINARY || require('electron');
	const args = process.env.OPENCOMIC_TEST_BINARY ? [] : ['.dist/main.js'];
	const child = spawn(binary, [...args, '--user-data-dir='+profile, '--remote-debugging-port='+port], {stdio: ['ignore', 'pipe', 'pipe']});
	let output = '';
	child.stdout.on('data', b => { output = (output+b).slice(-10000); });
	child.stderr.on('data', b => { output = (output+b).slice(-10000); });
	let socket;
	let evaluate;
	const errors = [];
	try
	{
		let target;
		for(let i = 0; i < 120; i++)
		{
			try { target = (await (await fetch('http://localhost:'+port+'/json')).json()).find(t => t.url.includes('templates/index.html')); } catch {}
			if(target) break;
			await delay(250);
		}
		assert.ok(target, 'Electron renderer starts: '+output);
		socket = new WebSocket(target.webSocketDebuggerUrl);
		await new Promise(resolve => socket.addEventListener('open', resolve, {once: true}));
		let id = 0;
		const pending = new Map();
		socket.addEventListener('message', event => {
			const result = JSON.parse(event.data);
			if(result.method === 'Runtime.exceptionThrown') errors.push(result.params.exceptionDetails);
			if(pending.has(result.id)) { pending.get(result.id)(result); pending.delete(result.id); }
		});
		const command = (method, params = {}) => new Promise((resolve, reject) => {
			const requestId = ++id;
			const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('CDP timeout: '+method)); }, 30000);
			pending.set(requestId, result => { clearTimeout(timer); result.error ? reject(new Error(JSON.stringify(result.error))) : resolve(result.result); });
			socket.send(JSON.stringify({id: requestId, method, params}));
		});
		await command('Runtime.enable');
		evaluate = async expression => {
			const result = await command('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
			if(result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
			return result.result.value;
		};
		const wait = async expression => {
			for(let i = 0; i < 240; i++) { if(await evaluate(expression)) return; await delay(250); }
			throw new Error('UI condition timed out: '+expression+'\n'+await evaluate('document.body.innerText')+'\n'+JSON.stringify(errors)+'\n'+output);
		};
		const screenshot = async name => {
			await fs.mkdir('dist/test-artifacts', {recursive: true});
			const result = await command('Page.captureScreenshot', {format: 'png'});
			await fs.writeFile('dist/test-artifacts/'+name+'.png', Buffer.from(result.data, 'base64'));
		};
		await wait("typeof windowHasLoaded !== 'undefined' && windowHasLoaded");
		await evaluate("dom.changeLanguage('it'); dom.loadMangaSourcesPage();");
		await wait("document.querySelector('.manga-sources [data-source]') && !document.querySelector('.manga-sources').hasAttribute('aria-busy')");
		console.log('PASS: native sidebar navigation, Italian localization and integrated engine startup');
		await screenshot('sources');
		await evaluate("document.querySelector('.manga-sources [data-tab=repositories]').click()");
		await wait("!!document.querySelector('.ms-repository-form')");
		await evaluate("document.querySelector('.ms-repository-form input').value='https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json'; document.querySelector('.ms-repository-form').requestSubmit()");
		await wait("!!document.querySelector('[data-remove-repository]')");
		console.log('PASS: adding the supplied repository through the UI');
		await screenshot('repositories');
		await evaluate("document.querySelector('.manga-sources [data-tab=extensions]').click()");
		await wait("!!document.querySelector('.ms-filter') && !!document.querySelector('[data-install]')");
		await evaluate("var input=document.querySelector('.ms-filter');input.value='MangaDex';input.dispatchEvent(new Event('input',{bubbles:true}))");
		assert.ok(await evaluate("Array.from(document.querySelectorAll('.ms-row[data-name]')).filter(row=>!row.hidden).every(row=>/mangadex/i.test(row.dataset.name))"));
		assert.ok(await evaluate("!!document.querySelector('[data-install]').textContent.trim()"), 'install labels are localized');
		await screenshot('extensions');
		console.log('PASS: extension rendering and live filtering');
		await evaluate("document.querySelector('.manga-sources [data-tab=sources]').click()");
		await wait("!!document.querySelector('[data-source]') && !document.querySelector('.manga-sources').hasAttribute('aria-busy')");
		await evaluate("var filter=document.querySelector('.ms-filter');filter.value='';filter.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-source]').click()");
		await wait("!!document.querySelector('[data-manga]')");
		await screenshot('catalogue');
		await evaluate("document.querySelector('[data-manga]').click()");
		await wait("!!document.querySelector('[data-chapter]')");
		await screenshot('chapters');
		await evaluate("document.querySelector('[data-chapter]').click()");
		await wait("typeof onReading !== 'undefined' && onReading && document.querySelectorAll('.reading-body img').length > 0");
		await delay(1000);
		await screenshot('reader');
		console.log('PASS: catalogue → manga → chapters → existing OpenComic reader');
		await evaluate('dom.history.goBack()');
		await wait("!!document.querySelector('.manga-sources [data-chapter]') && !onReading");
		console.log('PASS: reader Back returns to manga chapters');
		await evaluate('dom.nightMode()');
		await delay(300);
		await screenshot('chapters-dark');
		await evaluate('dom.nightMode()');
		assert.deepEqual(errors, [], 'no unhandled renderer exceptions');
		await evaluate('setTimeout(() => electronRemote.app.quit(), 100); true');
	}
	finally
	{
		if(evaluate && child.exitCode === null) { try { await evaluate('setTimeout(() => electronRemote.app.quit(), 100); true'); } catch {} }
		socket?.close();
		for(let i = 0; i < 20 && child.exitCode === null; i++) await delay(250);
		if(child.exitCode === null) child.kill('SIGKILL');
		await delay(1000);
		await fs.rm(profile, {recursive: true, force: true});
	}
}
main().catch(error => { console.error(error); process.exitCode = 1; });
