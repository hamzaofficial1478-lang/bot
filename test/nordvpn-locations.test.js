// Run with: npm test
const test = require('node:test');
const assert = require('node:assert');
const { nordvpnLocations } = require('../src/checker');

const server = (name, host) => ({ name, hostname: `${host}.nordvpn.com` });

test('builds locations in the VPN country, spread across cities, skipping unsafe names', async () => {
  global.fetch = async (url) => {
    let body;
    if (url.startsWith('https://ipwho.is')) body = { ip: '9.9.9.9', country: 'Canada', country_code: 'CA' };
    else if (url.endsWith('/countries')) {
      body = [{ id: 38, code: 'CA', name: 'Canada', cities: [
        { id: 2, name: 'Calgary', serverCount: 23 },
        { id: 1, name: 'Toronto', serverCount: 199 },
      ] }];
    } else if (url.includes('country_city_id]=1&limit=2')) {
      body = [server('Canada #1', 'ca1'), server('Canada #2"; del C:\\*', 'ca2')];
    } else if (url.includes('country_city_id]=2&limit=1')) body = [server('Canada #3', 'ca3')];
    else throw new Error(`unexpected ${url}`);
    return { ok: true, json: async () => body };
  };

  const locs = await nordvpnLocations(3);
  assert.deepStrictEqual(locs.map((l) => l.label), ['Canada #1 – Toronto', 'Canada #3 – Calgary']);
  assert.ok(locs.every((l) => l.target === 'CA' && l.locale === 'en-CA'));
  assert.match(locs[0].vpnCommand, /Canada #1|connect ca1$/);
});
