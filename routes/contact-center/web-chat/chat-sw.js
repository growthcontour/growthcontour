// public/chat-sw.js — Service Worker для push-сповіщень оператора

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}

  const title = data.title || 'Нове повідомлення';
  const options = {
    body: data.body || '',
    tag: data.roomId ? ('lc_' + data.roomId) : 'lc',
    renotify: true,
    data: { roomId: data.roomId || '', siteId: data.siteId || '' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const roomId = event.notification.data && event.notification.data.roomId;

  event.waitUntil((async () => {
    const clientsArr = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of clientsArr) {
      if (c.url.includes('/operator.html')) {
        await c.focus();
        if (roomId) c.postMessage({ type: 'lc:open-room', roomId });
        return;
      }
    }
    await self.clients.openWindow('/operator.html');
  })());
});