// Fetch a pinned upstream runtime with its own JRE; no system Java is required.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');

const version = 'v2.4.2366';
const builds = {
	'darwin-arm64': ['macOS-arm64.tar.gz', '3b269855928070253a4d9f7c4a57d9ff99d0272102410233c459b02a732e87e7'],
	'darwin-x64': ['macOS-x64.tar.gz', '18768b2e3b7fb25bf3eff9e4b4b14b6235b2dfea320701ab172ea7f902eeb97e'],
	'linux-x64': ['linux-x64.tar.gz', '7a469f8c820e65305f795d61f1776c783919884531497b587bdff898a7e0fa73'],
	'win32-x64': ['windows-x64.zip', 'b955f374a8d94b8d1c2750ae28fa7eb2066b479957561b5ba9cf8ac993c8fc13'],
};

async function main()
{
	const target = process.argv[2] || process.platform+'-'+process.arch;
	if(!builds[target]) throw new Error('No bundled runtime is available for '+target+'. Supported: '+Object.keys(builds).join(', '));
	const [suffix, hash] = builds[target];
	const name = 'Suwayomi-Server-'+version+'-'+suffix;
	const output = path.resolve(__dirname, '../..', 'build/runtime/suwayomi', target);
	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'opencomic-runtime-'));
	try
	{
		const response = await fetch('https://github.com/Suwayomi/Suwayomi-Server/releases/download/'+version+'/'+name, {signal: AbortSignal.timeout(600000)});
		if(!response.ok) throw new Error('Runtime download failed: '+response.status);
		const bytes = Buffer.from(await response.arrayBuffer());
		if(crypto.createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error('Runtime checksum mismatch.');
		const archive = path.join(temporary, name);
		await fs.writeFile(archive, bytes);
		await fs.mkdir(output, {recursive: true});
		if(suffix.endsWith('.tar.gz'))
		{
			const directory = name.replace(/\.tar\.gz$/, '');
			execFileSync('tar', ['-xzf', archive, '--strip-components', '1', '-C', output, directory+'/jre', directory+'/bin']);
		}
		else
		{
			// Windows ships a portable ZIP. Keep just Java and the server, not the
			// second Electron installation or upstream launcher.
			execFileSync('tar', ['-xf', archive, '-C', temporary]);
			const entries = await fs.readdir(temporary, {withFileTypes: true});
			const root = entries.find(entry => entry.isDirectory() && entry.name.startsWith('Suwayomi-Server'));
			const source = root ? path.join(temporary, root.name) : temporary;
			for(const dir of ['jre', 'bin']) await fs.cp(path.join(source, dir), path.join(output, dir), {recursive: true});
		}
		const license = await fetch('https://raw.githubusercontent.com/Suwayomi/Suwayomi-Server/'+version+'/LICENSE');
		if(!license.ok) throw new Error('Unable to fetch the Suwayomi license.');
		await fs.writeFile(path.join(output, 'LICENSE.Suwayomi'), await license.text());
		await fs.writeFile(path.join(output, 'UPSTREAM.txt'), 'Suwayomi-Server '+version+'\nSource: https://github.com/Suwayomi/Suwayomi-Server/tree/'+version+'\nArchive SHA-256: '+hash+'\nUnmodified server and JRE from the official release. See LICENSE.Suwayomi and jre/legal.\n');
		console.log('Manga source runtime ready: '+output);
	}
	finally { await fs.rm(temporary, {recursive: true, force: true}); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
