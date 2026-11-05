// Installable local development build. Public releases should use the normal
// Developer ID / notarization configuration instead.
const base = require('../package.json').build;
module.exports = {
	...base,
	mac: {
		...base.mac,
		target: ['dmg'],
		identity: '-',
		forceCodeSigning: false,
		notarize: false,
		hardenedRuntime: false,
		provisioningProfile: null,
	},
};
