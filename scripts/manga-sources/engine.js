const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const {setTimeout: delay} = require('node:timers/promises');
const {SourceClient} = require('./client.js');

class SourceEngine
{
	constructor(runtime, data)
	{
		this.runtime = runtime;
		this.data = data;
		this.child = null;
		this.starting = null;
		this.client = null;
	}

	start()
	{
		if(this.client && this.child) return Promise.resolve(this.client);
		if(!this.starting) this.starting = this._start().finally(() => { this.starting = null; });
		return this.starting;
	}

	async _start()
	{
		const java = path.join(this.runtime, 'jre', 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
		const jar = path.join(this.runtime, 'bin', 'Suwayomi-Server.jar');
		if(!fs.existsSync(java) || !fs.existsSync(jar)) throw new Error('The manga source engine is not bundled. Run npm run sources-runtime before building OpenComic.');
		fs.mkdirSync(this.data, {recursive: true});
		const port = await new Promise((resolve, reject) => {
			const socket = net.createServer();
			socket.on('error', reject);
			socket.listen(0, '127.0.0.1', () => {
				const port = socket.address().port;
				socket.close(error => error ? reject(error) : resolve(port));
			});
		});
		const password = crypto.randomBytes(32).toString('hex');
		const properties = {
			rootDir: this.data, ip: '127.0.0.1', port,
			initialOpenInBrowserEnabled: false, systemTrayEnabled: false, webUIEnabled: false,
			webUIUpdateCheckInterval: 0, kcefEnabled: false,
			authMode: 'BASIC_AUTH', authUsername: 'opencomic', authPassword: password,
		};
		const args = ['-Xmx512m', ...Object.entries(properties).map(([key, value]) => '-Dsuwayomi.tachidesk.config.server.'+key+'='+value), '-jar', jar];
		const child = this.child = spawn(java, args, {cwd: this.data, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
		let tail = '';
		let failure = null;
		const log = chunk => { tail = (tail+chunk.toString()).slice(-4000); };
		child.stdout.on('data', log);
		child.stderr.on('data', log);
		child.once('error', error => { failure = error; });
		child.once('exit', code => {
			failure = new Error('Source engine stopped ('+code+'). '+tail);
			if(this.child === child) { this.child = null; this.client = null; }
		});
		const client = new SourceClient('http://127.0.0.1:'+port, {cacheNamespace: 'bundled-suwayomi', headers: {Authorization: 'Basic '+Buffer.from('opencomic:'+password).toString('base64')}});
		try
		{
			for(let i = 0; i < 240; i++)
			{
				if(failure) throw failure;
				try
				{
					const response = await fetch(client.url+'/api/graphql', {
					method: 'POST', headers: {'Content-Type': 'application/json', ...client.headers},
					body: JSON.stringify({query: '{ __typename }'}), signal: AbortSignal.timeout(1000),
				});
					if(response.ok && (await response.json()).data?.__typename)
					{
						this.client = client;
						return client;
					}
				}
				catch { /* Wait until the database and extension engine are ready. */ }
				await delay(250);
			}
			throw new Error('Source engine startup timed out. '+tail);
		}
		catch(error) { child.kill(); throw error; }
	}

	stop()
	{
		this.child?.kill();
		this.child = null;
		this.client = null;
	}
}

module.exports = {SourceEngine};
