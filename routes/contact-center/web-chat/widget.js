// public/widget.js — LOADER (iframe-версія) v12
(function (window, document) {
	console.log("Growth contour system");

	// ─────────────────────────────────────────────────────────────
	// 1. Читання параметрів скрипта та базові константи
	// ─────────────────────────────────────────────────────────────
	const scriptTag = document.currentScript;
	const SITE_ID = scriptTag && scriptTag.getAttribute("data-site-id");
	const SERVER_URL = new URL(scriptTag.src).origin;
	const APP_ORIGIN = SERVER_URL;

	if (!SITE_ID) {
		console.warn("[LiveChat] no data-site-id");
		return;
	}

	let PRODUCT_CARD = false;
	let BRAND_COLOR = "#007fff";
	let EXTRA_BUTTONS_ENABLED = true;
	let EXTRA_BUTTONS = [];

	// ─────────────────────────────────────────────────────────────
	// 2. Запит конфігу з сервера → ініціалізація віджета
	// ─────────────────────────────────────────────────────────────
	fetch(SERVER_URL + "/chat/config?siteId=" + encodeURIComponent(SITE_ID), { method: "GET", credentials: "omit" })
		.then((r) => r.json())
		.then((cfg) => {
			if (cfg && cfg.allowed) {
				PRODUCT_CARD = !!cfg.productCard;
				if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(cfg.brandColor || "")) BRAND_COLOR = cfg.brandColor;

				// extraButtons: читаємо і з кореня, і з appearance.* — на випадок різних форматів відповіді
				const eb = cfg.extraButtons || (cfg.appearance && cfg.appearance.extraButtons) || {};
				EXTRA_BUTTONS_ENABLED = eb.enabled !== false; // відсутність → true (дефолт збережено)
				const items = Array.isArray(eb.items) ? eb.items : [];
				// Нормалізуємо до формату, який очікує initLoader: { label, href, bg, svg }
				EXTRA_BUTTONS = items.map((it) => ({
					label: it.label || "",
					href: it.link || it.href || "",
					bg: it.bg || BRAND_COLOR,
					svg: it.svg || "",
				}));

				initLoader();
			} else console.warn("[LiveChat] domain not allowed");
		})
		.catch(() => {});

	function initLoader() {
		const D = 16, // відступ від краю екрана
			BTN = 52; // розмір кнопок

		// ─────────────────────────────────────────────────────────
		// 3. Дочірні кнопки MFB-меню
		//    Дані приходять із сервера через cfg.appearance.extraButtons
		//    (див. читач у .then(cfg) на початку файлу).
		//    Структура елемента: { label, href, bg, svg }
		// ─────────────────────────────────────────────────────────
		const SHOW_MFB = EXTRA_BUTTONS_ENABLED && EXTRA_BUTTONS.length > 0;

		// ─────────────────────────────────────────────────────────
		// 4. Загальні стилі: док, кнопки чату, iframe-панель, badge
		// ─────────────────────────────────────────────────────────
		const style = document.createElement("style");
		style.textContent = `
      /* Док із двома кнопками в ряд: [чат] [MFB-тогл] */
      #lc-dock { position: fixed; right: ${D}px; bottom: ${D}px; z-index: 2147483001;
                 display: flex; align-items: flex-end; gap: 15px; }

      /* Кнопки чату та закриття (у доці, у потоці) */
      .lc-fab { position: relative; width: ${BTN}px; height: ${BTN}px; color: #fff;
                background: ${BRAND_COLOR}; border: 0; cursor: pointer;
                display: flex; align-items: center; justify-content: center;
                transition: transform .15s ease; }
      .lc-fab:hover { transform: scale(1.06); }
      .lc-fab svg { width: 24px; height: 24px; fill: #fff; }
      #lc-close { display: none; }  /* показуємо замість кнопки чату при відкритті */

      #lc-badge { position: absolute; top: -2px; right: -2px; background: #e5342b; color: #fff;
                  min-width: 18px; height: 18px; font: 11px/18px 'Lato',sans-serif;
                  text-align: center; padding: 0 4px; display: none; }

      #lc-panel { position: fixed; bottom: ${2 * D + BTN}px; right: ${D}px;
                  width: 377px; height: 520px; max-height: calc(100vh - ${2 * D + BTN + 24}px);
                  border: 0;
                  border: 1px solid ${BRAND_COLOR};
                  background: #fff; z-index: 99999999999;
                  opacity: 0; transform: translateY(16px);
                  visibility: hidden; pointer-events: none;
                  transition: opacity .25s ease, transform .25s ease, visibility 0s linear .25s; }
      #lc-panel.open { opacity: 1; transform: translateY(0);
                  visibility: visible; pointer-events: auto;
                  transition: opacity .25s ease, transform .25s ease, visibility 0s linear 0s; }

      #lc-panel.max { top: 0; right: 0; bottom: 0; width: 377px; height: 100%;
                      max-height: none; border-radius: 0; transform: translateX(16px); }
      #lc-panel.max.open { transform: translateX(0); }

      @media (max-width: 480px) {
        #lc-panel, #lc-panel.max { top: 0; right: 0; bottom: 0; left: 0;
          width: 100%; height: 100%; max-height: none; border-radius: 0;
          transform: translateY(16px); }
        #lc-panel.open, #lc-panel.max.open { transform: translateY(0); }
      }
    `;
		document.head.appendChild(style);

		// ─────────────────────────────────────────────────────────
		// 5. Стилі MFB-кнопки (+/×) та її дочірніх кнопок
		//
		//    ВАЖЛИВО: розкриття/закриття тепер керується ТІЛЬКИ класом
		//    .lc-open (його ставить/знімає JS). Жодних :hover-правил,
		//    бо на мобільних :hover «залипає» після тапу і ламає тогл.
		//    Ховер на десктопі реалізовано в JS (mouseenter/mouseleave).
		// ─────────────────────────────────────────────────────────
		const styleMfb = document.createElement("style");
		styleMfb.textContent = `
      .mfb-component__wrap { position: relative; display: inline-flex; -webkit-tap-highlight-color: transparent; }
      .mfb-component__wrap.lc-busy { pointer-events: none; }   /* поки чат відкритий — меню не чіпаємо */

      .mfb-component__button--main { position: relative; width: ${BTN}px; height: ${BTN}px;
        border: 0; padding: 0; margin: 0; background: ${BRAND_COLOR}; color: #fff; cursor: pointer;
        z-index: 20; display: flex; align-items: center; justify-content: center; text-decoration: none;
        transition: transform .15s ease; }
      .mfb-component__button--main:hover { transform: scale(1.06); }

      /* Іконки + та × — лежать одна на одній, перемикаються через opacity/rotate */
      .mfb-component__main-icon--resting, .mfb-component__main-icon--active {
        position: absolute; top: 50%; left: 50%; width: 24px; height: 24px; margin: -12px 0 0 -12px;
        fill: #fff; transition: opacity .2s ease, transform .2s ease; }
      .mfb-component__main-icon--active { opacity: 0; transform: rotate(-90deg); }

      /* Стан "меню відкрите" — єдине джерело істини для +/× */
      .mfb-component__wrap.lc-open .mfb-component__main-icon--resting { opacity: 0; transform: rotate(90deg); }
      .mfb-component__wrap.lc-open .mfb-component__main-icon--active { opacity: 1; transform: rotate(0); }

      .mfb-component__list { list-style: none; margin: 0; padding: 0;
        position: absolute; left: 0; bottom: 0; width: ${BTN}px; }
      .mfb-component__list > li { position: absolute; left: 0; bottom: 0; width: ${BTN}px;
        padding: 8px 0; margin: -8px 0;                        /* зона наведення без розривів */
        opacity: 0; transform: translateY(0) scale(0);
        transition: transform .3s cubic-bezier(.4,0,.2,1), opacity .3s; }

      /* Стан "меню відкрите" — дочірні кнопки виїжджають угору */
      .mfb-component__wrap.lc-open .mfb-component__list > li { opacity: 1;
        transform: translateY(calc(var(--i) * -64px)) scale(1);
        transition-delay: calc(var(--i) * .04s); }

      .mfb-component__button--child { position: relative; display: flex; align-items: center;
        justify-content: center; width: ${BTN}px; height: ${BTN}px; color: #fff; border: 0;
        cursor: pointer; text-decoration: none;
        transition: transform .15s ease; }
      .mfb-component__button--child:hover { transform: scale(1.06); }
      .mfb-component__button--child svg { width: 24px; height: 24px; fill: #fff; }
      .mfb-component__button--child[data-label]::after { content: attr(data-label);
        position: absolute; right: ${BTN + 12}px; top: 50%; transform: translateY(-50%);
        white-space: nowrap; background: rgba(0,0,0,.72); color: #fff;
        font: 12px/1 'Lato', sans-serif; padding: 6px 9px; border-radius: 4px;
        opacity: 0; transition: opacity .2s; pointer-events: none; }
      .mfb-component__wrap.lc-open .mfb-component__button--child[data-label]:hover::after { opacity: 1; }
    `;
		document.head.appendChild(styleMfb);

		// ─────────────────────────────────────────────────────────
		// 6. Кнопка виклику чату (ліва)
		// ─────────────────────────────────────────────────────────
		const openBtn = document.createElement("button");
		openBtn.id = "lc-open";
		openBtn.className = "lc-fab";
		openBtn.setAttribute("aria-label", "Чат");
		openBtn.innerHTML = `
      <svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
      <span id="lc-badge"></span>`;

		// Кнопка закриття — на місці кнопки чату при відкритті
		const closeBtn = document.createElement("button");
		closeBtn.id = "lc-close";
		closeBtn.className = "lc-fab";
		closeBtn.setAttribute("aria-label", "Закрити");
		closeBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3l6.3 6.3 6.3-6.3z"/></svg>`;

		// ─────────────────────────────────────────────────────────
		// 7. Головна MFB-кнопка (+/×) та її дочірні кнопки
		//    Створюється ЛИШЕ якщо enabled && items.length > 0.
		// ─────────────────────────────────────────────────────────
		let mfbWrap = null;
		let mainBtn = null;

		if (SHOW_MFB) {
			mfbWrap = document.createElement("div");
			mfbWrap.className = "mfb-component__wrap";

			// Використовуємо <button>, а не <a href="#">, щоб клік гарантовано
			// доходив і не спрацьовував перехід за якорем.
			mainBtn = document.createElement("button");
			mainBtn.type = "button";
			mainBtn.className = "mfb-component__button--main";
			mainBtn.setAttribute("aria-label", "Контакти");
			mainBtn.setAttribute("aria-expanded", "false");
			mainBtn.innerHTML = `
      <svg class="mfb-component__main-icon--resting" viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
      <svg class="mfb-component__main-icon--active" viewBox="0 0 24 24"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3l6.3 6.3 6.3-6.3z"/></svg>`;

			mainBtn.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				if (mfbWrap.classList.contains("lc-busy")) return;
				const isOpenMenu = mfbWrap.classList.toggle("lc-open");
				mainBtn.setAttribute("aria-expanded", isOpenMenu ? "true" : "false");
			});

			mfbWrap.appendChild(mainBtn);

			// ── Список дочірніх кнопок ──
			const mfbList = document.createElement("ul");
			mfbList.className = "mfb-component__list";
			EXTRA_BUTTONS.forEach((b, i) => {
				const li = document.createElement("li");
				li.style.setProperty("--i", i + 1);
				const isLink = !!b.href;
				const el = document.createElement(isLink ? "a" : "button");
				el.className = "mfb-component__button--child";
				if (isLink) {
					el.href = b.href;
					el.target = "_blank";
					el.rel = "noopener";
				}
				if (b.label) el.setAttribute("data-label", b.label);
				el.setAttribute("aria-label", b.label || "Кнопка");
				el.style.background = b.bg || BRAND_COLOR;
				el.innerHTML = b.svg || "";
				li.appendChild(el);
				mfbList.appendChild(li);
			});
			mfbWrap.appendChild(mfbList);

			// ── Ховер на десктопі ──
			if (window.matchMedia("(hover: hover)").matches) {
				mfbWrap.addEventListener("mouseenter", () => {
					if (mfbWrap.classList.contains("lc-busy")) return;
					mfbWrap.classList.add("lc-open");
					mainBtn.setAttribute("aria-expanded", "true");
				});
				mfbWrap.addEventListener("mouseleave", () => {
					mfbWrap.classList.remove("lc-open");
					mainBtn.setAttribute("aria-expanded", "false");
				});
			}
		}

		// ─────────────────────────────────────────────────────────
		// 9. Док: [чат/закрити] зліва, [MFB +/×] справа
		// ─────────────────────────────────────────────────────────
		const dock = document.createElement("div");
		dock.id = "lc-dock";
		dock.appendChild(openBtn);
		dock.appendChild(closeBtn);
		if (mfbWrap) dock.appendChild(mfbWrap);
		document.body.appendChild(dock);

		// Закриття MFB-меню при кліку поза ним
		if (mfbWrap) {
			document.addEventListener("click", (e) => {
				if (!mfbWrap.contains(e.target)) {
					mfbWrap.classList.remove("lc-open");
					mainBtn.setAttribute("aria-expanded", "false");
				}
			});
		}

		// ─────────────────────────────────────────────────────────
		// 10. iframe чату
		// ─────────────────────────────────────────────────────────
		const panel = document.createElement("iframe");
		panel.id = "lc-panel";
		panel.setAttribute("title", "Live chat");
		panel.setAttribute("referrerpolicy", "origin-when-cross-origin");
		panel.setAttribute("allow", "autoplay");
		panel.src = SERVER_URL + "/chat/frame.html?siteId=" + encodeURIComponent(SITE_ID) + "&page=" + encodeURIComponent(location.href);
		document.body.appendChild(panel);

		const badge = document.getElementById("lc-badge");
		let isOpen = false,
			maximized = false;

		function post(type) {
			if (panel.contentWindow) panel.contentWindow.postMessage({ type }, APP_ORIGIN);
		}
		function setBadge(n) {
			if (n > 0) {
				badge.textContent = n > 99 ? "99+" : String(n);
				badge.style.display = "block";
			} else {
				badge.style.display = "none";
			}
		}
		function showOpen() {
			openBtn.style.display = "flex";
			closeBtn.style.display = "none";
		}
		function showClose() {
			openBtn.style.display = "none";
			closeBtn.style.display = "flex";
		}

		// ── Відкриття чату ──
		function open() {
			panel.classList.add("open");
			isOpen = true;
			setBadge(0);
			post("lc:open");
			showClose();

			// згортаємо MFB-меню і блокуємо його, поки чат відкритий
			if (mfbWrap) {
				mfbWrap.classList.remove("lc-open");
				mainBtn.setAttribute("aria-expanded", "false");
				mfbWrap.classList.add("lc-busy");
			}
		}

		// ── Закриття чату ──
		function close() {
			panel.classList.remove("open");
			isOpen = false;
			post("lc:close");
			showOpen();
			if (mfbWrap) mfbWrap.classList.remove("lc-busy"); // чат закрито — меню знову активне
			// .max знімаємо ПІСЛЯ анімації зникнення, щоб не було стрибка розміру
			if (maximized) {
				maximized = false;
				setTimeout(() => {
					if (!isOpen) panel.classList.remove("max");
				}, 260);
			}
		}

		function maximize() {
			panel.classList.add("max");
			maximized = true;
			post("lc:maximized");
		}
		function restore() {
			panel.classList.remove("max");
			maximized = false;
			post("lc:restored");
		}

		openBtn.onclick = open;
		closeBtn.onclick = close;

		// ─────────────────────────────────────────────────────────
		// 11. Пробудження аудіо в iframe при першій взаємодії зі сторінкою
		// ─────────────────────────────────────────────────────────
		function wakeAudio() {
			if (panel.contentWindow) panel.contentWindow.postMessage({ type: "lc:wake-audio" }, APP_ORIGIN);
		}
		["click", "keydown", "touchstart"].forEach((ev) => document.addEventListener(ev, wakeAudio, { once: true }));

		// ─────────────────────────────────────────────────────────
		// 12. Картка товару (JSON-LD)
		// ─────────────────────────────────────────────────────────
		function pickProductNode(json) {
			const nodes = [];
			const push = (x) => {
				if (x && typeof x === "object") nodes.push(x);
			};
			if (Array.isArray(json)) json.forEach(push);
			else {
				push(json);
				if (Array.isArray(json["@graph"])) json["@graph"].forEach(push);
			}
			return (
				nodes.find((n) => {
					const t = n["@type"];
					return t === "Product" || (Array.isArray(t) && t.includes("Product"));
				}) || null
			);
		}

		function normAvailability(a) {
			const s = String(a || "").toLowerCase();
			if (s.includes("instock") || s.includes("in_stock")) return "in";
			if (s.includes("outofstock") || s.includes("soldout")) return "out";
			if (s.includes("preorder")) return "preorder";
			if (s.includes("backorder")) return "backorder";
			return "";
		}

		function firstImage(img) {
			if (!img) return "";
			if (typeof img === "string") return img;
			if (Array.isArray(img)) {
				const f = img[0];
				return typeof f === "string" ? f : (f && f.url) || "";
			}
			if (typeof img === "object") return img.url || "";
			return "";
		}

		// Повноекранний перегляд фото — малюємо в сторінці-господарі (поза iframe)
		let lightboxEl = null;
		function openLightbox(url) {
			if (!url) return;
			if (!lightboxEl) {
				lightboxEl = document.createElement("div");
				lightboxEl.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.88);" + "display:flex;align-items:center;justify-content:center;z-index:2147483647;cursor:zoom-out";
				const img = document.createElement("img");
				img.style.cssText = "max-width:92%;max-height:92%;border-radius:4px;box-shadow:0 10px 40px rgba(0,0,0,.5)";
				lightboxEl.appendChild(img);
				lightboxEl.addEventListener("click", () => {
					lightboxEl.style.display = "none";
				});
				document.body.appendChild(lightboxEl);
			}
			lightboxEl.querySelector("img").src = url;
			lightboxEl.style.display = "flex";
		}

		// закриття lightbox по Esc
		document.addEventListener("keydown", (e) => {
			if (e.key === "Escape" && lightboxEl && lightboxEl.style.display === "flex") {
				lightboxEl.style.display = "none";
			}
		});

		function readProduct() {
			try {
				const scripts = document.querySelectorAll('script[type="application/ld+json"]');
				let node = null;
				for (const s of scripts) {
					let json;
					try {
						json = JSON.parse(s.textContent);
					} catch (e) {
						continue;
					}
					node = pickProductNode(json);
					if (node) break;
				}
				if (!node) return null;

				// offers буває обʼєктом або масивом
				let offer = node.offers;
				if (Array.isArray(offer)) offer = offer[0] || {};
				offer = offer || {};

				const brand = node.brand && (typeof node.brand === "string" ? node.brand : node.brand.name);

				const rating = node.aggregateRating || {};
				const product = {
					name: node.name || "",
					url: offer.url || node.url || location.href,
					sku: node.sku || node.mpn || node.productID || "",
					gtin: node.gtin13 || node.gtin || node.gtin12 || node.gtin14 || node.gtin8 || "",
					image: firstImage(node.image),
					description: (node.description || "").slice(0, 500),
					price: offer.price != null ? String(offer.price) : "",
					currency: offer.priceCurrency || "",
					availability: normAvailability(offer.availability),
					inventory: offer.inventoryLevel != null ? String(offer.inventoryLevel) : "",
					brand: brand || "",
					rating: rating.ratingValue != null ? String(rating.ratingValue) : "",
					reviewCount: rating.reviewCount != null ? String(rating.reviewCount) : "",
				};
				if (!product.name) return null;
				return product;
			} catch (e) {
				return null;
			}
		}

		let lastProductKey = "";
		function sendProduct() {
			if (!PRODUCT_CARD) return;
			const p = readProduct();
			const key = p ? p.url + "|" + p.sku + "|" + p.price : "";
			if (key === lastProductKey) {
				return;
			}
			lastProductKey = key;
			if (panel.contentWindow) {
				panel.contentWindow.postMessage({ type: "lc:product", product: p }, APP_ORIGIN);
			}
		}

		// ─────────────────────────────────────────────────────────
		// 13. Обмін повідомленнями з iframe
		// ─────────────────────────────────────────────────────────
		window.addEventListener("message", (e) => {
			if (e.origin !== APP_ORIGIN) return;
			if (e.source !== panel.contentWindow) return;
			const d = e.data || {};
			if (d.type === "lc:unread") {
				if (!isOpen) setBadge(d.count | 0);
			} else if (d.type === "lc:ready") {
				if (isOpen) post("lc:open");
				if (panel.contentWindow) panel.contentWindow.postMessage({ type: "lc:device", mobile: window.matchMedia("(max-width: 768px)").matches }, APP_ORIGIN);
				sendProduct();
			} else if (d.type === "lc:request-open") {
				if (!isOpen) open();
			} else if (d.type === "lc:request-close") {
				close();
			} else if (d.type === "lc:request-maximize") {
				maximize();
			} else if (d.type === "lc:request-restore") {
				restore();
			} else if (d.type === "lc:lightbox") {
				openLightbox(d.url);
			}
		});

		// Esc закриває чат
		document.addEventListener("keydown", (e) => {
			if (e.key === "Escape" && isOpen) close();
		});

		// ─────────────────────────────────────────────────────────
		// 14. Перше читання товару + реакція на SPA-навігацію
		// ─────────────────────────────────────────────────────────
		setTimeout(sendProduct, 1500);

		(function watchUrl() {
			let lastHref = location.href;
			const check = () => {
				if (location.href !== lastHref) {
					lastHref = location.href;
					setTimeout(sendProduct, 800);
				}
			};
			["pushState", "replaceState"].forEach((fn) => {
				const orig = history[fn];
				history[fn] = function () {
					const r = orig.apply(this, arguments);
					check();
					return r;
				};
			});
			window.addEventListener("popstate", check);
		})();
	}
})(window, document);
