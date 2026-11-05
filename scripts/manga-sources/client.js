const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

function httpUrl(value)
{
	const url = new URL(value);
	if(!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
		throw new Error('Enter an HTTP or HTTPS URL without credentials or a fragment.');
	return url.href;
}

class SourceClient
{
	constructor(url, {headers = {}, fetchImpl = fetch, cacheNamespace = url} = {})
	{
		this.url = httpUrl(url).replace(/\/$/, '');
		this.headers = headers;
		this.fetch = fetchImpl;
		this.cacheNamespace = cacheNamespace;
		this.downloads = new Map();
	}

	async query(query, variables = {})
	{
		const response = await this.fetch(this.url+'/api/graphql', {
			method: 'POST', headers: {'Content-Type': 'application/json', ...this.headers},
			body: JSON.stringify({query, variables}), signal: AbortSignal.timeout(120000),
		});
		if(!response.ok) throw new Error('Source engine: HTTP '+response.status);
		const result = await response.json();
		if(result.errors?.length) throw new Error(result.errors.map(error => error.message).join('\n'));
		if(!result.data) throw new Error('The source engine returned an invalid response.');
		return result.data;
	}

	async repositories()
	{
		return (await this.query('query { extensionStores { nodes { indexUrl name } } }')).extensionStores.nodes;
	}

	async addRepository(url)
	{
		return this.query('mutation($input: AddExtensionStoreInput!) { addExtensionStore(input: $input) { extensionStore { name indexUrl } } }', {input: {indexUrl: httpUrl(url)}});
	}

	async removeRepository(url)
	{
		return this.query('mutation($input: RemoveExtensionStoreInput!) { removeExtensionStore(input: $input) { clientMutationId } }', {input: {indexUrl: httpUrl(url)}});
	}

	async extensions(refresh = false)
	{
		const fields = 'pkgName name lang versionName isInstalled hasUpdate isObsolete source { nodes { id name lang } }';
		if(refresh) return (await this.query('mutation { fetchExtensions(input: {}) { extensions { '+fields+' } } }')).fetchExtensions.extensions;
		return (await this.query('query { extensions { nodes { '+fields+' } } }')).extensions.nodes;
	}

	async install(id, action)
	{
		if(!['install', 'uninstall', 'update'].includes(action)) throw new Error('Invalid extension action.');
		return this.query('mutation($input: UpdateExtensionInput!) { updateExtension(input: $input) { extension { pkgName isInstalled } } }', {input: {id, patch: {[action]: true}}});
	}

	async sources()
	{
		return (await this.query('query { sources { nodes { id name lang supportsLatest } } }')).sources.nodes;
	}

	async browse(source, query = '', page = 1, type = 'POPULAR')
	{
		if(!Number.isSafeInteger(page) || page < 1 || !['POPULAR', 'LATEST', 'SEARCH'].includes(type)) throw new Error('Invalid catalogue request.');
		return (await this.query('mutation($input: FetchSourceMangaInput!) { fetchSourceManga(input: $input) { hasNextPage mangas { id title thumbnailUrl } } }', {input: {source: String(source), query, page, type: query ? 'SEARCH' : type}})).fetchSourceManga;
	}

	async manga(id)
	{
		return (await this.query('mutation($input: FetchMangaAndChaptersInput!) { fetchMangaAndChapters(input: $input) { manga { id title description author thumbnailUrl } chapters { id name chapterNumber sourceOrder } } }', {input: {id, fetchManga: true, fetchChapters: true}})).fetchMangaAndChapters;
	}

	async image(url, limit = 32 * 1024 * 1024, signal)
	{
		const target = new URL(url, this.url+'/');
		// All content goes through the engine, which applies source cookies/Referer.
		if(target.origin !== new URL(this.url).origin) throw new Error('The source engine returned an external image URL.');
		const response = await this.fetch(target.href, {headers: this.headers, signal: signal || AbortSignal.timeout(60000), redirect: 'error'});
		if(!response.ok) throw new Error('Page download: HTTP '+response.status);
		const chunks = [];
		let size = 0;
		for await(const chunk of response.body)
		{
			size += chunk.length;
			if(size > limit) throw new Error('Image exceeds the download limit.');
			chunks.push(chunk);
		}
		const buffer = Buffer.concat(chunks);
		const {fileTypeFromBuffer} = await import('file-type');
		const type = await fileTypeFromBuffer(buffer);
		if(!type || !['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'].includes(type.mime)) throw new Error('The source did not return a supported image.');
		return {buffer, ...type};
	}

	async thumbnail(url)
	{
		const image = await this.image(url, 5 * 1024 * 1024);
		return 'data:'+image.mime+';base64,'+image.buffer.toString('base64');
	}

	downloadChapter(id, root, onProgress = () => {}, signal)
	{
		if(!Number.isSafeInteger(id) || id < 0) throw new Error('Invalid chapter ID.');
		const key = crypto.createHash('sha256').update(this.cacheNamespace).digest('hex').slice(0, 16)+'-'+id;
		if(this.downloads.has(key)) return this.downloads.get(key);
		const job = this._downloadChapter(id, path.join(root, key), onProgress, signal).finally(() => this.downloads.delete(key));
		this.downloads.set(key, job);
		return job;
	}

	async _downloadChapter(id, folder, onProgress, signal)
	{
		const marker = path.join(folder, 'complete.json');
		try
		{
			const files = JSON.parse(await fs.readFile(marker, 'utf8'));
			if(Array.isArray(files) && files.length && files.every(file => /^\d+\.(jpg|png|webp|gif|avif)$/.test(file)))
			{
				await Promise.all(files.map(file => fs.access(path.join(folder, file))));
				return folder;
			}
		}
		catch { /* An incomplete chapter is retried atomically. */ }
		const result = await this.query('mutation($input: FetchChapterPagesInput!) { fetchChapterPages(input: $input) { pages } }', {input: {chapterId: id}});
		const pages = result.fetchChapterPages.pages;
		if(!Array.isArray(pages) || !pages.length || pages.length > 3000) throw new Error('This chapter has no pages or exceeds the page limit.');
		const staging = folder+'.partial-'+crypto.randomUUID();
		await fs.mkdir(staging, {recursive: true});
		const files = [];
		try
		{
			for(let i = 0; i < pages.length; i++)
			{
				signal?.throwIfAborted();
				const image = await this.image(pages[i], undefined, signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : undefined);
				const file = String(i + 1).padStart(5, '0')+'.'+image.ext;
				await fs.writeFile(path.join(staging, file), image.buffer);
				files.push(file);
				onProgress(i + 1, pages.length);
			}
			await fs.writeFile(path.join(staging, 'complete.json'), JSON.stringify(files));
			await fs.rm(folder, {recursive: true, force: true});
			await fs.rename(staging, folder);
			return folder;
		}
		finally { await fs.rm(staging, {recursive: true, force: true}); }
	}
}

module.exports = {SourceClient, httpUrl};
