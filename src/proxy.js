const PROTOCOLS = ['http:', 'https:', 'socks4:', 'socks5:'];

// Accepts "http://user:pass@host:port", "socks5://host:port", plain "host:port",
// or the "host:port:user:pass" format a lot of proxy providers hand out.
function toUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  let url;
  try {
    if (raw.includes('://')) {
      url = new URL(raw);
    } else {
      const [host, port, user, ...pass] = raw.split(':');
      url = new URL(`http://${host}:${port || ''}`);
      if (user) {
        url.username = user;
        url.password = pass.join(':'); // passwords are allowed to contain colons
      }
    }
  } catch {
    throw new Error('That proxy doesn\'t look right. Use http://user:pass@host:port or host:port:user:pass');
  }

  if (!PROTOCOLS.includes(url.protocol)) {
    throw new Error(`Proxy type "${url.protocol.replace(':', '')}" isn't supported. Use http, https or socks5.`);
  }
  if (!url.hostname) {
    throw new Error('Proxy needs a host and port, e.g. http://user:pass@us.example.com:8080');
  }
  return url;
}

// Shape Playwright expects for chromium.launch({ proxy }).
function parseProxy(input) {
  const url = toUrl(input);
  if (!url) return undefined;
  const proxy = { server: `${url.protocol}//${url.host}` };
  if (url.username) proxy.username = decodeURIComponent(url.username);
  if (url.password) proxy.password = decodeURIComponent(url.password);
  return proxy;
}

// Safe to show on screen or write into a report.
function maskProxy(input) {
  const url = toUrl(input);
  if (!url) return '';
  const user = url.username ? `${decodeURIComponent(url.username)}:***@` : '';
  return `${url.protocol}//${user}${url.host}`;
}

module.exports = { parseProxy, maskProxy };
