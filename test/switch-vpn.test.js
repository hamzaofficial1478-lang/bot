// Run with: npm test
const test = require('node:test');
const assert = require('node:assert');
const { switchVpn } = require('../src/checker');

// Fake IP service: the first lookup (before the VPN command) sees the old IP, later ones the new IP.
function fakeIpChange() {
  let calls = 0;
  global.fetch = async () => ({ ok: true, json: async () => ({ ip: calls++ === 0 ? '1.1.1.1' : '2.2.2.2' }) });
}

test('runs the VPN command and returns once the IP has changed', async () => {
  fakeIpChange();
  assert.strictEqual(await switchVpn('node -e "0"'), null);
});

test('a failing VPN command stops the visit with a readable error', async () => {
  fakeIpChange();
  await assert.rejects(
    switchVpn('node -e "console.error(\'not logged in\'); process.exit(3)"'),
    /The VPN command failed: not logged in/,
  );
});
