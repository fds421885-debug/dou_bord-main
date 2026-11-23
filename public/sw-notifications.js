// DuoBoard Service Worker notification click & push handler (loaded via Workbox importScripts)
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var data = event.notification && event.notification.data ? event.notification.data : {};
  var senderUid = data.senderUid || '';
  var chatId = data.chatId || '';
  var actionTab = data.actionTab || (senderUid ? 'friends' : 'friends');
  var targetUrl = senderUid
    ? '/?openChat=' + encodeURIComponent(senderUid)
    : '/?openTab=' + encodeURIComponent(actionTab);

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if (client && 'focus' in client) {
          client.focus();
          client.postMessage({
            type: 'DUOBOARD_NOTIFICATION_CLICK',
            senderUid: senderUid,
            chatId: chatId,
            actionTab: actionTab,
          });
          return;
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});

self.addEventListener('push', function (event) {
  if (!event.data) return;
  try {
    var payload = event.data.json();
    var title = payload.title || 'DuoBoard — رسالة جديدة';
    var options = {
      body: payload.body || '',
      icon: '/pwa-192x192.png',
      badge: '/pwa-192x192.png',
      dir: 'rtl',
      lang: 'ar',
      tag: payload.tag || 'duoboard-msg',
      renotify: true,
      data: payload.data || {},
    };
    event.waitUntil(self.registration.showNotification(title, options));
  } catch (e) {
    // Ignore malformed push payload
  }
});
