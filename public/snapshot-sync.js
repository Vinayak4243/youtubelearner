(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AdaptPracticeSnapshotSync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function accountRecoveryKey(baseKey, userId) {
    if (!userId) throw new Error('A user id is required for account recovery storage.');
    return `${baseKey}.account.${userId}`;
  }

  function canAcknowledgeSave(savedRevision, currentRevision, savedUserId, currentUserId) {
    return Number.isInteger(savedRevision)
      && Number.isInteger(currentRevision)
      && savedRevision === currentRevision
      && Boolean(savedUserId)
      && savedUserId === currentUserId;
  }

  return { accountRecoveryKey, canAcknowledgeSave };
});
