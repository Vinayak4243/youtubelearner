const assert = require('node:assert/strict');
const test = require('node:test');
const { accountRecoveryKey, canAcknowledgeSave } = require('../public/snapshot-sync');

test('an earlier cloud acknowledgement cannot clear recovery for a newer local revision', () => {
  const recovery = new Map([['adaptpractice.v1.account.user-1', 'version 2']]);
  const saveStartedAtRevision = 1;
  const currentLocalRevision = 2;
  if (canAcknowledgeSave(saveStartedAtRevision, currentLocalRevision, 'user-1', 'user-1')) {
    recovery.delete(accountRecoveryKey('adaptpractice.v1', 'user-1'));
  }
  assert.equal(recovery.get('adaptpractice.v1.account.user-1'), 'version 2');
  assert.equal(canAcknowledgeSave(2, 2, 'user-1', 'user-1'), true);
});

test('recovery snapshots use distinct storage keys for separate authenticated accounts', () => {
  assert.equal(accountRecoveryKey('adaptpractice.v1', 'user-a'), 'adaptpractice.v1.account.user-a');
  assert.notEqual(accountRecoveryKey('adaptpractice.v1', 'user-a'), accountRecoveryKey('adaptpractice.v1', 'user-b'));
  assert.throws(() => accountRecoveryKey('adaptpractice.v1', ''), /user id is required/);
  assert.equal(canAcknowledgeSave(2, 2, 'user-a', 'user-b'), false);
});
