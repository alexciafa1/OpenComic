const ipc = require('electron').ipcRenderer;
let root = null;
let revision = 0;
let busy = false;
let downloading = false;
let state = {view: 'sources', items: [], filter: '', lang: ''};
let retry = null;

function api(action, data = {}) { return ipc.invoke('manga-sources', action, data); }
function text() { return language.mangaSources; }

function active(element = root) { return element && element.isConnected && template._contentRight().contains(element); }

function status(message = '')
{
	if(active()) root.querySelector('.ms-status').textContent = message;
}

async function run(task)
{
	if(busy) return;
	busy = true;
	const element = root;
	const version = ++revision;
	retry = () => run(task);
	element.querySelector('.ms-error').hidden = true;
	status(text().loading);
	element.setAttribute('aria-busy', 'true');
	const buttonStates = [...element.querySelectorAll('button, input, select')].map(button => [button, button.disabled]);
	for(const [button] of buttonStates) button.disabled = true;
	try
	{
		const next = await task();
		if(active(element) && version === revision && next) { state = next; render(); }
	}
	catch(error)
	{
		if(active(element) && version === revision)
		{
			const box = element.querySelector('.ms-error');
			box.hidden = false;
			box.querySelector('p').textContent = text().error+': '+error.message;
		}
	}
	finally
	{
		if(version === revision) { busy = false; status(); }
		element.removeAttribute('aria-busy');
		for(const [button, disabled] of buttonStates) button.disabled = disabled;
	}
}

function filterList()
{
	if(!active()) return;
	let matches = 0;
	for(const row of root.querySelectorAll('.ms-row[data-name]'))
	{
		row.hidden = !row.dataset.name.toLocaleLowerCase().includes(state.filter.toLocaleLowerCase()) || (state.lang && row.dataset.lang !== state.lang);
		if(!row.hidden) matches++;
	}
	const empty = root.querySelector('.ms-no-matches');
	if(empty) empty.hidden = matches > 0 || !state.items.length;
}

function render()
{
	if(!active()) return;
	const view = state.view;
	handlebarsContext.mangaSources = {
		...state, t: text(), repositoriesView: view === 'repositories',
		listView: ['sources', 'extensions'].includes(view), extensionsView: view === 'extensions',
		browseView: view === 'browse', detailView: view === 'detail', hasPrevious: state.page > 1,
		languages: [...new Set((state.items || []).map(item => item.lang))].sort(),
	};
	root.querySelector('.ms-content').innerHTML = template.load('manga.sources.content.html');
	for(const button of root.querySelectorAll('[data-tab]'))
	{
		if(button.dataset.tab === view) button.setAttribute('aria-current', 'page');
		else button.removeAttribute('aria-current');
	}
	filterList();
	loadCovers(root, revision);
	gamepad.updateBrowsableItems('mangaSources');
}

async function loadCovers(element, version)
{
	const images = [...element.querySelectorAll('[data-cover]')];
	await Promise.all(Array.from({length: Math.min(4, images.length)}, async() => {
		while(images.length && active(element) && revision === version)
		{
			const image = images.shift();
			try
			{
				const src = await api('thumbnail', {url: image.dataset.cover});
				if(image.isConnected && active(element) && revision === version) image.src = src;
			}
			catch { /* Keep the cover placeholder if a source image is unavailable. */ }
		}
	}));
}

async function list(view, refresh = false)
{
	if(view === 'repositories') return {view, repositories: await api('repositories'), items: [], filter: '', lang: ''};
	let items = await api(view, {refresh});
	if(view === 'extensions' && !refresh && !items.length) items = await api(view, {refresh: true});
	if(view === 'sources') items = items.map(item => item.id === '0' ? {...item, name: text().localSource, lang: text().localLanguage} : item);
	return {view, items, filter: state.filter || '', lang: state.lang || ''};
}

function tab(view)
{
	if(downloading) return;
	run(() => list(view));
}

async function browse(source, query = '', page = 1, type = 'POPULAR')
{
	const result = await api('browse', {source: source.id, query, page, type});
	return {view: 'browse', source, query, page, type, ...result};
}

