export const styles = String.raw`
:root {
  color-scheme: light;
  font-family: system-ui, sans-serif;
  color: #142a3b;
  background: #f4f7f9;
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
  width: 245px;
  flex: none;
  padding: 28px 22px;
  background: #122c3d;
  color: #c7d8e4;
}
aside a {
  color: inherit;
  display: block;
  text-decoration: none;
  padding: 9px 8px;
  border-radius: 5px;
}
aside a:hover,
aside a[aria-current] {
  background: #24485e;
  color: white;
}
.brand {
  font-size: 21px;
  font-weight: 750;
  color: white;
  padding: 0;
}
aside p {
  font-size: 12px;
  margin-bottom: 35px;
}
nav h2 {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  margin: 25px 8px 7px;
  color: #90adbf;
}
main {
  min-width: 0;
  flex: 1;
  padding: 36px;
  max-width: 1600px;
}
h1 {
  font-size: 29px;
  margin: 0 0 22px;
}
h2 {
  font-size: 18px;
  margin: 28px 0 14px;
}
a {
  color: #066b82;
}
button,
.button {
  display: inline-block;
  background: #087d86;
  color: white;
  padding: 10px 15px;
  border: 0;
  border-radius: 5px;
  font: inherit;
  font-size: 14px;
  text-decoration: none;
  cursor: pointer;
}
button:hover,
.button:hover {
  background: #075f65;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
.secondary {
  background: #e1ebef;
  color: #254353;
}
.danger {
  background: #b23d38;
}
.actions,
.filters {
  display: flex;
  align-items: end;
  flex-wrap: wrap;
  gap: 12px;
  margin: 16px 0;
}
.filters label {
  font-size: 12px;
}
.filters input,
.filters select {
  max-width: 240px;
}
input,
select,
textarea {
  font: inherit;
  padding: 10px;
  border: 1px solid #b9cbd5;
  border-radius: 4px;
  background: white;
  color: #142a3b;
  width: 100%;
  margin-top: 5px;
}
textarea {
  min-height: 90px;
}
label {
  display: block;
  font-size: 14px;
}
form.editor {
  max-width: 750px;
  background: white;
  padding: 24px;
  border: 1px solid #d6e2e8;
  border-radius: 7px;
  display: grid;
  gap: 18px;
}
.table-wrap {
  overflow: auto;
  background: white;
  border: 1px solid #d6e2e8;
  border-radius: 7px;
}
table {
  border-collapse: collapse;
  width: 100%;
  font-size: 14px;
}
th,
td {
  text-align: left;
  padding: 13px 16px;
  border-bottom: 1px solid #e6edf1;
  vertical-align: top;
}
th {
  background: #eaf1f5;
  font-size: 12px;
  color: #446171;
  white-space: nowrap;
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
  border: 1px solid #d6e2e8;
  border-radius: 7px;
  padding: 20px;
  gap: 14px;
  font-size: 14px;
}
dt {
  color: #526b7a;
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
  background: #fff0ed;
  color: #8a2420;
  border: 1px solid #edbfb4;
  padding: 14px;
  border-radius: 5px;
}
.muted {
  color: #526b7a;
}
dialog {
  max-width: 500px;
  border: 1px solid #b9cbd5;
  border-radius: 8px;
  padding: 28px;
}
dialog::backdrop {
  background: #122c3d88;
}
dialog button {
  margin-top: 15px;
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 20px;
}
.card {
  background: white;
  border: 1px solid #d6e2e8;
  border-radius: 7px;
  padding: 24px;
}
.card strong {
  display: block;
  font-size: 32px;
  margin-top: 12px;
}
@media (max-width: 850px) {
  body {
    display: block;
  }
  aside {
    width: auto;
    padding: 18px;
  }
  aside p {
    margin: 8px 0;
  }
  nav {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  nav h2 {
    display: none;
  }
  main {
    padding: 22px;
  }
  dl {
    grid-template-columns: 130px 1fr;
  }
}
`;
