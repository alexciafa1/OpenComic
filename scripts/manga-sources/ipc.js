const path = require('node:path');
const {SourceEngine} = require('./engine.js');

module.exports = function({app, ipcMain}, storagePath)
{
	const runtime = app.isPackaged ? path.join(process.resourcesPath, 'suwayomi') : path.join(__dirname, '../../build/runtime/suwayomi', process.platform+'-'+process.arch);
	const engine = new SourceEngine(runtime, path.join(path.dirname(storagePath), 'manga-source-engine'));
	const jobs = new Map();
	app.on('before-quit', () => {
		for(const job of jobs.values()) job.abort();
		engine.stop();
	});
	const actions = {
		repositories: client => client.repositories(),
		addRepository: (client, data) => client.addRepository(data.url),
		removeRepository: (client, data) => client.removeRepository(data.url),
		extensions: (client, data) => client.extensions(!!data.refresh),
		install: (client, data) => client.install(data.id, data.action),
		sources: client => client.sources(),
		browse: (client, data) => client.browse(data.source, data.query, data.page, data.type),
		manga: (client, data) => client.manga(data.id),
		thumbnail: (client, data) => client.thumbnail(data.url),
	};
	ipcMain.handle('manga-sources', async(event, action, data = {}) => {
		if(!event.sender.getURL().startsWith('file:')) throw new Error('Invalid source request.');
		if(action === 'cancel') { jobs.get(event.sender.id)?.abort(); return; }
		if(action !== 'chapter' && !actions[action]) throw new Error('Unknown source action.');
		const client = await engine.start();
		if(action !== 'chapter') return actions[action](client, data);
		if(jobs.has(event.sender.id)) throw new Error('A chapter is already being downloaded.');
		const controller = new AbortController();
		jobs.set(event.sender.id, controller);
		const closed = () => controller.abort();
		event.sender.once('destroyed', closed);
		try
		{
			return await client.downloadChapter(data.id, path.join(path.dirname(storagePath), 'manga-chapters'), (loaded, total) => {
				if(!event.sender.isDestroyed()) event.sender.send('manga-sources-progress', {loaded, total});
			}, controller.signal);
		}
		finally
		{
			jobs.delete(event.sender.id);
			if(!event.sender.isDestroyed()) event.sender.removeListener('destroyed', closed);
		}
	});
};
