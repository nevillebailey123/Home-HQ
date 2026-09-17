const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(process.env.APP_SOURCE || path.join(__dirname, '../app.js'), 'utf8');
function extract(name) {
  const start = source.search(new RegExp('^  (?:async )?function ' + name + '\\(', 'm'));
  assert(start >= 0, name);
  const end = source.indexOf('\n  }', start);
  return source.slice(start, end + 4);
}
const clone = value => JSON.parse(JSON.stringify(value));
let stored = {id:'house', documents:[{id:'insurance', title:'Home, cars Insurance', expiryDate:'2027-07-04', addExpiryToCalendar:true}], scheduleItems:[], propertyTemplates:[], historyRecords:[], tenancies:[]};
let remote, shown = 0, resolveSync, sync = new Promise(resolve => { resolveSync = resolve; });
const alerts = [];
const normalize = building => {
  const result = clone(building);
  result.scheduleItems = context.syncDocumentScheduleItems(result, result.scheduleItems).items;
  return result;
};
const context = vm.createContext({
  console: {error() {}}, activeBuildingId:'house', activeScheduleItemId:'',
  FormData: class { constructor(form) {this.values=form.values;} get(name) {return this.values[name];} },
  getAllTenanciesForBuilding: building => building.tenancies || [],
  getDocumentRegisterTitle: record => record.title,
  getScheduleStatusText: () => 'Scheduled',
  getPropertyTemplates: building => building.propertyTemplates,
  normalizePropertyTemplateRecord: record => record,
  getRecurringDatesFromTemplate: template => template.customRecurringDates || [],
  findBuildingById: () => stored,
  getScheduleContextById: () => normalize(stored),
  readSchedulePrimaryContactId: (form, data) => data.get('primaryContactId') || '',
  readRecurringDatesFromEditForm: form => form.values.recurringDates || [],
  persistScheduleContext: building => {stored=normalize(building); return stored;},
  renderBuildings() {}, renderSchedulePage() {},
  openScheduleDetailsDialog: async () => {shown++;},
  alert: message => alerts.push(message),
  window: {alert: message => alerts.push(message), BuildingStorage: {
    waitForSupabaseSync: () => sync.then(result => {if(result.success) remote=clone(stored); return result;}),
    updateBuilding: building => {stored=clone(building);},
    getBuildingById: () => stored
  }}
});
for (const name of ['syncDocumentScheduleItems', 'getScheduleDetailsData', 'applyScheduleDetailsUpdates', 'calculateNextDueDateFromSettings', 'handleScheduleDetailsSave', 'updateScheduleSourceDocumentExpiry']) {
  if (name === 'updateScheduleSourceDocumentExpiry' && !source.includes('function ' + name + '(')) continue;
  vm.runInContext(extract(name), context);
}
const button = {disabled:false, textContent:'Save'};
const form = {dataset:{}, querySelector: () => button, values:{title:'Home, cars Insurance expires', propertyId:'house', frequency:'Annual', initialDueDate:'2027-07-04', primaryContactId:'leah', notes:''}};
(async () => {
  const generated = normalize(stored).scheduleItems[0];
  assert.equal(stored.scheduleItems.length, 0, 'fixture reproduces generated item missing from raw storage');
  const pending = context.handleScheduleDetailsSave(stored, generated, form);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stored.scheduleItems.length, 1, 'generated item must be saved rather than silently ignored');
  assert.equal(shown, 0, 'wait for remote persistence before showing Saved');
  assert.equal(button.disabled, true);
  resolveSync({success:true});
  await pending;
  assert.equal(shown, 1);
  stored=clone(remote);
  assert.equal(normalize(stored).scheduleItems[0].frequency, 'Annual');
  assert.equal(normalize(stored).scheduleItems[0].preferredContactId, 'leah');
  form.values.initialDueDate='2027-08-04';
  sync=Promise.resolve({success:true});
  await context.handleScheduleDetailsSave(stored, generated, form);
  stored=clone(remote);
  assert.equal(stored.documents[0].expiryDate, '2027-08-04');
  assert.equal(normalize(stored).scheduleItems[0].dueDate, '2027-08-04');
  form.values.primaryContactId='';
  await context.handleScheduleDetailsSave(stored, generated, form);
  assert.equal(normalize(remote).scheduleItems[0].preferredContactId, '');
  const previousShown=shown;
  sync=Promise.reject(new Error('Database unavailable'));
  await context.handleScheduleDetailsSave(stored, generated, form);
  assert.equal(shown, previousShown);
  assert.match(alerts.pop(), /Database unavailable/);
  assert.equal(button.disabled, false);
  sync=Promise.resolve({success:false, skipped:true, reason:'Signed out'});
  await context.handleScheduleDetailsSave(stored, generated, form);
  assert.equal(shown, previousShown);
  assert.match(alerts.pop(), /Signed out/);
  console.log('PASS: generated document reminder saves, survives reload, updates expiry, clears contact, and reports remote failures');
})().catch(error => {console.error(error); process.exitCode=1;});
