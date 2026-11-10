# Setup: from this folder to a live site and QR code

About 20 minutes. Everything is free.

The page is plain HTML/CSS/JS on **GitHub Pages**. Sign-ups are saved in a **Google Sheet** through a small **Apps Script** web app.

## How privacy works

- Phone numbers are written only to the Google Sheet. Keep that Sheet private (don't share it).
- The public page reads from the script's `GET` address, which returns only slot, name, performance, and the creche total. The code never includes phone numbers in that response.
- Creche names and phone numbers are private too. Only the total count is public.

## 1. Create the Sheet and the script

1. Go to [sheets.new](https://sheets.new) and name it **Community Creche sign-ups**.
2. Open **Extensions → Apps Script**.
3. Delete the starter code, paste in everything from [apps-script/Code.gs](apps-script/Code.gs), and click **Save**.

## 2. Deploy it as a web app

1. Click **Deploy → New deployment**. Click the gear next to "Select type" and choose **Web app**.
2. Set **Execute as: Me** and **Who has access: Anyone**.
3. Click **Deploy**, then **Authorize access** and choose your Google account.
   Google warns that the app is unverified, because you wrote it. Click **Advanced → Go to (project name) (unsafe) → Allow**.
4. Copy the **Web app URL** (it ends in `/exec`). (https://script.google.com/macros/s/AKfycbwxS8wBJgu4yQ1EuiZ_nVsK2OwB3DEFbbGp5uP9EbfUiMCenJglqoWRm4TYdHIDxEd_/exec)
5. Paste the URL into your browser. You should see `{"ok":true,"performances":[],"creches":0}`. Two new tabs, **Performances** and **Creches**, appear in the Sheet.

## 3. Point the site at the script

Open [config.js](config.js) and paste the URL between the quotes:

```js
window.CRECHE_CONFIG = {
  scriptUrl: "https://script.google.com/macros/s/XXXX/exec",
};
```

Until you do this the page runs in preview mode with sample data, and the maroon "Preview mode" bar shows at the top.

To try it on your computer first: `python3 -m http.server` in this folder, then open http://localhost:8000.

## 4. Publish on GitHub Pages

1. Create a new GitHub repository (public is fine, since the site is public anyway).
2. Push this folder to it.
3. In the repo, go to **Settings → Pages**. Under **Build and deployment**, choose **Deploy from a branch**, then `main` and `/ (root)`, then **Save**.
4. After a minute the site is live at `https://YOUR-NAME.github.io/YOUR-REPO/`.

## 5. Make the QR code

```bash
pip install segno
python3 tools/make_qr.py https://YOUR-NAME.github.io/YOUR-REPO/
```

This writes `qr/community-creche-qr.svg` (use this for print, since it stays sharp at any size) and `qr/community-creche-qr.png`.
**Scan the printed code with a phone before printing a stack of them.**

## During the event

- **The Sheet is the master list.** Sort the **Performances** tab by the **Time** column for a run-of-show, or just read it top to bottom.
- **To free up a slot** (someone cancels, or a typo), delete that row. The page shows the slot as open again within about 15 seconds.
- **To fix a name or performance**, edit the cell. It updates on the page within about 15 seconds.
- **Never rename the tabs or the header row.** The script looks for `Performances` and `Creches`.

## If you change `Code.gs` later

**Deploy → Manage deployments → pencil icon → Version: New version → Deploy.** The URL stays the same. Choosing "New deployment" instead creates a different URL.

## Known limits

- The script URL is visible in the page source. Anyone who finds it could submit fake sign-ups by hand. The code rejects bad input and a hidden spam-trap field catches simple bots, but nothing stops a determined person. Delete unwanted rows from the Sheet.
- There is no cancel button for performers. They contact the organizer, who deletes the row.
- Google limits Apps Script to a few hundred thousand runs a day. This event will use a tiny fraction of that.
