// Opt-in integration test: starts the bundled engine in an isolated profile.
// --repository reads Keiyoushi; --install additionally executes its MangaDex APK.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const sharp = require('sharp');
const {SourceEngine} = require('../manga-sources/engine');

async function main()
{
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opencomic-sources-integration-'));
	const engine = new SourceEngine(path.resolve('build/runtime/suwayomi', process.platform+'-'+process.arch), path.join(root, 'engine'));
	try
	{
		const chapter = path.join(root, 'engine/local/OpenComic test manga/Chapter 001');
		await fs.mkdir(chapter, {recursive: true});
		for(let i = 1; i <= 3; i++) await sharp({create: {width: 400, height: 600, channels: 3, background: {r: 50 * i, g: 80, b: 120}}}).png().toFile(path.join(chapter, String(i).padStart(3, '0')+'.png'));
		const client = await engine.start();
		assert.equal((await fetch(client.url+'/api/graphql', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{"query":"{ __typename }"}'})).status, 401);
		console.log('PASS: bundled Java/server startup; loopback API requires authentication');
		assert.deepEqual(await client.repositories(), []);
		assert.ok((await client.sources()).some(source => source.id === '0'));
		const catalogue = await client.browse('0');
		assert.ok(catalogue.mangas.some(manga => manga.title === 'OpenComic test manga'));
		console.log('PASS: source catalogue and manga browsing');
		const manga = await client.manga(catalogue.mangas.find(manga => manga.title === 'OpenComic test manga').id);
		assert.equal(manga.chapters.length, 1);
		const destination = await client.downloadChapter(manga.chapters[0].id, path.join(root, 'chapters'));
		assert.deepEqual((await fs.readdir(destination)).sort(), ['00001.png', '00002.png', '00003.png', 'complete.json']);
		console.log('PASS: chapter enumeration, page API and native-reader image cache');
		const thumb = catalogue.mangas[0].thumbnailUrl;
		if(thumb) assert.match(await client.thumbnail(thumb), /^data:image\//);
		console.log('PASS: source thumbnail proxy');
		if(process.argv.includes('--repository'))
		{
			const url = 'https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json';
			await client.addRepository(url);
			const repos = await client.repositories();
			assert.ok(repos.length);
			const extensions = await client.extensions(true);
			assert.ok(extensions.length);
			console.log('PASS: supplied repository import and extension refresh ('+extensions.length+' extensions)');
			console.log('Repository:', JSON.stringify(repos));
			const candidate = extensions.find(extension => /MangaDex/i.test(extension.name) && extension.lang === 'all');
			if(candidate && process.argv.includes('--install'))
			{
				await client.install(candidate.pkgName, 'install');
				assert.ok((await client.extensions()).find(extension => extension.pkgName === candidate.pkgName)?.isInstalled);
				const installedSources = await client.sources();
				assert.ok(installedSources.some(source => /MangaDex/i.test(source.name)));
				if(process.argv.includes('--live'))
				{
					const source = installedSources.find(source => /MangaDex/i.test(source.name) && source.lang === 'en');
					assert.ok(source);
					const titles = await client.browse(source.id);
					assert.ok(titles.mangas.length > 0);
					const details = await client.manga(titles.mangas[0].id);
					assert.ok(details.manga.title);
					console.log('PASS: live MangaDex popular catalogue and manga details ('+titles.mangas.length+' titles; '+details.chapters.length+' chapters)');
				}
				await client.install(candidate.pkgName, 'uninstall');
				assert.ok(!(await client.extensions()).find(extension => extension.pkgName === candidate.pkgName)?.isInstalled);
				console.log('PASS: real APK installation, source registration and uninstallation');
			}
			else if(!candidate) console.log('NOTICE: repository exposes notices only:', extensions.map(extension => extension.name).join(', '));
			for(const repo of repos) await client.removeRepository(repo.indexUrl);
			assert.deepEqual(await client.repositories(), []);
			console.log('PASS: repository removal');
		}
	}
	finally
	{
		const child = engine.child;
		engine.stop();
		if(child && child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
		await fs.rm(root, {recursive: true, force: true});
	}
}
main().catch(error => { console.error(error); process.exitCode = 1; });