async function readChapter(index)
{
	if(busy || downloading) return;
	const chapter = state.chapters[index];
	if(!chapter) return;
	downloading = true;
	const element = root;
	const version = ++revision;
	const box = element.querySelector('.ms-download');
	box.hidden = false;
	element.querySelector('.ms-error').hidden = true;
	for(const button of element.querySelectorAll('button')) button.disabled = button.dataset.action !== 'cancel';
	const progress = (_event, {loaded, total}) => {
		if(!active(element) || revision !== version) return;
		box.querySelector('progress').value = loaded / total * 100;
		box.querySelector('.ms-progress-text').textContent = loaded+' / '+total;
	};
	ipc.on('manga-sources-progress', progress);
	try
	{
		const folder = await api('chapter', {id: chapter.id});
		if(active(element) && revision === version)
		{
			storage.setKey('compressedMetadata', folder, {title: state.manga.title+' — '+chapter.name, author: state.manga.author || ''});
			// Open the completed folder directly in the existing reader, preserving
			// page layout, manga/webtoon mode, keyboard shortcuts and local progress.
			recentlyOpened.set(folder);
			dom.fromLibrary(false);
			await dom.openComic(true, folder, folder);
		}
	}
	catch(error)
	{
		if(active(element) && revision === version && !/abort/i.test(error.message))
		{
			const box = element.querySelector('.ms-error');
			box.hidden = false;
			box.querySelector('p').textContent = text().error+': '+error.message;
			retry = async() => { await readChapter(index); };
		}
	}
	finally
	{
		ipc.removeListener('manga-sources-progress', progress);
		downloading = false;
		box.hidden = true;
		for(const button of element.querySelectorAll('button')) button.disabled = false;
	}
}

function click(event)
{
	const button = event.target.closest('button');
	if(!button || button.disabled) return;
	const data = button.dataset;
	if(data.action === 'cancel') { api('cancel').catch(() => {}); return; }
	if(busy || downloading) return;
	if(data.tab) { tab(data.tab); return; }
	if(data.action === 'retry') { if(retry) retry(); return; }
	if(data.action === 'refresh') { run(() => list(state.view, true)); return; }
	if(data.source !== undefined) { run(() => browse(state.items[+data.source])); return; }
	if(data.manga !== undefined)
	{
		const parent = state;
		run(async() => ({view: 'detail', parent, ...await api('manga', {id: state.mangas[+data.manga].id})}));
		return;
	}
	if(data.chapter !== undefined) { readChapter(+data.chapter); return; }
	if(data.action === 'back')
	{
		if(state.view === 'detail') { state = state.parent; revision++; render(); }
		else tab('sources');
		return;
	}
	if(['next', 'previous'].includes(data.action)) { run(() => browse(state.source, state.query, state.page + (data.action === 'next' ? 1 : -1), state.type)); return; }
	if(data.removeRepository !== undefined)
	{
		if(!window.confirm(text().confirmRemove)) return;
		const url = state.repositories[+data.removeRepository].indexUrl;
		run(async() => { await api('removeRepository', {url}); return list('repositories'); });
		return;
	}
	for(const action of ['install', 'uninstall', 'update'])
	{
		if(data[action] === undefined) continue;
		if(action === 'uninstall' && !window.confirm(text().confirmUninstall)) return;
		const id = state.items[+data[action]].pkgName;
		run(async() => { await api('install', {id, action}); return list('extensions'); });
		return;
	}
}

function home()
{
	revision++;
	busy = false;
	handlebarsContext.headerTitle = language.mangaSources.title;
	template.loadHeader('manga.sources.header.html', false);
	template.loadContentRight('manga.sources.html', false);
	root = template._contentRight().querySelector('.manga-sources');
	root.addEventListener('click', click);
	root.addEventListener('input', event => {
		if(event.target.matches('.ms-filter')) { state.filter = event.target.value; filterList(); }
	});
	root.addEventListener('change', event => {
		if(event.target.matches('.ms-language')) { state.lang = event.target.value; filterList(); }
		if(event.target.matches('.ms-sort')) run(() => browse(state.source, '', 1, event.target.value));
	});
	root.addEventListener('submit', event => {
		event.preventDefault();
		if(busy || downloading) return;
		const form = new FormData(event.target);
		if(event.target.matches('.ms-repository-form')) run(async() => { await api('addRepository', {url: form.get('url')}); return list('repositories'); });
		if(event.target.matches('.ms-search-form')) run(() => browse(state.source, String(form.get('query')).trim(), 1, state.type));
	});
	events.events();
	if(['detail', 'browse'].includes(state.view)) render();
	else { run(() => list(state.view)); status(text().starting); }
}

module.exports = {
	home,
	getTabState: () => structuredClone(state),
	setTabStateFirst: data => { state = data?.view ? structuredClone(data) : {view: 'sources', items: [], filter: '', lang: ''}; },
};
