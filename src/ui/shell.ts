export const shell = String.raw`
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Global Registry</title>
    <link rel="stylesheet" href="/assets/app.css" />
    <script src="/assets/app.js" defer></script>
  </head>
  <body>
    <aside>
      <a class="brand" href="/">Global Registry</a>
      <nav aria-label="Main navigation">
        <a href="/locations" data-i18n="locations">Locations</a>
        <h2 data-i18n="sectionInfrastructure">Infrastructure</h2>
        <a href="/devices" data-i18n="devices">Devices</a
        ><a href="/virtual-machines" data-i18n="virtual-machines">Virtual Machines</a
        ><a href="/interfaces" data-i18n="interfaces">Interfaces</a>
        <h2 data-i18n="sectionNetwork">Network</h2>
        <a href="/vlans" data-i18n="vlans">VLANs</a
        ><a href="/prefixes" data-i18n="prefixes">Prefixes</a
        ><a href="/ip-addresses" data-i18n="ip-addresses">IP Addresses</a>
        <h2 data-i18n="sectionActivity">Activity</h2>
        <a href="/audit-log" data-i18n="audit-log">Audit Log</a
        ><a href="/docs" data-i18n="apiDocs">API documentation</a>
      </nav>
      <label class="lang"
        ><span data-i18n="language">Language</span
        ><select id="lang"
          ><option value="en">English</option><option value="ja">日本語</option></select
        ></label
      >
    </aside>
    <main id="main"><p role="status" data-i18n="loading">Loading…</p></main>
    <dialog id="auth">
      <form id="auth-form">
        <h2 data-i18n="authTitle">Local development access</h2>
        <p data-i18n="authHelp">
          Enter LOCAL_AUTH_SECRET from your local .dev.vars file. It is kept in this browser tab
          only.
        </p>
        <label
          ><span data-i18n="authSecret">Local secret</span
          ><input name="secret" type="password" required autocomplete="off" /></label
        ><button data-i18n="authContinue">Continue</button>
        <p id="auth-error" role="alert"></p>
      </form>
    </dialog>
    <noscript>JavaScript is required for this interface. The REST API is also available.</noscript>
  </body>
</html>
`;
