const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const clone = value => JSON.parse(JSON.stringify(value));

function database() {
  const tables = { properties: [{id: 'asset', building_name: 'Asset'}], documents: [], document_links: [] };
  let failInsert = false;
  let nextId = 1;
  const client = {
    auth: { getSession: async () => ({data: {session: {user: {id: 'test'}}}}) },
    from(table) {
      let operation = 'select', payload, predicates = [], single = false, limit;
      const query = {
        select() { return query; },
        upsert(rows) { operation = 'upsert'; payload = rows; return query; },
        insert(rows) { operation = 'insert'; payload = rows; return query; },
        delete() { operation = 'delete'; return query; },
        eq(key, value) { predicates.push(row => row[key] === value); return query; },
        in(key, values) { predicates.push(row => values.includes(row[key])); return query; },
        gte(key, value) { predicates.push(row => row[key] >= value); return query; },
        limit(value) { limit = value; return query; },
        single() { single = true; return query; },
        then(resolve, reject) {
          return Promise.resolve().then(() => {
            const rows = tables[table] ||= [];
            const matches = row => predicates.every(predicate => predicate(row));
            if (operation === 'insert' && failInsert && table === 'document_links') {
              return {error: {message: 'simulated write failure'}};
            }
            if (operation === 'delete') tables[table] = rows.filter(row => !matches(row));
            if (operation === 'insert') rows.push(...clone(payload).map(row => ({id: nextId++, ...row})));
            if (operation === 'upsert') for (const row of clone(payload)) {
              const index = rows.findIndex(old => old.id === row.id);
              if (index < 0) rows.push(row); else rows[index] = row;
            }
            let data = rows.filter(matches);
            if (limit) data = data.slice(0, limit);
            return {data: clone(single ? data[0] || null : data), error: null};
          }).then(resolve, reject);
        }
      };
      return query;
    }
  };
  return {client, tables, failLinks(value) { failInsert = value; }};
}

async function tab(db) {
  let state;
  const window = {supabase: {createClient: () => db.client}, BuildingStorage: {
    getBuildings: () => state.buildings,
    getMasterData: () => state.masterData
  }};
  const context = vm.createContext({window, console});
  vm.runInContext(fs.readFileSync(path.join(root, 'supabase-storage.js'), 'utf8'), context);
  state = await window.ComplianceHQSupabase.loadApplicationData();
  return {api: window.ComplianceHQSupabase, state};
}

async function testPersistence() {
  const db = database();
  const fresh = await tab(db), stale = await tab(db);
  fresh.state.buildings[0].documents.push({id: 'doc', title: 'Saved document', storage: {kind:'supabase', path:'doc/file.pdf'}});
  await fresh.api.syncCurrentApplicationData();
  await fresh.api.verifyDocumentSaved('doc', 'asset', 'doc/file.pdf');
  await stale.api.syncCurrentApplicationData();
  const refreshed = await tab(db);
  assert.equal(refreshed.state.buildings[0].documents[0].id, 'doc', 'stale tab must preserve the document and asset link');
  db.failLinks(true);
  fresh.state.buildings[0].documents[0].scheduleItemId = 'calendar';
  await assert.rejects(fresh.api.syncCurrentApplicationData(), /simulated write failure/);
  assert.equal(db.tables.document_links.length, 1, 'failed link replacement must preserve the old link');
  db.failLinks(false);
  await fresh.api.syncCurrentApplicationData();
  assert.equal(db.tables.document_links.length, 1);
  assert.equal(db.tables.document_links[0].schedule_item_id, 'calendar');
  await assert.rejects(fresh.api.verifyDocumentSaved('doc', 'other-asset', 'doc/file.pdf'), /not been linked/);
  fresh.state.buildings[0].documents = [];
  await fresh.api.syncCurrentApplicationData();
  assert.equal(db.tables.documents.length, 0, 'explicit deletion of a known document must work');
  assert.equal(db.tables.document_links.length, 0);
}

async function testForm() {
  const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const begin = source.indexOf('  async function confirmDocumentSave(');
  const end = source.indexOf('  function updateBuildingDocumentsStateForBuilding(', begin);
  let resolveSync, uploads = 0, closed = 0, records = [], verified = 0;
  const alerts = [];
  let sync = new Promise(resolve => { resolveSync = resolve; });
  const field = value => ({value});
  const context = vm.createContext({
    console: {error() {}}, pendingDocumentUpload: null,
    documentSaveBtn: {disabled: false, textContent: 'Save Document'},
    documentTitleInput: field('Test'), documentFileInput: {files: [{name:'file.pdf', type:'application/pdf', size:10}]},
    documentTenancySelect: field(''), documentScheduleSelect: field(''),
    documentDateInput: field(''), documentExpiryInput: field(''),
    documentExpiryCalendarToggle: {checked:false}, documentNotesInput: field(''),
    activeDocumentFormMode: 'add', activeDocumentContext: null,
    getDocumentFormBuilding: () => ({id:'asset'}),
    updateBuildingDocumentsStateForBuilding(id, mutate) { const result = mutate({documents:records}); records = result.documents; return result; },
    closeDocumentForm() { closed++; },
    window: {
      alert: text => alerts.push(text),
      BuildingStorage: {createId: () => 'new-document', waitForSupabaseSync: () => sync},
      ComplianceHQSupabase: {
        uploadDocumentFile: async () => { uploads++; return {kind:'supabase', path:'doc/file.pdf'}; },
        verifyDocumentSaved: async () => { verified++; }
      }
    }
  });
  vm.runInContext(source.slice(begin, end), context);
  const save = context.handleSaveDocument({preventDefault() {}});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, 0, 'form must remain open until database acknowledgement');
  assert.equal(context.documentSaveBtn.disabled, true);
  resolveSync({success:false, skipped:true, reason:'Signed out'});
  await save;
  assert.equal(closed, 0);
  assert.equal(verified, 0);
  assert.match(alerts[0], /Signed out/);
  assert.equal(context.documentSaveBtn.disabled, false);
  sync = Promise.resolve({success:true});
  await context.handleSaveDocument({preventDefault() {}});
  assert.equal(closed, 1);
  assert.equal(verified, 1);
  assert.equal(uploads, 1, 'retry must reuse the completed upload');
  assert.equal(records.length, 1, 'retry must not duplicate the document');
  context.documentSaveBtn.disabled = false;
  sync = Promise.reject(new Error('Connection failed'));
  await context.handleSaveDocument({preventDefault() {}});
  assert.equal(closed, 1, 'failed sync must not close the form');
  assert.match(alerts[1], /Connection failed/);
}

(async () => {
  await testPersistence();
  await testForm();
  console.log('PASS: document persistence, stale-tab preservation, safe link retry, save acknowledgement, failure handling and upload reuse');
})().catch(error => { console.error(error); process.exitCode = 1; });
