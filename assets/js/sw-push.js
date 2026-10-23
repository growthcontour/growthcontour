self.addEventListener("push", (event) => {
	let data = {};
	try {
		data = event.data ? event.data.json() : {};
	} catch (e) {}

	const title = data.title || "CRM";
	const options = {
		body: data.body || "",
		icon: data.icon || "/assets/img/logo-192.png", // підправ під наявну іконку або прибери рядок
		badge: data.badge,
		data: { url: data.url || "/" },
		tag: data.tag,
		renotify: !!data.tag,
	};

	event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const target = (event.notification.data && event.notification.data.url) || "/";

	event.waitUntil(
		clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
			for (const c of list) {
				if (c.url.includes(target) && "focus" in c) return c.focus();
			}
			if (clients.openWindow) return clients.openWindow(target);
		})
	);
});