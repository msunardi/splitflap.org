# splitflap lite

A stripped-down split-flap board: one board screen, any number of phone remotes, a message mode and a widgets mode (date and time, next schedule item, weather, notes).

## Run it

```sh
npm install          # once, from the repository root
npm run lite         # or: npm run lite:dev  (restarts when server code changes)
```

- Board: `http://localhost:3001/` (open it on the TV or computer screen)
- Phone: `http://<this computer's IP>:3001/phone.html`, then enter the 4-character code shown on the board

After changing `lite/server.js`, restart the server and reload the board and phone pages. The phone warns you if the server is older than the page.

Click or press any key on the board once to turn on sound; browsers block audio until then.

## "Use my location" needs HTTPS

Browsers only share location with secure pages: HTTPS, or `localhost` on the same computer. A phone opening `http://192.168.x.x:3001` is neither, so the browser blocks location before it asks you. City search works either way.

To use your location from a phone, serve the lite app over HTTPS with a certificate for your computer's network address.

1. Find the computer's network address (Windows: `ipconfig`, the IPv4 address, e.g. `10.0.0.97`).
2. From the repository root, in Git Bash, create a certificate for that address (replace the IP):

   ```sh
   mkdir -p lite/certs
   MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
     -keyout lite/certs/key.pem -out lite/certs/cert.pem -subj "/CN=splitflap-lite" \
     -addext "subjectAltName=IP:10.0.0.97,DNS:localhost,IP:127.0.0.1"
   ```

3. Restart the server. When `lite/certs/cert.pem` and `key.pem` exist it serves HTTPS on the same port and says so at startup. (`SSL_CERT` and `SSL_KEY` can point at a certificate elsewhere.) `lite/certs/` is git-ignored.
4. Open `https://10.0.0.97:3001/` on the board and `https://10.0.0.97:3001/phone.html` on the phone. The certificate is self-signed, so each browser shows a warning once: choose **Advanced → Proceed** (Chrome) or **Show details → visit this website** (Safari).
5. Tap **Use my location** and allow location when the phone asks.

If your computer's IP address changes, create the certificate again.

### Without the browser warning

Install [mkcert](https://github.com/FiloSottile/mkcert), run `mkcert -install`, then `mkcert -cert-file lite/certs/cert.pem -key-file lite/certs/key.pem 10.0.0.97 localhost 127.0.0.1`. Then install mkcert's root certificate (`mkcert -CAROOT` shows where it is) on the phone and mark it trusted: on iPhone, Settings → General → About → Certificate Trust Settings.

## Google Calendar in the schedule widget

1. On a computer, open calendar.google.com → **Settings** (gear) → under **Settings for my calendars** pick your calendar → **Integrate calendar** → copy **Secret address in iCal format**. (The phone app doesn't show it. Work or school accounts may have it turned off.)
2. On the phone: **Widgets** tab → **Next in today's schedule** → **Edit** → paste the link → **Connect**.

The board then shows the next timed event today from the calendar and from the items you typed, whichever comes first. All-day events are skipped because they have no time to count down to. Repeating events, skipped occurrences and moved occurrences are handled.

- The server checks the calendar every 5 minutes, and Google can take a while to update this link, so a new event may take 5–15 minutes or more to appear.
- The secret address works like a password. Only the server keeps it: phones see the calendar's name, and the board only gets event times and titles. If it leaks, reset it on the same Google Calendar settings page and connect the new one.
- The server keeps it in memory, so after restarting the server, connect the calendar again.
- One calendar per board.

## Weather

Weather comes from Open-Meteo (no API key), falling back to weather.gov for US locations. City search uses Open-Meteo's geocoding service, so the place you type is sent to it. Weather refreshes every 10 minutes.
