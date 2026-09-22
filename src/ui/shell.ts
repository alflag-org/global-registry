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
      <p>Infrastructure inventory · IPAM</p>
      <nav aria-label="Main navigation">
        <a href="/locations">Locations</a>
        <h2>Infrastructure</h2>
        <a href="/devices">Devices</a><a href="/virtual-machines">Virtual Machines</a
        ><a href="/interfaces">Interfaces</a>
        <h2>Network</h2>
        <a href="/vlans">VLANs</a><a href="/prefixes">Prefixes</a
        ><a href="/ip-addresses">IP Addresses</a>
        <h2>Activity</h2>
        <a href="/audit-log">Audit Log</a><a href="/docs">API documentation</a>
      </nav>
    </aside>
    <main id="main"><p role="status">Loading inventory…</p></main>
    <dialog id="auth">
      <form id="auth-form">
        <h2>Local development access</h2>
        <p>
          Enter LOCAL_AUTH_SECRET from your local .dev.vars file. It is kept in this browser tab
          only.
        </p>
        <label
          >Local secret<input name="secret" type="password" required autocomplete="off" /></label
        ><button>Continue</button>
        <p id="auth-error" role="alert"></p>
      </form>
    </dialog>
    <noscript>JavaScript is required for this interface. The REST API is also available.</noscript>
  </body>
</html>
`;
