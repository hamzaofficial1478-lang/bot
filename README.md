# Site Geo Check

A small app that runs on your own computer and shows you how your website loads and looks for visitors in the USA, Canada and Europe. You paste in your link, pick the locations, and it opens the site from each one, waits a few seconds, scrolls through the page and gives you a side-by-side report.

For each location you get:

- the IP address the site actually saw, with its city and country, and a warning if your VPN or proxy put you in the wrong country
- server response time, Largest Contentful Paint, layout shift and full load time, coloured using Google's good / needs-work / poor thresholds
- the HTTP status, any redirects (handy for spotting geo-redirects like `/en-gb/` or `/fr-ca/`) and where you ended up
- a screenshot of the top of the page plus a full-page one
- whether a cookie banner appeared (your European visitors should see one), which currencies were on the page, and the page language
- which CDN edge served you and whether it was a cache hit, if your host sends those headers
- console errors, failed requests and broken files
- a note if different locations were served different page content

## Getting it running

You need [Node.js](https://nodejs.org) (the LTS version is fine).

**Windows:** double-click `start.bat`. The first run installs everything, which takes a minute or two. After that it opens the dashboard in your browser.

**Mac / Linux / manual:**

```bash
npm run setup     # first time only: installs packages and the browser
npm start         # opens http://localhost:3000
```

The dashboard only listens on your own machine (`127.0.0.1`), so nobody else on your network can reach it.

## Checking from different countries

There are two ways to do it, and you can mix them.

**With your VPN.** The built-in "My current connection (VPN)" location uses whatever your computer is connected to. Connect your VPN to, say, New York, run a check, then switch to Toronto and run again, then London, and so on. Every run is saved under "Past checks", so you can flick between them afterwards. The "Seen from" line tells you exactly where the site thought you were.

**With proxies, one per location.** This is the hands-off option, because you can tick New York, Toronto, Frankfurt and London and check them all in one go. Click "Add location", give it a name, choose the region it *should* be in and paste the proxy address. Plenty of VPN providers (NordVPN and Surfshark, for example) list proxy server addresses and separate "service credentials" in their manual-setup pages. Proxy services that sell location-specific endpoints work too. Both of these formats are accepted:

```
http://username:password@us-nyc.example.com:8080
us-nyc.example.com:8080:username:password
```

HTTP and HTTPS proxies with a username and password work reliably. If your provider only gives you SOCKS5 with a login and it won't connect, use their HTTP option instead.

Your locations, proxy logins included, are saved in `data/locations.json` on your computer. That folder is in `.gitignore`, so it never ends up on GitHub.

## Options

- **Show the browser while it runs:** watch each visit happen in a real window instead of in the background.
- **Use my installed Google Chrome:** uses your normal Chrome install instead of the bundled Chromium. It's a fresh, empty profile, so your own tabs, logins and history aren't touched.
- **Stay on the page for:** how many seconds to wait after the page loads before the screenshot is taken (0 to 15). This gives pop-ups, cookie banners and slow widgets time to appear.

## What it deliberately doesn't do

It makes one honest visit per location each time you press the button. It doesn't loop, fake lots of visitors, rotate through IPs to inflate numbers, or try to look like a human to get past bot detection. Each visit adds `SiteGeoCheck/1.0` to the browser's user agent, so you can spot (and filter out) these visits in your server logs. If you use Google Tag Manager, you can stop your analytics tag firing when the user agent contains `SiteGeoCheck`.

If a location comes back with a "bot check shown" badge, your host or CDN (Cloudflare, usually) challenged the visit. That's useful to know in its own right. Just bear in mind that a real visitor on a normal home connection is far less likely to see that page.

## Where things live

```
src/server.js    local web server and API
src/checker.js   opens the browser, visits the site, collects the results
src/store.js     saves locations and reports under data/
src/proxy.js     reads the proxy formats above
public/          the dashboard (plain HTML, CSS and JS, no build step)
data/reports/    one folder per check: report.json and the screenshots
```
