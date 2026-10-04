import assert from 'node:assert/strict';
import type { Browser } from 'playwright';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export async function checkInitialLanguage(browser: Browser, base: string) {
  for (const { locale, stored, unavailable, language } of [
    { locale: 'ja-JP', language: 'ja' },
    { locale: 'en-US', stored: 'ja', language: 'ja' },
    { locale: 'ja-JP', stored: 'en', language: 'en' },
    { locale: 'en-US', language: 'en' },
    { locale: 'ja-JP', stored: 'unsupported', language: 'ja' },
    { locale: 'ja-JP', unavailable: true, language: 'ja' },
  ]) {
    const page = await browser.newPage({ locale });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(
      ({ stored, unavailable }) => {
        if (unavailable) {
          Object.defineProperty(globalThis, 'localStorage', {
            get() {
              throw new DOMException('Storage is unavailable.', 'SecurityError');
            },
          });
        } else if (stored !== undefined && localStorage.getItem('registry-lang') === null) {
          localStorage.setItem('registry-lang', stored);
        }
      },
      { stored, unavailable },
    );
    let scriptGate = gate();
    let apiGate = gate();
    await page.route('**/assets/app.js', async (route) => {
      await scriptGate.promise;
      await route.continue();
    });
    await page.route('**/openapi.json', async (route) => {
      await apiGate.promise;
      await route.continue();
    });
    const devices = language === 'ja' ? 'デバイス' : 'Devices';
    try {
      for (const pathname of ['/', '/devices']) {
        scriptGate = gate();
        apiGate = gate();
        if (pathname === '/') {
          await page.goto(base, { waitUntil: 'commit' });
        } else {
          await Promise.all([
            page.waitForURL(base + pathname, { waitUntil: 'commit' }),
            page.getByRole('link', { name: devices, exact: true }).first().click(),
          ]);
        }
        await page.locator('#main').waitFor({ state: 'attached' });
        await page.locator('#lang').waitFor({ state: 'hidden' });
        for (const label of await page.locator('[data-i18n]').all()) {
          assert.equal(await label.isVisible(), false, 'Untranslated shell label is visible');
        }
        assert.equal(await page.locator('#lang').isVisible(), false);
        assert.equal(await page.locator('.brand').isVisible(), true);

        scriptGate.resolve();
        await page.locator('#lang').waitFor({ state: 'visible' });
        assert.equal(await page.locator('html').getAttribute('lang'), language);
        assert.equal(await page.locator('#lang').inputValue(), language);
        assert.equal(await page.locator('#lang').isVisible(), true);
        assert.equal(await page.locator('nav a[href="/devices"]').innerText(), devices);
        const loading = page.getByRole('status');
        assert.equal(
          await loading.innerText(),
          language === 'ja' ? '読み込み中…' : 'Loading inventory…',
        );
        assert.equal(await loading.isVisible(), true, 'Localized shell must not wait for API data');

        apiGate.resolve();
        await page
          .getByRole('heading', {
            name:
              pathname === '/'
                ? language === 'ja'
                  ? 'ダッシュボード'
                  : 'Infrastructure inventory'
                : devices,
            exact: true,
          })
          .waitFor();
      }
      if (stored === 'ja') {
        await Promise.all([page.waitForEvent('load'), page.locator('#lang').selectOption('en')]);
        assert.equal(await page.locator('html').getAttribute('lang'), 'en');
        assert.equal(await page.locator('nav a[href="/devices"]').innerText(), 'Devices');
        await page.goto(base);
        await page
          .getByRole('heading', { name: 'Infrastructure inventory', exact: true })
          .waitFor();
      }
      assert.deepEqual(errors, []);
    } finally {
      scriptGate.resolve();
      apiGate.resolve();
      await page.close();
    }
  }
}
