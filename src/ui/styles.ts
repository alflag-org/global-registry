export const styles = String.raw`
:root {
  color-scheme: light;
  font-family: system-ui, 'Hiragino Sans', 'Noto Sans JP', sans-serif;
  color: #16191f;
  background: #f2f3f3;
}
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  display: flex;
  min-height: 100vh;
}
aside {
  width: 240px;
  flex: none;
  display: flex;
  flex-direction: column;
  padding: 20px 16px;
  background: #232f3e;
  color: #d5dbdb;
}
aside a {
  color: inherit;
  display: block;
  text-decoration: none;
  padding: 8px 10px;
  border-radius: 4px;
  font-size: 14px;
}
aside a:hover,
aside a[aria-current] {
  background: #31465f;
  color: white;
}
.brand {
  font-size: 20px;
  font-weight: 750;
  color: white;
  padding: 0 10px 14px;
}
nav h2 {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  margin: 22px 10px 6px;
  color: #aab7b8;
}
.lang {
  margin-top: auto;
  padding: 14px 10px 0;
  border-top: 1px solid #3b4a5c;
  display: block;
  font-size: 12px;
  color: #aab7b8;
}
.lang select {
  width: 100%;
  margin-top: 6px;
  padding: 7px;
  font-size: 13px;
  background: #31465f;
  color: #fff;
  border: 1px solid #48596d;
}
main {
  min-width: 0;
  flex: 1;
  padding: 28px 32px;
  max-width: 1600px;
}
h1 {
  font-size: 26px;
  font-weight: 600;
  margin: 0 0 18px;
}
h2 {
  font-size: 17px;
  margin: 26px 0 12px;
}
a {
  color: #0073bb;
}
button,
.button {
  display: inline-block;
  background: #0073bb;
  color: white;
  padding: 8px 14px;
  border: 0;
  border-radius: 4px;
  font: inherit;
  font-size: 14px;
  text-decoration: none;
  cursor: pointer;
}
button:hover,
.button:hover {
  background: #0a5a91;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
.secondary {
  background: #eaeded;
  color: #16191f;
  border: 1px solid #d5dbdb;
}
.danger {
  background: #d13212;
}
.actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin: 14px 0;
}
.toolbar {
  display: flex;
  align-items: end;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  background: white;
  border: 1px solid #d5dbdb;
  border-radius: 4px;
  padding: 14px 16px;
  margin: 14px 0 18px;
}
.filters {
  display: flex;
  align-items: end;
  flex-wrap: wrap;
  gap: 12px;
}
.filters label {
  font-size: 12px;
  color: #545b64;
}
.filters input,
.filters select {
  max-width: 240px;
}
input,
select,
textarea {
  font: inherit;
  padding: 8px 10px;
  border: 1px solid #aab7b8;
  border-radius: 4px;
  background: white;
  color: #16191f;
  width: 100%;
  margin-top: 4px;
}
input:focus,
select:focus,
textarea:focus {
  outline: none;
  border-color: #0073bb;
  box-shadow: 0 0 0 2px #0073bb33;
}
textarea {
  min-height: 90px;
}
label {
  display: block;
  font-size: 14px;
}
form.editor {
  max-width: 680px;
  background: white;
  padding: 24px;
  border: 1px solid #d5dbdb;
  border-radius: 4px;
  display: grid;
  gap: 16px;
}
.table-wrap {
  overflow: auto;
  background: white;
  border: 1px solid #d5dbdb;
  border-radius: 4px;
}
table {
  border-collapse: collapse;
  width: 100%;
  font-size: 14px;
}
th,
td {
  text-align: left;
  padding: 11px 16px;
  border-bottom: 1px solid #eaeded;
  vertical-align: top;
}
th {
  background: #fafafa;
  font-size: 12px;
  font-weight: 600;
  color: #545b64;
  white-space: nowrap;
}
tbody tr:hover {
  background: #f2f8fd;
}
td {
  max-width: 400px;
  overflow-wrap: anywhere;
}
tr:last-child td {
  border: 0;
}
dl {
  display: grid;
  grid-template-columns: 180px 1fr;
  background: white;
  border: 1px solid #d5dbdb;
  border-radius: 4px;
  padding: 18px;
  gap: 12px;
  font-size: 14px;
}
dt {
  color: #545b64;
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
}
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 12px;
}
.error {
  background: #fdf3f1;
  color: #8a2420;
  border: 1px solid #d1321255;
  border-left: 4px solid #d13212;
  padding: 12px 14px;
  border-radius: 4px;
}
.muted {
  color: #545b64;
}
dialog {
  max-width: 500px;
  border: 1px solid #aab7b8;
  border-radius: 6px;
  padding: 26px;
}
dialog::backdrop {
  background: #232f3e88;
}
dialog button {
  margin-top: 15px;
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
}
.card {
  background: white;
  border: 1px solid #d5dbdb;
  border-left: 4px solid #0073bb;
  border-radius: 4px;
  padding: 18px 20px;
}
.card a {
  text-decoration: none;
  font-size: 14px;
}
.card strong {
  display: block;
  font-size: 30px;
  font-weight: 600;
  margin-top: 8px;
  color: #16191f;
}
@media (max-width: 850px) {
  body {
    display: block;
  }
  aside {
    width: auto;
    padding: 14px;
  }
  nav {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  nav h2 {
    display: none;
  }
  .lang {
    margin: 10px 0 0;
    max-width: 160px;
    border: 0;
    padding: 10px 0 0;
  }
  main {
    padding: 18px;
  }
  dl {
    grid-template-columns: 130px 1fr;
  }
}
`;
